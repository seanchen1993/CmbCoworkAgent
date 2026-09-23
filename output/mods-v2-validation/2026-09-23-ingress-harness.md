# Real ingress matrix and diagnostic attribution — 2026-09-23

The independent Electron fixture traverses real withModToolCall, ModsManager, FunctionSession, utility QuickJS, LocalSandbox read, classic events, audit and publication. It preserves fixture limitations explicitly: isolated thread/lease, temporary source list, output policy off, no renderer or actual model.

Options and paired budget tests were added before implementation. Final 10 options/budget tests + 3 diagnostic tests pass. Diagnostic red async settlement (1 fail / 2 pass) was fixed; actual return values/errors are preserved. Diagnostic counts exclude setup/cold/warmups; inclusive guest/native/store costs cannot be summed. Any --profile run is disqualified even at full sample counts.

Real executions retained:
- Initial formal matrix: v2-ingress-2026-09-23T07-07-00-271Z-matrix-0d787b39, 38515 calls, 566131 ms, qualified workload, budgets failed.
- Profile baseline: v2-ingress-2026-09-23T13-54-39-813Z-matrix-d776e91c. Actual durable writes identify cost; no fake database or relaxed durability.
- Post-optimization formal: v2-ingress-2026-09-23T14-16-49-303Z-matrix-240976e7, 38515 calls / 417776 ms / activeCount 0, qualified workload, budgets failed, exit 2. Fixed 15 ms and 5% thresholds retained.

Validation includes Mods29 165 files / 1260 tests and Electron29 156 checks, Node/Web typecheck and scoped ESLint. The standalone ingress runner also builds and executes its own real main/utility bundles. It never overwrites application out or mutates dependencies. Its manifest and raw samples preserve exact run options, source HEAD, bundle hashes and owned processes. These measurements do not establish whole-app UI/idle/streaming/soak gates or Autobiz business acceptance.
