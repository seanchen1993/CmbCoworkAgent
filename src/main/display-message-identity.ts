import { createHash } from "node:crypto"

export const MAX_BOUNDED_TRANSCRIPT_ID_LENGTH = 256
const DISPLAY_ID_HASH_PREFIX = {
  "tool-call": "cmb-checkpoint-tool-id:sha256:",
  "provider-source": "cmb-checkpoint-provider-id:sha256:"
}

export type DisplayMessageIdKind = keyof typeof DISPLAY_ID_HASH_PREFIX

export function formatDisplayMessageIdHash(hash: string, kind: DisplayMessageIdKind): string {
  return DISPLAY_ID_HASH_PREFIX[kind] + hash
}

export function projectDisplayMessageId(id: string, kind: DisplayMessageIdKind): string {
  const prefix = DISPLAY_ID_HASH_PREFIX[kind]
  const displayId = kind === "provider-source" ? id.trim() : id
  if (kind === "provider-source" && !displayId) return ""
  if (id.length <= MAX_BOUNDED_TRANSCRIPT_ID_LENGTH && !displayId.startsWith(prefix)) {
    return id
  }
  // Match the checkpoint's encoded JSON token without allocating another copy
  // of a long ID. Keep UTF-16 surrogate pairs together across chunks.
  const hash = createHash("sha256").update('"')
  for (let start = 0; start < id.length;) {
    let end = Math.min(start + 4096, id.length)
    const high = id.charCodeAt(end - 1)
    const low = id.charCodeAt(end)
    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) end -= 1
    hash.update(JSON.stringify(id.slice(start, end)).slice(1, -1))
    start = end
  }
  return formatDisplayMessageIdHash(hash.update('"').digest("hex"), kind)
}
