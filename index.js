module.exports = function (app) {
  const plugin = {};
  let unsubscribes = [];
  let simInterval = null;
  let options = {};

  plugin.id = 'signal-k-tack-and-gybe';
  plugin.name = 'Tack and Gybe Performance Analyzer';
  plugin.description = 'ORC-aligned performance analyzer tracking advanced STW, VMG, and AWA metrics.';

  plugin.start = function (startOptions, restartPlugin) {
    options = startOptions || {};
    app.debug('MAT 12.20 Performance Engine Active with Seamless Simulation Physics.');
    
    let targetSTW = options.targetSpeedKnots || 7.80; 
    let thresholdPercent = options.recoveryThreshold || 95;
    let recoveryMultiplier = thresholdPercent / 100;

    startSimulator(targetSTW, recoveryMultiplier);
  };

  // --- Live Sensor Telemetry Cache ---
  let currentSTW = 4.01;   // Base speed in m/s (~7.8 knots)
  let currentTWA = -0.698; // -40 degrees upwind (Port Tack Entry)
  let currentAWA = -0.488; // ~ -28 degrees Apparent Wind Angle

  // --- Tracking State Machine ---
  let currentState = 'Straight'; 
  let maneuverType = 'None';
  let startTime = 0;
  
  let entrySTW = 0;
  let minSTW = 99;
  let maxSTW = 0;
  let minVMG = 99; 
  let maxVMG = 0;

  // Tracking Integrators
  let actualDistanceMeters = 0;
  let theoreticalDistanceMeters = 0;
  let actualVmgDistanceMeters = 0;
  let theoreticalVmgDistanceMeters = 0;

  let simStep = 0;
  let isManeuvering = false;

  function startSimulator(targetEntrySTW, recoveryMultiplier) {
    if (simInterval) clearInterval(simInterval);
    
    simInterval = setInterval(() => {
      // Fire an analytical test tack roughly every 35-40 seconds
      if (!isManeuvering && Math.random() < 0.005) {
        isManeuvering = true;
        simStep = 0;
      }

      if (isManeuvering) {
        simStep++;
        
        // PHASE 1: Nosing into the wind & losing speed (Steps 1-35 / Head-to-wind apex)
        if (simStep <= 35) {
          let progress = simStep / 35;
          
          // Sweep TWA smoothly from -40° (Port) up to 0° (Head to wind)
          let twaDeg = -40 + (40 * progress);
          currentTWA = twaDeg * Math.PI / 180;
          currentAWA = (twaDeg * 0.7) * Math.PI / 180;

          // Parabolic deceleration down to exactly 50% of target speed at the apex
          let speedFactor = 1.0 - (0.50 * Math.sin(progress * Math.PI / 2));
          let knots = targetEntrySTW * speedFactor;
          currentSTW = knots / 1.94384;
        } 
        // PHASE 2: Bearing away & accelerating on the new tack (Steps 36-220)
        else if (simStep <= 220) {
          let accelProgress = (simStep - 35) / (220 - 35); 
          
          // Bear away to the new Starboard Upwind angle (+40° TWA) quickly over the first few seconds
          let angleProgress = Math.min(1, (simStep - 35) / 25); 
          let twaDeg = 40 * angleProgress;
          currentTWA = twaDeg * Math.PI / 180;
          currentAWA = (twaDeg * 0.7) * Math.PI / 180;
          
          // Logarithmic acceleration profile scaling smoothly from 50% up to 100% target speed
          let speedFactor = 0.50 + (0.50 * Math.sqrt(accelProgress));
          let knots = targetEntrySTW * speedFactor;
          currentSTW = knots / 1.94384;
        } 
        else {
          isManeuvering = false;
        }
      } else { 
        // Baseline State: Static Port Tack Upwind (TWA: -40°, AWA: -28°)
        currentTWA = -40 * Math.PI / 180;
        currentAWA = -28 * Math.PI / 180;
        currentSTW = targetEntrySTW / 1.94384; 
      }

      runAnalysisEngine(targetEntrySTW, recoveryMultiplier);
    }, 100);
  }

  function runAnalysisEngine(targetEntrySTW, recoveryMultiplier) {
    let stwKnots = currentSTW * 1.94384;
    let twaDeg = currentTWA * 180 / Math.PI;
    let awaDeg = currentAWA * 180 / Math.PI;
    
    // VMG Equation: VMG = STW * cos(TWA)
    let liveVmgMS = currentSTW * Math.cos(currentTWA);
    let vmgKnots = liveVmgMS * 1.94384;
    
    // Baseline reference Upwind VMG
    let targetVmgKnots = targetEntrySTW * Math.cos(40 * Math.PI / 180);

    if (currentState === 'Straight') {
      if (Math.abs(twaDeg) < 20 && isManeuvering) {
        currentState = 'InTurn';
        maneuverType = 'Tack';
        startTime = Date.now();
        
        entrySTW = stwKnots;
        minSTW = stwKnots;
        maxSTW = stwKnots;
        minVMG = vmgKnots;
        maxVMG = vmgKnots;
        
        actualDistanceMeters = 0;
        theoreticalDistanceMeters = 0;
        actualVmgDistanceMeters = 0;
        theoreticalVmgDistanceMeters = 0;
      }
    }

    if (currentState === 'InTurn' || currentState === 'Recovery') {
      let timeElapsedSec = (Date.now() - startTime) / 1000;

      if (stwKnots < minSTW) minSTW = stwKnots;
      if (stwKnots > maxSTW) maxSTW = stwKnots;
      if (vmgKnots < minVMG) minVMG = vmgKnots;
      if (vmgKnots > maxVMG) maxVMG = vmgKnots;

      actualDistanceMeters += (currentSTW * 0.1);
      theoreticalDistanceMeters += ((targetEntrySTW / 1.94384) * 0.1); 
      
      actualVmgDistanceMeters += (liveVmgMS * 0.1);
      theoreticalVmgDistanceMeters += ((targetVmgKnots / 1.94384) * 0.1);

      let metersLost = theoreticalDistanceMeters - actualDistanceMeters;
      let vmgMetersLost = theoreticalVmgDistanceMeters - actualVmgDistanceMeters;

      // Transition to recovery status once past 25 degrees on the new board
      if (currentState === 'InTurn' && twaDeg > 25) {
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

      if (currentState === 'Recovery' && stwKnots >= (targetEntrySTW * recoveryMultiplier)) {
        currentState = 'Straight';
        maneuverType = 'Straight';
        emitDelta('performance.maneuver.state', 'Ready');
      }
    } else {
      emitDelta('performance.maneuver.type', 'Straight');
      emitDelta('performance.maneuver.state', 'Ready');
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