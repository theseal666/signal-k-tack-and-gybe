# signalk-tack-and-gybe — Design Plan

Status: **M0–M2 done** (July 2026). Gybe detection added, leaderboard emit fixed,
ORC polar removed in favour of configurable upwind/downwind speed targets,
package renamed to `signalk-tack-and-gybe` and cleaned for npm publication.

## Goal

Detect, measure, and archive every tack and gybe while sailing. Answer:
- How many metres did this manoeuvre cost?
- How long was recovery?
- Is the crew getting better over time? (Top-10 leaderboard)

The plugin is data-source agnostic — it consumes standard SignalK paths from
live instruments. No simulation, no NMEA dependency.

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
- Tack: `|twaDeg|` settles below entry angle on new tack
- Gybe: `|twaDeg|` settles above 120° on new gybe heading

**Recovery done** (`Recovery → Straight`):
- STW ≥ `snapshotEntrySTW × recoveryThreshold`

## Broken things to fix

### ✅ M0 — Gybe detection (DONE)

Entry trigger now fires for `|TWA| > 110°` (downwind leg). Pending→InTurn
detects TWA sign-crossing near ±180° → `maneuverType = 'Gybe'`. InTurn→Recovery
uses `|TWA| > 120°` for gybes vs `< 10°` for tacks.

### ✅ M1 — Leaderboard emit (DONE)

`emitDelta('performance.maneuver.database', db)` now called in `logManeuver()`
immediately after save. Dashboard leaderboard and averages will populate.

### ✅ M2 — npm/appstore readiness (DONE)

- Package renamed to `signalk-tack-and-gybe`
- `axios` removed entirely; ORC polar integration removed (add back later as M5)
- Recovery criterion replaced with configurable `upwindTargetKnots` /
  `downwindTargetKnots` — cleaner than entry-speed-relative threshold
- Schema has `title` + `description` on all properties
- `app.setPluginStatus()` called on start, stop, and after each logged manoeuvre
- `engines`, `files`, `.gitignore` added; `signalk.appIcon` removed (no icon yet)
- Version bumped to `0.2.0`

### M3 — Clean install path (replaces install.sh)

Once published on npm the correct install method is the SignalK plugin manager
(`npm install` from the admin UI). The `install.sh` was a workaround for the
missing npm package. Once the package is on npm, replace install.sh docs with
the standard SK appstore install instructions.

## SignalK paths used

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
| `performance.maneuver.database` | object | Rolling averages + Top-10 leaderboard |

## Configuration schema

```js
{
  upwindTargetKnots: {
    type: 'number',
    title: 'Upwind target boatspeed (knots)',
    description: 'Target STW for upwind. Tack recovery ends when STW ≥ this × threshold.',
    default: 7.5
  },
  downwindTargetKnots: {
    type: 'number',
    title: 'Downwind target boatspeed (knots)',
    description: 'Target STW for downwind. Gybe recovery ends when STW ≥ this × threshold.',
    default: 9.0
  },
  recoveryThreshold: {
    type: 'number',
    title: 'Recovery threshold (%)',
    description: 'Percentage of target speed at which manoeuvre is considered recovered.',
    default: 95
  }
}
```

ORC polar integration is deferred — will be added as M5 once the core is
stable and published. It can be wired back in as an optional layer on top of
the manual targets.

## Milestones

- ✅ **M0 — Gybe detection**: state machine handles both tacks and gybes.
- ✅ **M1 — Leaderboard emit**: `performance.maneuver.database` emitted on every logged manoeuvre.
- ✅ **M2 — npm/appstore prep**: renamed, axios removed, schema fixed, package.json cleaned.
- 🔲 **M3 — Clean install**: replace install.sh docs with npm/appstore install instructions. Publish `signalk-tack-and-gybe` to npm.
- 🔲 **M4 — Persistent history endpoint**: `registerWithRouter` → `GET /history` returns full `performanceDatabase` JSON, so the dashboard can load history on open without waiting for a new manoeuvre.
- 🔲 **M5 — ORC polar (deferred)**: optional ORC/RMS polar URL as an override for `upwindTargetKnots`. Native fetch, no axios. Keyed by TWS in knots.
- 🔲 **M6 — Session segmentation**: tag each manoeuvre with a session ID from `navigation.logTrip` so you can filter the dashboard by race day.

## Risks & notes

- **`environment.wind.angleTrueWater`**: some instruments publish TWA on
  `angleTrueGround` instead. If TWA always reads 0, switch the subscription.
- **ORC polar integration**: the `rms.vmgUpwind` lookup is fragile — the ORC
  JSON schema varies by source. For now it's best-effort; the fallback
  `targetSpeedKnots` covers the common case.
- **Rudder angle availability**: not all boats have a rudder sensor. Detection
  can fall back to TWA rate-of-change if `steering.rudderAngle` is missing.
- **Version 1.0.0 in package.json**: suggests production-ready, but the plugin
  is still a prototype. Bump down to 0.1.0 and increment properly.
