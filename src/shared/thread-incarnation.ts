/** Reserved metadata field. Renderer patches cannot write this key. */
export const THREAD_INCARNATION_METADATA_KEY = "cmb_thread_incarnation"

export interface ThreadIncarnationSnapshot {
  token: string | null
  legacyCreatedAt: number
}

export function matchesThreadIncarnationSnapshot(
  current: ThreadIncarnationSnapshot,
  expected: ThreadIncarnationSnapshot
): boolean {
  if (current.token !== null || expected.token !== null) {
    return current.token !== null && current.token === expected.token
  }
  return current.legacyCreatedAt === expected.legacyCreatedAt
}

/** SQLite composite keys must distinguish legacy rows from token-bearing rows without NULL. */
export function threadIncarnationKey(incarnation: ThreadIncarnationSnapshot): string {
  if (incarnation.token !== null && incarnation.token.length > 0) {
    return `uuid:${incarnation.token}`
  }
  if (incarnation.token === null && Number.isSafeInteger(incarnation.legacyCreatedAt)) {
    return `legacy:${incarnation.legacyCreatedAt}`
  }
  throw new TypeError("Invalid thread incarnation")
}
