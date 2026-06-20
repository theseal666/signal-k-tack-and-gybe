const fs = require('fs');
const path = require('path');
const axios = require('axios'); // Ensure axios is available for network lookups

module.exports = function (app) {
  const plugin = {};
  let unsubscribes = [];
  let simInterval = null;
  let options = {};
  
  let historyFilePath = '';

  plugin.id = 'signal-k-tack-and-gybe';
  plugin.name = 'Tack and Gybe Performance Analyzer';
  plugin.description = 'Advanced performance logger with persistent Top 10 database, rolling historical buffer, and automatic ORC Polar integrations.';

  const BUFFER_SIZE = 50; 
  let rollingHistory = [];
  
  let currentState = 'Straight'; 
  let maneuverType = 'Straight';
  let startTime = 0;
  let pendingStartTime = 0;
  let accelerationStartTime = 0; 
  
  let snapshotEntrySTW = 0;
  let snapshotEntryVMG = 0;
  let snapshotEntryTWA = 0;
  
  let minSTW = 99; let maxSTW = 0;
  let minVMG = 99; let maxVMG = 0;
  let maxOverturnTWA = 0; 
  let timeInDeadZone = 0; 

  let actualDistanceMeters = 0; let theoreticalDistanceMeters = 0;
  let actualVmgDistanceMeters = 0; let theoreticalVmgDistanceMeters = 0;

  let currentSTW = 4.01;   
  let currentTWA = -0.698; 
  let currentAWA = -0.488; 
  let currentRudder = 0.0; 
  let currentTWS = 6.17;   // Default 12 knots true wind speed for polar resolution

  let orcTargetSTW = 7.80; 

  let simStep = 0;
  let isManeuvering = false;

  let globalRecoveryMultiplier = 0.95;

  let performanceDatabase = {
    totalTacksLogged: 0,
    averages: { metersLost: 0, recoveryDurationSec: 0, minStwKnots: 0 },
    topTenBests: [] 
  };

  // Load/Save history
  function loadHistoryDatabase() {
    try {
      if (historyFilePath && fs.existsSync(historyFilePath)) {
        const fileData = fs.readFileSync(historyFilePath, 'utf8');
        performanceDatabase = JSON.parse(fileData);
      }
    } catch (e) {
      app.error('Failed to parse history database: ' + e.message);
    }
  }

  function saveHistoryDatabase() {
    try {
      if (!historyFilePath) return;
      fs.writeFileSync(historyFilePath, JSON.stringify(performanceDatabase, null, 2), 'utf8');
    } catch (e) {
      app.error('Failed to write history database: ' + e.message);
    }
  }

  // Fetch ORC polar targets using axios with timeout
  async function fetchOrcPolarTargets(url) {
    try {
      app.debug(`Querying ORC database for certificate profiles: ${url}`);
      const response = await axios.get(url, { timeout: 5000 });
      if (response.data && response.data.rms) {
        options.polarData = response.data.rms;
        resolveLivePolarTargets();
        app.debug('ORC polar data curves populated successfully.');
      }
    } catch (err) {
      app.error('ORC API retrieval failed, defaulting to backup parameters: ' + (err && err.message));
      orcTargetSTW = options.targetSpeedKnots || 7.80;
    }
  }

  function resolveLivePolarTargets() {
    if (!options.polarData) return;
    let twsKnots = currentTWS * 1.94384;
    try {
      let vpp = options.polarData;
      if (vpp.vmgUpwind && Array.isArray(vpp.vmgUpwind)) {
        // Find first item where twsKnots <= item.tws, fallback to last
        let target = vpp.vmgUpwind.find(item => twsKnots <= item.tws) || vpp.vmgUpwind[vpp.vmgUpwind.length - 1];
        if (target) orcTargetSTW = target.vboat || options.targetSpeedKnots || orcTargetSTW;
      }
    } catch (e) { app.error('Error resolving ORC polar matrix: ' + e.message); }
  }

  function emitDelta(path, value) {
    try {
      app.handleMessage(plugin.id, {
        updates: [{ values: [{ path: path, value: value }] }]
      });
    } catch (e) { /* non-fatal */ }
  }

  function logTackToDatabase(summary) {
    let db = performanceDatabase;
    db.totalTacksLogged++;
    let n = db.totalTacksLogged;
    if (n === 1) {
      db.averages = { metersLost: summary.metersLost, recoveryDurationSec: summary.recoveryDurationSec, minStwKnots: summary.minStwKnots };
    } else {
      db.averages.metersLost = Number(((db.averages.metersLost * (n - 1) + summary.metersLost) / n).toFixed(1));
      db.averages.recoveryDurationSec = Number(((db.averages.recoveryDurationSec * (n - 1) + summary.recoveryDurationSec) / n).toFixed(1));
      db.averages.minStwKnots = Number(((db.averages.minStwKnots * (n - 1) + summary.minStwKnots) / n).toFixed(2));
    }
    db.topTenBests.push(summary);
    db.topTenBests.sort((a, b) => a.metersLost - b.metersLost);
    if (db.topTenBests.length > 10) db.topTenBests.pop();
    saveHistoryDatabase();
    emitDelta('performance.maneuver.lastSummary', summary);
  }

  // Simple simulation physics to keep the analyzer live when no instrument data present
  function executeSimulationPhysics() {
    // A lightweight simulation that varies TWA and STW to stimulate state changes
    simStep++;
    const wobble = Math.sin(simStep / 10) * 0.2;
    currentRudder = Math.sin(simStep / 8) * 0.1;
    currentTWA = -0.5 + wobble; // radians
    currentAWA = currentTWA - 0.1;
    currentSTW = 4.0 + Math.abs(Math.cos(simStep / 15)) * 1.5;
    // call analysis
    runAnalysisPipeline(orcTargetSTW, globalRecoveryMultiplier);
  }

  function startEngineLoop(recoveryMultiplier) {
    globalRecoveryMultiplier = recoveryMultiplier || 0.95;
    if (simInterval) clearInterval(simInterval);

    simInterval = setInterval(() => {
      // If no subscriptions are active, run the simulator loop to feed the analyzer
      if (unsubscribes.length === 0) {
        executeSimulationPhysics();
      } else {
        // If we have live data, still run analysis periodically
        runAnalysisPipeline(orcTargetSTW, globalRecoveryMultiplier);
      }
    }, 200);
  }

  function runAnalysisPipeline(activeTargetSTW, recoveryMultiplier) {
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
      } else if (timeInPending > 10.0 || Math.abs(twaDeg) > 35) {
        currentState = 'Straight';
      }
    }

    if (currentState === 'InTurn' || currentState === 'Recovery') {
      // update min/max
      minSTW = Math.min(minSTW, stwKnots);
      maxSTW = Math.max(maxSTW, stwKnots);
      minVMG = Math.min(minVMG, vmgKnots);
      maxVMG = Math.max(maxVMG, vmgKnots);

      // simplistic criteria to move to Recovery state
      if (currentState === 'InTurn') {
        if (Math.abs(twaDeg) < 10) {
          currentState = 'Recovery';
        }
      }

      // end recovery when STW reaches threshold
      if (currentState === 'Recovery' && stwKnots >= (snapshotEntrySTW * (recoveryMultiplier || globalRecoveryMultiplier))) {
        // compute summary
        let summary = {
          type: maneuverType,
          timestamp: new Date().toISOString(),
          metersLost: Number(((snapshotEntrySTW - minSTW) * 10).toFixed(1)), // placeholder calc
          recoveryDurationSec: Math.round((Date.now() - startTime) / 1000),
          minStwKnots: Number(minSTW.toFixed(2))
        };
        logTackToDatabase(summary);
        // reset state
        currentState = 'Straight';
        maneuverType = 'Straight';
      }
    }

    // emit some live deltas for debugging/visibility
    emitDelta('performance.maneuver.state', { state: currentState, stwKnots: Number(stwKnots.toFixed(2)), twaDeg: Number(twaDeg.toFixed(1)) });
  }

  // --- Plugin Methods ---
  plugin.start = function (startOptions, restartPlugin) {
    options = startOptions || {};
    const configDir = (app.getDataDirPath && app.getDataDirPath()) || '.';
    historyFilePath = path.join(configDir, 'tack-history.json');
    loadHistoryDatabase();

    if (options.orcUrl) {
      fetchOrcPolarTargets(options.orcUrl);
    } else {
      orcTargetSTW = options.targetSpeedKnots || orcTargetSTW;
    }

    // Derive the dynamic multiplier from user settings
    let thresholdPercent = options.recoveryThreshold || 95;
    let recoveryMultiplier = thresholdPercent / 100;

    let localSub = {
      context: 'vessels.self',
      subscribe: [
        { path: 'navigation.speedThroughWater', period: 100 },
        { path: 'environment.wind.angleTrueWater', period: 100 },
        { path: 'environment.wind.angleApparent', period: 100 },
        { path: 'steering.rudderAngle', period: 100 },
        { path: 'environment.wind.speedTrue', period: 500 }
      ]
    };

    try {
      app.subscriptionmanager.subscribe(
        localSub,
        unsubscribes,
        subscriptionError => { app.error('Instrumentation binding error: ' + subscriptionError); },
        delta => {
          if (!delta || !delta.updates) return;
          delta.updates.forEach(update => {
            if (!update.values) return;
            update.values.forEach(kv => {
              if (kv.path === 'navigation.speedThroughWater') currentSTW = kv.value;
              if (kv.path === 'environment.wind.angleTrueWater') currentTWA = kv.value;
              if (kv.path === 'environment.wind.angleApparent') currentAWA = kv.value;
              if (kv.path === 'steering.rudderAngle') currentRudder = kv.value;
              if (kv.path === 'environment.wind.speedTrue') {
                currentTWS = kv.value;
                resolveLivePolarTargets(); 
              }
            });
          });
        }
      );
    } catch (e) {
      app.error('Failed to subscribe to instrument feeds: ' + e.message);
    }

    startEngineLoop(recoveryMultiplier);
  };

  plugin.stop = function () {
    try {
      if (unsubscribes && unsubscribes.length) {
        unsubscribes.forEach(u => { try { u(); } catch (e) {} });
        unsubscribes = [];
      }
      if (simInterval) clearInterval(simInterval);
      simInterval = null;
      saveHistoryDatabase();
    } catch (e) {
      app.error('Error while stopping plugin: ' + e.message);
    }
  };

  plugin.id = plugin.id || 'signal-k-tack-and-gybe';

  plugin.schema = {
    type: 'object',
    properties: {
      orcUrl: { type: 'string' },
      targetSpeedKnots: { type: 'number' },
      recoveryThreshold: { type: 'number' }
    }
  };

  return plugin;
};
