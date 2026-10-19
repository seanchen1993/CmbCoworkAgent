import type { ServerResponse } from "node:http"

/** Announce the real streaming connection while its body still awaits the actual result. */
export function flushFullAppSseHeaders(response: ServerResponse): void {
  if (response.headersSent) return
  response.writeHead(200, { "content-type": "text/event-stream" })
  response.flushHeaders()
}

/** Once SSE headers are visible, a model-fixture error must end the stream, never fake a delta. */
export function endFullAppModelError(response: ServerResponse): void {
  if (response.headersSent) response.destroy()
  else {
    response.writeHead(500)
    response.end("Full App model fixture rejected unexpected facts")
  }
}
