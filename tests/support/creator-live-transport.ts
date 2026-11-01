import type { ServerResponse } from "node:http"

/** Decode once after buffering: a TCP chunk may end in the middle of a UTF-8 code point. */
export async function readCreatorLiveJsonRequest(
  chunks: AsyncIterable<Uint8Array>,
  prefix: "LIVE" | "GENERIC_LIVE",
  maximumBytes = 5_000_000
) {
  const parts: Buffer[] = []
  let bytes = 0
  for await (const chunk of chunks) {
    const part = Buffer.from(chunk)
    bytes += part.length
    if (bytes > maximumBytes) throw Error(`${prefix}_REQUEST_SIZE_LIMIT`)
    parts.push(part)
  }
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts))
  } catch {
    throw Error(`${prefix}_REQUEST_UTF8_INVALID`)
  }
  return JSON.parse(text)
}

/** Preserve the application's bounded provider retry; the relay never retries a request itself. */
export function rejectCreatorLiveRelay(
  response: ServerResponse,
  code: string,
  status: number,
  terminal: (code: string) => void
) {
  const retryable =
    code === "UPSTREAM_NETWORK_ERROR" || /^UPSTREAM_HTTP_(?:408|425|429|5\d\d)$/.test(code)
  if (!retryable) terminal(code)
  // A broken upstream stream must stay broken, not become a successful stream with JSON appended.
  if (response.headersSent) {
    response.destroy(new Error(code))
    return
  }
  response.writeHead(status, { "content-type": "application/json" })
  response.end(
    JSON.stringify({
      error: {
        code,
        message: code,
        origin: code.startsWith("UPSTREAM_") ? "provider" : "acceptance-harness"
      }
    })
  )
}
