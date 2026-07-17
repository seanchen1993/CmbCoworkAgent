/**
 * Remote HTTP API gateway for the agent.
 *
 * Exposes a minimal REST + SSE surface so a remote client (reaching this machine
 * by IP) can create a thread, send it a message, and receive the streamed reply:
 *
 *   GET  /healthz                       -> { ok: true }                (no auth)
 *   POST /v1/threads                    -> Thread                      (body: metadata?)
 *   GET  /v1/threads/:id                -> Thread | 404
 *   GET  /v1/threads/:id/messages       -> Message[]
 *   POST /v1/threads/:id/messages       -> text/event-stream           (body: { message, modelId? })
 *   POST /v1/threads/:id/cancel         -> { aborted: boolean }
 *
 * Built on Node's http module (no framework) to keep the dependency/attack
 * surface small. Every non-health request requires a bearer token.
 *
 * SECURITY: API threads run with ALL tool approvals bypassed — a message can make
 * the agent read/write files and execute arbitrary code on this machine. The
 * gateway is opt-in (CMB_API_ENABLED) and token-gated by default. See config.ts.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "http"
import { timingSafeEqual } from "crypto"
import { registerAgentStreamSink } from "../agent/agent-stream-sinks"
import {
  apiCreateThread,
  apiGetThread,
  apiGetThreadMessages,
  apiCancelThread,
  runApiAgentTurn
} from "./agent-bridge"
import { readApiGatewayConfig, apiGatewayStartBlockReason, type ApiGatewayConfig } from "./config"
import { createOpenAiStreamEncoder } from "./openai-stream"

const MAX_BODY_BYTES = 1024 * 1024 // 1 MiB — messages/metadata only, no uploads.

let server: Server | null = null

function isTerminalPayload(payload: unknown): boolean {
  const type =
    !!payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { type?: unknown }).type
      : undefined
  return type === "done" || type === "error"
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function extractToken(req: IncomingMessage): string {
  const auth = req.headers["authorization"]
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim()
  }
  const headerToken = req.headers["x-api-token"]
  if (typeof headerToken === "string") return headerToken.trim()
  return ""
}

function isAuthorized(req: IncomingMessage, config: ApiGatewayConfig): boolean {
  // No token configured → open access (auth disabled).
  if (!config.token) return true
  const provided = extractToken(req)
  if (!provided) return false
  return constantTimeEquals(provided, config.token)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text)
  })
  res.end(text)
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")))
      } catch {
        reject(new Error("Invalid JSON body"))
      }
    })
    req.on("error", reject)
  })
}

/**
 * Stream one agent turn to the client over Server-Sent Events.
 *
 * `format` controls the wire shape:
 *  - "openai" (default): clean OpenAI chat.completion.chunk stream (text deltas,
 *    tool calls, tool results), ending with `data: [DONE]`.
 *  - "raw": the agent's internal payloads verbatim (debugging / full fidelity).
 */
function handleSendMessage(
  req: IncomingMessage,
  res: ServerResponse,
  threadId: string,
  message: string,
  modelId: string | undefined,
  format: "openai" | "raw"
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  })

  const encoder =
    format === "openai" ? createOpenAiStreamEncoder(threadId, Math.floor(Date.now() / 1000)) : null
  if (!encoder) {
    // Prime the raw stream so proxies/clients open it immediately.
    res.write(`event: open\ndata: ${JSON.stringify({ threadId })}\n\n`)
  }

  let ended = false
  const heartbeat = setInterval(() => {
    if (!ended) res.write(": ping\n\n")
  }, 15000)
  // Safety cap: the turn runs asynchronously (renderer-driven), so the response
  // stays open until a terminal payload arrives. Bound it so a stuck run can't
  // hold the connection forever.
  const maxTimer = setTimeout(() => end(), 15 * 60 * 1000)

  const end = (): void => {
    if (ended) return
    ended = true
    clearInterval(heartbeat)
    clearTimeout(maxTimer)
    unsubscribe()
    res.end()
  }

  const unsubscribe = registerAgentStreamSink(threadId, (_channel, payload) => {
    if (ended) return
    const p = payload as { type?: string; error?: unknown }
    if (encoder) {
      if (p?.type === "done") {
        res.write(encoder.finish())
        end()
        return
      }
      if (p?.type === "error") {
        res.write(encoder.error(String(p.error ?? "error")))
        end()
        return
      }
      const frame = encoder.encode(payload)
      if (frame) res.write(frame)
    } else {
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
      if (isTerminalPayload(payload)) end()
    }
  })

  // Client hung up → stop streaming and abort the run.
  req.on("close", () => {
    if (ended) return
    apiCancelThread(threadId)
    end()
  })

  // Kick off the turn. The stream is delivered via the sink above and closed on
  // its terminal payload — NOT when this promise resolves (renderer-driven turns
  // resolve immediately after handing off). Only a failure to start ends here.
  runApiAgentTurn(threadId, message, modelId).catch((err) => {
    if (ended) return
    const msg = String(err instanceof Error ? err.message : err)
    res.write(encoder ? encoder.error(msg) : `data: ${JSON.stringify({ type: "error", error: msg })}\n\n`)
    end()
  })
}

async function route(req: IncomingMessage, res: ServerResponse, config: ApiGatewayConfig): Promise<void> {
  const method = req.method ?? "GET"
  const url = new URL(req.url ?? "/", "http://localhost")
  const path = url.pathname

  // Liveness probe — intentionally unauthenticated.
  if (method === "GET" && path === "/healthz") {
    sendJson(res, 200, { ok: true })
    return
  }

  if (!isAuthorized(req, config)) {
    sendJson(res, 401, { error: "unauthorized" })
    return
  }

  // POST /v1/threads — accepts explicit workspacePath / model / agentMode / title
  // (and/or a nested `metadata` object). agentMode ∈ normal|coordinator|workflow.
  if (method === "POST" && path === "/v1/threads") {
    const body = (await readJsonBody(req).catch(() => null)) as {
      metadata?: Record<string, unknown>
      workspacePath?: unknown
      model?: unknown
      agentMode?: unknown
      title?: unknown
    } | null
    const metadata: Record<string, unknown> = { ...(body?.metadata ?? {}) }
    if (typeof body?.workspacePath === "string") metadata.workspacePath = body.workspacePath
    if (typeof body?.model === "string") metadata.model = body.model
    if (typeof body?.agentMode === "string") metadata.agentMode = body.agentMode
    if (typeof body?.title === "string") metadata.title = body.title
    const thread = apiCreateThread(metadata)
    sendJson(res, 201, thread)
    return
  }

  const threadMatch = path.match(/^\/v1\/threads\/([^/]+)(\/messages|\/cancel)?$/)
  if (threadMatch) {
    const threadId = decodeURIComponent(threadMatch[1])
    const sub = threadMatch[2]

    if (method === "GET" && !sub) {
      const thread = apiGetThread(threadId)
      if (!thread) {
        sendJson(res, 404, { error: "thread_not_found" })
        return
      }
      sendJson(res, 200, thread)
      return
    }

    if (method === "GET" && sub === "/messages") {
      if (!apiGetThread(threadId)) {
        sendJson(res, 404, { error: "thread_not_found" })
        return
      }
      sendJson(res, 200, { messages: apiGetThreadMessages(threadId) })
      return
    }

    if (method === "POST" && sub === "/messages") {
      if (!apiGetThread(threadId)) {
        sendJson(res, 404, { error: "thread_not_found" })
        return
      }
      const body = (await readJsonBody(req).catch(() => null)) as {
        message?: unknown
        modelId?: unknown
      } | null
      const message = typeof body?.message === "string" ? body.message : ""
      if (!message.trim()) {
        sendJson(res, 400, { error: "message_required" })
        return
      }
      const modelId = typeof body?.modelId === "string" ? body.modelId : undefined
      // Clean OpenAI-style stream by default; ?format=raw for the internal stream.
      const format = url.searchParams.get("format") === "raw" ? "raw" : "openai"
      handleSendMessage(req, res, threadId, message, modelId, format)
      return
    }

    if (method === "POST" && sub === "/cancel") {
      const aborted = apiCancelThread(threadId)
      sendJson(res, 200, { aborted })
      return
    }
  }

  sendJson(res, 404, { error: "not_found" })
}

/**
 * Start the HTTP API gateway if enabled and its security preconditions are met.
 * Returns true when the server started listening. Safe to call once at startup.
 */
export function startApiGateway(): boolean {
  if (server) return true
  const config = readApiGatewayConfig()
  const blockReason = apiGatewayStartBlockReason(config)
  if (blockReason) {
    console.warn(`[ApiGateway] not starting: ${blockReason}`)
    return false
  }

  server = createServer((req, res) => {
    route(req, res, config).catch((err) => {
      console.error("[ApiGateway] request error:", err)
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" })
      else if (!res.writableEnded) res.end()
    })
  })

  server.on("error", (err) => {
    console.error("[ApiGateway] server error:", err)
  })

  server.listen(config.port, config.host, () => {
    const authNote = config.token
      ? "token auth ON"
      : "NO AUTH — open to anyone who can reach this port (set CMB_API_TOKEN to require a token)"
    console.warn(
      `[ApiGateway] listening on http://${config.host}:${config.port} — ${authNote}. ` +
        `API threads bypass ALL tool approvals (arbitrary code/file access). ` +
        `Reachable from the network; restrict exposure accordingly.`
    )
  })
  return true
}

/** Stop the gateway (called on app quit). */
export function stopApiGateway(): void {
  if (!server) return
  server.close()
  server = null
}
