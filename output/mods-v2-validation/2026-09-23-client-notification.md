# Client notification responsiveness — 2026-09-23

Base 0f441efb. Live Client changes were held behind the ordinary Pane 100 ms notification batch. The host now coalesces Client notifications over 16 ms and can bring forward an outstanding ordinary batch. An already earlier notification is never postponed; ordinary Pane invalidation stays at 100 ms. One timer serves the batch and close still cancels it. No authority, callback, grant, publication or guest scheduling path changes.

Review checked bursts cannot reset the deadline indefinitely, expedited notifications do not leave a second pending timer, no callback survives close, and the changed frame cadence only applies while Clients actually change. Active animations may notify at up to the existing 16 ms Client frame cadence; this is why whole-app idle/soak measurements remain required.

- Regression first: 2 failed / 1 passed for Client batching and expediting; final suite has 4 cases, including retaining an earlier deadline.
- Real guest/session panes, Client lifecycle and focus narrow suites: 5 files / 51 tests pass before the last deadline regression; Mods30 includes all four final tests.
- Mods30: 167 files / 1267 tests pass. Node/Web typecheck exit 0, scoped ESLint 0 errors / 0 warnings.
- Electron30: 156 checks pass, exit 0; ordinary build restored. Archived `2026-09-23-electron-30-artifacts`.
- Frozen whole-desktop smoke4: `desktop-soak-2026-09-23T14-35-09-458Z-smoke-ca19ea05`, 8 plugins / 4 panes / 24 acknowledged messages / 3 off and reload cycles, exit 0. Compared with smoke3, trusted click-to-host-ack p95 283.8 → 204.1 ms; trusted input-to-second-frame 13.3 → 9.9 ms. Small diagnostics, not a formal latency acceptance claim.
- Electron30 off native read p95 3.7083 / 3.8600 ms (+4.0908%); noop1000 p95 9.3261 ms, pending 0. Earlier formal real-ingress budget failures remain valid and are not replaced by these single-run figures.

The independent full desktop idle/streaming measurement and two-hour soak are still pending. This commit improves a measured delay; it does not certify all performance gates or business acceptance.
