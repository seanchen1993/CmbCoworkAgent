export class HarnessResponseTooLargeError extends Error {
  readonly code = "HARNESS_ENTERPRISE_RESPONSE_TOO_LARGE"

  constructor(
    readonly source: string,
    readonly maxBytes: number
  ) {
    super(`${source} response exceeded ${maxBytes} bytes`)
    this.name = "HarnessResponseTooLargeError"
  }
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error("Harness response read was aborted")
  error.name = "AbortError"
  return error
}

export async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
  source: string,
  signal?: AbortSignal
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer")
  }
  if (signal?.aborted) throw abortReason(signal)

  const contentLengthHeader = response.headers.get("content-length")
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader)
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      void response.body?.cancel().catch(() => undefined)
      throw new HarnessResponseTooLargeError(source, maxBytes)
    }
  }
  if (!response.body) return Buffer.alloc(0)

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let totalBytes = 0
  const cancelReader = (): void => {
    void reader.cancel(signal?.reason).catch(() => undefined)
  }
  signal?.addEventListener("abort", cancelReader, { once: true })

  try {
    while (true) {
      if (signal?.aborted) throw abortReason(signal)
      const { done, value } = await reader.read()
      if (signal?.aborted) throw abortReason(signal)
      if (done) break
      if (!value || value.byteLength === 0) continue
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => undefined)
        throw new HarnessResponseTooLargeError(source, maxBytes)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    signal?.removeEventListener("abort", cancelReader)
    try {
      reader.releaseLock()
    } catch {
      // The stream may still be settling after cancellation; it no longer has a retained listener.
    }
  }

  return Buffer.concat(chunks, totalBytes)
}
