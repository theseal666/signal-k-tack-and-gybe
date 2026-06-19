Tack and Gybe Performance Analyzer (H5000 Edition)
An advanced, high-performance Signal K plugin designed for the MAT 12.20 racing platform. This engine interfaces with live NMEA 2000 networks (optimized for B&G H5000 processors) to analyze maneuvers using high-frequency rolling memory lookup arrays.
It ignores simple tactical luffs by verifying full cross-wind sign alignment, integrates dynamic Speed Through Water (STW) and Velocity Made Good (VMG) meters lost, tracks helm overshoot profiles, processes ORC polar certificate files directly, and persists historical statistics to an on-deck local knowledge base.
Repository File Structure
signal-k-tack-and-gybe/
├── index.js          # High-frequency 10Hz Tracking Engine, ORC API Fetcher & File System IO
├── package.json      # Node.js Dependencies & Signal K Hooks
├── README.md         # Documentation & Mathematical Engine Breakdown
└── public/
    └── index.html    # 3-Column Chart.js & HTML5 Canvas Telemetry Dashboard
Core Analytical Logic & Lifecycle
Unlike basic monitoring tools that track live data as it happens, this plugin utilizes a 50-sample historical ring buffer running at 10Hz (every 100ms). This allows the plugin to look back into the past to capture your baseline metrics before the boat began slowing down for the turn.
  [ Steady Upwind ] ────► Dynamic ORC Target Resolution (TWS vs. Polar Grid)
         │ 
         ▼
  [ 1. Entry Phase (Pending) ]  ──► Senses Rudder > 5° & TWA < 32°
         │                          Freezes 5s Historical Speed Snapshots
         ▼
  [ 2. Wind Apex (Confirmed) ]  ──► Verifies TWA Crosses 0° (Sign-Change Check)
         │                          Overrules False Luffs / Starts Meters Lost Integration
         ▼
  [ 3. Recovery Phase ]         ──► Gauges Helm Overturn & Dead Zone Slag Time
         │                          Climbs toward Target Exit Speed Multiplier
         ▼
  [ 4. Knowledgebase Commit ]   ──► Stores Summary payload to 'tack-history.json'
                                    Updates Rolling Averages & Filters All-Time Top 10
Phase-by-Phase Operational Mechanics
0. Dynamic Target Setting (ORC Integration)
If an ORC Certificate JSON URL is provided, the plugin fetches the boat's rating files at startup. As you sail, it continuously monitors live True Wind Speed (TWS) from the H5000 and calculates an interpolated vmgUpwind target speed from your official polar curves. This updates your speed baseline dynamically as the breeze changes.
1. The Entry Phase (Maneuver Pending)
While sailing normally, the plugin maintains a running 5-second window of data in memory. A maneuver is flagged as Pending the exact millisecond the Rudder Angle exceeds 5° while the True Wind Angle (TWA) pinches tighter than 32°.
Look-Back Catch: The engine instantly freezes the data index from 5 seconds ago in the historical array. This captures your true pre-maneuver entry speed before helm resistance or sail spill began decelerating the hull.
2. The Cross-Wind Trigger (Maneuver Confirmed)
The system sits in a Pending state for up to 10 seconds.
The Luffing Shield: If the helmsman is simply luffing to defend a lane against a windward boat, the boat will head up but will not cross the eye of the wind. The pending window will time out safely, discard the snapshot, and register no false tack.
The Confirmation: A tack is officially logged only when the TWA swaps its mathematical sign (e.g., transitioning from -35° Port to +5° Starboard). The state changes to InTurn, T=0 is marked, and the frozen look-back speeds are assigned as the absolute baseline references.
3. Metric Integration & Tracking
Once confirmed, the execution block samples metrics at 10Hz:
Meters Lost Calculation: Calculated as:
Meters Lost=∑( 
1.94384
Historical Snapshot STW−Live STW
​	
 )×0.1 seconds
Helmsman Overturn: Tracks the maximum deviation angle where the helmsman pressed the bow down below the entry upwind angle target to accelerate out of the speed hole before bringing the boat back up to close-hauled targets.
Dead Zone Counter: Tracks the exact amount of time in seconds spent with a TWA under 20° (where sails are luffing and generating zero lift).
4. File-System Persistence
When the live STW recovers to your user-adjusted threshold (e.g., 95% of your pre-tack snapshot entry speed), the maneuver is closed out. The summary metrics are instantly committed to a local file system flat-file (tack-history.json), protecting your performance data through server reboots or system resets.
Emitted Signal K Delta Paths
Your frontend dashboard or NMEA gateway instruments can bind directly to these live streaming update data paths:
Path	Type	Description
performance.maneuver.state	String	Current engine status (Ready, InTurn, Recovery)
performance.maneuver.metersLost	Number	Cumulative boat length equivalent distance lost in real-time (m)
performance.maneuver.liveStwKnots	Number	High-frequency filtered Speed Through Water (kn)
performance.maneuver.liveVmgKnots	Number	Computed Velocity Made Good relative to the wind (kn)
performance.maneuver.lastSummary	Object	Deep analytical telemetry profile card of the completed tack
performance.maneuver.database	Object	Fleet rolling lifetime averages and Top 10 leaderboard entries
Configuration Settings
Adjust these thresholds directly inside the Server -> Plugin Configuration dashboard interface:
ORC JSON Polar Certificate Link URL: The URL endpoint hosting your boat's official RMS/ORC JSON polar file for dynamic target resolution.
Backup Target Entry Speed (Knots): Base speed reference targets matching target boat polar data templates if an ORC certificate is not configured or offline (Default: 7.80 kn).
Recovery Completion Threshold (%): The percentage of your look-back entry speed you must reach to mark a maneuver as completely completed (Default: 95%). Lower this parameter if choppy wave conditions cause your boat to get trapped in long recovery tracking states.