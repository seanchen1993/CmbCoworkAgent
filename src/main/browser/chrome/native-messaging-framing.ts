const HEADER_BYTES = 4
const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024

export function encodeNativeMessage(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8")
  const framed = Buffer.allocUnsafe(HEADER_BYTES + payload.length)
  framed.writeUInt32LE(payload.length, 0)
  payload.copy(framed, HEADER_BYTES)
  return framed
}

export class NativeMessageDecoder {
  private buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0)

  constructor(private readonly maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES) {}

  push(chunk: Buffer): unknown[] {
    if (chunk.length === 0) return []
    this.buffered = (
      this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk])
    ) as Buffer
    const messages: unknown[] = []

    while (this.buffered.length >= HEADER_BYTES) {
      const payloadBytes = this.buffered.readUInt32LE(0)
      if (payloadBytes <= 0 || payloadBytes > this.maxMessageBytes) {
        throw new Error(`Native messaging payload length is invalid: ${payloadBytes}`)
      }
      if (this.buffered.length < HEADER_BYTES + payloadBytes) break

      const payload = this.buffered.subarray(HEADER_BYTES, HEADER_BYTES + payloadBytes)
      this.buffered = this.buffered.subarray(HEADER_BYTES + payloadBytes)
      try {
        messages.push(JSON.parse(payload.toString("utf8")) as unknown)
      } catch {
        throw new Error("Native messaging payload is not valid JSON")
      }
    }

    return messages
  }
}
