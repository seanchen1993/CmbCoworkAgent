# Runtime elapsed-time budgets — 2026-09-24

Function guest execution slices, CPU windows, pending invocation deadlines, utility heartbeat and reply deadlines now use process-local monotonic time. Clock correction cannot indefinitely extend an invocation or unload a healthy runtime. Public wall-clock values, authority, generation, cancellation, watchdog intervals and configured limits are unchanged.

Three regressions failed before implementation: frozen-wall pending guest, forward-jump live guest and forward-jump healthy utility (`runtime-clock-red.log`). An additional test keeps heartbeats alive while withholding the reply and freezing wall time: the original reply deadline still expires and unloads the generation.

Validation (all filenames below have prefix `2026-09-24-`):

- Four narrow files, 52 tests passed (`runtime-clock-final.log`), including real QuickJS, original FunctionSession and stream dispatcher tests.
- Real Electron utility/session suite: 41 checks passed (`runtime-clock-process.log`), including a 350 ms host call across a one-hour wall-clock correction. The first new harness assertion incorrectly compared the invocation envelope; corrected to assert its value, then the entire suite passed. Runtime/frame/reply/pending/call cleanup remains covered.
- Electron application completion suite: 13 checks passed (`runtime-clock-electron.log`); production bundle restored. Global/project off controls, real failing native test, repair/recheck, checkpoint approval, pinned validator, duplicate completion and recovery inspection all passed. Local protocol producer is a test fixture, not real-model business acceptance.
- Node and Web TypeScript passed; all five changed runtime/harness files passed ESLint without warnings (`runtime-clock-lint-final.log`). Code review confirmed all converted fields are private elapsed-time values, never persisted or compared across processes.
- Integration performance diagnostic: warmed two-hook/matcher p95 7.935 ms, pane p95 12.077 ms, Client p95 33.052 ms. This run overlapped typechecking and is not a formal performance acceptance. Formal desktop TTFT and ingress gates remain failed, and the two-hour soak remains pending. Off controls above execute no completion gate.

Only the Mods v2 worktree changed. No UAT, shared dependencies, installer build or release action.
