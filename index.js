module.exports = function (app) {
  const plugin = {};
  let unsubscribes = [];
  let simInterval = null;

  plugin.id = 'signal-k-tack-and-gybe';
  plugin.name = 'Tack and Gybe Performance Analyzer';
  plugin.description = 'Analyzes tacks and gybes using simulated high-frequency H5000 data.';

  plugin.start = function (options, restartPlugin) {
    app.debug('Tack/Gybe Plugin Started (Simulation Mode Active)');

    // Start our H5000 telemetry simulator loop (updates at 10Hz / every 100ms)
    startSimulator();
  };

  // State variables for tracking the maneuver
  let currentSTW = 4.37; // 8.5 knots in m/s
  let currentHeading = 0;
  let currentTWA = -0.698; // -40 degrees in radians (Port Tack)
  
  let simStep = 0;
  let isManeuvering = false;

  function startSimulator() {
    // Every 100ms, update the data stream
    simInterval = setInterval(() => {
      
      // Every 300 steps (~30 seconds), trigger a tack sequence
      if (!isManeuvering && Math.random() < 0.005) {
        isManeuvering = true;
        simStep = 0;
        app.debug('--- SIMULATION: Commencing Tack Sequence! ---');
      }

      if (isManeuvering) {
        simStep++;
        
        // Phase 1: The Turn (Takes about 6 seconds / 60 steps)
        if (simStep <= 60) {
          // TWA moves smoothly from -40 to +40 degrees
          let progress = simStep / 60;
          let twaDegrees = -40 + (80 * progress);
          currentTWA = twaDegrees * Math.PI / 180;

          // Speed drops from 8.5 knots down to 4.2 knots at the apex (step 30), then begins initial recovery
          // Parabolic speed drop profile:
          let speedDropFactor = Math.pow((simStep - 30) / 30, 2); // 0 at apex, 1 at ends
          let knots = 4.2 + (4.3 * speedDropFactor);
          currentSTW = knots / 1.94384;
        } 
        // Phase 2: Post-Tack Acceleration (Next 14 seconds / 140 steps)
        else if (simStep <= 200) {
          currentTWA = 40 * Math.PI / 180; // Settled on Starboard tack
          
          // Linear acceleration back up to top speed
          let accelProgress = (simStep - 60) / 140;
          let knots = 5.5 + (3.0 * accelProgress);
          currentSTW = knots / 1.94384;
        } 
        // Phase 3: Maneuver Complete
        else {
          isManeuvering = false;
          app.debug('--- SIMULATION: Boat has fully accelerated. ---');
        }
      } else {
        // Baseline sailing straight (Port Tack)
        currentTWA = -40 * Math.PI / 180;
        currentSTW = 8.5 / 1.94384;
      }

      // Fire data into our plugin's analyzer loop exactly like the real H5000 would
      handleDataStream('navigation.speedThroughWater', currentSTW);
      handleDataStream('environment.wind.angleTrueApparent', currentTWA);

    }, 100);
  }

  function handleDataStream(path, value) {
    if (value === null || value === undefined) return;

    if (path === 'navigation.speedThroughWater') {
      currentSTW = value;
    } 
    else if (path === 'environment.wind.angleTrueApparent') {
      currentTWA = value;
      
      let twaDegrees = (value * 180 / Math.PI).toFixed(1);
      let stwKnots = (currentSTW * 1.94384).toFixed(2);
      
      // Log data trends during the simulated tack
      if (isManeuvering) {
        app.debug(`[MANEUVER ACTIVE] TWA: ${twaDegrees}° | STW: ${stwKnots} kn`);
      }
    }
  }

  plugin.stop = function () {
    if (simInterval) clearInterval(simInterval);
    unsubscribes.forEach(f => f());
    unsubscribes = [];
    app.debug('Plugin stopped');
  };

  plugin.schema = { type: 'object', properties: {} };

  return plugin;
};