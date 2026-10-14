import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import type { FunctionSecretProtector } from "../../src/main/mods/v2/user-config-secrets"

/** Authenticated encryption for Node regressions; real Electron tests use actual safeStorage. */
export function testSecretProtector(): FunctionSecretProtector {
  const key = randomBytes(32)
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => {
      const nonce = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, nonce)
      const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
      return Buffer.concat([nonce, cipher.getAuthTag(), bytes])
    },
    decryptString: (bytes) => {
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12))
      decipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8")
    }
  }
}
