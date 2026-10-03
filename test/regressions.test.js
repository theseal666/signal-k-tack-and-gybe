const assert = require('chai').assert;
const fs = require('fs');
const src = fs.readFileSync(require.resolve('../index.js'), 'utf8');

// This plugin has no functional harness yet: it drives itself off a SignalK
// subscription and a 200 ms interval, and its simulate mode needs more of the
// server API than a stub provides. These are source-level guards against the
// three specific defects found in the 2026-10-03 Karukera log — narrow, but
// they fail if someone reintroduces the exact bug.

describe('tack-and-gybe regressions', () => {
  it('measures durations on a monotonic clock, not wall time', () => {
    // The Pi has no RTC. It boots on a stale clock and NTP steps it when a fix
    // arrives; on 2026-10-03 that step landed inside the first manoeuvre and
    // the summary recorded 2,242,658 s of recovery — 25.95 days, the exact
    // size of the jump.
    assert.include(src, 'process.hrtime.bigint()', 'a monotonic clock source must be present');
    const analysis = src.slice(src.indexOf('function runAnalysis()'));
    const body = analysis.slice(0, analysis.indexOf('\n  }\n'));
    assert.notInclude(body, 'Date.now()',
      'runAnalysis must not read wall time — durations break across an NTP step');
    assert.include(body, 'monoNow()');
  });

  it('takes the pre-manoeuvre baseline when the turn is confirmed', () => {
    // Pending fired 210 times for 10 real manoeuvres. Snapshotting there froze
    // the baseline at a random mid-leg moment whenever a stale Pending was
    // still open as a real turn began.
    assert.include(src, 'function beginManoeuvre(', 'baseline helper must exist');
    const pendingBlock = src.slice(src.indexOf("if (currentState === 'Straight') {"));
    const entry = pendingBlock.slice(0, pendingBlock.indexOf('Pending → InTurn'));
    assert.notInclude(entry, 'snapshotEntrySTW =',
      'the baseline must not be captured on entry to Pending');
    const confirm = src.slice(src.indexOf('const confirmTack'));
    assert.include(confirm.slice(0, 600), 'beginManoeuvre(now)',
      'the baseline must be captured when the manoeuvre is confirmed');
  });

  it('refuses to publish a summary with an impossible duration', () => {
    assert.include(src, 'MAX_MANOEUVRE_SEC', 'a duration backstop must exist');
    const guard = src.slice(src.indexOf('const durationSec'), src.indexOf('logManeuver({'));
    assert.include(guard, 'MAX_MANOEUVRE_SEC',
      'the backstop must run before the summary is logged');
  });

  it('keeps wall time for the human-readable timestamp', () => {
    assert.include(src, 'timestamp: new Date().toISOString()',
      'the logged timestamp should still be wall time — that is what a reader wants');
  });
});

describe('monotonic clock', () => {
  it('never goes backwards', () => {
    const mono = () => Number(process.hrtime.bigint() / 1000000n);
    let prev = mono();
    for (let i = 0; i < 20000; i++) {
      const t = mono();
      assert.isAtLeast(t, prev);
      prev = t;
    }
  });
});
