# Main-session compaction hooks — 2026-09-23

The main runtime emits `classic.PreCompact` at the actual summarization boundary, after its no-progress and tool-result-only shortcuts, and before the summary model or archive writer runs. A block prevents both summary and archive work. This is the same controller used by automatic context compaction and explicit `session.compact` preparation; it is not a `beforeModel` approximation or a summary-model completion callback.

Inputs follow the local Claude Code v2.1.278 declaration (`C:/ai/claude-code-v2.1.278/mods/types/claude-code.d.ts`):

| Event | Fields | Host behavior |
| --- | --- | --- |
| PreCompact | `trigger: "manual" | "auto"`, `custom_instructions: string | null` | Runs before real summary work. `block` or `preventContinuation` cancels compaction. |
| PostCompact | `trigger: "manual" | "auto"`, `compact_summary: string` | Observes the final summary only after the checkpoint is durable and its evidence is still current. |

Both keep the existing classic base identities and go through `runHooks`, `ModsManager`, FunctionSession dispatch, authority and signal checks, and the configured legacy hook scope. Matchers inspect `trigger`. Legacy command/HTTP inputs use the same snake_case fields. A legacy PreCompact imported with `async: true` is deliberately awaited so its decision can gate the summary; this is an **adapted** behavior. PostCompact is observational: its block or error cannot undo a committed checkpoint.

Automatic compaction attaches a host-generated receipt to its final `_summarizationEvent`. A graph-local checkpointer wrapper consumes the receipt only for a matching save, awaits the existing saver and required flush, and reads the current checkpoint. It compares checkpoint ID and compaction evidence: session ID, owner, receipt, cutoff, usage boundary, archive pointer and final summary content. Concurrent replacement, including replacement under the same checkpoint ID, suppresses PostCompact. Observation-read failure logs a diagnostic and suppresses the notification without converting an already durable write into a failed write. Actual `put` and flush failures retain their original failure semantics.

Explicit compaction retains the existing preparation, fresh archive, thread mutation lease, checkpoint comparison, `updateState`, flush and authority checks. Before notification it verifies the returned checkpoint ID and persisted compaction evidence. A failed pre-commit mutation can compensate the fresh archive; a possibly committed mutation keeps its recovery pointer. Preparing a plan or successfully calling the summary model never emits PostCompact on its own.

When Mods is off and no legacy compaction hook is enabled, the dynamic host predicate skips both hooks and receipt creation. The saver wrapper only forwards ordinary operations; it adds no compaction flush or observation read. Re-enabling hooks can take effect on a later compaction without changing the original summarization algorithm.

## Compatibility limits

- Main automatic and explicit compaction are **adapted** to CmbCowork's actual summary/checkpoint lifecycle. Isolated task-subagent internal summarization is **unsupported** for these notifications; it has no inherited main-session observer.
- Notifications are **at most once within the active controller**, with at most 16 outstanding receipts. They are not a durable outbox. Process exit after a durable write but before observation can lose PostCompact; restart does not replay it. A failed put/flush consumes its receipt conservatively; a later retry does not promise another notification. This is not cross-restart exactly-once delivery.
- Missing/inherited checkpointers cannot prove a main durable commit and therefore cannot produce automatic PostCompact through this wrapper. Production main runtimes use SqlJsSaver.
- Classic JSON bounds still apply. Oversized input is not silently truncated into different evidence.
- A compaction notification is not a test PASS, business acceptance result or workflow checkpoint advancement.

## Verification

`src/main/agent/context-compaction-hooks.integration.test.ts` exercises real LangChain `createAgent`, the production summarization controller, QuickJS FunctionGuestRuntime/FunctionSession, temporary archive files and SqlJsSaver. Models are deterministic fixtures; no live provider or business acceptance is claimed. It covers enabled/disabled, manual/automatic, block, summary/budget failure, cancellation, no progress, SQLite write/flush failure, duplicate observation, external and same-ID checkpoint replacement, and failed post-commit observation reads. Manual preparation/commit is exercised with the real graph and saver; complete application runtime/IPC and Electron coverage is tracked separately by the root validation run.

The dated validation report is `output/mods-v2-validation/2026-09-23-pre-post-compact.md`.
