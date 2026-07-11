# signalk-tack-and-gybe — Design Plan

Status: **M0–M2 done** (July 2026).

## Goal

Detect, measure, and archive every tack and gybe while sailing. Answer:
- How many metres did this manoeuvre cost?
- How long was recovery?
- Is the crew getting better over time? (separate Top-10 for tacks and gybes)

The plugin is data-source agnostic — it consumes standard Signal K paths from
live instruments. A simulation mode is provided for testing without real data.

## State machine

```
Straight → Pending → InTurn → Recovery → Straight
                  ↘ (timeout / no crossing) ↗
```

**Entry** (`Straight → Pending`): rudder angle exceeds threshold AND:
- TWA is upwind (`|twaDeg| < 40°`) → potential tack
- TWA is downwind (`|twaDeg| > 110°`) → potential gybe

**Confirm** (`Pending → InTurn`): TWA sign changes AND:
- `|twaDeg| < 20°` at crossing → Tack (through irons)
- `|twaDeg| > 150°` at crossing → Gybe (through dead run)

**Turn done** (`InTurn → Recovery`):
- Tack: `|twaDeg| > 15° AND < 90°` after 500 ms gate
- Gybe: `|twaDeg| < 170°` after 500 ms gate
- Gate prevents instant transition at the exact sign-crossing tick

**Recovery done** (`Recovery → Straight`):
- Tack: STW ≥ `upwindTargetKnots × recoveryMultiplier`
- Gybe: STW ≥ `downwindTargetKnots × recoveryMultiplier`

## Milestones

### ✅ M0 — Gybe detection (done)

Entry trigger fires for `|TWA| > 110°` (downwind leg). Pending→InTurn detects
TWA sign-crossing near ±180° → `maneuverType = 'Gybe'`. InTurn→Recovery uses
`|TWA| < 170°` for gybes vs `> 15° && < 90°` for tacks.

`normalizeRadians()` maps all TWA to (−π, π] so a sweep from +179° to −179°
registers as a natural sign change — no special-casing needed at the dead run.

### ✅ M1 — Leaderboard emit (done)

`emitDelta('performance.maneuver.database', db)` now called in `logManeuver()`
immediately after save. Dashboard leaderboard and averages populate correctly.

### ✅ M2 — npm/appstore readiness (done)

- Package renamed to `signalk-tack-and-gybe` (must start with `signalk-`)
- `axios` removed entirely; ORC polar integration removed (deferred to M5)
- Recovery criterion replaced with configurable `upwindTargetKnots` /
  `downwindTargetKnots` — cleaner than entry-speed-relative threshold
- Schema has `title` + `description` on all properties
- `app.setPluginStatus()` called on start, stop, and after each logged manoeuvre
- `engines`, `files`, `.gitignore` added
- Version `0.2.0`

### ✅ M2.1 — Separate tack / gybe leaderboards (done)

`performanceDatabase` restructured to `{ tacks: { count, averages, topTen }, gybes: { count, averages, topTen } }`.
`logManeuver()` routes by `summary.type`. Old single-bucket format is detected
on load and discarded (cannot split retroactively — fresh start).

Dashboard updated with:
- Two side-by-side stat panels (Tacks in blue, Gybes in pink)
- Separate Top-10 leaderboards per manoeuvre type

### ✅ M2.2 — COG conflict fix (done)

Simulation previously emitted to `navigation.courseOverGroundTrue`, conflicting
with the RaceBox IMU source in real mode. Fixed: simulation no longer emits to
that SK path. COG travels exclusively through `performance.maneuver.state`
`cogDeg` field (non-null only in simulate mode). Dashboard WS subscription to
`navigation.courseOverGroundTrue` handles real instrument COG in live mode.

### 🔲 M3 — Publish to npm

Once the first real-sailing test is done and history is validated, publish
`signalk-tack-and-gybe` to npm so it appears in the Signal K AppStore.

### 🔲 M4 — Persistent history endpoint

`registerWithRouter` → `GET /history` returns full `performanceDatabase` JSON,
so the dashboard can load history on open without waiting for a new manoeuvre.

### 🔲 M5 — ORC polar (deferred)

Optional ORC/RMS polar URL as an override for `upwindTargetKnots`. Native
fetch, no axios. Keyed by TWS in knots.

### 🔲 M6 — Session segmentation

Tag each manoeuvre with a session ID from `navigation.logTrip` so you can
filter the dashboard by race day.

## Signal K paths used

### Subscribed (input)

| Path | Unit | Description |
| :--- | :--- | :--- |
| `navigation.speedThroughWater` | m/s | Boat speed through water |
| `environment.wind.angleTrueWater` | rad | True wind angle (water ref) |
| `environment.wind.angleApparent` | rad | Apparent wind angle |
| `steering.rudderAngle` | rad | Helm angle |
| `environment.wind.speedTrue` | m/s | True wind speed |

### Emitted (output)

| Path | Type | Description |
| :--- | :--- | :--- |
| `performance.maneuver.state` | object | Live state + telemetry at 5 Hz |
| `performance.maneuver.lastSummary` | object | Full summary when manoeuvre closes |
| `performance.maneuver.database` | object | Split tack/gybe averages + Top-10 leaderboards |

## Configuration schema

```js
{
  upwindTargetKnots:   { type: 'number', default: 7.5 },
  downwindTargetKnots: { type: 'number', default: 9.0 },
  recoveryThreshold:   { type: 'number', default: 95  },  // %
  simulate:            { type: 'boolean', default: false }
}
```

## Known risks & notes

- **`environment.wind.angleTrueWater`**: some instruments publish TWA on
  `angleTrueGround` instead. If TWA always reads 0, switch the subscription.
- **Rudder availability**: not all boats have a rudder sensor. Detection can
  fall back to TWA rate-of-change if `steering.rudderAngle` is missing.
- **Database migration**: old `tack-history.json` files written before M2.1
  use the combined format and will be discarded on first load. Delete the file
  and let the plugin create a fresh one.
