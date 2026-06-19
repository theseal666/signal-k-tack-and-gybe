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
    app.debug('MAT 12.20 Performance Engine Active with Fixed Physics.');
    
    let targetSTW = options.targetSpeedKnots || 7.80; // Adjusted standard target for tight upwind target
    let thresholdPercent = options.recoveryThreshold || 95;
    let recoveryMultiplier = thresholdPercent / 100;

    startSimulator(targetSTW, recoveryMultiplier);
  };

  // --- Live Sensor Telemetry Cache ---
  let currentSTW = 4.01;  // ~7.8 knots base
  let currentTWA = -0.698; // -40 degrees upwind (Port Tack Entry)
  let currentAWA = -0.488; // ~ -28 degrees Apparent

  // --- Tracking State Machine ---
  let currentState = 'Straight'; 
  let maneuverType = 'None';
  let startTime = 0;
  
  let entrySTW = 0;
  let minSTW = 99;
  let maxSTW = 0;
  let minVMG = 99; 
  let maxVMG = 0;

  let actualDistanceMeters = 0;
  let theoreticalDistanceMeters = 0;
  let actualVmgDistanceMeters = 0;
  let theoreticalVmgDistanceMeters = 0;

  let simStep = 0;
  let isManeuvering = false;

  function startSimulator(targetEntrySTW, recoveryMultiplier) {
    if (simInterval) clearInterval(simInterval);
    
    simInterval = setInterval(() => {
      // Trigger a tack every 35 seconds automatically
      if (!isManeuvering && Math.random() < 0.005) {
        isManeuvering = true;
        simStep = 0;
      }

      if (isManeuvering) {
        simStep++;
        
        // Phase 1: The Turn (6 seconds / 60 steps)
        if (simStep <= 60) {
          let progress = simStep / 60;
          // Smoothly sweep True Wind Angle from -40° (Port) to +40° (Starboard)
          let twaDeg = -40 + (80 * progress);
          currentTWA = twaDeg * Math.PI / 180;
          currentAWA = (twaDeg * 0.7) * Math.PI / 180; // AWA tightly follows TWA ahead of hull

          // Smooth parabolic speed drop: Speed bottoms out perfectly at step 35 (Head to wind)
          let dropFactor = Math.pow((simStep - 35) / 35, 2);
          if (simStep > 35) dropFactor = Math.pow((simStep - 35) / 25, 2); // Smooth asymmetry 
          
          let knots = (targetEntrySTW * 0.50) + ((targetEntrySTW * 0.50) * dropFactor);
          currentSTW = knots / 1.94384;
        } 
        // Phase 2: Post-Tack Acceleration Curve (16 seconds / 160 steps)
        else if (simStep <= 220) {
          // Settled on new Starboard Upwind angle (+40° TWA)
          currentTWA = 40 * Math.PI / 180;
          currentAWA = 28 * Math.PI / 180;
          
          let accelProgress = (simStep - 60) / 160;
          // Logarithmic acceleration profile up from the apex minimum
          let knots = (targetEntrySTW * 0.50) + ((targetEntrySTW * 0.50) * Math.sqrt(accelProgress));
          currentSTW = knots / 1.94384;
        } 
        else {
          isManeuvering = false;
        }
      } else { 
        // Baseline Sailing: Clean Port Tack Upwind (TWA: -40°, AWA: -28°)
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
    
    // Core VMG formula relative to wind direction: VMG = STW * cos(TWA)
    let liveVmgMS = currentSTW * Math.cos(currentTWA);
    let vmgKnots = liveVmgMS * 1.94384;
    
    // Expected Target VMG based on your entry target criteria
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

      // Transition turn phase to recovery phase once boat swings through past 25 degrees on new tack
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