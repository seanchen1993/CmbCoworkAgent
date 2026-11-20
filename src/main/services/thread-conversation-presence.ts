import {
  getBoundedThreadConversationPresence,
  getLegacyCheckpointMigrationStatus,
  type LegacyCheckpointMigrationStatus,
  type ThreadVisibleMessagePresence
} from "../db"
import { hasVisibleCheckpointTranscriptInWorker } from "../checkpointer/runtime-projection-client"
import { getThreadCheckpointPath } from "../storage"
import { readThreadMessagesPageInWorker } from "../thread-message-hydration/client"

export interface ThreadConversationPresenceSnapshot {
  durablePresence: ThreadVisibleMessagePresence
  legacyMigrationStatus: LegacyCheckpointMigrationStatus
  checkpointHasTranscript?: boolean
}

/**
 * Resolve a mutation guard without confusing internal plumbing rows with a
 * user-visible conversation. Unknown/bounded-overflow and interrupted legacy
 * copies fail closed. A completed migration makes the durable table authoritative.
 */
export function resolveThreadConversationPresenceForMutation(
  snapshot: ThreadConversationPresenceSnapshot
): ThreadVisibleMessagePresence {
  if (snapshot.durablePresence !== "empty") return snapshot.durablePresence
  if (snapshot.legacyMigrationStatus === "migrating") return "unknown"
  if (snapshot.legacyMigrationStatus === "complete") return "empty"
  if (snapshot.checkpointHasTranscript === undefined) return "unknown"
  return snapshot.checkpointHasTranscript ? "nonempty" : "empty"
}

function readDurablePresenceSnapshot(threadId: string): ThreadConversationPresenceSnapshot {
  return {
    durablePresence: getBoundedThreadConversationPresence(threadId),
    legacyMigrationStatus: getLegacyCheckpointMigrationStatus(threadId)
  }
}

async function readExactDurablePresenceSnapshot(
  threadId: string
): Promise<ThreadConversationPresenceSnapshot> {
  const page = await readThreadMessagesPageInWorker(threadId, {
    limit: 1,
    byteBudget: 64 * 1024,
    includeVisibleMessagePresence: true
  })
  return {
    durablePresence:
      page.hasVisibleMessages === true
        ? "nonempty"
        : page.hasVisibleMessages === false
          ? "empty"
          : "unknown",
    legacyMigrationStatus:
      page.legacyCheckpointMigrationStatus ?? getLegacyCheckpointMigrationStatus(threadId)
  }
}

/**
 * Bounded, fail-closed source of truth shared by mode and workspace mutations.
 * Only a truly row-less pre-migration task consults the isolated checkpoint
 * worker; after that await, durable state is sampled again to close the race.
 */
export async function readThreadConversationPresenceForMutation(
  threadId: string,
  options: { checkpointForegroundKey?: string | number } = {}
): Promise<ThreadVisibleMessagePresence> {
  let durable = readDurablePresenceSnapshot(threadId)
  if (durable.durablePresence === "nonempty") return "nonempty"
  if (durable.durablePresence === "unknown") {
    // Keep large-row JSON parsing and an exact scan of long internal-only
    // histories out of Electron main. Callers hold the thread mutation lock,
    // so this worker snapshot remains valid until the guarded mutation commits.
    durable = await readExactDurablePresenceSnapshot(threadId)
  }
  if (durable.durablePresence !== "empty" || durable.legacyMigrationStatus !== null) {
    return resolveThreadConversationPresenceForMutation(durable)
  }

  const checkpointHasTranscript = await hasVisibleCheckpointTranscriptInWorker(
    getThreadCheckpointPath(threadId),
    threadId,
    "",
    options.checkpointForegroundKey
  )
  const latest = readDurablePresenceSnapshot(threadId)
  if (latest.durablePresence === "nonempty") return "nonempty"
  if (latest.legacyMigrationStatus === "migrating") return "unknown"
  if (latest.legacyMigrationStatus === "complete") return "empty"
  // A long internal-only durable history still reports `unknown` to the
  // bounded main-thread sampler. The exact worker result above proved it empty
  // while the mutation lock excluded transcript writes, so retain that proof.
  if (latest.durablePresence === "unknown" && durable.durablePresence !== "empty") {
    return "unknown"
  }
  return checkpointHasTranscript ? "nonempty" : "empty"
}
