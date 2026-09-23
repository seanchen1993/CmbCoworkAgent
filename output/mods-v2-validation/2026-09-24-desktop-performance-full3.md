# Desktop performance full3 — qualified, failed

Code baseline: 35170ce4. Frozen artifact directory: `desktop-performance-2026-09-23T18-25-45-965Z-full-0eac1e8e`. Command: `node tests/run-mods-desktop-soak.mjs --performance`; process exit 1. Log: `2026-09-24-desktop-performance-formal-3.log`.

Actual Electron app, eight approved guests with turn.step passthrough, four Client panes, original agent loop and fixed local SSE producer. No concurrent test, build or E2E during measurement. This measures runtime overhead, not remote provider or business accuracy.

| Measure | Off | On | Outcome |
| --- | --- | --- | --- |
| CPU window (ms) | 300013.577 | 300003.132 | Both meet five-minute minimum |
| Single-core CPU percentage | 1.794499 | 1.858774 | +0.064274 points, within 0.5 |
| TTFT p95 (ms), 50 samples each | 737.4 | 940.4 | +203, FAIL >40 |
| Streaming characters/second | 263.358012 | 262.597715 | Ratio 0.997113, PASS |

110 actual requests, 938848ms elapsed. `qualified=true`, `passed=false`, `DESKTOP_PERFORMANCE_BUDGET_FAILED`. This supersedes full2's insufficient off-window duration without changing budgets. Latest ingress performance also remains over budget. Formal two-hour/10000-event soak has not run. No release performance acceptance is claimed; TTFT needs profiling and remediation.
