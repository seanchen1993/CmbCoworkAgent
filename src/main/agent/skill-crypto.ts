/**
 * Lightweight AES-256-GCM encryption/decryption for premium skill files.
 *
 * Design goals
 * ────────────
 * • Protect premium skill content stored on disk from casual inspection.
 * • Key is derived deterministically from a compile-time app secret combined
 *   with a per-installation salt so the key is unique per machine/installation.
 * • Binary-safe: input/output are always Node Buffers; callers handle
 *   string ↔ Buffer conversion.
 *
 * Wire format  (all binary)
 * ─────────────────────────
 *   MAGIC (8 bytes)  | IV (12 bytes) | AUTH_TAG (16 bytes) | CIPHERTEXT
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

// ── Constants ────────────────────────────────────────────────────────────────

/** Magic bytes written at the start of every encrypted skill file. */
const MAGIC = Buffer.from("SKENC\x01\x00\x00") // 8 bytes

const IV_LEN = 12
const TAG_LEN = 16
const HEADER_LEN = MAGIC.length + IV_LEN + TAG_LEN // 36 bytes

// A compile-time secret mixed into the derived key.
// Not a secret on its own — security relies on the combination with the
// per-installation salt stored in ~/.cmbcoworkagent/skill.salt.
const APP_SECRET = "CmbCoworkAgent::SkillEncryption::v1::2026"

// ── Key management ───────────────────────────────────────────────────────────

let _cachedKey: Buffer | null = null

function getSaltPath(): string {
  const dir = join(homedir(), ".cmbcoworkagent")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, "skill.salt")
}

function getOrCreateSalt(): Buffer {
  const saltPath = getSaltPath()
  if (existsSync(saltPath)) {
    const content = readFileSync(saltPath)
    if (content.length === 32) return content
  }
  // First run: generate a random 32-byte salt and persist it.
  const salt = randomBytes(32)
  writeFileSync(saltPath, salt, { mode: 0o600 })
  return salt
}

/**
 * Returns the 32-byte AES key used for all skill file encryption.
 * Derived once per process lifetime and cached.
 */
export function getSkillEncryptionKey(): Buffer {
  if (_cachedKey) return _cachedKey
  const salt = getOrCreateSalt()
  _cachedKey = createHash("sha256")
    .update(APP_SECRET)
    .update(salt)
    .digest()
  return _cachedKey
}

// ── Encrypt / Decrypt ────────────────────────────────────────────────────────

/**
 * Returns true if the buffer starts with the skill-encryption magic header.
 */
export function isSkillEncrypted(buf: Buffer): boolean {
  if (buf.length < HEADER_LEN) return false
  return buf.subarray(0, MAGIC.length).equals(MAGIC)
}

/**
 * Encrypts `plaintext` and returns the binary ciphertext buffer.
 */
export function encryptSkillBuffer(plaintext: Buffer): Buffer {
  const key = getSkillEncryptionKey()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()

  return Buffer.concat([MAGIC, iv, tag, encrypted])
}

/**
 * Decrypts a buffer that was produced by `encryptSkillBuffer`.
 * Throws if the magic header is missing or authentication fails.
 */
export function decryptSkillBuffer(cipherBuf: Buffer): Buffer {
  if (!isSkillEncrypted(cipherBuf)) {
    throw new Error("[SkillCrypto] Buffer does not have a valid skill-encryption header")
  }
  const key = getSkillEncryptionKey()

  let offset = MAGIC.length
  const iv = cipherBuf.subarray(offset, offset + IV_LEN)
  offset += IV_LEN
  const tag = cipherBuf.subarray(offset, offset + TAG_LEN)
  offset += TAG_LEN
  const encrypted = cipherBuf.subarray(offset)

  const decipher = createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()])
}

/**
 * Convenience: decrypt a buffer if it is encrypted, otherwise return as-is.
 * Safe to call on any skill file regardless of whether it is premium.
 */
export function decryptSkillBufferIfNeeded(buf: Buffer): Buffer {
  return isSkillEncrypted(buf) ? decryptSkillBuffer(buf) : buf
}

