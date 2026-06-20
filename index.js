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
  
  let snapshotEntrySTW = 0; // knots
  let snapshotEntryVMG = 0; // knots
  let snapshotEntryTWA = 0; // degrees
  
  let minSTW = 99; let maxSTW = 0;
  let minVMG = 99; let maxVMG = 0;
  let maxOverturnTWA = 0; 
  let timeInDeadZone = 0; 

  let actualDistanceMeters = 0; let theoreticalDistanceMeters = 0;
  let actualVmgDistanceMeters = 0; let theoreticalVmgDistanceMeters = 0;
  let metersLostAccum = 0;

  // Live inputs (currentSTW is in m/s, others in radians or m/s as applicable)
  let currentSTW = 4.01;   
  let currentTWA = -0.698; 
  let currentAWA = -0.488; 
  let currentRudder = 0.0; 
  let currentTWS = 6.17;   // m/s

  let orcTargetSTW = 7.80; 

  let globalRecoveryMultiplier = 0.95;

  let lastAnalysisTime = Date.now();
  let lastDataTimestamp = 0; // updated when we receive valid data

  let performanceDatabase = {
    totalTacksLogged: 0,
    averages: { metersLost: 0, recoveryDurationSec: 0, minStwKnots: 0 },
    topTenBests: [] 
  };

  // --- Helpers ---
  const knotsToMS = k => Number(k) * 0.514444;
  const msToKnots = m => Number(m) * 1.943844492;
  const deg = r => Number(r) * 180 / Math.PI;

  function safeNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // Normalize radians to -PI..PI
  function normalizeRadians(a) {
    let v = Number(a);
    if (!Number.isFinite(v)) return null;
    while (v <= -Math.PI) v += 2 * Math.PI;
    while (v > Math.PI) v -= 2 * Math.PI;
    return v;
  }

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
    let twsKnots = msToKnots(currentTWS);
    try {
      let vpp = options.polarData;
      if (vpp.vmgUpwind && Array.isArray(vpp.vmgUpwind) && vpp.vmgUpwind.length) {
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

  // Note: This plugin must be agnostic to the data source. It should NOT run an internal simulation.
  // It processes whatever data arrives via app.subscriptionmanager (either instrument feeds or a separate sim plugin publishing the same paths).

  function startEngineLoop(recoveryMultiplier) {
    globalRecoveryMultiplier = recoveryMultiplier || 0.95;
    if (simInterval) clearInterval(simInterval);

    // Run analysis periodically but do NOT mutate current* variables here. The data must come from
    // the Signal K subscription (real instruments) or a separate sim plugin that publishes the same paths.
    lastAnalysisTime = Date.now();
    simInterval = setInterval(() => {
      try {
        runAnalysisPipeline(orcTargetSTW, globalRecoveryMultiplier);
      } catch (e) {
        app.error('Engine loop error: ' + e.message);
      }
    }, 200);
  }

  function runAnalysisPipeline(activeTargetSTW, recoveryMultiplier) {
    const now = Date.now();
    let dt = (now - lastAnalysisTime) / 1000.0;
    if (!Number.isFinite(dt) || dt <= 0) dt = 0.2; // fallback
    lastAnalysisTime = now;

    // If we haven't received fresh data recently, skip heavy computations
    if (!lastDataTimestamp || (now - lastDataTimestamp) > 2000) {
      // still emit state but mark as stale, include tack/angles for the UI
      const twaDeg = currentTWA * 180.0 / Math.PI;
      const awaDeg = currentAWA * 180.0 / Math.PI;
      const stwKnots = msToKnots(currentSTW);
      const tack = (awaDeg < 0) ? 'port' : 'starboard';
      emitDelta('performance.maneuver.state', { state: currentState, stale: true, stwKnots: Number(stwKnots.toFixed(3)), twaDeg: Number(twaDeg.toFixed(2)), awaDeg: Number(awaDeg.toFixed(2)), tack: tack });
      return;
    }

    // currentSTW is m/s -> convert to knots for comparisons where needed
    const stwKnots = msToKnots(currentSTW);
    const twaDeg = currentTWA * 180.0 / Math.PI;
    const awaDeg = currentAWA * 180.0 / Math.PI;
    const rudderDeg = currentRudder * 180.0 / Math.PI;

    const liveVmgMS = currentSTW * Math.cos(currentTWA); // m/s
    const vmgKnots = msToKnots(liveVmgMS);

    // Maintain rolling history for look-back snapshots
    if (currentState === 'Straight' || currentState === 'Pending') {
      rollingHistory.push({ stw: Number(stwKnots.toFixed(3)), vmg: Number(vmgKnots.toFixed(3)), twa: Number(twaDeg.toFixed(2)), ts: now });
      if (rollingHistory.length > BUFFER_SIZE) rollingHistory.shift();
    }

    // Entry detection
    if (currentState === 'Straight') {
      if (Math.abs(rudderDeg) > 5 && Math.abs(twaDeg) < 32) {
        currentState = 'Pending';
        pendingStartTime = now;
        let historicalBase = rollingHistory[0] || { stw: stwKnots, vmg: vmgKnots, twa: twaDeg };
        snapshotEntrySTW = historicalBase.stw; // knots
        snapshotEntryVMG = historicalBase.vmg; // knots
        snapshotEntryTWA = Math.abs(historicalBase.twa); // degrees
        maxOverturnTWA = 0;
        timeInDeadZone = 0;
        metersLostAccum = 0;
        actualDistanceMeters = 0; theoreticalDistanceMeters = 0;
        actualVmgDistanceMeters = 0; theoreticalVmgDistanceMeters = 0;
      }
    }

    // Pending logic: detect sign-cross of TWA
    if (currentState === 'Pending') {
      let timeInPending = (now - pendingStartTime) / 1000.0;
      // Use the previous sample (second-last) to detect a recent sign change rather than the oldest buffer entry
      let historyEntry = (rollingHistory.length >= 2) ? rollingHistory[rollingHistory.length - 2] : (rollingHistory[0] || { twa: twaDeg });
      let signChange = (historyEntry.twa < 0 && twaDeg > 0) || (historyEntry.twa > 0 && twaDeg < 0);

      if (signChange && Math.abs(twaDeg) < 15) {
        currentState = 'InTurn';
        maneuverType = 'Tack';
        startTime = now;
        minSTW = stwKnots; maxSTW = stwKnots;
        minVMG = vmgKnots; maxVMG = vmgKnots;
        // initialize integration accumulators already done at entry
      } else if (timeInPending > 10.0 || Math.abs(twaDeg) > 35) {
        currentState = 'Straight';
      }
    }

    // During InTurn/Recovery we integrate distance, VMG and track min/max
    if (currentState === 'InTurn' || currentState === 'Recovery') {
      // update min/max
      minSTW = Math.min(minSTW, stwKnots);
      maxSTW = Math.max(maxSTW, stwKnots);
      minVMG = Math.min(minVMG, vmgKnots);
      maxVMG = Math.max(maxVMG, vmgKnots);

      // update overturn: how much absolute TWA exceeded the original entry TWA (heuristic)
      const overturn = Math.max(0, Math.abs(twaDeg) - snapshotEntryTWA);
      if (overturn > maxOverturnTWA) maxOverturnTWA = overturn;

      // dead zone: when TWA under 20 degrees (sails luffing)
      if (Math.abs(twaDeg) < 20) timeInDeadZone += dt;

      // integrate actual and theoretical distances
      // actualDistanceMeters integrates the boat's forward distance (m)
      actualDistanceMeters += currentSTW * dt; // m/s * s = m
      // theoretical uses snapshot entry speed (knots -> m/s)
      theoreticalDistanceMeters += knotsToMS(snapshotEntrySTW) * dt;

      // VMG distance integration (component towards target)
      actualVmgDistanceMeters += liveVmgMS * dt;
      theoreticalVmgDistanceMeters += knotsToMS(snapshotEntryVMG) * Math.cos(snapshotEntryTWA * Math.PI / 180.0) * dt;

      // meters lost accumulation: difference between entry speed and live speed when slower
      const speedDeficitMS = Math.max(0, knotsToMS(snapshotEntrySTW) - currentSTW);
      metersLostAccum += speedDeficitMS * dt;

      // simplistic criteria to move to Recovery state
      if (currentState === 'InTurn') {
        if (Math.abs(twaDeg) < 10) {
          currentState = 'Recovery';
        }
      }

      // end recovery when STW reaches threshold
      if (currentState === 'Recovery' && stwKnots >= (snapshotEntrySTW * (recoveryMultiplier || globalRecoveryMultiplier))) {
        // compute summary with increased precision
        const metersLost = Number(Math.max(metersLostAccum, theoreticalDistanceMeters - actualDistanceMeters).toFixed(1));
        const summary = {
          type: maneuverType,
          timestamp: new Date().toISOString(),
          metersLost: metersLost,
          recoveryDurationSec: Number(((now - startTime) / 1000.0).toFixed(1)),
          minStwKnots: Number(minSTW.toFixed(2)),
          maxOverturnTWA: Number(maxOverturnTWA.toFixed(1)),
          timeInDeadZoneSec: Number(timeInDeadZone.toFixed(2)),
          actualDistanceMeters: Number(actualDistanceMeters.toFixed(2)),
          theoreticalDistanceMeters: Number(theoreticalDistanceMeters.toFixed(2)),
          actualVmgDistanceMeters: Number(actualVmgDistanceMeters.toFixed(2)),
          theoreticalVmgDistanceMeters: Number(theoreticalVmgDistanceMeters.toFixed(2))
        };
        logTackToDatabase(summary);
        // reset state
        currentState = 'Straight';
        maneuverType = 'Straight';
      }
    }

    // derive tack from apparent wind angle (AWA): negative = port, positive = starboard
    const tack = (awaDeg < 0) ? 'port' : 'starboard';

    // emit live metrics for UI, include tack and awaDeg so the dashboard can show correct side
    emitDelta('performance.maneuver.state', {
      state: currentState,
      stwKnots: Number(stwKnots.toFixed(3)),
      twaDeg: Number(twaDeg.toFixed(2)),
      awaDeg: Number(awaDeg.toFixed(2)),
      tack: tack,
      vmgKnots: Number(vmgKnots.toFixed(3)),
      metersLostAccum: Number(metersLostAccum.toFixed(2))
    });
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
              // Coerce to numbers and drop non-numeric values
              const v = safeNumber(kv.value);
              if (v === null) return;
              switch (kv.path) {
                case 'navigation.speedThroughWater':
                  currentSTW = v; // m/s
                  lastDataTimestamp = Date.now();
                  break;
                case 'environment.wind.angleTrueWater':
                  const twaN = normalizeRadians(v);
                  if (twaN === null) return;
                  currentTWA = twaN; // radians normalized
                  lastDataTimestamp = Date.now();
                  break;
                case 'environment.wind.angleApparent':
                  const awaN = normalizeRadians(v);
                  if (awaN === null) return;
                  currentAWA = awaN; // radians normalized
                  lastDataTimestamp = Date.now();
                  break;
                case 'steering.rudderAngle':
                  currentRudder = v; // radians
                  lastDataTimestamp = Date.now();
                  break;
                case 'environment.wind.speedTrue':
                  currentTWS = v; // m/s
                  lastDataTimestamp = Date.now();
                  resolveLivePolarTargets();
                  break;
                default:
                  break;
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
