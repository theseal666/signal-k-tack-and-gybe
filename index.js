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
    app.debug('MAT 12.20 Performance Engine Active.');
    
    let targetSTW = options.targetSpeedKnots || 8.54;
    // Read the threshold from settings, convert percentage (e.g. 95) to a decimal multiplier (0.95)
    let thresholdPercent = options.recoveryThreshold || 95;
    let recoveryMultiplier = thresholdPercent / 100;
    
    app.debug(`Recovery complete target set to ${thresholdPercent}% of target speed.`);

    startSimulator(targetSTW, recoveryMultiplier);
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
  let entryVMG = 0;
  let minSTW = 99;
  let maxSTW = 0;
  let minVMG = 99; 
  let maxVMG = 0;

  // Precision tracking distance integrators
  let actualDistanceMeters = 0;
  let theoreticalDistanceMeters = 0;
  let actualVmgDistanceMeters = 0;
  let theoreticalVmgDistanceMeters = 0;

  let simStep = 0;
  let isManeuvering = false;

  function startSimulator(targetEntrySTW, recoveryMultiplier) {
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
          // Simulates boat speed accelerating back up to 100% of target entry speed
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

      runAnalysisEngine(targetEntrySTW, recoveryMultiplier);
    }, 100);
  }

  function runAnalysisEngine(targetEntrySTW, recoveryMultiplier) {
    let stwKnots = currentSTW * 1.94384;
    let twaDeg = currentTWA * 180 / Math.PI;
    let awaDeg = currentAWA * 180 / Math.PI;
    
    let liveVmgMS = currentSTW * Math.cos(currentTWA);
    let vmgKnots = liveVmgMS * 1.94384;
    let targetVmgKnots = targetEntrySTW * Math.cos(65 * Math.PI / 180);

    if (currentState === 'Straight') {
      if (Math.abs(twaDeg) < 25 && isManeuvering) {
        currentState = 'InTurn';
        maneuverType = 'Tack';
        startTime = Date.now();
        
        entrySTW = stwKnots;
        entryVMG = vmgKnots;
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

      if (currentState === 'InTurn' && Math.abs(twaDeg) > 45) {
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

      // --- DYNAMIC EXIT CONDITION ---
      // Uses the user-defined threshold instead of a hardcoded 95%
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

  // --- UPDATED CONFIGURATION SCHEMA ---
  plugin.schema = {
    type: 'object',
    title: 'MAT 12.20 Performance Settings',
    properties: {
      orcUrl: {
        type: 'string',
        title: 'ORC Certificate Link'
      },
      targetSpeedKnots: {
        type: 'number',
        title: 'Manual Target Entry Speed (Knots)',
        default: 8.54
      },
      recoveryThreshold: {
        type: 'number',
        title: 'Recovery Completion Threshold (%)',
        description: 'The percentage of your target speed the boat must reach to mark a maneuver as completely finished (e.g., 90% or 95%). lower this if your boat stays stuck in the recovery state.',
        default: 95
      }
    }
  };

  return plugin;
};