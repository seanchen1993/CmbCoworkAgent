import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import { homedir } from "node:os"
import { join } from "node:path"
import { rejectCreatorLiveRelay } from "./creator-live-transport"

/** Only this parent process sees credentials; Electron receives a localhost dummy key. */
export function genericModLiveRelay() {
  const id = process.env.CMB_CREATOR_LIVE_MODEL_ID?.trim()
  assert(id, "GENERIC_LIVE_MODEL_OPT_IN_REQUIRED")
  const home = process.env.CMB_CREATOR_LIVE_CONFIG_HOME ?? join(homedir(), ".cmbcoworkagent")
  const stored = JSON.parse(readFileSync(join(home, "custom-models.json"), "utf8"))
  const rows = Array.isArray(stored) ? stored : Object.values(stored)
  const config = rows.find((row) => row?.id === id)
  assert(config?.model && config?.baseUrl, "GENERIC_LIVE_MODEL_NOT_CONFIGURED")
  const keyName = "CUSTOM_API_KEY__" + createHash("sha256").update(id).digest("hex").slice(0, 12)
  const line = readFileSync(join(home, ".env"), "utf8")
    .split("\n")
    .find((row) => row.slice(0, row.indexOf("=")).trim() === keyName)
  const key = line?.slice(line.indexOf("=") + 1).trim()
  assert(key, "GENERIC_LIVE_KEY_UNAVAILABLE")
  const url = new URL(config.baseUrl)
  assert(["http:", "https:"].includes(url.protocol))
  url.pathname = url.pathname.replace(/\/+$/, "") || "/v1"
  if (!url.pathname.endsWith("/chat/completions")) url.pathname += "/chat/completions"
  const metrics: Array<{
    round: string
    number: number
    status?: number
    elapsedMs: number
    tools: Array<{ name: string; action?: string }>
    failures?: Array<{ code: string }>
    error?: string
  }> = []
  const aborts = new Set<AbortController>()
  let round = "setup",
    fatal: string | undefined
  const server = createServer(async (request, response) => {
    const metric = {
      round,
      number: metrics.length + 1,
      elapsedMs: 0,
      tools: []
    } as (typeof metrics)[number]
    const started = Date.now(),
      abort = new AbortController()
    aborts.add(abort)
    const reject = (code: string, status: number) => {
      metric.error = code
      rejectCreatorLiveRelay(response, code, status, (code) => {
        fatal = code
      })
    }
    try {
      assert.equal(request.url, "/v1/chat/completions")
      assert(metrics.filter((row) => row.round === round).length < 24, "GENERIC_LIVE_ROUND_LIMIT")
      metrics.push(metric)
      let raw = ""
      for await (const bytes of request) {
        raw += bytes
        assert(raw.length < 5_000_000, "GENERIC_LIVE_REQUEST_SIZE")
      }
      const body = JSON.parse(raw)
      for (const message of body.messages ?? [])
        for (const call of message.tool_calls ?? []) {
          let action: string | undefined
          try {
            action = JSON.parse(call.function.arguments).action
          } catch {
            /* partial arguments */
          }
          metric.tools.push({ name: String(call.function.name), ...(action ? { action } : {}) })
        }
      metric.failures = (body.messages ?? []).flatMap(
        (message: { role: string; content: unknown }) => {
          if (message.role !== "tool" || typeof message.content !== "string") return []
          try {
            const result = JSON.parse(message.content)
            return result.ok === false &&
              typeof result.error === "string" &&
              /^[A-Z][A-Z0-9_]{0,100}$/.test(result.error)
              ? [{ code: result.error }]
              : []
          } catch {
            return []
          }
        }
      )
      body.model = config.model
      body.max_tokens = Math.min(
        8192,
        Number(body.max_tokens ?? body.max_completion_tokens ?? 8192)
      )
      delete body.max_completion_tokens
      const upstream = await fetch(url, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(90_000)])
      })
      metric.status = upstream.status
      if (!upstream.ok) {
        await upstream.body?.cancel()
        reject(`UPSTREAM_HTTP_${upstream.status}`, upstream.status)
        return
      }
      response.writeHead(200, {
        "content-type": upstream.headers.get("content-type") ?? "text/event-stream"
      })
      for await (const bytes of upstream.body!) response.write(bytes)
      response.end()
    } catch (cause) {
      const code =
        cause instanceof Error && /^GENERIC_LIVE_[A-Z_]+$/.test(cause.message)
          ? cause.message
          : "UPSTREAM_NETWORK_ERROR"
      reject(code, 502)
    } finally {
      metric.elapsedMs = Date.now() - started
      aborts.delete(abort)
    }
  })
  return {
    metrics,
    model: String(config.model),
    redact: (text: string) => text.replaceAll(key, "[REDACTED]"),
    phase: (value: string) => {
      round = value
    },
    failure: () => fatal,
    inFlight: () => aborts.size,
    async listen() {
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
      const address = server.address()
      assert(address && typeof address !== "string")
      return `http://127.0.0.1:${address.port}/v1`
    },
    async close() {
      aborts.forEach((abort) => abort.abort())
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
    }
  }
}
