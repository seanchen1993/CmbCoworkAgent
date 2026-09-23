# Formal desktop performance full4 — 2026-09-24

Code HEAD `4e188d8c`, frozen ordinary application snapshot. Run: `node tests/run-mods-desktop-soak.mjs --performance`. No concurrent builds/tests/benchmarks during measurement; only light source/document review. Retention optimization is included; test bridge absent.

Artifacts: `desktop-performance-2026-09-23T20-26-04-922Z-full-f21f61f3/`; log `2026-09-24-desktop-performance-full4.log`. The driver completed all measurements and cleanup, exited 1 on the fixed latency budget. `qualified: true`, `passed: false`.

| Gate | Actual | Result |
| --- | --- | --- |
| Idle CPU, five real minutes each | off 1.791525 / on 1.890381 single-core points; delta 0.098856 | PASS ≤0.5 |
| TTFT p95, 50 off / 50 on | off 154.2 ms / on 221.9 ms; delta 67.7 ms | FAIL ≤40 ms |
| Identical character stream throughput | ratio 0.996589 | PASS |

Five alternating rounds, 110 actual provider requests including warmups, eight approved pass-through plugins and four Client panes during streaming. Original main agent, model adapter, preload IPC and completion loop; controlled local SSE, not an external model or business acceptance. CPU idle windows close the panes and include main/renderer/utility process metrics. First text is observed at production preload IPC, not final paint.

The previous full3 p95 delta was 203 ms. Absolute TTFT and differential improved after removing shared retention payload work, but the remaining 67.7 ms is still a failed gate. No thresholds relaxed, samples discarded or retry-to-green claim. Ingress performance and the separate two-hour/10,000-event soak remain outstanding. This run is not the soak.
