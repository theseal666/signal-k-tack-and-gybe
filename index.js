module.exports = function (app) {
  const plugin = {};
  let unsubscribes = [];

  plugin.id = 'signal-k-tack-and-gybe';
  plugin.name = 'Tack and Gybe Performance Analyzer';
  plugin.description = 'Analyzes tacks and gybes using high-frequency H5000 data.';

  plugin.start = function (options, restartPlugin) {
    app.debug('Tack/Gybe Plugin Started. Setting up data subscriptions...');

    // Define the data paths we need from the H5000 system
    let subscription = {
      context: 'vessels.self',
      subscribe: [
        { path: 'navigation.headingTrue', period: 100 },      // 10Hz high-frequency
        { path: 'navigation.speedThroughWater', period: 200 }, // 5Hz
        { path: 'environment.wind.angleTrueApparent', period: 100 } // TWA (Radians)
      ]
    };

    // Handle incoming data deltas
    app.subscriptionmanager.subscribe(
      subscription,
      unsubscribes,
      subscriptionError => {
        app.error('Subscription error: ' + subscriptionError);
      },
      delta => {
        delta.updates.forEach(update => {
          update.values.forEach(value => {
            handleDataStream(value.path, value.value);
          });
        });
      }
    );
  };

  // State variables for tracking the maneuver
  let currentSTW = 0;
  let currentHeading = 0;
  let currentTWA = 0; // Signal K sends angles in Radians!

  function handleDataStream(path, value) {
    if (value === null || value === undefined) return;

    if (path === 'navigation.speedThroughWater') {
      currentSTW = value; // in meters per second
    } 
    else if (path === 'navigation.headingTrue') {
      currentHeading = value; // in radians
    } 
    else if (path === 'environment.wind.angleTrueApparent') {
      currentTWA = value; // in radians (-PI to +PI)
      
      // Print the values to the server logs to prove it's working
      let twaDegrees = (value * 180 / Math.PI).toFixed(1);
      let stwKnots = (currentSTW * 1.94384).toFixed(2);
      
      app.debug(`TWA: ${twaDegrees}° | STW: ${stwKnots} kn`);
      
      // TODO: Add state machine here to detect the cross-through!
    }
  }

  plugin.stop = function () {
    // Clean up subscriptions when plugin stops
    unsubscribes.forEach(f => f());
    unsubscribes = [];
    app.debug('Plugin stopped');
  };

  plugin.schema = { type: 'object', properties: {} };

  return plugin;
};