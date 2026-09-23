# PreCompact / PostCompact validation — 2026-09-23

Worktree: `C:/ai/CmbCoworkAgent-mods-v2`; no UAT changes, dependency install, build or commit by this subtask.

## Implementation and review

- Pre is co-located with real summarization, after shortcuts and before model/archive work. Manual uses the same controller.
- Auto Post requires host receipt, real saver put/flush, current checkpoint ID and compaction evidence match. Manual Post follows the existing runtime mutation lock/updateState/flush plus final ID/evidence/authority checks.
- Classic field validation, matcher and legacy snake_case inputs updated; Pre imported async is an awaited gate. Hook configuration support and two existing UI explanations updated.
- Independent review found and fixed post-commit read errors incorrectly propagating as write errors, production-disabled callbacks still producing receipts/extra durability I/O, and same-ID concurrent content replacement. Owner is also included in the evidence comparison.
- At-most-once in-memory observation is explicit; no outbox, cross-restart notification guarantee, or business PASS claim.

## Test-first evidence

| Log | Initial expected failure |
| --- | --- |
| `2026-09-23-pre-post-compact-red.log` | Six real integration cases: missing checkpoint observer API. |
| `2026-09-23-compact-fields-red.log` | Missing `trigger` / `custom_instructions`. |
| `2026-09-23-compact-contract-red.log` | Incomplete compaction input incorrectly accepted. |
| `2026-09-23-compact-async-red.log` | Imported async Pre returned unblocked before its gate settled. |
| `2026-09-23-compact-review-red.log` | Durable mutation rejected on observation read failure. Disabled case had an incidental QuickJS initialization error under simultaneous full-suite/build load; its final green run validates the actual disabled behavior. |
| `2026-09-23-compact-same-id-red.log` | Same-ID replacement incorrectly published Post. |
| `2026-09-23-compact-owner-red.log` | Changed owner incorrectly matched the old evidence. |

## Validation results

- Final focused run: **5 files / 120 tests PASS**, recorded in `2026-09-23-pre-post-compact-green.log` (09:49; 3.55 seconds).
- Node typecheck: **PASS / exit 0**, `2026-09-23-compact-typecheck-node.log`.
- ESLint (10 touched source/test files): **PASS / exit 0**, `2026-09-23-compact-eslint.log`.
- Touched-file `git diff --check`: **PASS / exit 0**.
- The 14 new integration cases use real createAgent + FunctionGuestRuntime/FunctionSession + filesystem archive + SqlJsSaver. The model is deterministic; this proves host lifecycle/commit wiring, not model quality or Autobiz acceptance.
- Enabled/disabled uses the same callback installation and dynamic predicate as production. Enabled block: zero summary model calls and zero archive files. Disabled: summary succeeds with no hook event, no compaction receipt and no extra `flushStrict` call.
- Existing 80 summarization regressions and classic bridge/session/schema suites are included in the final focused run, preserving retry, offload and Command behavior.

## Performance and remaining validation boundary

Ordinary checkpoint saves have only the graph-local forwarding wrapper; additional flush/read is restricted to an enabled, pending compaction receipt. Disabled integration verifies absence of that durability overhead. This is a structural/functional performance regression check, not an application p95/CPU/renderer qualification.

The independent v2 two-hour soak remains running under Electron PID 22160, run directory `v2-performance-2026-09-23T01-25-33-860Z-soak-full-25731583`. At 09:47 it had 1,835 events, eight reloads, eight active guests and zero pending frames/replies/RPC calls. Its frozen bundle predates this hook change; it must not be reported as soak coverage of new compaction code. Root owns final Electron/application performance and packaging validation. No Electron or live-provider/business acceptance result is claimed by this report.
# Parent integrated verification, 2026-09-23

Electron run 9 passed real PreCompact prevention before a provider request, successful manual
compaction with a smaller durable checkpoint and PostCompact observation, and actual automatic
compaction with Mods globally off and no hook notifications. The public checkpoint reader verifies
the persisted summary; the transcript deliberately retains original visible messages. Run 8's
incorrect transcript assertion is retained in its failure log rather than presented as a product fix.
Run 9 subsequently reached the six-minute suite watchdog while starting separate status-site tests;
it is scoped compaction evidence, not a full-suite pass. Screenshots/results are archived separately.
Combined Node/Web typecheck and changed-files ESLint (zero errors) passed. The original desktop-agent
standalone baseline also passed. Full Vitest and the expanded Electron suite are still running.
