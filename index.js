module.exports = function (app) {
  const plugin = {};
  let unsubscribes = [];
  let simInterval = null;

  plugin.id = 'signal-k-tack-and-gybe';
  plugin.name = 'Tack and Gybe Performance Analyzer';
  plugin.description = 'Analyzes tacks and gybes using simulated high-frequency H5000 data.';

  plugin.start = function (options, restartPlugin) {
    app.debug('Tack/Gybe Plugin Started and broadcasting keys.');
    startSimulator();
  };

  let currentSTW = 4.37; 
  let currentHeading = 0;
  let currentTWA = -0.698; 
  let simStep = 0;
  let isManeuvering = false;
  let maneuverType = 'Straight';

  function startSimulator() {
    simInterval = setInterval(() => {
      // Trigger a tack sequence roughly every 30 seconds
      if (!isManeuvering && Math.random() < 0.005) {
        isManeuvering = true;
        maneuverType = 'Tack';
        simStep = 0;
      }

      if (isManeuvering) {
        simStep++;
        if (simStep <= 60) {
          let progress = simStep / 60;
          let twaDegrees = -40 + (80 * progress);
          currentTWA = twaDegrees * Math.PI / 180;
          let speedDropFactor = Math.pow((simStep - 30) / 30, 2); 
          let knots = 4.2 + (4.3 * speedDropFactor);
          currentSTW = knots / 1.94384;
        } 
        else if (simStep <= 200) {
          currentTWA = 40 * Math.PI / 180; 
          let accelProgress = (simStep - 60) / 140;
          let knots = 5.5 + (3.0 * accelProgress);
          currentSTW = knots / 1.94384;
        } 
        else {
          isManeuvering = false;
          maneuverType = 'Straight';
        }
      } else {
        currentTWA = -40 * Math.PI / 180;
        currentSTW = 8.5 / 1.94384;
      }

      // 1. Process data internally
      handleDataStream('navigation.speedThroughWater', currentSTW);
      handleDataStream('environment.wind.angleTrueApparent', currentTWA);

      // 2. NEW: Broadcast our calculated values back into Signal K!
      emitDelta('performance.maneuver.type', maneuverType);
      emitDelta('performance.maneuver.liveStwKnots', Number((currentSTW * 1.94384).toFixed(2)));

    }, 100);
  }

  function handleDataStream(path, value) {
    if (path === 'navigation.speedThroughWater') currentSTW = value;
    if (path === 'environment.wind.angleTrueApparent') currentTWA = value;
  }

  // Helper function to format and send data keys to Signal K
  function emitDelta(path, value) {
    app.handleMessage(plugin.id, {
      updates: [
        {
          values: [
            {
              path: path,
              value: value
            }
          ]
        }
      ]
    });
  }

  plugin.stop = function () {
    if (simInterval) clearInterval(simInterval);
    app.debug('Plugin stopped');
  };

  plugin.schema = { type: 'object', properties: {} };
  return plugin;
};
