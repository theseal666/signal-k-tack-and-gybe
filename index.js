const fs = require('fs');
const path = require('path');

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
  let currentTWS = 6.17;   

  let orcTargetSTW = 7.80; 

  let simStep = 0;
  let isManeuvering = false;

  let performanceDatabase = {
    totalTacksLogged: 0,
    averages: { metersLost: 0, recoveryDurationSec: 0, minStwKnots: 0 },
    topTenBests: [] 
  };

  plugin.start = function (startOptions, restartPlugin) {
    options = startOptions || {};
    
    const configDir = app.getDataDirPath();
    historyFilePath = path.join(configDir, 'tack-history.json');
    loadHistoryDatabase();

    if (options.orcUrl) {
      fetchOrcPolarTargets(options.orcUrl);
    } else {
      orcTargetSTW = options.targetSpeedKnots || 7.80;
    }

    // --- FIX: Derive the dynamic multiplier from user settings ---
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

    app.subscriptionmanager.subscribe(
      localSub,
      unsubscribes,
      subscriptionError => { app.error('H5000 instrumentation binding error: ' + subscriptionError); },
      delta => {
        delta.updates.forEach(update => {
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

    startEngineLoop(recoveryMultiplier);
  };

  // ... [Keep existing fetchOrcPolarTargets, resolveLivePolarTargets, loadHistoryDatabase, saveHistoryDatabase, startEngineLoop, executeSimulationPhysics as they are] ...
  
  // NOTE: For the functions above, keep your existing logic exactly as it is in your current file.

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
      // ... [Keep your existing physics calculations] ...
      
      // --- FIX: Use the dynamic recoveryMultiplier here ---
      if (currentState === 'Recovery' && stwKnots >= (snapshotEntrySTW * recoveryMultiplier)) {
         // ... [Your existing logic to end the maneuver] ...
      }
    }
  }

  // ... [Keep emitDelta, logTackToDatabase, plugin.stop, plugin.schema as they are] ...
  return plugin;
};