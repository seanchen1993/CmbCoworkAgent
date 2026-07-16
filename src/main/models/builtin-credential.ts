import { createDecipheriv } from "crypto"

// This only prevents the shared fallback credential from appearing as plaintext in
// source control and build artifacts. Because the client must decrypt it locally,
// it is obfuscation rather than a security boundary; runtime overrides remain the
// supported rotation mechanism.
const BUNDLED_KEY_PARTS = [
  "29c779f6cdcbaf32",
  "ff54b9f6bbdfa814",
  "07c42f0211cef59e",
  "cd93d48a356926d2"
] as const

const BUNDLED_CREDENTIAL = {
  iv: "yTpNdMd7TBWEu8xV",
  authTag: "eCdP1t/wbmw5RvvOxd4yew==",
  ciphertext: "ib88K50Vghhw6MlNBXvr7/PRl+VOHBkGYQubKUdP320Oz6E="
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
