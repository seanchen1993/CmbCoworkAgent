import type { ServerResponse } from "node:http"

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
