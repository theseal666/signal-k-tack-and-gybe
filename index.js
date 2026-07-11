const fs = require('fs');
const path = require('path');

module.exports = function (app) {
  const plugin = {};
  let unsubscribes = [];
  let analysisInterval = null;
  let historyFilePath = '';

  plugin.id = 'signalk-tack-and-gybe';
  plugin.name = 'Tack and Gybe Analyzer';
  plugin.description = 'Detects and measures tacks and gybes, tracking metres lost, recovery time, and a persistent Top-10 leaderboard.';

  const BUFFER_SIZE = 50;
  let rollingHistory = [];

  let currentState = 'Straight';
  let maneuverType = 'Straight';
  let startTime = 0;
  let inTurnStartTime = 0; // gate to prevent instant InTurn→Recovery at sign-crossing
  let pendingStartTime = 0;

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

  // Live inputs — m/s or radians as per SignalK spec
  let currentSTW = 0;
  let currentTWA = 0;
  let currentAWA = 0;
  let currentRudder = 0;
  let currentTWS = 0;

  let cfg = {};

  let lastAnalysisTime = Date.now();
  let lastDataTimestamp = 0;

  function defaultDatabase() {
    return {
      tacks: { count: 0, averages: { metersLost: 0, recoveryDurationSec: 0, minStwKnots: 0 }, topTen: [] },
      gybes: { count: 0, averages: { metersLost: 0, recoveryDurationSec: 0, minStwKnots: 0 }, topTen: [] }
    };
  }
  let performanceDatabase = defaultDatabase();

  const knotsToMS = k => Number(k) * 0.514444;
  const msToKnots = m => Number(m) * 1.943844492;
  const lerp = (a, b, t) => a + (b - a) * t;

  function safeNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function normalizeRadians(a) {
    let v = Number(a);
    if (!Number.isFinite(v)) return null;
    while (v <= -Math.PI) v += 2 * Math.PI;
    while (v > Math.PI) v -= 2 * Math.PI;
    return v;
  }

  function loadHistoryDatabase() {
    try {
      if (historyFilePath && fs.existsSync(historyFilePath)) {
        const loaded = JSON.parse(fs.readFileSync(historyFilePath, 'utf8'));
        // Migrate old format (had totalTacksLogged/topTenBests) — can't split, start fresh
        if (loaded && loaded.tacks && loaded.gybes) {
          performanceDatabase = loaded;
        } else {
          app.debug('Old database format detected — starting fresh with split tack/gybe schema');
        }
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

  function emitDelta(skPath, value) {
    try {
      app.handleMessage(plugin.id, {
        updates: [{ values: [{ path: skPath, value: value }] }]
      });
    } catch (e) { /* non-fatal */ }
  }

  function logManeuver(summary) {
    const db = performanceDatabase;
    const cat = summary.type === 'Gybe' ? db.gybes : db.tacks;
    cat.count++;
    const n = cat.count;
    if (n === 1) {
      cat.averages = {
        metersLost: summary.metersLost,
        recoveryDurationSec: summary.recoveryDurationSec,
        minStwKnots: summary.minStwKnots
      };
    } else {
      cat.averages.metersLost =
        Number(((cat.averages.metersLost * (n - 1) + summary.metersLost) / n).toFixed(1));
      cat.averages.recoveryDurationSec =
        Number(((cat.averages.recoveryDurationSec * (n - 1) + summary.recoveryDurationSec) / n).toFixed(1));
      cat.averages.minStwKnots =
        Number(((cat.averages.minStwKnots * (n - 1) + summary.minStwKnots) / n).toFixed(2));
    }
    cat.topTen.push(summary);
    cat.topTen.sort((a, b) => a.metersLost - b.metersLost);
    if (cat.topTen.length > 10) cat.topTen.pop();
    saveHistoryDatabase();
    emitDelta('performance.maneuver.lastSummary', summary);
    emitDelta('performance.maneuver.database', db);
    app.setPluginStatus(
      `${db.tacks.count} tacks, ${db.gybes.count} gybes — last: ${summary.type} ${summary.metersLost} m lost, ${summary.recoveryDurationSec} s`
    );
  }

  // ── Simulation ─────────────────────────────────────────────────────────────
  // When cfg.simulate is true, this replaces the SK subscription.
  // Phases drive the same currentXxx variables that runAnalysis() reads.
  //
  // Full cycle (~46s):
  //   upwind-steady (4s) → tack-entry (0.5s) → tack-turn (2.5s) →
  //   tack-recovery (9s) → bear-away (2s) → downwind-steady (5s) →
  //   gybe-entry (0.5s) → gybe-turn (2.5s) → gybe-recovery (9s) →
  //   head-up (2s) → loop
  let simPhase = 'upwind-steady';
  let simPhaseStart = 0;

  function stepSimulation(now) {
    const ms = now - simPhaseStart;
    function next(p) { simPhase = p; simPhaseStart = now; }

    switch (simPhase) {
      case 'upwind-steady':
        // Starboard tack close-hauled: TWA ≈ −38° (port side)
        currentSTW = 3.86; currentTWA = -0.663; currentAWA = -0.576; currentRudder = 0;
        if (ms > 4000) next('tack-entry');
        break;

      case 'tack-entry':
        // Helm goes hard over
        currentRudder = -0.349;
        if (ms > 500) next('tack-turn');
        break;

      case 'tack-turn': {
        // TWA sweeps −38° → +38° through irons; speed drops to ≈2.5 kn
        const t = Math.min(1, ms / 2500);
        currentTWA = lerp(-0.663, 0.663, t);
        currentAWA = lerp(-0.576, 0.576, t);
        currentSTW = lerp(3.86, 1.29, t);
        currentRudder = -0.349;
        if (ms > 2500) next('tack-recovery');
        break;
      }

      case 'tack-recovery': {
        // Boat settled on new tack, rebuilding speed to 7.5 kn
        const t = Math.min(1, ms / 9000);
        currentSTW = lerp(1.29, 3.86, t);
        currentTWA = 0.663; currentAWA = 0.576; currentRudder = 0;
        if (ms > 9000) next('bear-away');
        break;
      }

      case 'bear-away': {
        // Head down from close-hauled to running (TWA +38° → +150°)
        const t = Math.min(1, ms / 2000);
        currentTWA = lerp(0.663, 2.618, t);
        currentAWA = lerp(0.576, 2.531, t);
        currentSTW = lerp(3.86, 4.63, t);
        currentRudder = 0;
        if (ms > 2000) next('downwind-steady');
        break;
      }

      case 'downwind-steady':
        // Port gybe run: TWA ≈ +150°
        currentSTW = 4.63; currentTWA = 2.618; currentAWA = 2.531; currentRudder = 0;
        if (ms > 5000) next('gybe-entry');
        break;

      case 'gybe-entry':
        // Helm over for gybe
        currentRudder = 0.349;
        if (ms > 500) next('gybe-turn');
        break;

      case 'gybe-turn': {
        // TWA sweeps +150° → +210° (wraps to −150° at the dead run crossing)
        const t = Math.min(1, ms / 2500);
        const twaDeg = lerp(150, 210, t);
        currentTWA = normalizeRadians(twaDeg * Math.PI / 180); // handles ±180° wrap
        currentAWA = normalizeRadians(twaDeg * 0.966 * Math.PI / 180);
        currentSTW = lerp(4.63, 1.54, t);
        currentRudder = 0.349;
        if (ms > 2500) next('gybe-recovery');
        break;
      }

      case 'gybe-recovery': {
        // Settled on new gybe, rebuilding to 9 kn
        const t = Math.min(1, ms / 9000);
        currentSTW = lerp(1.54, 4.63, t);
        currentTWA = -2.618; currentAWA = -2.531; currentRudder = 0;
        if (ms > 9000) next('head-up');
        break;
      }

      case 'head-up': {
        // Head up from run back to close-hauled on starboard tack
        const t = Math.min(1, ms / 2000);
        currentTWA = lerp(-2.618, -0.663, t);
        currentAWA = lerp(-2.531, -0.576, t);
        currentSTW = lerp(4.63, 3.86, t);
        currentRudder = 0;
        if (ms > 2000) next('upwind-steady');
        break;
      }
    }
    lastDataTimestamp = now;
  }

  // ── Analysis pipeline ───────────────────────────────────────────────────────
  function runAnalysis() {
    const now = Date.now();
    let dt = (now - lastAnalysisTime) / 1000.0;
    if (!Number.isFinite(dt) || dt <= 0) dt = 0.2;
    lastAnalysisTime = now;

    if (cfg.simulate) stepSimulation(now);

    const stwKnots = msToKnots(currentSTW);
    const twaDeg = currentTWA * 180.0 / Math.PI;
    const awaDeg = currentAWA * 180.0 / Math.PI;
    const rudderDeg = currentRudder * 180.0 / Math.PI;
    const liveVmgMS = currentSTW * Math.cos(currentTWA);
    const vmgKnots = msToKnots(liveVmgMS);
    const tack = awaDeg < 0 ? 'port' : 'starboard';

    // Emit a stale heartbeat when instruments have been quiet for > 2 s
    if (!lastDataTimestamp || (now - lastDataTimestamp) > 2000) {
      emitDelta('performance.maneuver.state', {
        state: currentState, stale: true,
        stwKnots: Number(stwKnots.toFixed(3)),
        twaDeg: Number(twaDeg.toFixed(2)),
        awaDeg: Number(awaDeg.toFixed(2)),
        tack
      });
      return;
    }

    // Maintain rolling pre-manoeuvre snapshot buffer
    if (currentState === 'Straight' || currentState === 'Pending') {
      rollingHistory.push({
        stw: Number(stwKnots.toFixed(3)),
        vmg: Number(vmgKnots.toFixed(3)),
        twa: Number(twaDeg.toFixed(2)),
        ts: now
      });
      if (rollingHistory.length > BUFFER_SIZE) rollingHistory.shift();
    }

    // ── Entry detection ──────────────────────────────────────────────────────
    // Tacks: upwind (|TWA| < 40°), gybes: downwind (|TWA| > 110°)
    if (currentState === 'Straight') {
      const isUpwind = Math.abs(twaDeg) < 40;
      const isDownwind = Math.abs(twaDeg) > 110;
      if (Math.abs(rudderDeg) > 5 && (isUpwind || isDownwind)) {
        currentState = 'Pending';
        pendingStartTime = now;
        // Most recent entry = true pre-manoeuvre state. [0] (oldest) could be from a previous leg.
        const base = rollingHistory[rollingHistory.length - 1] || { stw: stwKnots, vmg: vmgKnots, twa: twaDeg };
        snapshotEntrySTW = base.stw;
        snapshotEntryVMG = base.vmg;
        snapshotEntryTWA = Math.abs(base.twa);
        maxOverturnTWA = 0;
        timeInDeadZone = 0;
        metersLostAccum = 0;
        actualDistanceMeters = 0; theoreticalDistanceMeters = 0;
        actualVmgDistanceMeters = 0; theoreticalVmgDistanceMeters = 0;
      }
    }

    // ── Pending → InTurn: confirm the manoeuvre by a TWA sign change ─────────
    if (currentState === 'Pending') {
      const timeInPending = (now - pendingStartTime) / 1000.0;
      const prev = rollingHistory.length >= 2
        ? rollingHistory[rollingHistory.length - 2]
        : (rollingHistory[0] || { twa: twaDeg });
      const signChange = (prev.twa < 0 && twaDeg > 0) || (prev.twa > 0 && twaDeg < 0);

      if (signChange && Math.abs(twaDeg) < 20) {
        currentState = 'InTurn';
        maneuverType = 'Tack';
        startTime = now;
        inTurnStartTime = now;
        minSTW = stwKnots; maxSTW = stwKnots;
        minVMG = vmgKnots; maxVMG = vmgKnots;
      } else if (signChange && Math.abs(twaDeg) > 150) {
        currentState = 'InTurn';
        maneuverType = 'Gybe';
        startTime = now;
        inTurnStartTime = now;
        minSTW = stwKnots; maxSTW = stwKnots;
        minVMG = vmgKnots; maxVMG = vmgKnots;
      } else if (timeInPending > 10.0) {
        currentState = 'Straight'; // no committed crossing — cancel
      }
    }

    // ── InTurn / Recovery: integrate distances, track extremes ───────────────
    if (currentState === 'InTurn' || currentState === 'Recovery') {
      minSTW = Math.min(minSTW, stwKnots);
      maxSTW = Math.max(maxSTW, stwKnots);
      minVMG = Math.min(minVMG, vmgKnots);
      maxVMG = Math.max(maxVMG, vmgKnots);

      const overturn = Math.max(0, Math.abs(twaDeg) - snapshotEntryTWA);
      if (overturn > maxOverturnTWA) maxOverturnTWA = overturn;

      if (Math.abs(twaDeg) < 20) timeInDeadZone += dt;

      actualDistanceMeters += currentSTW * dt;
      theoreticalDistanceMeters += knotsToMS(snapshotEntrySTW) * dt;
      actualVmgDistanceMeters += liveVmgMS * dt;
      theoreticalVmgDistanceMeters +=
        knotsToMS(snapshotEntryVMG) * Math.cos(snapshotEntryTWA * Math.PI / 180.0) * dt;

      const speedDeficitMS = Math.max(0, knotsToMS(snapshotEntrySTW) - currentSTW);
      metersLostAccum += speedDeficitMS * dt;

      // InTurn → Recovery: boat has passed the apex and sails are filling.
      // Gate of 500 ms prevents a false transition at the exact sign-crossing tick
      // (where |TWA| would satisfy the condition immediately).
      if (currentState === 'InTurn' && (now - inTurnStartTime) > 500) {
        if (maneuverType === 'Tack' && Math.abs(twaDeg) > 15 && Math.abs(twaDeg) < 90) {
          // Sails filling on the new close-hauled course (past through-irons zone)
          currentState = 'Recovery';
        }
        if (maneuverType === 'Gybe' && Math.abs(twaDeg) < 170) {
          // Sails filling on the new gybe heading (past the dead-run zone)
          currentState = 'Recovery';
        }
      }

      // Recovery → Straight: boat is back up to target speed
      if (currentState === 'Recovery') {
        const targetKnots = maneuverType === 'Gybe'
          ? cfg.downwindTargetKnots
          : cfg.upwindTargetKnots;
        if (stwKnots >= targetKnots * cfg.recoveryMultiplier) {
          const metersLost = Number(
            Math.max(metersLostAccum, theoreticalDistanceMeters - actualDistanceMeters).toFixed(1)
          );
          logManeuver({
            type: maneuverType,
            timestamp: new Date().toISOString(),
            metersLost,
            recoveryDurationSec: Number(((now - startTime) / 1000.0).toFixed(1)),
            minStwKnots: Number(minSTW.toFixed(2)),
            maxStwKnots: Number(maxSTW.toFixed(2)),
            maxOverturnTWA: Number(maxOverturnTWA.toFixed(1)),
            timeInDeadZoneSec: Number(timeInDeadZone.toFixed(2)),
            actualDistanceMeters: Number(actualDistanceMeters.toFixed(2)),
            theoreticalDistanceMeters: Number(theoreticalDistanceMeters.toFixed(2)),
            actualVmgDistanceMeters: Number(actualVmgDistanceMeters.toFixed(2)),
            theoreticalVmgDistanceMeters: Number(theoreticalVmgDistanceMeters.toFixed(2))
          });
          currentState = 'Straight';
          maneuverType = 'Straight';
        }
      }
    }

    // COG: in sim assume wind FROM 180° (south), so COG = (TWA_deg + 360) % 360.
    // In real mode, COG comes from instruments via navigation.courseOverGroundTrue.
    const cogDeg = cfg.simulate
      ? ((twaDeg + 360) % 360)
      : null;

    emitDelta('performance.maneuver.state', {
      state: currentState,
      stwKnots: Number(stwKnots.toFixed(3)),
      twaDeg: Number(twaDeg.toFixed(2)),
      awaDeg: Number(awaDeg.toFixed(2)),
      rudderDeg: Number(rudderDeg.toFixed(1)),
      cogDeg: cogDeg !== null ? Number(cogDeg.toFixed(1)) : null,
      tack,
      vmgKnots: Number(vmgKnots.toFixed(3)),
      metersLostAccum: Number(metersLostAccum.toFixed(2))
    });
  }

  // ── Plugin lifecycle ────────────────────────────────────────────────────────
  plugin.start = function (startOptions) {
    const options = startOptions || {};
    const configDir = (app.getDataDirPath && app.getDataDirPath()) || '.';
    historyFilePath = path.join(configDir, 'tack-history.json');
    loadHistoryDatabase();

    cfg = {
      upwindTargetKnots: options.upwindTargetKnots || 7.5,
      downwindTargetKnots: options.downwindTargetKnots || 9.0,
      recoveryMultiplier: (options.recoveryThreshold || 95) / 100,
      simulate: options.simulate === true,
    };

    if (cfg.simulate) {
      simPhase = 'upwind-steady';
      simPhaseStart = Date.now();
      app.setPluginStatus('SIMULATION mode — watch the dashboard for tacks and gybes');
    } else {
      app.setPluginStatus('Running — waiting for manoeuvres');
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
        app.subscriptionmanager.subscribe(
          localSub,
          unsubscribes,
          err => app.error('Instrumentation binding error: ' + err),
          delta => {
            if (!delta || !delta.updates) return;
            delta.updates.forEach(update => {
              if (!update.values) return;
              update.values.forEach(kv => {
                const v = safeNumber(kv.value);
                if (v === null) return;
                switch (kv.path) {
                  case 'navigation.speedThroughWater':
                    currentSTW = v; lastDataTimestamp = Date.now(); break;
                  case 'environment.wind.angleTrueWater': {
                    const n = normalizeRadians(v);
                    if (n !== null) { currentTWA = n; lastDataTimestamp = Date.now(); }
                    break;
                  }
                  case 'environment.wind.angleApparent': {
                    const n = normalizeRadians(v);
                    if (n !== null) { currentAWA = n; lastDataTimestamp = Date.now(); }
                    break;
                  }
                  case 'steering.rudderAngle':
                    currentRudder = v; lastDataTimestamp = Date.now(); break;
                  case 'environment.wind.speedTrue':
                  currentTWS = v; lastDataTimestamp = Date.now(); break;
                // COG is read by the dashboard directly via its own WS subscription
                }
              });
            });
          }
        );
      } catch (e) {
        app.error('Failed to subscribe to instrument feeds: ' + e.message);
      }
    }

    if (analysisInterval) clearInterval(analysisInterval);
    lastAnalysisTime = Date.now();
    analysisInterval = setInterval(() => {
      try { runAnalysis(); } catch (e) { app.error('Analysis loop error: ' + e.message); }
    }, 200);
  };

  plugin.stop = function () {
    try {
      unsubscribes.forEach(u => { try { u(); } catch (e) {} });
      unsubscribes = [];
      if (analysisInterval) { clearInterval(analysisInterval); analysisInterval = null; }
      saveHistoryDatabase();
      app.setPluginStatus('Stopped');
    } catch (e) {
      app.error('Error while stopping plugin: ' + e.message);
    }
  };

  plugin.schema = {
    type: 'object',
    properties: {
      upwindTargetKnots: {
        type: 'number',
        title: 'Upwind target boatspeed (knots)',
        description: 'Target STW for upwind sailing. Tack recovery is complete when STW reaches this × recovery threshold.',
        default: 7.5
      },
      downwindTargetKnots: {
        type: 'number',
        title: 'Downwind target boatspeed (knots)',
        description: 'Target STW for downwind sailing. Gybe recovery is complete when STW reaches this × recovery threshold.',
        default: 9.0
      },
      recoveryThreshold: {
        type: 'number',
        title: 'Recovery threshold (%)',
        description: 'Percentage of target speed at which the manoeuvre is considered recovered (default 95 = 95% of target).',
        default: 95
      },
      simulate: {
        type: 'boolean',
        title: 'Simulation mode',
        description: 'Play back a synthetic tack + gybe sequence (~46 s loop) for testing the dashboard without real instruments. Disable before sailing.',
        default: false
      }
    }
  };

  return plugin;
};
