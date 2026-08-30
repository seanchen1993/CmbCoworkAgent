import { readThreadMessagesPageInWorker } from "../thread-message-hydration/client"
import {
  isRuntimeVisiblePersistedMessage,
  persistedMessageToRuntimeMessage
} from "../ipc/persisted-runtime-message"
import type {
  CheckpointMessageRecoveryContext,
  CheckpointMessageRecoveryResult
} from "../checkpointer/sqljs-saver"

const RECOVERY_MESSAGE_LIMIT = 1_000
const RECOVERY_BYTE_BUDGET = 4 * 1024 * 1024

/**
 * Rebuild a broken root checkpoint from the authoritative durable transcript.
 * SQLite scanning and JSON decoding stay in the hydration Worker; Electron main
 * receives only the already-bounded page and constructs at most 1,000 messages.
 */
export async function recoverMainCheckpointMessages(
  context: CheckpointMessageRecoveryContext
): Promise<CheckpointMessageRecoveryResult | null> {
  if (context.checkpointNs !== "") return null
  const checkpointCreatedAt = new Date(context.checkpointTs).getTime()
  if (!Number.isFinite(checkpointCreatedAt)) return null

  const page = await readThreadMessagesPageInWorker(context.threadId, {
    limit: RECOVERY_MESSAGE_LIMIT,
    byteBudget: RECOVERY_BYTE_BUDGET,
    includeVisibleMessagePresence: true,
    notAfterCreatedAt: checkpointCreatedAt,
    recoveryCheckpointId: context.checkpointId
  })
  // A partially migrated legacy checkpoint is not an authoritative durable
  // source yet, even when the rows copied so far fit into one page.
  if (page.legacyCheckpointMigrationStatus === "migrating") return null
  if ((page.truncatedMessageIds?.length ?? 0) > 0) return null
  const seenMessageIds = new Set<string>()
  const messages = page.messages
    .filter(isRuntimeVisiblePersistedMessage)
    .filter((message) => {
      if (!message.id || seenMessageIds.has(message.id)) return false
      seenMessageIds.add(message.id)
      return true
    })
    .map(persistedMessageToRuntimeMessage)
    .filter((message): message is NonNullable<typeof message> => message !== null)

  const complete = !page.hasMore
  if (
    (context.expectedMessageCount > 0 && messages.length === 0) ||
    messages.length > context.expectedMessageCount ||
    (complete && messages.length !== context.expectedMessageCount)
  ) {
    return null
  }
  // An approval/interrupt can refer to a tool call anywhere in its exact
  // checkpoint transcript. Never replace that transcript with a bounded tail.
  if (
    context.requiresExactRecovery &&
    (!complete || messages.length !== context.expectedMessageCount)
  ) {
    return null
  }

  console.warn("[SqlJsSaver] Rebuilding missing checkpoint message snapshot", {
    threadId: context.threadId,
    checkpointId: context.checkpointId,
    missingCheckpointId: context.missingCheckpointId,
    recoveredMessages: messages.length,
    durableMessages: page.total,
    complete
  })
  return { messages, complete, boundedByHistory: page.hasMore }
}
