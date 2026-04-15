/**
 * Obfuscated encoding for skill files.
 *
 * Design goals
 * ────────────
 * • Encode skill files with simple obfuscation for transport and storage.
 * • Uses Base64 + string reversal to prevent trivial decoding.
 * • Binary-safe: input/output are always Node Buffers; callers handle
 *   string ↔ Buffer conversion.
 *
 * Wire format (text-based)
 * ────────────────────────
 *   MAGIC (8 bytes) | Reversed_Base64_Content
 */

// ── Constants ────────────────────────────────────────────────────────────────

/** Magic bytes written at the start of every encoded skill file. */
const MAGIC = Buffer.from("SKENC\x02\x00\x00") // 8 bytes, version 2

// ── Utility functions ────────────────────────────────────────────────────────

/**
 * Returns true if the buffer starts with the skill-encoding magic header.
 */
export function isSkillEncrypted(buf: Buffer): boolean {
  if (buf.length < MAGIC.length) return false
  return buf.subarray(0, MAGIC.length).equals(MAGIC)
}

/**
 * Encodes `plaintext` with obfuscation and returns the binary buffer with magic header.
 * Process: plaintext -> Base64 -> reverse string -> MAGIC + result
 */
export function encryptSkillBuffer(plaintext: Buffer): Buffer {
  // Convert to Base64 then reverse the string
  const base64Content = plaintext.toString("base64")
  const reversed = base64Content.split("").reverse().join("")
  // Create the content: MAGIC + reversed Base64 string
  const contentBuffer = Buffer.from(reversed, "utf-8")
  return Buffer.concat([MAGIC, contentBuffer])
}

/**
 * Decodes a buffer that was produced by `encryptSkillBuffer`.
 * Process: extract reversed Base64 -> reverse back -> decode Base64 -> original plaintext
 * Throws if the magic header is missing.
 */
export function decryptSkillBuffer(buf: Buffer): Buffer {
  if (!isSkillEncrypted(buf)) {
    throw new Error("[SkillCrypto] Buffer does not have a valid skill-encoding header")
  }

  // Extract the reversed Base64 content
  const reversed = buf.subarray(MAGIC.length).toString("utf-8")

  // Reverse it back to get original Base64
  const base64Content = reversed.split("").reverse().join("")

  // Decode from Base64
  return Buffer.from(base64Content, "base64")
}

/**
 * Convenience: decode a buffer if it is encoded, otherwise return as-is.
 * Safe to call on any skill file regardless of whether it is encoded.
 */
export function decryptSkillBufferIfNeeded(buf: Buffer): Buffer {
  return isSkillEncrypted(buf) ? decryptSkillBuffer(buf) : buf
}
