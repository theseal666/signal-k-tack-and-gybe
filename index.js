const fs = require('fs');
const path = require('path');
const axios = require('axios'); // network lookups

module.exports = function (app) {
  const plugin = {};
  let unsubscribes = [];
  let analysisInterval = null;
  let options = {};

  let historyFilePath = '';

  plugin.id = 'signal-k-tack-and-gybe';
  plugin.name = 'Tack and Gybe Performance Analyzer';
  plugin.description = 'Advanced performance logger with persistent Top 10 database, rolling historical buffer, and automatic ORC Polar integrations.';

  const BUFFER_SIZE = 120; // keep more points for timeline
  let rollingHistory = [];

  // runtime state
  let currentState = 'Straight'; // Straight | Pending | InTurn | Recovery
  let maneuverType = 'Straight';

  // timestamps
  let entryTimestamp = null; // ms
  let inTurnTimestamp = null;
  let recoveryStartTimestamp = null;

  // candidate/pending timers for hysteresis
  let candidatePendingSince = null; // when a potential turn was first detected
  let pendingSince = null; // actual Pending enter time
  let recoveryConfirmSince = null; // when recovery condition first met

  // snapshot entry values (knots/degrees)
  let snapshotEntrySTW = null; // knots
  let snapshotEntryVMG = null; // knots
  let snapshotEntryAWA = null; // degrees (abs off wind)

  // running stats
  let minSTW = 999, maxSTW = 0;
  let minVMG = 999, maxVMG = -999;
  let maxOverturnTWA = 0;
  let timeInDeadZone = 0; // seconds

  // integrators (meters)
  let actualDistanceMeters = 0;
  let theoreticalDistanceMeters = 0;
  let actualVmgDistanceMeters = 0;
  let theoreticalVmgDistanceMeters = 0;
  let metersLostAccum = 0;

  // last received inputs (from subscriptions)
  let currentSTW = 0; // m/s
  let currentTWA = 0; // radians
  let currentAWA = 0; // radians
  let currentRudder = 0; // radians
  let currentTWS = 0; // m/s

  // ORC / targets
  let orcTargetSTW = 7.8; // knots fallback
  let globalRecoveryMultiplier = 0.95;

  let lastAnalysisTime = Date.now();
  let lastDataTimestamp = 0;

  let performanceDatabase = {
    totalTacksLogged: 0,
    averages: { metersLost: 0, recoveryDurationSec: 0, minStwKnots: 0 },
    topTenBests: []
  };

  // helpers
  const knotsToMS = k => Number(k) * 0.514444;
  const msToKnots = m => Number(m) * 1.943844492;
  const deg = r => Number(r) * 180 / Math.PI;

  function safeNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // load/save DB
  function loadHistoryDatabase() {
    try {
      if (historyFilePath && fs.existsSync(historyFilePath)) {
        const fileData = fs.readFileSync(historyFilePath, 'utf8');
        const parsed = JSON.parse(fileData);
        if (parsed && typeof parsed === 'object') performanceDatabase = parsed;
      }
    } catch (e) { app.error('Failed to parse history database: ' + e.message); }
  }

  function saveHistoryDatabase() {
    try {
      if (!historyFilePath) return;
      fs.writeFileSync(historyFilePath, JSON.stringify(performanceDatabase, null, 2), 'utf8');
    } catch (e) { app.error('Failed to write history database: ' + e.message); }
  }

  async function fetchOrcPolarTargets(url) {
    try {
      app.debug(`Querying ORC database for polar: ${url}`);
      const response = await axios.get(url, { timeout: 5000 });
      if (response.data && response.data.rms) {
        options.polarData = response.data.rms;
        resolveLivePolarTargets();
        app.debug('ORC polar data loaded.');
      }
    } catch (err) {
      app.error('ORC API retrieval failed: ' + (err && err.message));
      orcTargetSTW = options.targetSpeedKnots || orcTargetSTW;
    }
  }

  function resolveLivePolarTargets() {
    if (!options.polarData) return;
    try {
      const twsKnots = msToKnots(currentTWS);
      const vpp = options.polarData;
      if (vpp && vpp.vmgUpwind && vpp.vmgUpwind.length) {
        const target = vpp.vmgUpwind.find(item => twsKnots <= item.tws) || vpp.vmgUpwind[vpp.vmgUpwind.length - 1];
        if (target) orcTargetSTW = target.vboat || options.targetSpeedKnots || orcTargetSTW;
      }
    } catch (e) { app.error('Error resolving ORC polar: ' + e.message); }
  }

  function emitDelta(path, value) {
    try {
      app.handleMessage(plugin.id, { updates: [{ values: [{ path, value }] }] });
    } catch (e) { /* non-fatal */ }
  }

  function persistSummary(summary) {
    // push summary to DB and write file
    let db = performanceDatabase;
    db.totalTacksLogged = (db.totalTacksLogged || 0) + 1;
    const n = db.totalTacksLogged;
    if (n === 1) {
      db.averages = { metersLost: summary.metersLost, recoveryDurationSec: summary.recoveryDurationSec, minStwKnots: summary.minStwKnots };
    } else {
      db.averages.metersLost = Number(((db.averages.metersLost * (n - 1) + summary.metersLost) / n).toFixed(1));
      db.averages.recoveryDurationSec = Number(((db.averages.recoveryDurationSec * (n - 1) + summary.recoveryDurationSec) / n).toFixed(1));
      db.averages.minStwKnots = Number(((db.averages.minStwKnots * (n - 1) + summary.minStwKnots) / n).toFixed(2));
    }
    db.topTenBests = db.topTenBests || [];
    db.topTenBests.push(summary);
    db.topTenBests.sort((a, b) => (a.metersLost - b.metersLost));
    if (db.topTenBests.length > 10) db.topTenBests.pop();
    saveHistoryDatabase();

    // emit both summary and database
    emitDelta('performance.maneuver.lastSummary', summary);
    emitDelta('performance.maneuver.database', db);
  }

  // Maneuver snapshot helper
  function makeSnapshot(ts, stw_ms, twa_rad, awa_rad) {
    const stw_k = msToKnots(stw_ms);
    const twa_deg = deg(twa_rad);
    const awa_deg = Math.abs(deg(awa_rad));
    const vmg_ms = stw_ms * Math.cos(Math.abs(twa_rad));
    const vmg_k = msToKnots(vmg_ms);
    return { ts, stw_ms, stw_k: Number(stw_k.toFixed(3)), twa_deg: Number(twa_deg.toFixed(2)), awa_deg: Number(awa_deg.toFixed(2)), vmg_ms, vmg_k: Number(vmg_k.toFixed(3)) };
  }

  // Engine: runs analysis frequently and manages state machine and integrators
  function startEngineLoop(recoveryMultiplier) {
    globalRecoveryMultiplier = recoveryMultiplier || globalRecoveryMultiplier;
    if (analysisInterval) clearInterval(analysisInterval);
    lastAnalysisTime = Date.now();
    analysisInterval = setInterval(() => {
      try { runAnalysisPipeline(globalRecoveryMultiplier); } catch (e) { app.error('Engine loop error: ' + (e && e.message)); }
    }, 200);
  }

  // State machine parameters (tweakable)
  const CFG = {
    turnStartDeltaDeg: 5, // minimal steering induced AWA/TWA change to consider starting a turn
    pendingConfirmSec: 0.6, // require sustained condition before entering Pending
    pendingMaxSec: 10,
    crossThresholdDeg: 15, // threshold near 0deg to consider crossing
    crossConfirmSec: 0.2, // require short confirmation for crossing
    settleAngleDeg: 8, // considered settled on new tack
    recoveryThreshold: 0.95, // fraction of entry STW to consider recovered
    recoveryConfirmSec: 1.0, // require sustained recovery speed
    deadZoneDeg: 20,
    minSpeedKnots: 0.5,
    minInturnSec: 0.8, // require at least this long in InTurn before settling
    maxManeuverSec: 300
  };

  // runtime maneuver buffer (snapshots)
  let maneuverSnapshots = [];

  function resetManeuverState() {
    entryTimestamp = null; inTurnTimestamp = null; recoveryStartTimestamp = null;
    candidatePendingSince = null; pendingSince = null; recoveryConfirmSince = null;
    snapshotEntrySTW = null; snapshotEntryVMG = null; snapshotEntryAWA = null;
    minSTW = 999; maxSTW = 0; minVMG = 999; maxVMG = -999; maxOverturnTWA = 0; timeInDeadZone = 0;
    actualDistanceMeters = 0; theoreticalDistanceMeters = 0; actualVmgDistanceMeters = 0; theoreticalVmgDistanceMeters = 0; metersLostAccum = 0;
    maneuverSnapshots = [];
  }

  function runAnalysisPipeline(recoveryMultiplier) {
    const now = Date.now();
    let dt = (now - lastAnalysisTime) / 1000.0;
    if (!Number.isFinite(dt) || dt <= 0) dt = 0.2;
    lastAnalysisTime = now;

    // if no recent data, emit stale state and return
    if (!lastDataTimestamp || (now - lastDataTimestamp) > 3000) {
      emitDelta('performance.maneuver.state', { state: currentState, stale: true });
      return;
    }

    // compute current live metrics
    const stw_ms = currentSTW;
    const stw_kn = msToKnots(stw_ms);
    const twa_deg = deg(currentTWA);
    const awa_deg = Math.abs(deg(currentAWA));
    const vmg_ms = stw_ms * Math.cos(Math.abs(currentTWA));
    const vmg_kn = msToKnots(vmg_ms);

    // push to rolling history
    rollingHistory.push({ ts: now, stw_kn: Number(stw_kn.toFixed(3)), vmg_kn: Number(vmg_kn.toFixed(3)), twa_deg: Number(twa_deg.toFixed(2)) });
    if (rollingHistory.length > BUFFER_SIZE) rollingHistory.shift();

    // ENTRY detection: from Straight -> Pending with hysteresis
    if (currentState === 'Straight') {
      const recent = rollingHistory[Math.max(0, rollingHistory.length - 1)] || { stw_kn, vmg_kn, twa_deg };
      const rudderDeg = Math.abs(deg(currentRudder));
      const twaDelta = Math.abs(twa_deg - (recent.twa_deg || twa_deg));
      const candidate = ((rudderDeg > 6) || (twaDelta > CFG.turnStartDeltaDeg)) && stw_kn >= CFG.minSpeedKnots;

      if (candidate) {
        if (!candidatePendingSince) candidatePendingSince = now;
        const elapsed = (now - candidatePendingSince) / 1000.0;
        if (elapsed >= CFG.pendingConfirmSec) {
          // enter Pending
          currentState = 'Pending';
          entryTimestamp = now;
          pendingSince = now;
          // snapshot base from an earlier point in history (a few samples back)
          const baseIdx = Math.max(0, rollingHistory.length - 6);
          const base = rollingHistory[baseIdx] || recent;
          snapshotEntrySTW = base.stw_kn;
          snapshotEntryVMG = base.vmg_kn;
          snapshotEntryAWA = Math.abs(base.twa_deg);
          maneuverSnapshots = [];
          minSTW = stw_kn; maxSTW = stw_kn; minVMG = vmg_kn; maxVMG = vmg_kn; maxOverturnTWA = 0; timeInDeadZone = 0;
          actualDistanceMeters = 0; theoreticalDistanceMeters = 0; actualVmgDistanceMeters = 0; theoreticalVmgDistanceMeters = 0; metersLostAccum = 0;
        }
      } else {
        candidatePendingSince = null; // reset candidate
      }
    }

    // PENDING -> InTurn detection (require short confirmation)
    if (currentState === 'Pending') {
      const timeInPending = (now - (pendingSince || entryTimestamp || now)) / 1000.0;
      const oldest = rollingHistory[0] || { twa_deg };
      const signChange = (oldest.twa_deg < 0 && twa_deg > 0) || (oldest.twa_deg > 0 && twa_deg < 0);
      const crossing = signChange || Math.abs(twa_deg) < CFG.crossThresholdDeg;

      if (crossing) {
        // short confirmation window
        if (!inTurnTimestamp) inTurnTimestamp = now; // reuse as confirm timer
        const crossedFor = (now - inTurnTimestamp) / 1000.0;
        if (crossedFor >= CFG.crossConfirmSec) {
          currentState = 'InTurn';
          maneuverType = 'Tack';
          // ensure snapshotEntry values initialized
          if (!snapshotEntrySTW) snapshotEntrySTW = stw_kn;
          if (!snapshotEntryVMG) snapshotEntryVMG = vmg_kn;
          // set inTurnTimestamp properly
          inTurnTimestamp = now;
        }
      } else {
        // not crossing yet - if pending takes too long abort
        inTurnTimestamp = null;
        if (timeInPending > CFG.pendingMaxSec || Math.abs(twa_deg) > 60) {
          currentState = 'Straight';
          resetManeuverState();
        }
      }
    }

    // INTURN / RECOVERY processing: integrate and watch for recovery
    if (currentState === 'InTurn' || currentState === 'Recovery') {
      // update stats
      minSTW = Math.min(minSTW, stw_kn); maxSTW = Math.max(maxSTW, stw_kn);
      minVMG = Math.min(minVMG, vmg_kn); maxVMG = Math.max(maxVMG, vmg_kn);
      const overturn = Math.max(0, Math.abs(twa_deg) - (snapshotEntryAWA || 0));
      if (overturn > maxOverturnTWA) maxOverturnTWA = overturn;
      if (awa_deg < CFG.deadZoneDeg) timeInDeadZone += dt;

      // integrate distances
      actualDistanceMeters += stw_ms * dt;
      theoreticalDistanceMeters += knotsToMS(snapshotEntrySTW || stw_kn) * dt;
      actualVmgDistanceMeters += vmg_ms * dt;
      theoreticalVmgDistanceMeters += knotsToMS(snapshotEntryVMG || vmg_kn) * dt;
      metersLostAccum += Math.max(0, knotsToMS(snapshotEntrySTW || stw_kn) - stw_ms) * dt;

      // push snapshot for trace / debug
      maneuverSnapshots.push(makeSnapshot(now, stw_ms, currentTWA, currentAWA));

      // transition InTurn -> Recovery: when AWA settles away from crossing (within settleAngleDeg)
      if (currentState === 'InTurn') {
        const settled = Math.abs(twa_deg) > CFG.settleAngleDeg && (Date.now() - inTurnTimestamp) / 1000.0 > CFG.minInturnSec;
        if (settled) {
          currentState = 'Recovery';
          recoveryStartTimestamp = Date.now();
          recoveryConfirmSince = null;
        }
      }

      // transition Recovery -> Straight when STW reaches threshold, require sustained condition
      if (currentState === 'Recovery') {
        const recoveredNow = stw_kn >= (snapshotEntrySTW * (recoveryMultiplier || globalRecoveryMultiplier));
        if (recoveredNow) {
          if (!recoveryConfirmSince) recoveryConfirmSince = now;
          const held = (now - recoveryConfirmSince) / 1000.0 >= CFG.recoveryConfirmSec;
          if (held) {
            const totalDuration = Number(((now - (inTurnTimestamp || entryTimestamp || now)) / 1000.0).toFixed(1));
            const metersLost = Number(Math.max(metersLostAccum, theoreticalDistanceMeters - actualDistanceMeters).toFixed(1));

            const summary = {
              type: maneuverType,
              timestamp: new Date().toISOString(),
              durationSec: totalDuration,
              metersLost: metersLost,
              recoveryDurationSec: Number(((now - (inTurnTimestamp || entryTimestamp)) / 1000.0).toFixed(1)),
              minStwKnots: Number(minSTW.toFixed(2)),
              maxStwKnots: Number(maxSTW.toFixed(2)),
              minVmgKnots: Number(minVMG.toFixed(3)),
              maxVmgKnots: Number(maxVMG.toFixed(3)),
              maxOverturnTWA: Number(maxOverturnTWA.toFixed(1)),
              timeInDeadZoneSec: Number(timeInDeadZone.toFixed(2)),
              actualDistanceMeters: Number(actualDistanceMeters.toFixed(2)),
              theoreticalDistanceMeters: Number(theoreticalDistanceMeters.toFixed(2)),
              actualVmgDistanceMeters: Number(actualVmgDistanceMeters.toFixed(2)),
              theoreticalVmgDistanceMeters: Number(theoreticalVmgDistanceMeters.toFixed(2)),
              samples: maneuverSnapshots.length
            };

            persistSummary(summary);

            // reset to Straight and keep rolling history
            currentState = 'Straight';
            maneuverType = 'Straight';
            resetManeuverState();
          }
        } else {
          recoveryConfirmSince = null; // reset if condition lost
          const elapsed = (now - (inTurnTimestamp || entryTimestamp || now)) / 1000.0;
          if (elapsed > CFG.maxManeuverSec) {
            // timeout: finalize anyway
            const totalDuration = Number(((now - (inTurnTimestamp || entryTimestamp || now)) / 1000.0).toFixed(1));
            const metersLost = Number(Math.max(metersLostAccum, theoreticalDistanceMeters - actualDistanceMeters).toFixed(1));
            const summary = { type: maneuverType, timestamp: new Date().toISOString(), durationSec: totalDuration, metersLost: metersLost, recoveryDurationSec: Number(((now - (inTurnTimestamp || entryTimestamp)) / 1000.0).toFixed(1)), minStwKnots: Number(minSTW.toFixed(2)), maxStwKnots: Number(maxSTW.toFixed(2)), minVmgKnots: Number(minVMG.toFixed(3)), maxVmgKnots: Number(maxVMG.toFixed(3)), maxOverturnTWA: Number(maxOverturnTWA.toFixed(1)), timeInDeadZoneSec: Number(timeInDeadZone.toFixed(2)), actualDistanceMeters: Number(actualDistanceMeters.toFixed(2)), theoreticalDistanceMeters: Number(theoreticalDistanceMeters.toFixed(2)), actualVmgDistanceMeters: Number(actualVmgDistanceMeters.toFixed(2)), theoreticalVmgDistanceMeters: Number(theoreticalVmgDistanceMeters.toFixed(2)), samples: maneuverSnapshots.length };
            persistSummary(summary);
            currentState = 'Straight'; maneuverType = 'Straight'; resetManeuverState();
          }
        }
      }
    }

    // emit live state and metrics for the UI (knots/degrees)
    emitDelta('performance.maneuver.state', {
      state: currentState,
      stwKnots: Number(msToKnots(currentSTW).toFixed(3)),
      twaDeg: Number(deg(currentTWA).toFixed(2)),
      vmgKnots: Number(msToKnots(currentSTW * Math.cos(Math.abs(currentTWA))).toFixed(3)),
      metersLostAccum: Number(metersLostAccum.toFixed(2))
    });
  }

  // --- Plugin life-cycle ---
  plugin.start = function (startOptions, restartPlugin) {
    options = startOptions || {};
    const configDir = (app.getDataDirPath && app.getDataDirPath()) || '.';
    historyFilePath = path.join(configDir, 'tack-history.json');
    loadHistoryDatabase();

    if (options.orcUrl) fetchOrcPolarTargets(options.orcUrl);
    else orcTargetSTW = options.targetSpeedKnots || orcTargetSTW;

    const thresholdPercent = options.recoveryThreshold || 95;
    const recoveryMultiplier = thresholdPercent / 100;

    const localSub = {
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
      app.subscriptionmanager.subscribe(localSub, unsubscribes, err => { if (err) app.error('Subscription error: ' + err); }, delta => {
        if (!delta || !delta.updates) return;
        delta.updates.forEach(update => {
          if (!update.values) return;
          update.values.forEach(kv => {
            // For instrument feeds we expect numeric values per path
            const vnum = safeNumber(kv.value);
            if (vnum === null) return;
            switch (kv.path) {
              case 'navigation.speedThroughWater': currentSTW = vnum; lastDataTimestamp = Date.now(); break; // m/s
              case 'environment.wind.angleTrueWater': currentTWA = vnum; lastDataTimestamp = Date.now(); break; // rad
              case 'environment.wind.angleApparent': currentAWA = vnum; lastDataTimestamp = Date.now(); break; // rad
              case 'steering.rudderAngle': currentRudder = vnum; lastDataTimestamp = Date.now(); break; // rad
              case 'environment.wind.speedTrue': currentTWS = vnum; lastDataTimestamp = Date.now(); resolveLivePolarTargets(); break; // m/s
              default: break;
            }
          });
        });
      });
    } catch (e) { app.error('Failed to subscribe: ' + (e && e.message)); }

    startEngineLoop(recoveryMultiplier);
  };

  plugin.stop = function () {
    try {
      if (unsubscribes && unsubscribes.length) unsubscribes.forEach(u => { try { u(); } catch (e) {} });
      unsubscribes = [];
      if (analysisInterval) clearInterval(analysisInterval);
      analysisInterval = null;
      saveHistoryDatabase();
    } catch (e) { app.error('Error while stopping plugin: ' + (e && e.message)); }
  };

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
