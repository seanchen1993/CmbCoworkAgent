# Checkpoint retention shared payload scan — 2026-09-24

Long-history desktop profiling found root checkpoint retention spending roughly half a second before first text, with Mods both off and on. The recursive query repeatedly visited shared snapshot payloads. It now materializes only snapshot IDs, parents and payload sizes for the selected thread's root namespace once per scan, then traverses that bounded-width relation.

The writer transaction, UNION cycle termination, per-root accounting, fork boundary selection, byte/count budgets, ordering and deletion rules are unchanged. No schema migration, cross-call cache, durability relaxation or Mods authority change. Materialization lives only inside the SQLite statement; large serialized message payloads are not copied into the materialized relation. The thread's snapshot relation is still scanned: this is not constant-time retention or a whole-project bound.

Regression and review:

- First failing test: 20 actual shared snapshots caused 210 payload-length evaluations (`2026-09-24-retention-payload-red.log`). After the change there are 20. An instrumented SQLite length function counts actual evaluations, rather than relying on elapsed-time thresholds.
- Additional independent ancestry accounting checks cover shared parents, cycles, missing ancestors, Unicode payloads and colliding IDs in a different thread/namespace. Existing competing-writer test still attempts the write during the retention snapshot and verifies it is locked out until commit.
- Entire checkpointer Vitest directory: 7 files, 87 tests passed (`retention-payload-final.log`, date prefix as above). Five standalone suites passed: message delta, checkpoint fork, reopen performance, LRU leases and thread cleanup. This is targeted regression, not a new full-repository green claim.
- Node TypeScript passed after final tests; Web TypeScript passed in the preceding runtime capability and no renderer/types changed here. Scoped ESLint: zero errors, 21 existing format warnings outside the changed lines. Modified files normalized to LF without unrelated source formatting.
- Original application session-recovery Electron passed: 1,002 original messages preserved individually; after two turns 1,006 durable messages with no loss/duplicates; complete Electron restart, strict checkpoint read and stream persistence scenarios passed (`retention-session-electron.log`, screenshots and persistence-results.json retained).
- Mods completion Electron: 13 checks passed (`retention-mods-electron.log`), including actual guest/session, native unit failure and repair/recheck, pinned validator, once-only checkpoint, disabled controls and recovery inspection. Ordinary bundles restored. This controlled model producer is not business-model acceptance.

Performance diagnosis, same 40-call history warmup and intrusive profiler:

| Measurement | Before off / on | After off / on |
| --- | --- | --- |
| Retention sampled inclusive CPU before first text | 541.080 / 528.537 ms | 33.071 / 35.653 ms |
| Invocation-to-first-text of profiled call | 658.8 / 697.3 ms | 158.8 / 217.2 ms |

Artifacts: `2026-09-24-desktop-profile-warm/` and `2026-09-24-retention-profile-warm/`. Inspector startup sample excluded from CPU attribution. These are small diagnostic samples, not accepted latency/CPU gates; after-run two-sample p95 delta is still 58.4 ms. Formal desktop full3 and ingress failures remain until new qualified runs; no outliers removed or thresholds relaxed. The off path benefits from the same core query improvement.

Only Mods v2 worktree changed; UAT, shared dependencies and release packaging untouched.
