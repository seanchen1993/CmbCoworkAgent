# Classic empty-handler hot path — 2026-09-23

Base: 01efeadc, codex/mods-v2. Only the classicEvent discovery change and its new regression test belong to this capability; the older Autobiz CAS work in manager.ts is excluded from the commit.

For a live FunctionSession with no matching classic handler, avoid a repeated filesystem source discovery. Continue through the original session, publication, epoch, thread, runtime and grant checks. Disabled calls return before plugin traversal. Cold/loading sessions, disposed guests, matching and wildcard handlers keep the original discovery path. Plugin changes still use the existing invalidation route; completion evidence recapture is unchanged.

Review checked that no new shortcut invokes core without publication or grant validation, cancellation and invalidation are rechecked after awaits, and no SQLite durability/audit operation is removed. There is no new guest capability or host contract revision.

- Failing regression first: 1 failed / 3 passed (repeated discovery). Real QuickJS/FunctionSession/control store green: new test plus manager/classic session, 3 files / 58 tests. Final hotpath/profile options suite: 3 files / 17 tests.
- Node and Web typechecks exit 0; scoped ESLint has no errors. Existing file formatting warnings remain.
- Mods29: 165 files / 1260 tests pass. Electron29: 156 checks, exit 0; ordinary build restored. Artifacts: `2026-09-23-electron-29-artifacts`.
- Electron's individual off read p95: 3.8057 / 4.0394 ms (+6.1408%); noop 1000 p95 9.1666 ms, pending 0. These isolated samples do not establish the formal performance gate.
- Formal idle-host matrix `v2-ingress-2026-09-23T14-16-49-303Z-matrix-240976e7`: 5 rounds, 1000 measured + 100 warmups per profile, 38515 total calls, 417776 ms, activeCount 0. Qualified workload, **budget failed**, exit 2. Single-plugin p95 by round: 17.5474, 16.7882, 17.5031, 16.9504, 16.7639 ms; fixed limit remains 15 ms. Disabled arms made zero plugin discoveries/runtime starts; last global-off p95 +8.7933% exceeds 5%, other nine arms are within budget.
- Diagnostic comparison (100 samples, not acceptance): single-plugin p95 22.2728 → 17.7397 ms, eight-plugin 65.3976 → 47.8426 ms. Three durable writes and all original grant checks remain.

The optimization is a verified bounded improvement, not final performance, whole-desktop or business acceptance. Full application soak, idle CPU, streaming and actual Autobiz demo remain separate work.
