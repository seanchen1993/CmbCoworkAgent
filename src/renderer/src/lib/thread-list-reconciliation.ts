import type { Thread } from "@/types"

function timestamp(value: Date): number {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

export function canReuseThreadSummary(previous: Thread, next: Thread): boolean {
  // Every persisted metadata/status/title write advances updated_at. Use that
  // durable revision instead of walking or serializing an arbitrarily large
  // metadata object again in the renderer after each focus refresh.
  return (
    previous.thread_id === next.thread_id &&
    timestamp(previous.created_at) === timestamp(next.created_at) &&
    timestamp(previous.updated_at) === timestamp(next.updated_at) &&
    previous.status === next.status &&
    previous.title === next.title
  )
}

/**
 * Preserve stable thread objects across list refreshes. A no-op focus refresh
 * then keeps the array reference too, so chat/project surfaces do not rerender
 * merely because IPC structured-cloned the same summaries again.
 */
export function reconcileThreadSummaries(
  previous: readonly Thread[],
  incoming: readonly Thread[]
): Thread[] {
  if (previous.length === 0) return incoming as Thread[]

  const previousById = new Map(previous.map((thread) => [thread.thread_id, thread]))
  let unchanged = previous.length === incoming.length
  const reconciled = incoming.map((thread, index) => {
    const existing = previousById.get(thread.thread_id)
    const next = existing && canReuseThreadSummary(existing, thread) ? existing : thread
    if (next !== previous[index]) unchanged = false
    return next
  })

  return unchanged ? (previous as Thread[]) : reconciled
}
