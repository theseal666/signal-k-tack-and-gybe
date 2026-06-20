# Tack and Gybe Performance Analyzer (Signal K plugin)

A focused Signal K plugin to analyze tacks and gybes, produce precise summary metrics, and maintain a rolling history and Top‑10 knowledge base. The analyzer is source‑agnostic: it consumes Signal K deltas (from instruments or an external sim plugin) on the same paths and does not simulate data internally.

## Quick overview

- Rolling history: 50 samples for look‑back entry snapshots.
- State machine: Straight → Pending → InTurn → Recovery → Straight.
- DT‑aware integration for distance (meters) and VMG to increase precision.
- Tracks meters lost, helm overturn and dead‑zone time.
- Persists maneuver summaries to `tack-history.json` and maintains rolling averages + Top‑10.

## Repository layout

- `index.js` — Main plugin engine (subscription handling, analysis, ORC fetch, persistence)
- `package.json` — Dependencies
- `README.md` — Documentation
- `public/index.html` — Optional dashboard (binds to emitted Signal K paths)

## Signal K paths the plugin subscribes to

These paths must be provided by live instruments or your external sim plugin (numeric values):

- `navigation.speedThroughWater` (m/s)
- `environment.wind.angleTrueWater` (radians)
- `environment.wind.angleApparent` (radians)
- `steering.rudderAngle` (radians)
- `environment.wind.speedTrue` (m/s)

## Emitted Signal K delta paths

- `performance.maneuver.state` — { state, stwKnots, twaDeg, vmgKnots, stale?, metersLostAccum }
- `performance.maneuver.lastSummary` — Detailed summary object when a maneuver closes
- `performance.maneuver.database` — Rolling averages and Top‑10 leaderboard

## Precision & metric details

- Integration is dt‑aware: distances and VMG are integrated using measured dt between analysis ticks.
- Units:
  - Inputs: `speedThroughWater` and `wind.speedTrue` are treated as m/s.
  - Conversions for knots ↔ m/s are provided for display or configuration.
- Meters lost:
  - Accumulated by integrating instantaneous speed deficit (m/s) while boat is below the snapshot entry speed.
  - Final `metersLost` uses `max(accumulated_deficit, theoreticalDistance - actualDistance)` to reduce sensitivity to short spikes.
- VMG integration: actual and theoretical VMG distance accumulated with dt.
- Overturn and dead‑zone:
  - Tracks maximum overturn (deg) relative to entry TWA and time spent with |TWA| < 20°.

## Configuration

- `orcUrl` — optional URL to ORC/RMS JSON polar file
- `targetSpeedKnots` — fallback / manual polar target (knots)
- `recoveryThreshold` — percentage (0–100) of entry speed to consider maneuver recovered (default 95)

## Operational notes & testing

- The plugin is source‑agnostic — ensure your external sim plugin publishes exactly the same paths with numeric values (not strings).
- If no fresh data (>2s), the analysis loop marks state `stale` and avoids false detections.
- To test without instruments:
  1. Run your sim plugin that publishes the required Signal K paths.
  2. Start this analyzer plugin.
  3. Confirm `performance.maneuver.state` deltas appear and `tack-history.json` receives summaries when maneuvers close.

## Example `performance.maneuver.lastSummary` schema

```json
{
  "type": "Tack",
  "timestamp": "2026-06-20T19:52:25.000Z",
  "metersLost": 3.4,
  "recoveryDurationSec": 8.2,
  "minStwKnots": 4.12,
  "maxOverturnTWA": 12.3,
  "timeInDeadZoneSec": 1.42,
  "actualDistanceMeters": 5.23,
  "theoreticalDistanceMeters": 8.12,
  "actualVmgDistanceMeters": 2.34,
  "theoreticalVmgDistanceMeters": 3.45
}
```

---

If you want changes to the README tone, additional examples, or a testing harness section, tell me and I'll update it.