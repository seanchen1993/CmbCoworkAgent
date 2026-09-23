# Whole desktop Mods workload

`node tests/run-mods-desktop-soak.mjs --smoke` validates the workload on a short run.
`node tests/run-mods-desktop-soak.mjs` requests at least two actual hours and 10,000
acknowledged Client messages. Run these from the Mods v2 worktree using Node 22.

The runner builds the ordinary application, checks that the test-only main entry is absent,
then copies all application output into a unique validation directory. Electron starts from
that frozen package root. Later builds cannot replace its main, renderer, preload or utility
bundles. Installed dependencies remain read only and must not change during the run. The
manifest records source HEAD, dirty status and hashes of the entire frozen application and test drivers.

Eight plugins are installed and approved through production IPC; all eight execute commands.
Four open real Client panes. The test changes real input controls, clicks real buttons and
counts an event only after a guest stores its sequential value and the acknowledgement returns
through the production renderer. Every 250 events it disables Mods, verifies the removal of
all panes and named Mods utility processes, re-enables Mods, reloads the renderer and checks
that persisted values survive. It never calls a guest dispatcher directly or uses the test IPC
bridge. Smoke runs use 24 messages and three reload cycles and never qualify as a full run.

Progress and raw samples are kept in the run's directory. A `STOP` file there requests bounded
cleanup; only the invocation's Electron app is closed. Process metrics and renderer heap after
forced GC are captured at multiple points within each live runtime and around reload/off.
Renderer heap and process RSS are different measurements. Qualification means that the full
workload finished; memory trends still require review. The report does not automatically
declare the absence of leaks.

Input and acknowledgement timings include Playwright scheduling and IPC. Separate in-page
probes measure trusted input to the second animation frame, and trusted click to the host
acknowledgement DOM update. Each probe removes its listeners, observer and frame callbacks
after the sample. Retain the raw values and distinct measurement scopes. This workload does not replace the separate streaming TTFT,
throughput, five-minute idle CPU or five-round tool ingress gates. Do not overlap formal
performance measurements with builds, other E2E or benchmarks.
