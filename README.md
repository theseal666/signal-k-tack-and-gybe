# signal-k-tack-and-gybe

A performance monitoring plugin for the **Signal K Node Server** designed to detect, measure, and analyze sailing maneuvers (tacks and gybes) in real-time. 

Optimized to utilize high-frequency (10Hz) telemetry streams from high-performance marine processors like the **B&G H5000**.

---

## Features (Roadmap)
* ⏱️ **Automatic Maneuver Detection:** Real-time state machine tracks heading changes to identify tacks and gybes.
* 📉 **Performance Metrics:** Measures entry speed, minimum speed drop ($\Delta v$), turn duration, and structural tack angles.
* 📈 **Speed Recovery Analysis:** Tracks the time required for the crew to accelerate back up to pre-maneuver target speeds.
* 📊 **Signal K Integration:** Emits data to custom `performance.*` Signal K paths for integration with displays and data loggers.

---

## Installation

### For Local Development & Testing
1. Clone this repository to your local development machine.
2. Inside the project folder, link the package globally:
   ```bash
   npm link
