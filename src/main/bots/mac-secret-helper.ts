import type { Readable, Writable } from "node:stream"
import {
  BOT_SECRET_CIPHER_LIMIT,
  BOT_SECRET_FRAME_LIMIT,
  BOT_SECRET_PLAIN_LIMIT,
  decodeSecretBytes,
  readSecretRequest
} from "./mac-secret-protocol"

interface SafeStoragePort {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

/** The actual Electron safeStorage port is supplied only by the helper entry. */
export async function runMacSecretHelper(input: {
  platform: NodeJS.Platform
  stdin: Readable
  stdout: Writable
  ready(): Promise<unknown>
  storage: SafeStoragePort
}): Promise<void> {
  if (input.platform !== "darwin") throw new Error("Unsupported credential provider")
  const chunks: Buffer[] = []
  let size = 0
  let frame: Buffer | undefined
  let bytes: Buffer | undefined
  let result: Buffer | undefined
  try {
    for await (const raw of input.stdin) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      size += chunk.length
      if (size > BOT_SECRET_FRAME_LIMIT) throw new Error("Invalid credential frame")
      chunks.push(chunk)
    }
    frame = Buffer.concat(chunks)
    const request = readSecretRequest(frame)
    bytes = request.bytes
    // Malformed or oversized input never accesses the user's Keychain.
    await input.ready()
    if (!input.storage.isEncryptionAvailable()) throw new Error("Credential protection unavailable")
    if (request.operation === "protect") {
      result = input.storage.encryptString(bytes.toString("base64"))
      if (!result.length || result.length > BOT_SECRET_CIPHER_LIMIT)
        throw new Error("Invalid credential result")
    } else {
      result = decodeSecretBytes(input.storage.decryptString(bytes), BOT_SECRET_PLAIN_LIMIT)
    }
    const response = result.toString("base64")
    await new Promise<void>((resolve, reject) => {
      input.stdout.write(response, (error) => (error ? reject(error) : resolve()))
    })
  } finally {
    for (const chunk of chunks) chunk.fill(0)
    frame?.fill(0)
    bytes?.fill(0)
    result?.fill(0)
  }
}
