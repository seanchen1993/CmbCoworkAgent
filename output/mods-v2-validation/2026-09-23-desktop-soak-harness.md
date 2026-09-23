# Whole desktop soak harness — 2026-09-23

Base 867cb119. This commit adds validation infrastructure and focused Electron selection, not a new production capability. Ordinary builds and the default integrated Electron suite retain their existing paths and deadline.

- Options tests first failed on missing implementation, then passed; an additional malformed duration/event evidence regression failed before validation was added. Final: 3 tests pass, smoke never qualifies.
- Initial Electron smoke failed at production command argument validation (MODS_COMMAND_ARGS); fixture now sends the required text argument. No production validation was relaxed.
- Smoke2 and Smoke3: real frozen ordinary Electron application, production IPC, SQLite, installed/approved eight guests, four real Client panes, 24 sequential persisted acknowledgements, three off/on runtime + renderer reload cycles. Both exit 0. Off removes all panes and named Mods utility processes; all counts survive replacement. Screenshots reviewed.
- Smoke3 artifacts: `2026-09-23-desktop-soak-smoke-3`; frozen app and hashes: `desktop-soak-2026-09-23T14-24-35-305Z-smoke-5a9e0ee0/application` and its parent run.json. Driver source changed between those smoke runs; new full runner records driver hashes separately.
- Smoke3 input automation p95 36.2623 ms, acknowledgement automation p95 418.6658 ms. Separate trusted DOM input-to-second-frame p95 13.3 ms; click-to-host-acknowledgement p95 283.8 ms. These are 24-sample diagnostics, not the final latency gate.
- Real renderer post-GC heap and all app process metrics retained at repeated live/off/reloaded points. This validates measurement and cleanup only; **two-hour / 10,000-event acceptance has not run yet**. Model stream and idle CPU gates remain separate.
- Node/Web typechecks exit 0. New support/runner lint has no errors; combined root E2E lint has 0 errors / 88 formatting warnings (existing large suite is not reformatted).

Review checked isolated storage, immutable application copy, manifest hashes, explicit smoke handling (clears inherited smoke flag for full runs), existing dependencies read only, no private test bridge, host ack count rather than optimistic state, sequential persistent value verification, bounded per-action waits, named process cleanup, and cancellation via per-run STOP file. In-page latency listeners/observer/frame handles are removed after each sample. RSS is not mislabeled as post-GC main/utility heap and workload qualification does not automatically certify absence of memory growth.
