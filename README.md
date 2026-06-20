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
- `public/index.html` — Optional dashboard (visualizes live emitted Signal K paths)
- `install.sh` — Optional installer script (automates the recommended install into Signal K user folder)

## Signal K paths the plugin subscribes to

These paths must be provided by live instruments or your external sim plugin (numeric values):

- `navigation.speedThroughWater` (m/s)
- `environment.wind.angleTrueWater` (radians)
- `environment.wind.angleApparent` (radians)
- `steering.rudderAngle` (radians)
- `environment.wind.speedTrue` (m/s)

## Emitted Signal K delta paths

- `performance.maneuver.state` — { state, stwKnots, twaDeg, vmgKnots, stale?, metersLostAccum }
- `performance.maneuver.metersLost` — Number or object with metersLost
- `performance.maneuver.liveStwKnots` — Number (knots)
- `performance.maneuver.liveVmgKnots` — Number (knots)
- `performance.maneuver.liveAwaDegrees` — Number (degrees)
- `performance.maneuver.lastSummary` — Detailed summary object when a maneuver closes
- `performance.maneuver.database` — Rolling averages and Top‑10 leaderboard

## Web Dashboard (public/index.html)

The plugin includes a small web dashboard in `public/index.html`. It visualizes live maneuver state, STW/VMG/ AWA graphs, the last maneuver analysis and a Top‑10 leaderboard.

What it shows

- Live status badge: Ready / InTurn / Recovery and live telemetry (STW, VMG, AWA, meters lost).
- Timeline chart: recent STW, VMG and AWA history.
- Last Maneuver Analysis card with meters lost, VMG gap, recovery time, min/max STW, overturn and dead‑zone time.
- Fleet averages and Top‑10 leaderboard (fewest meters lost).

How it connects

- The dashboard opens a WebSocket to the Signal K stream endpoint: `/signalk/v1/stream` and subscribes to `performance.maneuver.*` updates.
- By default it assumes the dashboard is served from the same host as the Signal K server (same origin). If you host the static file elsewhere, edit `public/index.html` and change the `wsUrl` variable to `ws://<SIGNALK_HOST>:3000/signalk/v1/stream?subscribe=none` (or `wss://` for TLS).

Quick local test (one-liner)

- Serve the `public` folder locally for a quick test (requires `npm`):

  npx http-server public -p 8080

  Then open http://localhost:8080 in your browser. If the dashboard shows no data, point `wsUrl` to your Signal K server address.

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

## Easy install (for sailors / non‑technical users)

Follow the simple method below to install the plugin into your Signal K user folder. The installer will place the plugin in `~/.signalk/node_modules/signal-k-tack-and-gybe` and try to restart Signal K.

Prerequisites

- A running Signal K server (e.g., installed on a Raspberry Pi).
- Node.js and npm installed on the same machine running Signal K (Node 16+ / 18+ recommended).
- git and curl or wget available.
- You must run the installer as the same user that runs Signal K (this ensures file ownership and permissions are correct). If you are unsure which user runs Signal K, check:

  ps aux | grep signalk-server | grep -v grep

  or inspect the Signal K data directory owner:

  ls -ld ~/.signalk

If Signal K runs as user `node` (common on Pi images), switch to that user or run the installer as that user using `sudo -u node -s`.

Single-line installer (recommended)

Interactive (prompts before running):

curl -fsSL https://raw.githubusercontent.com/theseal666/signal-k-tack-and-gybe/main/install.sh | bash

Non-interactive (auto yes):

curl -fsSL https://raw.githubusercontent.com/theseal666/signal-k-tack-and-gybe/main/install.sh | bash -s -- --yes

If `curl` is not available, use `wget`:

wget -qO- https://raw.githubusercontent.com/theseal666/signal-k-tack-and-gybe/main/install.sh | bash

What the installer does

- Clones the repository to a temporary folder.
- Runs `npm install --production` inside the plugin folder to install required dependencies (including `axios`).
- Copies the plugin into `~/.signalk/node_modules/signal-k-tack-and-gybe`.
- Attempts to restart Signal K (best-effort via `systemctl`).

Permissions notes

- Run the installer as the Signal K user so files are owned correctly. If you run it as root or another user, you may need to fix ownership, for example:

  sudo chown -R <signalk-user> ~/.signalk/node_modules/signal-k-tack-and-gybe

Replace `<signalk-user>` with the account the Signal K process runs under.

## Updating the plugin from Git

If you installed the plugin using the installer above, the easiest update is to re-run the installer (it will pull the latest files and reinstall dependencies). To update manually via git, only use the steps below if your plugin directory is a git checkout (you cloned it there):

1. Stop Signal K (optional but recommended):

   sudo systemctl stop signalk

2. Pull latest changes and reinstall deps:

   cd ~/.signalk/node_modules/signal-k-tack-and-gybe
   git fetch origin
   git reset --hard origin/main
   npm install --production

3. Start Signal K again:

   sudo systemctl start signalk

Alternative quick update (re-run installer):

curl -fsSL https://raw.githubusercontent.com/theseal666/signal-k-tack-and-gybe/main/install.sh | bash -s -- --yes

## Quick checks after install

- Verify plugin folder exists:

  ls ~/.signalk/node_modules/signal-k-tack-and-gybe

- Verify dependencies were installed (inside plugin folder):

  cd ~/.signalk/node_modules/signal-k-tack-and-gybe
  ls node_modules | grep axios

- Check for `tack-history.json` in Signal K data dir (created after first logged maneuver):

  ls $(node -e "console.log(require('os').homedir() + '/.signalk')")/tack-history.json || echo "no history yet"

- Watch Signal K logs for errors while starting the plugin:

  sudo journalctl -u signalk -f    # follow logs on systemd systems

## Troubleshooting

- If Signal K fails to load the plugin with `MODULE_NOT_FOUND` and the path references `signal-k-tack-and-gybe`, check the folder name under `~/.signalk/node_modules/` — it must be exactly `signal-k-tack-and-gybe` (lowercase).
- If ORC polar JSON parsing fails with an "Unexpected token" at the start, the remote JSON likely contains a UTF‑8 BOM; I can update the plugin to trim it automatically or you can remove the BOM from the source file.

---

If you want screenshots, a compact mobile UI, or a small harness to replay example delta payloads for demo/testing, tell me and I'll add them.