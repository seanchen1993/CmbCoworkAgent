export const HOOK_LOG_ENTRIES_PER_BUCKET_LIMIT = 200

export function appendBoundedHookLogEntry<T>(entries: readonly T[], entry: T): T[] {
  if (entries.length < HOOK_LOG_ENTRIES_PER_BUCKET_LIMIT) return [...entries, entry]
  return [...entries.slice(-(HOOK_LOG_ENTRIES_PER_BUCKET_LIMIT - 1)), entry]
}
