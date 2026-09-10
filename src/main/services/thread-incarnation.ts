import { randomUUID } from "crypto"

/** Reserved main-process metadata field. Renderer patches cannot write this key. */
export const THREAD_INCARNATION_METADATA_KEY = "cmb_thread_incarnation"

export interface ThreadIncarnationRow {
  created_at: number
  metadata: string | null
}

export interface ThreadIncarnation {
  token: string | null
  legacyCreatedAt: number
}

export function createThreadIncarnationToken(): string {
  return randomUUID()
}

export function readThreadIncarnationToken(rawMetadata: string | null): string | null {
  if (!rawMetadata) return null
  try {
    const metadata = JSON.parse(rawMetadata) as unknown
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null
    const value = (metadata as Record<string, unknown>)[THREAD_INCARNATION_METADATA_KEY]
    return typeof value === "string" && value.length > 0 ? value : null
  } catch {
    return null
  }
}

/**
 * New rows carry a UUID. Legacy rows fall back to their persisted creation timestamp; a recreated
 * row always receives a UUID, so even a same-millisecond delete/recreate cannot compare equal.
 */
export function captureThreadIncarnation(row: ThreadIncarnationRow): ThreadIncarnation {
  return {
    token: readThreadIncarnationToken(row.metadata),
    legacyCreatedAt: Number(row.created_at)
  }
}

export function matchesThreadIncarnation(
  row: ThreadIncarnationRow | null | undefined,
  expected: ThreadIncarnation
): boolean {
  if (!row) return false
  const latest = captureThreadIncarnation(row)
  if (expected.token !== null || latest.token !== null) {
    return expected.token !== null && latest.token === expected.token
  }
  return latest.legacyCreatedAt === expected.legacyCreatedAt
}

export function attachFreshThreadIncarnation(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    [THREAD_INCARNATION_METADATA_KEY]: createThreadIncarnationToken()
  }
}

/**
 * Preserve the database-owned incarnation field across whole-metadata replacements.
 *
 * The field is deliberately copied from the persisted row instead of trusting the
 * replacement. This means a caller can neither delete an existing token nor smuggle
 * a chosen token onto a legacy row.
 */
export function preserveThreadIncarnationMetadata(
  existingRawMetadata: string | null,
  replacementRawMetadata: string | null
): string {
  let replacement: Record<string, unknown>
  try {
    const parsed = replacementRawMetadata ? (JSON.parse(replacementRawMetadata) as unknown) : {}
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("Thread metadata replacement must be a JSON object")
    }
    replacement = { ...(parsed as Record<string, unknown>) }
  } catch (error) {
    if (error instanceof TypeError) throw error
    throw new TypeError("Thread metadata replacement must be valid JSON", { cause: error })
  }

  const existingToken = readThreadIncarnationToken(existingRawMetadata)
  if (existingToken) {
    replacement[THREAD_INCARNATION_METADATA_KEY] = existingToken
  } else {
    delete replacement[THREAD_INCARNATION_METADATA_KEY]
  }
  return JSON.stringify(replacement)
}
