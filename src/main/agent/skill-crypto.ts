/**
 * Base64 encoding for skill files.
 *
 * Design goals
 * ────────────
 * • Encode skill files in Base64 format for easier transport and storage.
 * • Simple encoding-only approach without actual encryption.
 * • Binary-safe: input/output are always Node Buffers; callers handle
 *   string ↔ Buffer conversion.
 *
 * Wire format (text-based)
 * ────────────────────────
 *   MAGIC (8 bytes as text) | Base64_Encoded_Content
 *   Example: "SKENC\x01\x00\x00" + base64_string
 */

// ── Constants ────────────────────────────────────────────────────────────────

/** Magic bytes written at the start of every encoded skill file. */
const MAGIC = Buffer.from("SKENC\x01\x00\x00") // 8 bytes

// ── Utility functions ────────────────────────────────────────────────────────

/**
 * Returns true if the buffer starts with the skill-encoding magic header.
 */
export function isSkillEncrypted(buf: Buffer): boolean {
  if (buf.length < MAGIC.length) return false
  return buf.subarray(0, MAGIC.length).equals(MAGIC)
}

/**
 * Encodes `plaintext` to Base64 and returns the binary buffer with magic header.
 * Format: MAGIC (8 bytes) | Base64_String (as UTF-8 bytes)
 */
export function encryptSkillBuffer(plaintext: Buffer): Buffer {
  // Convert plaintext to Base64
  const base64Content = plaintext.toString("base64")
  // Create the content: MAGIC + Base64 string (as UTF-8 bytes)
  const contentBuffer = Buffer.from(base64Content, "utf-8")
  return Buffer.concat([MAGIC, contentBuffer])
}

/**
 * Decodes a buffer that was produced by `encryptSkillBuffer`.
 * Extracts the Base64 content and decodes it back to the original plaintext.
 * Throws if the magic header is missing.
 */
export function decryptSkillBuffer(buf: Buffer): Buffer {
  if (!isSkillEncrypted(buf)) {
    throw new Error("[SkillCrypto] Buffer does not have a valid skill-encoding header")
  }

  // Extract the Base64 content (everything after the magic header)
  const base64Content = buf.subarray(MAGIC.length).toString("utf-8")

  // Decode from Base64 back to the original plaintext
  return Buffer.from(base64Content, "base64")
}

/**
 * Convenience: decode a buffer if it is encoded, otherwise return as-is.
 * Safe to call on any skill file regardless of whether it is encoded.
 */
export function decryptSkillBufferIfNeeded(buf: Buffer): Buffer {
  return isSkillEncrypted(buf) ? decryptSkillBuffer(buf) : buf
}

