module.exports = function (app) {
  const plugin = {};
  let unsubscribes = [];
  let simInterval = null;
  let options = {};

  plugin.id = 'signal-k-tack-and-gybe';
  plugin.name = 'Tack and Gybe Performance Analyzer';
  plugin.description = 'ORC-aligned performance analyzer for MAT 12.20 reaching dynamics.';

  plugin.start = function (startOptions, restartPlugin) {
    options = startOptions || {};
    app.debug('MAT 12.20 Performance Engine Active with user configurations.');
    
    // Read user configuration or fall back to defaults
    let targetSTW = options.targetSpeedKnots || 8.54;
    app.debug(`Using target entry speed benchmark: ${targetSTW} knots`);

    if (options.orcUrl) {
      app.debug(`Configured ORC Certificate Source: ${options.orcUrl}`);
    }

    startSimulator(targetSTW);
  };

  // --- Live Sensor Telemetry Cache ---
  let currentSTW = 4.37;  
  let currentTWA = -1.13; 
  let currentAWA = -0.73; 

  // --- Tracking State Machine ---
  let currentState = 'Straight'; 
  let maneuverType = 'None';
  let startTime = 0;
  
  let entrySTW = 0;
  let minSTW = 99;
  let maxSTW = 0;
  let minWMG = 99; 
  let maxWMG = 0;

  let actualDistanceMeters = 0;
  let theoreticalDistanceMeters = 0;

  let simStep = 0;
  let isManeuvering = false;

  function startSimulator(targetEntrySTW) {
    if (simInterval) clearInterval(simInterval);
    
    simInterval = setInterval(() => {
      if (!isManeuvering && Math.random() < 0.004) {
        isManeuvering = true;
        simStep = 0;
      }

      if (isManeuvering) {
        simStep++;
        if (simStep <= 60) {
          let progress = simStep / 60;
          let twaDeg = -65 + (130 * progress);
          currentTWA = twaDeg * Math.PI / 180;
          currentAWA = (twaDeg * 0.65) * Math.PI / 180; 

          let dropFactor = Math.pow((simStep - 30) / 30, 2); 
          let knots = (targetEntrySTW * 0.45) + ((targetEntrySTW * 0.55) * dropFactor); 
          currentSTW = knots / 1.94384;
        } 
        else if (simStep <= 220) {
          currentTWA = 65 * Math.PI / 180;
          currentAWA = 42 * Math.PI / 180;
          let accelProgress = (simStep - 60) / 160;
          let knots = (targetEntrySTW * 0.45) + ((targetEntrySTW * 0.55) * Math.sqrt(accelProgress));
          currentSTW = knots / 1.94384;
        } 
        else {
          isManeuvering = false;
        }
      } else { 
        currentTWA = -65 * Math.PI / 180;
        currentAWA = -42 * Math.PI / 180;
        currentSTW = targetEntrySTW / 1.94384; 
      }

      runAnalysisEngine(targetEntrySTW);
    }, 100);
  }

  function runAnalysisEngine(targetEntrySTW) {
    let stwKnots = currentSTW * 1.94384;
    let twaDeg = currentTWA * 180 / Math.PI;
    let awaDeg = currentAWA * 180 / Math.PI;
    let wmgKnots = (currentSTW * Math.cos(currentTWA)) * 1.94384;

    if (currentState === 'Straight') {
      if (Math.abs(twaDeg) < 25 && isManeuvering) {
        currentState = 'InTurn';
        maneuverType = 'Tack';
        startTime = Date.now();
        
        entrySTW = stwKnots;
        minSTW = stwKnots;
        maxSTW = stwKnots;
        minWMG = wmgKnots;
        maxWMG = wmgKnots;
        
        actualDistanceMeters = 0;
        theoreticalDistanceMeters = 0;
      }
    }

    if (currentState === 'InTurn' || currentState === 'Recovery') {
      let timeElapsedSec = (Date.now() - startTime) / 1000;

      if (stwKnots < minSTW) minSTW = stwKnots;
      if (stwKnots > maxSTW) maxSTW = stwKnots;
      if (wmgKnots < minWMG) minWMG = wmgKnots;
      if (wmgKnots > maxWMG) maxWMG = wmgKnots;

      actualDistanceMeters += (currentSTW * 0.1);
      theoreticalDistanceMeters += ((targetEntrySTW / 1.94384) * 0.1); 
      let metersLost = theoreticalDistanceMeters - actualDistanceMeters;

      if (currentState === 'InTurn' && Math.abs(twaDeg) > 45) {
        currentState = 'Recovery';
      }

      emitDelta('performance.maneuver.type', maneuverType);
      emitDelta('performance.maneuver.state', currentState);
      emitDelta('performance.maneuver.timeElapsed', Number(timeElapsedSec.toFixed(1)));
      emitDelta('performance.maneuver.liveStwKnots', Number(stwKnots.toFixed(2)));
      emitDelta('performance.maneuver.metersLost', Number(metersLost.toFixed(1)));
      emitDelta('performance.maneuver.minStwKnots', Number(minSTW.toFixed(2)));
    } else {
      emitDelta('performance.maneuver.type', 'Straight');
      emitDelta('performance.maneuver.state', 'Ready');
      emitDelta('performance.maneuver.liveStwKnots', Number(stwKnots.toFixed(2)));
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

  // --- AUTOMATED CONFIGURATION UI SCHEMA ---
  plugin.schema = {
    type: 'object',
    title: 'MAT 12.20 Performance Settings',
    properties: {
      orcUrl: {
        type: 'string',
        title: 'ORC Certificate Link',
        description: 'Format: Must be a direct URL to your public ORC PDF/data file (e.g., https://data.orc.org/public/WPub.dll/CC/03200002P4H)'
      },
      targetSpeedKnots: {
        type: 'number',
        title: 'Manual Target Entry Speed (Knots)',
        description: 'Set your target benchmark speed based on your ORC Polar Diagram for your matching TWS / TWA condition (e.g., 8.54 knots for 12kts wind @ 75°). Used to optimize precision calculation of meters lost.',
        default: 8.54
      }
    }
  };

  return plugin;
};