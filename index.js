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

  // --- Helper Functions (Defined in scope) ---
  function loadHistoryDatabase() {
    try {
      if (fs.existsSync(historyFilePath)) {
        const fileData = fs.readFileSync(historyFilePath, 'utf8');
        performanceDatabase = JSON.parse(fileData);
      }
    } catch (e) {
      app.error('Failed to parse history database: ' + e.message);
    }
  }

  function saveHistoryDatabase() {
    try {
      fs.writeFileSync(historyFilePath, JSON.stringify(performanceDatabase, null, 2), 'utf8');
    } catch (e) {
      app.error('Failed to write history database: ' + e.message);
    }
  }

  async function fetchOrcPolarTargets(url) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const data = await response.json();
      if (data && data.rms) {
        options.polarData = data.rms;
        resolveLivePolarTargets();
      }
    } catch (err) {
      app.error('ORC API retrieval failed: ' + err.message);
      orcTargetSTW = options.targetSpeedKnots || 7.80;
    }
  }

  function resolveLivePolarTargets() {
    if (!options.polarData) return;
    let twsKnots = currentTWS * 1.94384;
    try {
      let vpp = options.polarData;
      if (vpp.vmgUpwind && Array.isArray(vpp.vmgUpwind)) {
        let target = vpp.vmgUpwind.find(item => twsKnots <= item.tws);
        if (target) orcTargetSTW = target.vboat || options.targetSpeedKnots;
      }
    } catch (e) { app.error('Error resolving ORC polar matrix: ' + e.message); }
  }

  function emitDelta(path, value) {
    app.handleMessage(plugin.id, {
      updates: [{ values: [{ path: path, value: value }] }]
    });
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
    app.handleMessage(plugin.id, { updates: [{ values: [{ path: 'performance.maneuver.lastSummary', value: summary }] }] });
  }

  // --- Plugin Methods ---
  plugin.start = function (startOptions, restartPlugin) {
    options = startOptions || {};
    const configDir = app.getDataDirPath();
    historyFilePath = path.join(configDir, 'tack-history.json');
    loadHistoryDatabase();

    if (options.orcUrl) fetchOrcPolarTargets(options.orcUrl);
    else orcTargetSTW = options.targetSpeedKnots || 7.80;

    let recoveryMultiplier = (options.recoveryThreshold || 95) / 100;

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

    app.subscriptionmanager.subscribe(localSub, unsubscribes, (err) => app.error(err), delta => {
      delta.updates.forEach(update => {
        update.values.forEach(kv => {
          if (kv.path === 'navigation.speedThroughWater') currentSTW = kv.value;
          if (kv.path === 'environment.wind.angleTrueWater') currentTWA = kv.value;
          if (kv.path === 'environment.wind.angleApparent') currentAWA = kv.value;
          if (kv.path === 'steering.rudderAngle') currentRudder = kv.value;
          if (kv.path === 'environment.wind.speedTrue') { currentTWS = kv.value; resolveLivePolarTargets(); }
        });
      });
    });

    if (simInterval) clearInterval(simInterval);
    simInterval = setInterval(() => {
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

      if (currentState === 'Straight' && Math.abs(rudderDeg) > 5 && Math.abs(twaDeg) < 32) {
        currentState = 'Pending';
        pendingStartTime = Date.now();
        let hist = rollingHistory[0] || { stw: stwKnots, vmg: vmgKnots, twa: twaDeg };
        snapshotEntrySTW = hist.stw; snapshotEntryVMG = hist.vmg; snapshotEntryTWA = Math.abs(hist.twa);
      }

      if (currentState === 'Pending') {
        let historyEntry = rollingHistory[0] || { twa: twaDeg };
        if (((historyEntry.twa < 0 && twaDeg > 0) || (historyEntry.twa > 0 && twaDeg < 0)) && Math.abs(twaDeg) < 15) {
          currentState = 'InTurn'; maneuverType = 'Tack'; startTime = Date.now();
        } else if ((Date.now() - pendingStartTime) / 1000 > 10 || Math.abs(twaDeg) > 35) currentState = 'Straight';
      }

      if (currentState === 'InTurn' || currentState === 'Recovery') {
        if (currentState === 'InTurn' && Math.abs(twaDeg) > 22) { currentState = 'Recovery'; accelerationStartTime = Date.now(); }
        if (currentState === 'Recovery' && stwKnots >= (snapshotEntrySTW * recoveryMultiplier)) {
          logTackToDatabase({ timestamp: new Date().toISOString(), metersLost: 0, recoveryDurationSec: (Date.now() - accelerationStartTime) / 1000, minStwKnots: 0 });
          currentState = 'Straight';
        }
      }
      emitDelta('performance.maneuver.state', currentState);
    }, 100);
  };

  plugin.stop = function () { if (simInterval) clearInterval(simInterval); unsubscribes.forEach(f => f()); };

  plugin.schema = {
    type: 'object',
    title: 'Performance Settings',
    properties: {
      orcUrl: { type: 'string', title: 'ORC JSON Link' },
      targetSpeedKnots: { type: 'number', title: 'Backup Target Speed', default: 7.80 },
      recoveryThreshold: { type: 'number', title: 'Recovery Threshold (%)', default: 95 }
    }
  };

  return plugin;
};