# Native read input evidence — 2026-09-24

Base `b076336a`; changes are confined to the native backend description, manager/engine forwarding, and regression tests. The original request and middleware/core arguments remain unchanged. LocalSandbox describes its own read alias/defaults using the same helper as its classic hook input. The initial durable claim includes that description; real post-hook authorization still binds the actual input. A rewrite still writes a new final hash. Claim, settlement, duplicate-call rejection, SQLite FULL durability, authority, grants and lease checks remain in place.

Failure first: two actual QuickJS/FunctionSession/native-read tests failed on the original hash before implementation (`read-evidence-red-2.log`). Initial test-authoring mistakes (stringifying the SDK envelope and the audit field name) were corrected rather than treated as product failures. Added middleware argument preservation, original/final hash distinction, duplicate-call rejection and disabled native-read control.

Validation:

- Five complete targeted files: 122/122 passed, including manager, engine, durable store/crash recovery and 40 real native SDK integration cases. Physical SQLite `total_changes()` confirms zero final-hash updates for unchanged native read defaults and one for a classic rewrite; actual file content reflects rewritten pagination.
- Node/Web typechecks passed. Scoped lint has zero errors; new/changed implementation sections clean, three pre-existing manager formatting warnings remain.
- Full Electron run completed 132 checks then failed at the later ToolBatch scenario: the submitted text remained in the composer in the failure screenshot. Earlier real native-read permission, rewritten-input approval, parallel identity, guest/session, completion/checkpoint, restart and off checks passed. The whole run is **not green**.
- The unchanged focused ToolBatch Electron scenario then passed all six checks, including real parallel reads, missing-file failure, off control, block, cancel and revoke. The runner exited 0 and restored ordinary output. It included the separately pending focus SDK source, unused by this scenario; that capability has its own validation. The full-run submission timing failure remains recorded, not silently dismissed.
- Qualified exclusive ingress matrix: five rounds, 1,000 samples/profile, 100 warmups, real Electron/native backend/guest runtimes, frozen bundles. Folder `v2-ingress-2026-09-23T21-05-41-167Z-matrix-6f7041be`. Single-plugin p95: **13.683, 13.518, 13.233, 13.547, 13.271 ms**, all below the unchanged 15 ms gate (previous diagnostic 16.714 ms).
- Nine of ten off comparisons passed; round 1 project-off was +14.584% (+0.3574 ms), above the fixed 5% threshold. All off profiles recorded zero discovery and runtime starts. Matrix exited 2, so **overall ingress performance still fails**. No samples removed or thresholds changed.

This optimization is not a business PASS. Desktop TTFT full4 remains +67.7 ms against 40 ms; two-hour soak and Actions installer verification remain outstanding. Only the Mods v2 worktree was changed.
