/** Private, one-request stdin/stdout protocol; never a renderer or model API. */
export const BOT_MAC_SECRET_HELPER_FLAG = "--cmb-bot-secret-helper"
export const BOT_SECRET_PLAIN_LIMIT = 1024 * 1024
export const BOT_SECRET_CIPHER_LIMIT = 2 * 1024 * 1024
export const BOT_SECRET_FRAME_LIMIT = 3 * 1024 * 1024
export type BotSecretOperation = "protect" | "unprotect"

export function decodeSecretBytes(value: unknown, limit: number): Buffer {
  if (typeof value !== "string" || !value || value.length > Math.ceil(limit / 3) * 4)
    throw new Error("Invalid credential frame")
  const bytes = Buffer.from(value, "base64")
  if (!bytes.length || bytes.length > limit || bytes.toString("base64") !== value)
    throw new Error("Invalid credential frame")
  return bytes
}

export function readSecretRequest(frame: Buffer): {
  operation: BotSecretOperation
  bytes: Buffer
} {
  if (frame.length > BOT_SECRET_FRAME_LIMIT) throw new Error("Invalid credential frame")
  const value: unknown = JSON.parse(frame.toString("utf8"))
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid credential frame")
  const request = value as Record<string, unknown>
  if (
    Object.keys(request).length !== 3 ||
    request.version !== 1 ||
    (request.operation !== "protect" && request.operation !== "unprotect")
  )
    throw new Error("Invalid credential frame")
  return {
    operation: request.operation,
    bytes: decodeSecretBytes(
      request.data,
      request.operation === "protect" ? BOT_SECRET_PLAIN_LIMIT : BOT_SECRET_CIPHER_LIMIT
    )
  }
}
