# Integrated desktop UI regression — 2026-09-23

- Source: `72d511a6`, host revision v40, isolated Mods v2 branch. UAT untouched.
- Integrated Electron 13: 89 checks, exit 0. Actual utility/session, cold/reload, native tools,
  compaction, completion, presentation, focus, SVG and off controls. Artifacts archived separately.
- Tool sites focused Electron 1: three checks, exit 0; two new scenarios now wired into full runner.
  Those two scenarios were not part of the 89-check run. Protocol fixture is not business acceptance.
- Mods regression 14: 111 files, 894 tests passed, 154.05 seconds. Tool display standalone exit 0.
- Runner ESLint exit 0; individual feature reports record typecheck and scoped validation.
- Read performance: 500 samples after 100 warmups, baseline p95 3.8911 ms vs off 4.0833 ms
  (+4.939%). Single interleaved run under concurrent test load, not formal five-round qualification.
- Earlier integrated run 12 failed from host site mount notifications causing global redraw churn.
  Fix `a0382f8f` has a failing-before/passing-after multi-owner regression and bounded renderer queue.
- Review: the 10-minute bound is suite-wide; individual waits remain bounded. Focus selection uses
  an allowlist; packaged mode cannot silently take a focused development path. Packaged helper uses
  public APIs and remains pending validation against the final GitHub Actions artifact.
- Existing full-suite failures: 26 assertions reproduced in independent committed baseline 0273980c.
  This report does not claim full npm test, final packaging, or real Autobiz acceptance.
