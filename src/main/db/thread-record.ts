import type { NativeSqliteAdapter } from "./native-sqlite-adapter"
import { attachFreshThreadIncarnation } from "../services/thread-incarnation"

/** Same row creation for personal and dedicated task Threads. No settings,
 * recent workspace, model, skills, hooks or runtime are consulted here.
 * Caller owns the transaction when combining this with another durable row. */
export function insertThreadRecord(
  database: NativeSqliteAdapter,
  threadId: string,
  metadata?: Record<string, unknown>
) {
  const now = Date.now()
  const storedMetadata = attachFreshThreadIncarnation(metadata)
  const title = (storedMetadata.title as string) || null
  const serializedMetadata = JSON.stringify(storedMetadata)
  database.run(
    `INSERT INTO threads (thread_id, created_at, updated_at, metadata, status, title)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [threadId, now, now, serializedMetadata, "idle", title]
  )
  return {
    thread_id: threadId,
    created_at: now,
    updated_at: now,
    metadata: serializedMetadata,
    status: "idle",
    thread_values: null,
    title
  }
}
