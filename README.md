# Signal K Tack and Gybe Performance Analyzer

An advanced performance logging and maneuver analytics plugin designed for Signal K. This plugin uses high-frequency NMEA / H5000 telemetry data to detect, measure, and analyze the efficiency of tacks and gybes. Optimized with reference to high-performance racing platforms like the MAT 12.20.

## Features

* **Real-time Maneuver State Machine**: Dynamically switches tracking states (`Ready`, `InTurn`, `Recovery`) based on changing True Wind Angles (TWA).
* **Meters Lost Calculation**: Integrates your actual boat speed (STW) against your configured ORC target speed over the duration of the turn to show exactly how much distance was surrendered during the maneuver.
* **Comprehensive Performance Metrics**: Emits live updates to the Signal K data browser, tracking:
  * Minimum & Maximum Speed Through Water (`STW`)
  * Minimum & Maximum Velocity Made Good / Windward-Leeward component (`WMG`/`WMG`)
  * Apparent Wind Angle tracking (`AWA`)
  * Total duration of the maneuver in seconds.

## Broadcasted Signal K Paths

The plugin continuously updates the following keys under the `performance.maneuver.*` path group:

| Path | Type | Description |
| :--- | :--- | :--- |
| `performance.maneuver.type` | String | Current activity status (`Straight`, `Tack`, `Gybe`) |
| `performance.maneuver.state` | String | Tracking sub-state (`Ready`, `InTurn`, `Recovery`, `Finished`) |
| `performance.maneuver.timeElapsed` | Number | Seconds passed since the maneuver began |
| `performance.maneuver.liveStwKnots` | Number | Live Speed Through Water in Knots |
| `performance.maneuver.liveWmgKnots` | Number | Live Windward/Leeward component in Knots |
| `performance.maneuver.liveAwaDegrees` | Number | Live Apparent Wind Angle in Degrees |
| `performance.maneuver.minStwKnots` | Number | The lowest speed drop ($V_{min}$) noted during the turn |
| `performance.maneuver.metersLost` | Number | Cumulative structural distance lost in meters compared to target |

## Configuration

You can easily configure the plugin through the Signal K web interface under **Server -> Plugin Configuration**:

1. **ORC Certificate Link**: Optional direct URL link to your public ORC certificate profile data sheet for structural tracking reference.
2. **Manual Target Entry Speed (Knots)**: The baseline target cruise speed derived from your boat's polar diagram matching your current True Wind Speed (TWS) and TWA configuration. This value is heavily relied upon to run high-precision calculations for meters lost.

## Development & Simulation

The plugin features an embedded simulation mode that mimics high-frequency (10Hz) sensor updates to model real-world sailing physics while developing away from the boat network.

## License

MIT