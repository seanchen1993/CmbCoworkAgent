import { createServer } from "node:http"
import { once } from "node:events"

/** Opt-in business demonstration transport. Never used by ordinary/offline E2E. */
export async function startRealModelRelay(options: {
  baseUrl: string
  model: string
  apiKey: string
  requestLimit?: number
  fetch?: typeof fetch
}) {
  const upstream = new URL(options.baseUrl.replace(/\/$/, "") + "/chat/completions")
  if (upstream.protocol !== "https:") throw Error("DEMO_HTTPS_REQUIRED")
  const metrics: Array<{ status: number; elapsedMs: number; bytes: number }> = []
  const active = new Set<AbortController>()
  let requests = 0
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/chat/completions") {
      response.writeHead(404).end()
      return
    }
    if (++requests > (options.requestLimit ?? 60)) {
      response.writeHead(429).end("DEMO_REQUEST_BUDGET")
      return
    }
    const controller = new AbortController()
    active.add(controller)
    const timeout = setTimeout(() => controller.abort(), 180_000)
    response.once("close", () => {
      if (!response.writableFinished) controller.abort()
    })
    const started = performance.now()
    const metric = { status: 0, elapsedMs: 0, bytes: 0 }
    metrics.push(metric)
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 8 * 1024 * 1024) throw Error("DEMO_REQUEST_SIZE")
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      const result = await (options.fetch ?? fetch)(upstream, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({ ...body, model: options.model }),
        signal: controller.signal,
        redirect: "error"
      })
      metric.status = result.status
      if (!result.ok) {
        await result.body?.cancel()
        response.writeHead(502).end("DEMO_PROVIDER_REJECTED")
        return
      }
      response.writeHead(200, {
        "content-type": result.headers.get("content-type") ?? "application/json"
      })
      if (result.body)
        for await (const chunk of result.body) {
          metric.bytes += chunk.byteLength
          if (!response.write(chunk)) await once(response, "drain", { signal: controller.signal })
        }
      response.end()
    } catch {
      if (!response.headersSent) response.writeHead(502)
      response.end("DEMO_PROVIDER_UNAVAILABLE")
    } finally {
      metric.elapsedMs = performance.now() - started
      clearTimeout(timeout)
      active.delete(controller)
    }
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw Error("DEMO_RELAY_ADDRESS")
  return {
    url: `http://127.0.0.1:${address.port}`,
    metrics,
    async close() {
      for (const controller of active) controller.abort()
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await stopped
    }
  }
}
