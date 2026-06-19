const fs = require('fs');
const path = require('path');

module.exports = function (app) {
  const plugin = {};
  let unsubscribes = [];
  let simInterval = null;
  let options = {};
  
  // Storage paths for the local knowledge base file
  let historyFilePath = '';

  plugin.id = 'signal-k-tack-and-gybe';
  plugin.name = 'Tack and Gybe Performance Analyzer';
  plugin.description = 'Advanced performance logger with persistent Top 10 and historical averages database.';

  const BUFFER_SIZE = 50; 
  let rollingHistory = [];
  
  let currentState = 'Straight'; 
  let maneuverType = 'Straight';
  let startTime = 0;
  let pendingStartTime = 0;
  let accelerationStartTime = 0; // Tracks pure recovery acceleration timing
  
  let snapshotEntrySTW = 0;
  let snapshotEntryVMG = 0;
  let snapshotEntryTWA = 0;
  
  let minSTW = 99; let maxSTW = 0;
  let minVMG = 99; let maxVMG = 0;
  let maxOverturnTWA = 0; // Tracks the helmsman's overshoot peak
  let timeInDeadZone = 0;  // Seconds spent under 20° TWA

  let actualDistanceMeters = 0; let theoreticalDistanceMeters = 0;
  let actualVmgDistanceMeters = 0; let theoreticalVmgDistanceMeters = 0;

  let currentSTW = 4.01;   
  let currentTWA = -0.698; 
  let currentAWA = -0.488; 
  let currentRudder = 0.0; 

  let simStep = 0;
  let isManeuvering = false;

  // Knowledge base state
  let performanceDatabase = {
    totalTacksLogged: 0,
    averages: { metersLost: 0, recoveryDurationSec: 0, minStwKnots: 0 },
    topTenBests: [] // Sorted by fewest meters lost
  };

  plugin.start = function (startOptions, restartPlugin) {
    options = startOptions || {};
    
    // Set up persistence paths in Signal K config directory
    const configDir = app.getDataDirPath();
    historyFilePath = path.join(configDir, 'tack-history.json');
    loadHistoryDatabase();

    let targetSTW = options.targetSpeedKnots || 7.80; 
    let thresholdPercent = options.recoveryThreshold || 95;
    let recoveryMultiplier = thresholdPercent / 100;

    startEngineLoop(targetSTW, recoveryMultiplier);
  };

  function loadHistoryDatabase() {
    try {
      if (fs.existsSync(historyFilePath)) {
        const fileData = fs.readFileSync(historyFilePath, 'utf8');
        performanceDatabase = JSON.parse(fileData);
        app.debug('Tack history database loaded successfully.');
      }
    } catch (e) {
      app.error('Failed to parse tack history file, starting clean: ' + e.message);
    }
  }

  function saveHistoryDatabase() {
    try {
      fs.writeFileSync(historyFilePath, JSON.stringify(performanceDatabase, null, 2), 'utf8');
    } catch (e) {
      app.error('Failed to write history file to disk: ' + e.message);
    }
  }

  function startEngineLoop(targetEntrySTW, recoveryMultiplier) {
    if (simInterval) clearInterval(simInterval);
    
    simInterval = setInterval(() => {
      // Simulator logic mimicking real boat data, including an intentional overshoot/overturn
      if (!isManeuvering && Math.random() < 0.005) {
        isManeuvering = true;
        simStep = 0;
      }

      if (isManeuvering) {
        simStep++;
        if (simStep <= 15) {
          currentRudder = (8 * Math.PI / 180) * (simStep / 15);
          let twaDeg = -40 + (12 * (simStep / 15)); 
          currentTWA = twaDeg * Math.PI / 180;
          currentAWA = (twaDeg * 0.7) * Math.PI / 180;
          currentSTW = (targetEntrySTW - (0.4 * (simStep / 15))) / 1.94384; 
        }
        else if (simStep <= 50) {
          currentRudder = 12 * Math.PI / 180; 
          let progress = (simStep - 15) / 35;
          // Sweeps through 0 up to 46 degrees (deliberately overshooting upwind target of 40)
          let twaDeg = -28 + (74 * progress); 
          currentTWA = twaDeg * Math.PI / 180;
          currentAWA = (twaDeg * 0.7) * Math.PI / 180;
          let speedFactor = 0.95 - (0.45 * Math.sin(progress * Math.PI / 2));
          currentSTW = (targetEntrySTW * speedFactor) / 1.94384;
        }
        else if (simStep <= 220) {
          let progress = (simStep - 50) / 170;
          currentRudder = -2 * Math.PI / 180; 
          // Helmsman slowly brings the boat back up from 46° down to standard 40° upwind target
          let twaDeg = 46 - (6 * Math.min(1, progress * 3));
          currentTWA = twaDeg * Math.PI / 180;
          currentAWA = (twaDeg * 0.7) * Math.PI / 180;
          let speedFactor = 0.50 + (0.50 * Math.sqrt(progress));
          currentSTW = (targetEntrySTW * speedFactor) / 1.94384;
        }
        else {
          isManeuvering = false;
          currentRudder = 0;
        }
      } else { 
        currentTWA = -40 * Math.PI / 180;
        currentAWA = -28 * Math.PI / 180;
        currentSTW = targetEntrySTW / 1.94384; 
        currentRudder = 0.0;
      }

      runAnalysisPipeline(targetEntrySTW, recoveryMultiplier);
    }, 100);
  }

  function runAnalysisPipeline(targetEntrySTW, recoveryMultiplier) {
    let stwKnots = currentSTW * 1.94384;
    let twaDeg = currentTWA * 180 / Math.PI;
    let awaDeg = currentAWA * 180 / Math.PI;
    let rudderDeg = currentRudder * 180 / Math.PI;
    
    let liveVmgMS = currentSTW * Math.cos(currentTWA);
    let vmgKnots = liveVmgMS * 1.94384;

    if (currentState === 'Straight' || currentState === 'Pending') {
      rollingHistory.push({ stw: stwKnots, vmg: vmgKnots, twa: twaDeg });
      if (rollingHistory.length > BUFFER_SIZE) rollingHistory.shift();
    }

    // --- DETECTION: PENDING ENTRY ---
    if (currentState === 'Straight') {
      if (Math.abs(rudderDeg) > 5 && Math.abs(twaDeg) < 32) {
        currentState = 'Pending';
        pendingStartTime = Date.now();
        
        let historicalBase = rollingHistory[0] || { stw: stwKnots, vmg: vmgKnots, twa: twaDeg };
        snapshotEntrySTW = historicalBase.stw;
        snapshotEntryVMG = historicalBase.vmg;
        snapshotEntryTWA = Math.abs(historicalBase.twa);
        
        maxOverturnTWA = 0;
        timeInDeadZone = 0;
      }
    }

    // --- DETECTION: WIND CROSSING TRIGGER ---
    if (currentState === 'Pending') {
      let timeInPending = (Date.now() - pendingStartTime) / 1000;
      let historyEntry = rollingHistory[0] || { twa: twaDeg };
      let signChange = (historyEntry.twa < 0 && twaDeg > 0) || (historyEntry.twa > 0 && twaDeg < 0);

      if (signChange && Math.abs(twaDeg) < 15) {
        currentState = 'InTurn';
        maneuverType = 'Tack';
        startTime = Date.now();
        
        minSTW = stwKnots; maxSTW = stwKnots;
        minVMG = vmgKnots; maxVMG = vmgKnots;
        
        actualDistanceMeters = 0; theoreticalDistanceMeters = 0;
        actualVmgDistanceMeters = 0; theoreticalVmgDistanceMeters = 0;
      } 
      else if (timeInPending > 10.0 || Math.abs(twaDeg) > 35) {
        currentState = 'Straight';
      }
    }

    // --- PROCESSING & RECOVERY LOGIC ---
    if (currentState === 'InTurn' || currentState === 'Recovery') {
      let timeElapsedSec = (Date.now() - startTime) / 1000;

      if (stwKnots < minSTW) minSTW = stwKnots;
      if (stwKnots > maxSTW) maxSTW = stwKnots;
      if (vmgKnots < minVMG) minVMG = vmgKnots;
      if (vmgKnots > maxVMG) maxVMG = vmgKnots;

      if (Math.abs(twaDeg) < 20) {
        timeInDeadZone += 0.1; // Accumulate time sails spent flapping (100ms updates)
      }

      // Track helmsman's maximum bearing-away overshoot angle relative to target upwind entry
      let currentOvershoot = Math.abs(twaDeg) - snapshotEntryTWA;
      if (currentState === 'Recovery' && currentOvershoot > maxOverturnTWA) {
        maxOverturnTWA = currentOvershoot;
      }

      actualDistanceMeters += (currentSTW * 0.1);
      theoreticalDistanceMeters += ((snapshotEntrySTW / 1.94384) * 0.1); 
      
      actualVmgDistanceMeters += (liveVmgMS * 0.1);
      theoreticalVmgDistanceMeters += ((snapshotEntryVMG / 1.94384) * 0.1);

      let metersLost = theoreticalDistanceMeters - actualDistanceMeters;
      let vmgMetersLost = theoreticalVmgDistanceMeters - actualVmgDistanceMeters;

      // Transition turn -> recovery as sails catch air on opposite board
      if (currentState === 'InTurn' && Math.abs(twaDeg) > 22) {
        currentState = 'Recovery';
        accelerationStartTime = Date.now(); // Start pure acceleration clock
      }

      emitDelta('performance.maneuver.type', maneuverType);
      emitDelta('performance.maneuver.state', currentState);
      emitDelta('performance.maneuver.metersLost', Number(metersLost.toFixed(1)));
      emitDelta('performance.maneuver.liveStwKnots', Number(stwKnots.toFixed(2)));
      emitDelta('performance.maneuver.liveVmgKnots', Number(vmgKnots.toFixed(2)));
      emitDelta('performance.maneuver.liveAwaDegrees', Number(awaDeg.toFixed(1)));

      // --- CRITERIA COMPLETED: LOG PERFORMANCE TO KNOWLEDGEBASE ---
      if (currentState === 'Recovery' && stwKnots >= (snapshotEntrySTW * recoveryMultiplier)) {
        let recoveryDuration = (Date.now() - accelerationStartTime) / 1000;
        
        let tackSummary = {
          timestamp: new Date().toISOString(),
          metersLost: Number(metersLost.toFixed(1)),
          vmgMetersLost: Number(vmgMetersLost.toFixed(1)),
          recoveryDurationSec: Number(recoveryDuration.toFixed(1)),
          minStwKnots: Number(minSTW.toFixed(2)),
          maxStwKnots: Number(maxSTW.toFixed(2)),
          entryStwKnots: Number(snapshotEntrySTW.toFixed(2)),
          entryVmgKnots: Number(snapshotEntryVMG.toFixed(2)),
          maxVmgKnots: Number(maxVMG.toFixed(2)),
          overturnDegrees: Number(Math.max(0, maxOverturnTWA).toFixed(1)),
          deadZoneSec: Number(timeInDeadZone.toFixed(1))
        };

        logTackToDatabase(tackSummary);

        currentState = 'Straight';
        maneuverType = 'Straight';
        rollingHistory = [];
        emitDelta('performance.maneuver.state', 'Ready');
      }
    } else {
      emitDelta('performance.maneuver.type', 'Straight');
      emitDelta('performance.maneuver.state', currentState === 'Pending' ? 'InTurn' : 'Ready');
      emitDelta('performance.maneuver.liveStwKnots', Number(stwKnots.toFixed(2)));
      emitDelta('performance.maneuver.liveVmgKnots', Number(vmgKnots.toFixed(2)));
      emitDelta('performance.maneuver.liveAwaDegrees', Number(awaDeg.toFixed(1)));
    }
  }

  function logTackToDatabase(summary) {
    let db = performanceDatabase;
    db.totalTacksLogged++;

    // Calculate rolling mathematical cumulative averages
    let n = db.totalTacksLogged;
    if (n === 1) {
      db.averages = {
        metersLost: summary.metersLost,
        recoveryDurationSec: summary.recoveryDurationSec,
        minStwKnots: summary.minStwKnots
      };
    } else {
      db.averages.metersLost = Number(((db.averages.metersLost * (n - 1) + summary.metersLost) / n).toFixed(1));
      db.averages.recoveryDurationSec = Number(((db.averages.recoveryDurationSec * (n - 1) + summary.recoveryDurationSec) / n).toFixed(1));
      db.averages.minStwKnots = Number(((db.averages.minStwKnots * (n - 1) + summary.minStwKnots) / n).toFixed(2));
    }

    // Insert new tack into Top 10 list (sorted by lowest meters lost)
    db.topTenBests.push(summary);
    db.topTenBests.sort((a, b) => a.metersLost - b.metersLost);
    if (db.topTenBests.length > 10) {
      db.topTenBests.pop(); // Evict slow entries past index 10
    }

    saveHistoryDatabase();
    
    // Broadcast the full updated summary payload across Signal K so the webapp UI can print cards
    app.handleMessage(plugin.id, {
      updates: [{ values: [{ path: 'performance.maneuver.lastSummary', value: summary }] }]
    });
    app.handleMessage(plugin.id, {
      updates: [{ values: [{ path: 'performance.maneuver.database', value: db }] }]
    });
  }

  function emitDelta(path, value) {
    app.handleMessage(plugin.id, {
      updates: [{ values: [{ path: path, value: value }] }]
    });
  }

  plugin.stop = function () {
    if (simInterval) clearInterval(simInterval);
  };

  plugin.schema = {
    type: 'object',
    title: 'MAT 12.20 Performance Settings',
    properties: {
      orcUrl: { type: 'string', title: 'ORC Certificate Link' },
      targetSpeedKnots: { type: 'number', title: 'Manual Target Entry Speed (Knots)', default: 7.80 },
      recoveryThreshold: { type: 'number', title: 'Recovery Completion Threshold (%)', default: 95 }
    }
  };

  return plugin;
};