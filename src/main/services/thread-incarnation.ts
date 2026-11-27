import { randomUUID } from "crypto"

import {
  THREAD_INCARNATION_METADATA_KEY,
  matchesThreadIncarnationSnapshot,
  type ThreadIncarnationSnapshot
} from "../../shared/thread-incarnation"

export { THREAD_INCARNATION_METADATA_KEY } from "../../shared/thread-incarnation"

export interface ThreadIncarnationRow {
  created_at: number
  metadata: string | null
}

export type ThreadIncarnation = ThreadIncarnationSnapshot

export function createThreadIncarnationToken(): string {
  return randomUUID()
}

function readStoredMetadata(rawMetadata: string | null): Record<string, unknown> | null {
  if (!rawMetadata) return null
  try {
    const metadata = JSON.parse(rawMetadata) as unknown
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null
    return metadata as Record<string, unknown>
  } catch {
    return null
  }
}

export function readThreadIncarnationToken(rawMetadata: string | null): string | null {
  const value = readStoredMetadata(rawMetadata)?.[THREAD_INCARNATION_METADATA_KEY]
  return typeof value === "string" && value.length > 0 ? value : null
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
  return matchesThreadIncarnationSnapshot(captureThreadIncarnation(row), expected)
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
 * Preserve the database-owned incarnation and project binding across whole-metadata replacements.
 *
 * The field is deliberately copied from the persisted row instead of trusting the
 * replacement. This means a caller can neither delete an existing token nor smuggle
 * a chosen token onto a legacy row.
 */
export function preserveDatabaseOwnedThreadMetadata(
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

  const stored = readStoredMetadata(existingRawMetadata)
  const existingToken = stored?.[THREAD_INCARNATION_METADATA_KEY]
  if (typeof existingToken === "string" && existingToken.length > 0) {
    replacement[THREAD_INCARNATION_METADATA_KEY] = existingToken
  } else {
    delete replacement[THREAD_INCARNATION_METADATA_KEY]
  }
  if (stored && Object.hasOwn(stored, "chatProject")) replacement.chatProject = stored.chatProject
  else delete replacement.chatProject
  return JSON.stringify(replacement)
}
