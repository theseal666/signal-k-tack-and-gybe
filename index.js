module.exports = function (app) {
  const plugin = {};
  let unsubscribes = [];
  let simInterval = null;

  plugin.id = 'signal-k-tack-and-gybe';
  plugin.name = 'Tack and Gybe Performance Analyzer';
  plugin.description = 'Analyzes maneuver performance metrics including VMG and meters lost.';

  plugin.start = function (options, restartPlugin) {
    app.debug('Advanced Performance Tracking Mode Activated.');
    startSimulator();
  };

  // --- Real-time telemetry cache ---
  let currentSTW = 4.37; // m/s
  let currentTWA = -0.698; // rad
  let currentAWA = -0.523; // rad (Simulated Apparent Wind Angle)

  // --- State Machine Variables ---
  let currentState = 'Straight'; // 'Straight', 'InTurn', 'Recovery'
  let maneuverType = 'None';
  let startTime = 0;
  
  // Tracking Metrics
  let entrySTW = 0;
  let entryVMG = 0;
  let minSTW = 99;
  let minVMG = 99;
  let maxSTW = 0;
  let maxVMG = 0;

  // Integral accumulators for distance lost
  let actualDistanceMeters = 0;
  let theoreticalDistanceMeters = 0;

  // --- Simulator Variables ---
  let simStep = 0;
  let isManeuvering = false;

  function startSimulator() {
    simInterval = setInterval(() => {
      // Automate a tack trigger
      if (!isManeuvering && Math.random() < 0.005) {
        isManeuvering = true;
        simStep = 0;
      }

      if (isManeuvering) {
        simStep++;
        if (simStep <= 60) { // Dynamic Turn
          let progress = simStep / 60;
          let twaDeg = -40 + (80 * progress);
          currentTWA = twaDeg * Math.PI / 180;
          currentAWA = (twaDeg * 0.75) * Math.PI / 180; // AWA is narrower than TWA
          
          let speedDropFactor = Math.pow((simStep - 30) / 30, 2); 
          let knots = 4.1 + (4.4 * speedDropFactor);
          currentSTW = knots / 1.94384;
        } 
        else if (simStep <= 220) { // Acceleration profile
          currentTWA = 40 * Math.PI / 180;
          currentAWA = 28 * Math.PI / 180;
          let accelProgress = (simStep - 60) / 160;
          let knots = 4.1 + (4.4 * Math.sqrt(accelProgress)); // logarithmic acceleration profile
          currentSTW = knots / 1.94384;
        } 
        else {
          isManeuvering = false;
        }
      } else { // Steady State Reaching
        currentTWA = -40 * Math.PI / 180;
        currentAWA = -28 * Math.PI / 180;
        currentSTW = 8.5 / 1.94384;
      }

      // Execute internal state tracking loops at 10Hz
      analyzeTelemetry();

    }, 100);
  }

  function analyzeTelemetry() {
    let stwKnots = currentSTW * 1.94384;
    let twaDeg = currentTWA * 180 / Math.PI;
    
    // Calculate Velocity Made Good (VMG) = Speed * cos(True Wind Angle)
    let currentVMG = currentSTW * Math.cos(currentTWA);
    let vmgKnots = currentVMG * 1.94384;

    // --- STATE 1: DETECT START OF MANEUVER ---
    if (currentState === 'Straight') {
      // If TWA crosses inside +/- 15 degrees, a tack turn has initiated
      if (Math.abs(twaDeg) < 15 && isManeuvering) {
        currentState = 'InTurn';
        maneuverType = 'Tack';
        startTime = Date.now();
        
        entrySTW = stwKnots;
        entryVMG = vmgKnots;
        minSTW = stwKnots;
        minVMG = vmgKnots;
        maxSTW = stwKnots;
        maxVMG = vmgKnots;
        
        actualDistanceMeters = 0;
        theoreticalDistanceMeters = 0;
      }
    }

    // --- STATE 2 & 3: ACTIVE TRACKING DURING MANEUVER ---
    if (currentState === 'InTurn' || currentState === 'Recovery') {
      let timeElapsedSec = (Date.now() - startTime) / 1000;

      // Update minimums and maximums seen during execution
      if (stwKnots < minSTW) minSTW = stwKnots;
      if (stwKnots > maxSTW) maxSTW = stwKnots;
      if (vmgKnots < minVMG) minVMG = vmgKnots;
      if (vmgKnots > maxVMG) maxVMG = vmgKnots;

      // Integrate actual vs theoretical distance every 100ms
      // Distance = Speed (m/s) * Time (0.1 seconds)
      actualDistanceMeters += (currentSTW * 0.1);
      theoreticalDistanceMeters += ((entrySTW / 1.94384) * 0.1);
      let metersLost = theoreticalDistanceMeters - actualDistanceMeters;

      // Handle transitions between Turn Phase and Recovery Phase
      if (currentState === 'InTurn' && Math.abs(twaDeg) > 30) {
        currentState = 'Recovery';
      }

      // Broadcast high-frequency running metrics
      emitDelta('performance.maneuver.type', maneuverType);
      emitDelta('performance.maneuver.state', currentState);
      emitDelta('performance.maneuver.timeElapsed', Number(timeElapsedSec.toFixed(1)));
      emitDelta('performance.maneuver.liveStwKnots', Number(stwKnots.toFixed(2)));
      emitDelta('performance.maneuver.liveVmgKnots', Number(vmgKnots.toFixed(2)));
      emitDelta('performance.maneuver.liveAwaDegrees', Number((currentAWA * 180 / Math.PI).toFixed(1)));
      emitDelta('performance.maneuver.minStwKnots', Number(minSTW.toFixed(2)));
      emitDelta('performance.maneuver.metersLost', Number(metersLost.toFixed(1)));

      // --- STATE 4: MANEUVER RECOVERY COMPLETION CONTROLLER ---
      // End tracking when boat recovers back up to 95% of target entry speed
      if (currentState === 'Recovery' && stwKnots >= (entrySTW * 0.95)) {
        app.debug(`Maneuver Completed! Lost ${metersLost.toFixed(1)} meters.`);
        
        // Final updates to lock historical dashboard keys
        emitDelta('performance.maneuver.state', 'Finished');
        
        // Reset back to watching
        currentState = 'Straight';
        maneuverType = 'Straight';
      }
    } else {
      // Default idle state broadcasts
      emitDelta('performance.maneuver.type', 'Straight');
      emitDelta('performance.maneuver.state', 'Ready');
      emitDelta('performance.maneuver.liveStwKnots', Number(stwKnots.toFixed(2)));
      emitDelta('performance.maneuver.liveVmgKnots', Number(vmgKnots.toFixed(2)));
      emitDelta('performance.maneuver.liveAwaDegrees', Number((currentAWA * 180 / Math.PI).toFixed(1)));
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

  plugin.schema = { type: 'object', properties: {} };
  return plugin;
};