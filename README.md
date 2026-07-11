# signalk-tack-and-gybe

A Signal K server plugin that detects, measures, and archives every tack and gybe while sailing.

**Answers:**
- How many metres did this manoeuvre cost?
- How long was recovery?
- Is the crew getting better over time?

## Features

- State machine: `Straight → Pending → InTurn → Recovery → Straight`
- Separate tack and gybe leaderboards (Top 10 by fewest metres lost each)
- Separate running averages for tacks and gybes
- dt-aware distance/VMG integration for accurate metre-loss calculation
- Helm overturn angle and dead-zone time tracked per manoeuvre
- Built-in simulation mode for testing without live instruments
- Persistent history across restarts (`tack-history.json` in SK data dir)
- Live dashboard served at `http://<signalk-host>/plugins/signalk-tack-and-gybe/`

## Install

**From the Signal K AppStore / admin UI (recommended):**
Search for `signalk-tack-and-gybe` and click Install.

**Or directly from GitHub (Pi install):**
```bash
cd ~/.signalk
npm install https://github.com/theseal666/signal-k-tack-and-gybe.git
# then restart Signal K
```

## Configuration

| Option | Default | Description |
|---|---|---|
| `upwindTargetKnots` | 7.5 | Target STW upwind. Tack recovery ends when STW ≥ this × threshold. |
| `downwindTargetKnots` | 9.0 | Target STW downwind. Gybe recovery ends when STW ≥ this × threshold. |
| `recoveryThreshold` | 95 | % of target speed that counts as recovered. |
| `simulate` | false | Play back a synthetic 46 s tack+gybe loop. Disable before sailing. |

## Signal K paths subscribed (input)

| Path | Unit |
|---|---|
| `navigation.speedThroughWater` | m/s |
| `environment.wind.angleTrueWater` | rad |
| `environment.wind.angleApparent` | rad |
| `steering.rudderAngle` | rad |
| `environment.wind.speedTrue` | m/s |

## Signal K paths emitted (output)

| Path | Type | Description |
|---|---|---|
| `performance.maneuver.state` | object | Live telemetry at 5 Hz — state, STW, TWA, VMG, rudder angle, COG (sim), metres lost so far |
| `performance.maneuver.lastSummary` | object | Full summary when a manoeuvre closes |
| `performance.maneuver.database` | object | Persistent tack + gybe averages and leaderboards |

### `performance.maneuver.state` object

```json
{
  "state": "Recovery",
  "stwKnots": 6.12,
  "twaDeg": 41.2,
  "awaDeg": 34.8,
  "rudderDeg": -12.5,
  "cogDeg": 221.2,
  "tack": "port",
  "vmgKnots": 4.61,
  "metersLostAccum": 18.4
}
```

`cogDeg` is only populated in simulation mode (derived from TWA assuming wind from south). In real mode the dashboard reads `navigation.courseOverGroundTrue` directly from the SK stream (e.g., from a RaceBox IMU).

### `performance.maneuver.lastSummary` object

```json
{
  "type": "Tack",
  "timestamp": "2026-07-11T07:14:33.000Z",
  "metersLost": 14.2,
  "recoveryDurationSec": 11.4,
  "minStwKnots": 2.84,
  "maxStwKnots": 7.51,
  "maxOverturnTWA": 3.1,
  "timeInDeadZoneSec": 1.24,
  "actualDistanceMeters": 41.2,
  "theoreticalDistanceMeters": 55.4,
  "actualVmgDistanceMeters": 30.1,
  "theoreticalVmgDistanceMeters": 38.8
}
```

### `performance.maneuver.database` object

```json
{
  "tacks": {
    "count": 12,
    "averages": { "metersLost": 16.3, "recoveryDurationSec": 10.8, "minStwKnots": 2.91 },
    "topTen": [ ... ]
  },
  "gybes": {
    "count": 7,
    "averages": { "metersLost": 22.1, "recoveryDurationSec": 13.2, "minStwKnots": 1.87 },
    "topTen": [ ... ]
  }
}
```

## Dashboard

The plugin serves a live dashboard at:

```
http://<signalk-host>/plugins/signalk-tack-and-gybe/
```

**Left panel** — vessel orientation (AWA compass), live telemetry (STW, VMG, TWA, rudder, metres lost)

**Centre panel** — timeline chart: STW, VMG, TWA, rudder angle, COG — with a highlight box around each manoeuvre

**Right panel** — last manoeuvre analysis card; separate Tack and Gybe stat panels (count, avg metres lost, avg recovery time, avg min speed); separate Top-10 leaderboards for tacks and gybes

## Detection logic

### Tack

| Phase | Trigger |
|---|---|
| Pending | `\|TWA\| < 40°` AND rudder > 5° |
| InTurn | TWA sign-changes AND `\|TWA\| < 20°` at crossing |
| Recovery | `\|TWA\| > 15°` AND `< 90°` after 500 ms gate |
| Done | STW ≥ `upwindTargetKnots × threshold` |

### Gybe

| Phase | Trigger |
|---|---|
| Pending | `\|TWA\| > 110°` AND rudder > 5° |
| InTurn | TWA sign-changes AND `\|TWA\| > 150°` at crossing |
| Recovery | `\|TWA\| < 170°` after 500 ms gate |
| Done | STW ≥ `downwindTargetKnots × threshold` |

The TWA sign-change at ±180° (gybe through dead run) is handled by the `normalizeRadians()` helper that maps TWA to (−π, π] — a sweep from +179° to −179° registers as a sign change naturally.

## Simulation mode

Enable `simulate: true` in the plugin settings to play back a synthetic 46-second cycle:

```
upwind-steady (4 s) →
tack-entry (0.5 s) → tack-turn (2.5 s) → tack-recovery (9 s) →
bear-away (2 s) → downwind-steady (5 s) →
gybe-entry (0.5 s) → gybe-turn (2.5 s) → gybe-recovery (9 s) →
head-up (2 s) → repeat
```

Useful for validating the dashboard and tuning thresholds without going sailing.

## Updating

Re-install from the AppStore/admin UI, or from the Pi command line:

```bash
cd ~/.signalk
npm install https://github.com/theseal666/signal-k-tack-and-gybe.git
sudo systemctl restart signalk
```

## Roadmap

- [ ] Publish to npm / Signal K AppStore
- [ ] `GET /history` HTTP endpoint for loading history on dashboard open
- [ ] ORC polar integration (optional override for target speeds, native fetch)
- [ ] Session segmentation by `navigation.logTrip`
