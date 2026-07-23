import { createDecipheriv } from "crypto"

// This only prevents the shared fallback credential from appearing as plaintext in
// source control and build artifacts. Because the client must decrypt it locally,
// it is obfuscation rather than a security boundary; runtime overrides remain the
// supported rotation mechanism.
const BUNDLED_KEY_PARTS = [
  "236b5b573f3978a8",
  "7542113972109735",
  "d5e790fdee1d9cdc",
  "1dcffe389e610737"
] as const

const BUNDLED_CREDENTIAL = {
  iv: "QyVhAsQfufRtvAVz",
  authTag: "8l923jtWfvqy18or4CG2PA==",
  ciphertext: "A8Z7MXXdeLV/NkhFVOB07DAtrjeV873pvvnzga81LfK9xNw="
} as const

export function getBundledBuiltinModelApiKey(): string | undefined {
  try {
    const key = Buffer.from(BUNDLED_KEY_PARTS.join(""), "hex")
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(BUNDLED_CREDENTIAL.iv, "base64")
    )
    decipher.setAuthTag(Buffer.from(BUNDLED_CREDENTIAL.authTag, "base64"))
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(BUNDLED_CREDENTIAL.ciphertext, "base64")),
      decipher.final()
    ])
    const value = decrypted.toString("utf8").trim()
    return value || undefined
  } catch {
    return undefined
  }
}
