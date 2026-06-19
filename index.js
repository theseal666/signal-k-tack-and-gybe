module.exports = function (app) {
  const plugin = {};
  let unsubscribes = [];
  let simInterval = null;
  let options = {};

  plugin.id = 'signal-k-tack-and-gybe';
  plugin.name = 'Tack and Gybe Performance Analyzer';
  plugin.description = 'H5000 rolling-buffer analyzer capturing historical pre-tack entry data using TWA, STW, and Rudder.';

  // --- Real-Data Historical Memory Configuration ---
  const BUFFER_SIZE = 50; // 5 seconds of rolling history at 10Hz (100ms ticks)
  let rollingHistory = [];
  
  // State variables
  let currentState = 'Straight'; // Straight, Pending, InTurn, Recovery
  let maneuverType = 'Straight';
  let startTime = 0;
  let pendingStartTime = 0;
  
  // Historical Snapshots taken BEFORE the tack is confirmed
  let snapshotEntrySTW = 0;
  let snapshotEntryVMG = 0;
  
  let minSTW = 99;
  let maxSTW = 0;
  let minVMG = 99;
  let maxVMG = 0;

  let actualDistanceMeters = 0;
  let theoreticalDistanceMeters = 0;
  let actualVmgDistanceMeters = 0;
  let theoreticalVmgDistanceMeters = 0;

  // --- Live Sensor Caches ---
  let currentSTW = 4.01;   // m/s
  let currentTWA = -0.698; // Radians (-40 deg)
  let currentAWA = -0.488; // Radians
  let currentRudder = 0.0; // Radians

  // Simulation variables
  let simStep = 0;
  let isManeuvering = false;

  plugin.start = function (startOptions, restartPlugin) {
    options = startOptions || {};
    app.debug('MAT 12.20 H5000 Engine Active with Look-Back Memory.');
    
    let targetSTW = options.targetSpeedKnots || 7.80; 
    let thresholdPercent = options.recoveryThreshold || 95;
    let recoveryMultiplier = thresholdPercent / 100;

    // Run execution loop at 10Hz (100ms) to match high-frequency H5000 telemetry
    startEngineLoop(targetSTW, recoveryMultiplier);
  };

  function startEngineLoop(targetEntrySTW, recoveryMultiplier) {
    if (simInterval) clearInterval(simInterval);
    
    simInterval = setInterval(() => {
      // --- SIMULATOR PHYSICS ENGINE ---
      // Simulates real telemetry behavior including rudder movements
      if (!isManeuvering && Math.random() < 0.005) {
        isManeuvering = true;
        simStep = 0;
      }

      if (isManeuvering) {
        simStep++;
        if (simStep <= 15) {
          // Pre-Turn Entry Phase: Helmsman pulls rudder up to 8 degrees, pinching up slightly
          currentRudder = (8 * Math.PI / 180) * (simStep / 15);
          let twaDeg = -40 + (12 * (simStep / 15)); // Pinches from -40 down to -28
          currentTWA = twaDeg * Math.PI / 180;
          currentAWA = (twaDeg * 0.7) * Math.PI / 180;
          currentSTW = (targetEntrySTW - (0.4 * (simStep / 15))) / 1.94384; 
        }
        else if (simStep <= 50) {
          // Hard Turn Phase: Crossing the wind (Steps 16-50)
          currentRudder = 12 * Math.PI / 180; // Hard over
          let progress = (simStep - 15) / 35;
          let twaDeg = -28 + (68 * progress); // Sweeps through 0 up to +40
          currentTWA = twaDeg * Math.PI / 180;
          currentAWA = (twaDeg * 0.7) * Math.PI / 180;

          let speedFactor = 0.95 - (0.45 * Math.sin(progress * Math.PI / 2));
          currentSTW = (targetEntrySTW * speedFactor) / 1.94384;
        }
        else if (simStep <= 220) {
          // Acceleration Phase
          currentRudder = -2 * Math.PI / 180; // Counter rudder to straighten out
          currentTWA = 40 * Math.PI / 180;
          currentAWA = 28 * Math.PI / 180;
          let accelProgress = (simStep - 50) / 170;
          let speedFactor = 0.50 + (0.50 * Math.sqrt(accelProgress));
          currentSTW = (targetEntrySTW * speedFactor) / 1.94384;
        }
        else {
          isManeuvering = false;
          currentRudder = 0;
        }
      } else { 
        // Baseline Sailing Data
        currentTWA = -40 * Math.PI / 180;
        currentAWA = -28 * Math.PI / 180;
        currentSTW = targetEntrySTW / 1.94384; 
        currentRudder = 0.0;
      }

      // Execute analytical pipeline
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

    // Maintain the Rolling Memory Buffer while sailing normally
    if (currentState === 'Straight' || currentState === 'Pending') {
      rollingHistory.push({ stw: stwKnots, vmg: vmgKnots, twa: twaDeg });
      if (rollingHistory.length > BUFFER_SIZE) {
        rollingHistory.shift(); // Evict oldest data to maintain a strict 5-second window
      }
    }

    // --- CRITERIA STAGE 1: ENTRY PHASE DETECTION (PENDING) ---
    if (currentState === 'Straight') {
      // Trigger pending status if rudder is turned (>5°) AND boat pinches above 32° TWA
      if (Math.abs(rudderDeg) > 5 && Math.abs(twaDeg) < 32) {
        currentState = 'Pending';
        pendingStartTime = Date.now();
        
        // Lock in historical performance snapshots from 5 seconds ago!
        let historicalBase = rollingHistory[0] || { stw: stwKnots, vmg: vmgKnots };
        snapshotEntrySTW = historicalBase.stw;
        snapshotEntryVMG = historicalBase.vmg;
      }
    }

    // --- CRITERIA STAGE 2: PASS THROUGH THE WIND TRIGGER (CONFIRMED) ---
    if (currentState === 'Pending') {
      let timeInPending = (Date.now() - pendingStartTime) / 1000;
      
      // Look back at the oldest index in our buffer to verify a sign change relative to the wind
      let historyEntry = rollingHistory[0] || { twa: twaDeg };
      let signChange = (historyEntry.twa < 0 && twaDeg > 0) || (historyEntry.twa > 0 && twaDeg < 0);

      if (signChange && Math.abs(twaDeg) < 15) {
        // Boat has officially crossed the wind window! Confirm the tack
        currentState = 'InTurn';
        maneuverType = 'Tack';
        startTime = Date.now();
        
        minSTW = stwKnots; maxSTW = stwKnots;
        minVMG = vmgKnots; maxVMG = vmgKnots;
        
        actualDistanceMeters = 0;
        theoreticalDistanceMeters = 0;
        actualVmgDistanceMeters = 0;
        theoreticalVmgDistanceMeters = 0;
      } 
      // Safe-Luff Timeout: Reset if the boat stays in pending over 10s without crossing through the wind
      else if (timeInPending > 10.0 || Math.abs(twaDeg) > 35) {
        currentState = 'Straight';
      }
    }

    // --- CRITERIA STAGE 3: METRIC ANALYSIS & RECOVERY ---
    if (currentState === 'InTurn' || currentState === 'Recovery') {
      let timeElapsedSec = (Date.now() - startTime) / 1000;

      if (stwKnots < minSTW) minSTW = stwKnots;
      if (stwKnots > maxSTW) maxSTW = stwKnots;
      if (vmgKnots < minVMG) minVMG = vmgKnots;
      if (vmgKnots > maxVMG) maxVMG = vmgKnots;

      // Integrate lost distance dynamically relative to frozen historical baseline entries
      actualDistanceMeters += (currentSTW * 0.1);
      theoreticalDistanceMeters += ((snapshotEntrySTW / 1.94384) * 0.1); 
      
      actualVmgDistanceMeters += (liveVmgMS * 0.1);
      theoreticalVmgDistanceMeters += ((snapshotEntryVMG / 1.94384) * 0.1);

      let metersLost = theoreticalDistanceMeters - actualDistanceMeters;
      let vmgMetersLost = theoreticalVmgDistanceMeters - actualVmgDistanceMeters;

      if (currentState === 'InTurn' && Math.abs(twaDeg) > 22) {
        currentState = 'Recovery';
      }

      emitDelta('performance.maneuver.type', maneuverType);
      emitDelta('performance.maneuver.state', currentState);
      emitDelta('performance.maneuver.timeElapsed', Number(timeElapsedSec.toFixed(1)));
      emitDelta('performance.maneuver.liveStwKnots', Number(stwKnots.toFixed(2)));
      emitDelta('performance.maneuver.liveVmgKnots', Number(vmgKnots.toFixed(2)));
      emitDelta('performance.maneuver.metersLost', Number(metersLost.toFixed(1)));
      emitDelta('performance.maneuver.vmgMetersLost', Number(vmgMetersLost.toFixed(1)));
      emitDelta('performance.maneuver.minStwKnots', Number(minSTW.toFixed(2)));
      emitDelta('performance.maneuver.liveAwaDegrees', Number(awaDeg.toFixed(1)));

      // Recovery exit condition mapped directly to snapshot history targets
      if (currentState === 'Recovery' && stwKnots >= (snapshotEntrySTW * recoveryMultiplier)) {
        currentState = 'Straight';
        maneuverType = 'Straight';
        rollingHistory = []; // Flush buffer to handle clean tracking reset
        emitDelta('performance.maneuver.state', 'Ready');
      }
    } else {
      // Default Streaming State
      emitDelta('performance.maneuver.type', 'Straight');
      emitDelta('performance.maneuver.state', currentState === 'Pending' ? 'InTurn' : 'Ready');
      emitDelta('performance.maneuver.liveStwKnots', Number(stwKnots.toFixed(2)));
      emitDelta('performance.maneuver.liveVmgKnots', Number(vmgKnots.toFixed(2)));
      emitDelta('performance.maneuver.liveAwaDegrees', Number(awaDeg.toFixed(1)));
    }
  }

  function emitDelta(path, value) {
    app.handleMessage(plugin.id, {
      updates: [{ values: [{ path: path, value: value }] }]
    });
  }

  plugin.stop = function () {
    if (simInterval) clearInterval(simInterval);
    app.debug('Plugin stopped');
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