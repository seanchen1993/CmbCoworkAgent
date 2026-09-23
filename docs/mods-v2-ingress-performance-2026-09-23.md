# Mods v2 application tool ingress performance harness

`tests/run-mods-v2-ingress-performance.ts` measures a real production tool ingress in an isolated Electron main process. It does not call the FunctionSession hook dispatcher directly as a substitute for the host path.

The timed path is `withModToolCall → ModsManager → FunctionModsManager → FunctionSession → utilityProcess QuickJS → LocalSandbox.read`, including the configured native permission, classic hook, audit and publication paths. Each enabled profile must produce a real `host:read_file` audit receipt. Temporary pass-through plugins update a counted hop and a distinct input bit, so bypassed or fail-open guests fail the sample's correctness check. This small instrumentation is included in the timing.

Run from the Mods v2 worktree with Node 22:

```powershell
node --import tsx tests/run-mods-v2-ingress-performance.ts --smoke
node --import tsx tests/run-mods-v2-ingress-performance.ts
```

The first command is a functional smoke run: one round, ten measured samples and three warmups per profile. The second requests five rounds, 1,000 measured samples and 100 warmups per profile. Explicit `--rounds=N`, `--samples=N` and `--warmups=N` are supported within validated bounds. Reduced runs never qualify for the full matrix.

The enabled matrix covers 0, 1 and 8 plugins, alternates profile order between rounds and records cold-start latency separately. Project-off and global-off profiles each alternate baseline/disabled order on the same LocalSandbox instance. Baseline omits the manager, while the disabled arm keeps the actual manager configured off. Both arms use the same real file read. Disabled arms must have zero additional function plugin discoveries and zero additional runtime starts.

Each invocation creates its own date/UUID directory under `output/mods-v2-validation/v2-ingress-*`, isolated profile, HOME/app-data/temp roots, temporary plugins and SQLite control store. It builds independent bundles in that directory without writing `out`, running electron-vite, installing dependencies or modifying a worktree. `run.json` records the Git HEAD, bundle SHA-256 hashes, exact options, owned PIDs and STOP file. `result.json`, progress and raw per-round samples are retained. Writing the run's STOP file requests bounded cleanup of that invocation; its launcher never enumerates or kills other Electron processes.

The fixed budgets are disabled p95 delta ≤5% and single-plugin total measured ingress p95 ≤15 ms. Absolute baseline/disabled p50 and p95, delta milliseconds and delta percent are all recorded. A qualified matrix with any failed budget exits with code 2. Functional failures exit with code 1. Smoke output retains budget failures but cannot pass the performance gate.

This is an application **tool ingress** fixture, not a whole desktop application performance result. The host callbacks match production routing, but fixture-owned thread/lease and plugin roots replace the application thread database and installed-plugin settings. Output policy is off in every profile. Renderer/IPC latency, four-panel input latency, streaming TTFT/throughput, whole-app idle CPU, UI lifecycle stress and the two-hour application soak remain separate gates. A raw utility host soak and this ingress matrix must not be relabeled as those measurements.

Run the formal matrix only when other heavy builds, E2E and benchmarks are idle. Keep unsuccessful and noisy runs; do not adjust thresholds or drop outliers to manufacture a pass.


## Diagnostic attribution

`--profile --rounds=1 --samples=100 --warmups=10` instruments control-store calls and asynchronous guest/native boundaries
inside the measured enabled samples. It keeps the actual FULL-durability database operations,
permissions and original runtime dispatch. `storeCosts` reports call counts and total/mean/p95/max
milliseconds for claim, settle, grant/settings reads, publication and final-input binding.
Configuration, cold calls and warmups are excluded. Nested timings are inclusive: assertGrant
includes getGrant; guest.invoke includes nested native.dispatch and lower guests, so these totals must not be added together. native.dispatch includes the real LocalSandbox read and its permission/classic/audit path. The instrumentation has overhead;
these runs are explicitly disqualified from the acceptance matrix, even with five full rounds.
Do not run the diagnostic or acceptance matrix alongside builds/E2E or another benchmark.
