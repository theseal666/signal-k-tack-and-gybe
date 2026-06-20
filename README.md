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

## Easy install (for sailors / non‑technical users)

Follow one of the two simple methods below. Pick the method that matches how you access your Signal K server (Raspberry Pi or similar Linux host is common).

Prerequisites

- A running Signal K server (e.g., installed on a Raspberry Pi).
- Node.js and npm installed on the same machine running Signal K (Node 16+ / 18+ recommended).
- SSH access to the machine or a terminal on the device.

Method A — Recommended (copy into Signal K user plugins folder)

1. SSH to your Signal K machine (or open a terminal).
2. Download this plugin into your home folder:

   git clone https://github.com/theseal666/Signal-k-tack-and-gybe.git

3. Install Node dependencies for the plugin:

   cd Signal-k-tack-and-gybe
   npm install

4. Copy the plugin folder into your Signal K user node_modules directory (create if missing):

   mkdir -p ~/.signalk/node_modules
   cp -r $(pwd) ~/.signalk/node_modules/signal-k-tack-and-gybe

5. Restart the Signal K server to pick up the new plugin. Depending on how you installed Signal K, one of these will work:

   sudo systemctl restart signalk    # common for systemd / Debian installs
   sudo service signalk restart      # some systems
   # OR reboot the Pi: sudo reboot

6. After restart, open your Signal K admin UI (usually http://<your-pi-ip>:3000) → Plugins and enable/configure "Tack and Gybe Performance Analyzer".

Method B — Alternative (npm link / development install)

Use this if you want to develop or prefer a linked installation.

1. On the Signal K machine, clone the repo and install deps:

   git clone https://github.com/theseal666/Signal-k-tack-and-gybe.git
   cd Signal-k-tack-and-gybe
   npm install

2. Link it globally and into the Signal K installation:

   sudo npm link          # creates a global symlink for this package

   # Find where your signalk server is installed, then in that folder run:
   # sudo npm link signal-k-tack-and-gybe

   # If you installed Signal K globally you can do:
   cd $(npm root -g)/signalk-node-server || true
   sudo npm link signal-k-tack-and-gybe || true

3. Restart Signal K as in Method A.

Quick checks after install

- Verify the plugin folder exists:

  ls ~/.signalk/node_modules/signal-k-tack-and-gybe

- Verify dependencies were installed (inside plugin folder):

  cd ~/.signalk/node_modules/signal-k-tack-and-gybe
  ls node_modules | grep axios

- Check for `tack-history.json` in Signal K data dir (this file is created after the first logged maneuver):

  ls $(node -e "console.log(require('os').homedir() + '/.signalk')")/tack-history.json || echo "no history yet"

- Watch Signal K logs for errors while starting the plugin:

  sudo journalctl -u signalk -f    # follow logs on systemd systems

If something goes wrong

- Ensure Node and npm versions are recent.
- Ensure the plugin folder is owned by the same user that runs the Signal K process (permission issues cause silent failures).
- If the UI does not show the plugin, restart Signal K and check logs (journalctl or /var/log/syslog).
- If the plugin appears but emits no deltas, confirm your instruments or sim plugin publish numeric values on the required paths.

---

If you want, I can add a short shell script (install.sh) that automates Method A (clone, npm install, copy, restart). Would you like me to add that script to the repo?