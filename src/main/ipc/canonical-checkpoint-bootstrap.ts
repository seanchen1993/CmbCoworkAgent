import { getDb } from "../db"
import { getDbPath, getThreadCheckpointPath } from "../storage"
import { readLatestCheckpointRuntimeTupleInWorker, readLatestCheckpointTupleInWorker,
  type LegacyCheckpointTranscriptBootstrapResult } from "../checkpointer/runtime-projection-client"
import { verifyCanonicalCheckpointWorkerDisplay } from
  "../checkpointer/function-conversation-canonical-display"
import type { ThreadIncarnation } from "../services/thread-incarnation"

/** Read-only alternative to the legacy writer, admitted by complete native checkpoint proofs. */
export async function readCanonicalCheckpointBootstrap(input: {
  threadId: string
  workspace: string
  incarnation: ThreadIncarnation
  foregroundKey: string
  assertCurrent(): void
}): Promise<LegacyCheckpointTranscriptBootstrapResult | null> {
  input.assertCurrent()
  const databasePath = getThreadCheckpointPath(input.threadId)
  const runtimeTuple = await readLatestCheckpointRuntimeTupleInWorker(
    databasePath, input.threadId, "", input.foregroundKey)
  input.assertCurrent()
  const head = runtimeTuple as { checkpoint?: { id?: unknown } } | null
  const checkpointId = head?.checkpoint?.id
  if (typeof checkpointId !== "string" || !checkpointId) return null
  const database = getDb()
  if (!database.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND " +
    "name='function_conversation_checkpoint_receipts'")[0]?.values.length) return null
  // This is only a cheap candidate lookup; it never grants transcript authority.
  if (!database.exec("SELECT 1 FROM function_conversation_checkpoint_receipts " +
    "WHERE checkpoint_thread_id=? AND checkpoint_namespace='' AND checkpoint_id=? LIMIT 1",
  [input.threadId, checkpointId])[0]?.values.length) return null
  let complete = false
  await readLatestCheckpointTupleInWorker(databasePath, input.threadId, "", {
    messageLimit: 1, messageByteBudget: 64 * 1024, foregroundKey: input.foregroundKey,
    nativeDisplay: { messageDatabasePath: getDbPath(), threadId: input.threadId,
      workspace: input.workspace, incarnation: input.incarnation, checkpointId },
    assertSource: input.assertCurrent,
    verifyDisplay: value => verifyCanonicalCheckpointWorkerDisplay(value, input.threadId,
      checkpointId, input.assertCurrent, () => { complete = true })
  })
  input.assertCurrent()
  if (!complete) return null
  return { runtimeTuple, stats: { checkpointId, totalMessages: 0,
    migratedMessages: 0, batches: 0, payloadBytes: 0 } }
}
