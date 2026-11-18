import { createHash } from "node:crypto"

export const MAX_BOUNDED_TRANSCRIPT_ID_LENGTH = 256
const TOOL_CALL_ID_HASH_PREFIX = "cmb-checkpoint-tool-id:sha256:"

export function formatDisplayToolCallIdHash(hash: string): string {
  return TOOL_CALL_ID_HASH_PREFIX + hash
}

export function projectDisplayToolCallId(id: string): string {
  if (id.length <= MAX_BOUNDED_TRANSCRIPT_ID_LENGTH && !id.startsWith(TOOL_CALL_ID_HASH_PREFIX)) {
    return id
  }
  // The oversized checkpoint reader hashes the same encoded JSON string in SQL.
  return formatDisplayToolCallIdHash(createHash("sha256").update(JSON.stringify(id)).digest("hex"))
}
