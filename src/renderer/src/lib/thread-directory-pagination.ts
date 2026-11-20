import type { Thread } from "@/types"
import { canReuseThreadSummary } from "./thread-list-reconciliation"

export interface ThreadDirectoryMergeOptions {
  requestMutationEpoch: number
  mutationEpochById: ReadonlyMap<string, number>
  knownIndexById?: ReadonlyMap<string, number>
  /** True when the returned first page is the complete server directory. */
  completeSnapshot?: boolean
  /** Old rows at or ahead of this boundary were part of the authoritative page range. */
  authoritativePageBoundary?: Thread
}

function updatedAt(thread: Thread): number {
  const value =
    thread.updated_at instanceof Date
      ? thread.updated_at.getTime()
      : new Date(thread.updated_at).getTime()
  return Number.isFinite(value) ? value : 0
}

function compareNewestFirst(left: Thread, right: Thread): number {
  return updatedAt(right) - updatedAt(left) || left.thread_id.localeCompare(right.thread_id)
}

function createIndexById(threads: readonly Thread[]): Map<string, number> {
  return new Map(threads.map((thread, index) => [thread.thread_id, index]))
}

function resolveIncomingPage(
  previous: readonly Thread[],
  incoming: readonly Thread[],
  options: ThreadDirectoryMergeOptions
): Thread[] {
  const indexById = options.knownIndexById ?? createIndexById(previous)
  return incoming.flatMap((thread): Thread | [] => {
    const previousIndex = indexById.get(thread.thread_id)
    const existing = previousIndex === undefined ? undefined : previous[previousIndex]
    const mutatedAfterRequest =
      (options.mutationEpochById.get(thread.thread_id) ?? 0) > options.requestMutationEpoch
    if (mutatedAfterRequest) return existing ? existing : []
    return existing && canReuseThreadSummary(existing, thread) ? existing : thread
  })
}

/**
 * Revalidates only the newest directory page. The common no-op focus refresh
 * compares at most one bounded page and returns the original array without
 * walking a potentially huge loaded directory.
 */
export function mergeThreadDirectoryFirstPage(
  previous: readonly Thread[],
  incoming: readonly Thread[],
  options: ThreadDirectoryMergeOptions
): Thread[] {
  const resolvedPage = resolveIncomingPage(previous, incoming, options)
  const hasConcurrentMutation = [...options.mutationEpochById.values()].some(
    (epoch) => epoch > options.requestMutationEpoch
  )
  if (
    !hasConcurrentMutation &&
    (options.completeSnapshot
      ? resolvedPage.length === previous.length
      : resolvedPage.length > 0 || previous.length === 0) &&
    resolvedPage.length <= previous.length &&
    resolvedPage.every((thread, index) => thread === previous[index])
  ) {
    return previous as Thread[]
  }

  const pageIds = new Set(resolvedPage.map((thread) => thread.thread_id))
  const protectedThreads: Thread[] = []
  const tail: Thread[] = []
  for (const thread of previous) {
    if (pageIds.has(thread.thread_id)) continue
    if ((options.mutationEpochById.get(thread.thread_id) ?? 0) > options.requestMutationEpoch) {
      protectedThreads.push(thread)
      continue
    }
    if (options.completeSnapshot) continue
    if (
      options.authoritativePageBoundary &&
      compareNewestFirst(thread, options.authoritativePageBoundary) <= 0
    ) {
      continue
    }
    tail.push(thread)
  }
  const prefix = [...resolvedPage, ...protectedThreads].sort(compareNewestFirst)
  return [...prefix, ...tail]
}

/** Append one or more older server pages while preserving local mutations. */
export function appendThreadDirectoryPages(
  previous: readonly Thread[],
  incoming: readonly Thread[],
  options: ThreadDirectoryMergeOptions
): Thread[] {
  const indexById = options.knownIndexById ?? createIndexById(previous)
  const resolvedPage = resolveIncomingPage(previous, incoming, {
    ...options,
    knownIndexById: indexById
  })
  let next: Thread[] | null = null
  const appended: Thread[] = []
  for (const thread of resolvedPage) {
    const previousIndex = indexById.get(thread.thread_id)
    if (previousIndex === undefined) {
      appended.push(thread)
      continue
    }
    if (thread !== previous[previousIndex]) {
      next ??= [...previous]
      next[previousIndex] = thread
    }
  }
  if (appended.length === 0) return next ?? (previous as Thread[])
  return [...(next ?? previous), ...appended]
}

export function indexThreadDirectory(threads: readonly Thread[]): Map<string, number> {
  return createIndexById(threads)
}
