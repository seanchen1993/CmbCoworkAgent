import type { Message } from "../types"

/** Resolve complete worker content before the legacy sparse-fragment fallback. */
export function resolveWorkerSnapshotContent(
  existing: Message,
  incoming: Message
): Message["content"] | undefined {
  if (!incoming.worker_content_source) return undefined
  // Values can lag behind live chunks. Match the transport accumulator's prefix
  // replay protection; explicit wire snapshots can still truncate or clear text.
  if (
    incoming.worker_content_source === "values" &&
    typeof existing.content === "string" &&
    typeof incoming.content === "string" &&
    existing.content.startsWith(incoming.content)
  ) {
    return existing.content
  }
  return incoming.content
}
