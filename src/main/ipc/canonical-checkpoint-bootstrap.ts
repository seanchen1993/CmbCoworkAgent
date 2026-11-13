import { getDb } from "../db"
import { getDbPath, getThreadCheckpointPath } from "../storage"
import {
  readLatestCheckpointRuntimeTupleInWorker,
  readLatestCheckpointTupleInWorker,
  type LegacyCheckpointTranscriptBootstrapResult
} from "../checkpointer/runtime-projection-client"
import { verifyCanonicalCheckpointWorkerDisplay } from "../checkpointer/function-conversation-canonical-display"
import type { ThreadIncarnation } from "../services/thread-incarnation"

/** Read-only alternative to the legacy writer, admitted by complete native checkpoint proofs. */
export async function readCanonicalCheckpointBootstrap(input: {
  threadId: string
  workspace: string
  incarnation: ThreadIncarnation
  foregroundKey: string
  assertCurrent(): void
}): Promise<LegacyCheckpointTranscriptBootstrapResult | null> {
  const fixed = Object.freeze({ ...input, incarnation: Object.freeze({ ...input.incarnation }) })
  fixed.assertCurrent()
  const database = getDb()
  if (
    !database.exec(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND " +
        "name='function_conversation_checkpoint_receipts'"
    )[0]?.values.length
  )
    return null
  const incarnationKey = JSON.stringify(
    fixed.incarnation.token !== null
      ? ["token", fixed.incarnation.token]
      : ["legacy", fixed.incarnation.legacyCreatedAt]
  )
  // Discovery only. A miss keeps the original ordinary-source classification in the bridge;
  // a hit must still pass the exact checkpoint's full canonical display verification.
  if (
    !database.exec(
      "SELECT 1 FROM function_conversation_checkpoint_receipts " +
        "WHERE checkpoint_thread_id=? AND checkpoint_incarnation=? AND checkpoint_namespace='' LIMIT 1",
      [fixed.threadId, incarnationKey]
    )[0]?.values.length
  )
    return null
  fixed.assertCurrent()
  const databasePath = getThreadCheckpointPath(fixed.threadId)
  const runtimeTuple = await readLatestCheckpointRuntimeTupleInWorker(
    databasePath,
    fixed.threadId,
    "",
    fixed.foregroundKey
  )
  fixed.assertCurrent()
  const head = runtimeTuple as { checkpoint?: { id?: unknown } } | null
  const checkpointId = head?.checkpoint?.id
  if (typeof checkpointId !== "string" || !checkpointId) return null
  if (
    !database.exec(
      "SELECT 1 FROM function_conversation_checkpoint_receipts " +
        "WHERE checkpoint_thread_id=? AND checkpoint_incarnation=? AND checkpoint_namespace='' " +
        "AND checkpoint_id=? LIMIT 1",
      [fixed.threadId, incarnationKey, checkpointId]
    )[0]?.values.length
  )
    return null
  fixed.assertCurrent()
  let complete = false
  await readLatestCheckpointTupleInWorker(databasePath, fixed.threadId, "", {
    messageLimit: 1,
    messageByteBudget: 64 * 1024,
    foregroundKey: fixed.foregroundKey,
    nativeDisplay: {
      messageDatabasePath: getDbPath(),
      threadId: fixed.threadId,
      workspace: fixed.workspace,
      incarnation: fixed.incarnation,
      checkpointId
    },
    assertSource: fixed.assertCurrent,
    verifyDisplay: (value) =>
      verifyCanonicalCheckpointWorkerDisplay(
        value,
        fixed.threadId,
        checkpointId,
        fixed.assertCurrent,
        () => {
          complete = true
        }
      )
  })
  fixed.assertCurrent()
  if (!complete) return null
  return {
    runtimeTuple,
    stats: { checkpointId, totalMessages: 0, migratedMessages: 0, batches: 0, payloadBytes: 0 }
  }
}
