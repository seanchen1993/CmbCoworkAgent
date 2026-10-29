// These are file-adoption display records, also omitted by getThreadHydrationCore.
// Every other field, including unknown future fields, remains part of the source identity.
const displayMetadataKeys = new Set([
  "llmModifiedFiles",
  "llmFileHistory",
  "llmRecentlyRevertedFiles"
])

function sealedMetadata(raw: string | null): string | undefined {
  if (typeof raw !== "string") return undefined
  try {
    const value: unknown = JSON.parse(raw)
    // Do not normalize malformed, duplicate-key or non-canonical metadata into retry evidence.
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      JSON.stringify(value) !== raw
    )
      return undefined
    return JSON.stringify(Object.entries(value).filter(([key]) => !displayMetadataKeys.has(key)))
  } catch {
    return undefined
  }
}

/** An exact failed read may be replaced, never accepted with its old metadata or witnesses. */
export function createThreadDisplayMetadataGuard(
  originalMetadata: string | null,
  readCurrentMetadata: () => string | null
) {
  const retryable = new WeakSet<Error>()
  const canReplace = (current: string | null): boolean => {
    if (current === originalMetadata) return false
    const original = sealedMetadata(originalMetadata)
    return original !== undefined && sealedMetadata(current) === original
  }
  return {
    assertCurrent(): void {
      const current = readCurrentMetadata()
      if (current === originalMetadata) return
      const error = Error("MODS_CONVERSATION_THREAD_CHANGED")
      if (canReplace(current)) retryable.add(error)
      throw error
    },
    canRetryMetadata(error: unknown): boolean {
      if (!(error instanceof Error) || !retryable.has(error)) return false
      // Re-run DB, incarnation and sender guards before granting even a fresh read.
      return canReplace(readCurrentMetadata())
    }
  }
}

interface ThreadDisplayReadRetryScope {
  canRetryMetadata(error: unknown): boolean
  dispose(): void
}

const foregroundReads = new WeakMap<object, object>()

/**
 * One metadata replacement per IPC invocation; worker recovery keeps its independent budget.
 * A newer foreground request always owns the reader.
 */
export async function withThreadDisplayMetadataRetry<T, R extends ThreadDisplayReadRetryScope>(
  foregroundOwner: object | undefined,
  capture: () => R,
  read: (source: R) => Promise<T>
): Promise<T> {
  const request = {}
  if (foregroundOwner) foregroundReads.set(foregroundOwner, request)
  let original: R | undefined
  try {
    original = capture()
    try {
      return await read(original)
    } catch (error) {
      if (
        (foregroundOwner && foregroundReads.get(foregroundOwner) !== request) ||
        !original.canRetryMetadata(error)
      )
        throw error
      const replacement = capture()
      try {
        // Capture must not detach the original navigation lifetime or change its source.
        if (!original.canRetryMetadata(error)) throw error
        return await read(replacement)
      } finally {
        replacement.dispose()
      }
    }
  } finally {
    original?.dispose()
    if (foregroundOwner && foregroundReads.get(foregroundOwner) === request)
      foregroundReads.delete(foregroundOwner)
  }
}
