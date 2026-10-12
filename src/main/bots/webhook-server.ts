import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { BotStore } from "./store"
import { BotDomainError } from "../../shared/bot-types"
import type { BotWebhookView } from "../../shared/bot-webhooks"
import { formatUntrustedDeliveryPayload } from "./upstream/rakazo-webhook"
import { botLatestStateEnvelope } from "../../shared/bot-event-state"

const MAX_BODY = 32 * 1024
const fail = (code: string, message: string) => new BotDomainError(code, message)
function respond(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    Connection: "close",
    ...(status === 429 ? { "Retry-After": "60" } : {})
  })
  response.end(JSON.stringify(value))
}
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    const cleanup = () => {
      request.off("data", data)
      request.off("end", end)
      request.off("aborted", interrupted)
      request.off("error", interrupted)
    }
    const interrupted = () => {
      cleanup()
      reject(fail("webhook_interrupted", "请求中断，事件未接收"))
    }
    const data = (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        cleanup()
        request.pause()
        reject(fail("webhook_size", "事件正文超过 32 KiB"))
      } else chunks.push(chunk)
    }
    const end = () => {
      cleanup()
      try {
        resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))
      } catch {
        reject(fail("invalid_input", "事件正文必须使用 UTF-8"))
      }
    }
    request.on("data", data)
    request.once("end", end)
    request.once("aborted", interrupted)
    request.once("error", interrupted)
  })
}
function payload(raw: string): { framed: string; value: unknown } {
  let value: unknown
  try {
    value = raw.trim() ? JSON.parse(raw) : {}
  } catch {
    throw fail("invalid_input", "事件正文必须是有效 JSON")
  }
  const stack = [{ value, depth: 0 }]
  while (stack.length) {
    const current = stack.pop()!
    if (current.depth > 32) throw fail("invalid_input", "事件 JSON 嵌套超过 32 层")
    if (typeof current.value === "object" && current.value !== null)
      for (const child of Object.values(current.value))
        stack.push({ value: child, depth: current.depth + 1 })
  }
  const framed = formatUntrustedDeliveryPayload("[Inbound Webhook Event]", value)
  if (framed.length > 32_000 || framed.includes("\0"))
    throw fail("webhook_size", "事件正文展开后超过 32,000 字符，请缩减输入")
  return { framed, value }
}

/** Independent Host adapter: only a saved routine can be triggered; no model,
 * approval, configuration or general RPC endpoints are exposed over HTTP. */
export class BotWebhookServer {
  private server: Server | null = null
  private starting: Promise<void> | null = null
  private closing = false
  private base: string | null = null
  private failure: string | null = null
  private requestWindow = 0
  private requestCount = 0
  constructor(
    private readonly store: BotStore,
    private readonly wake: () => void,
    private readonly assertOwnership: () => void = () => {}
  ) {}

  get error(): string | null {
    return this.failure
  }
  get baseUrl(): string | null {
    return this.base
  }

  view(input: unknown): BotWebhookView {
    const state = this.store.webhooks.describe(input)
    return {
      ...state,
      url: this.base ? `${this.base}/v1/routines/${state.routineId}/events` : null,
      listenerError: this.failure
    }
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting
    if (this.server?.listening) return
    this.starting = this.open().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async open(): Promise<void> {
    this.closing = false
    const port = Number(
      this.store.db.exec("SELECT port FROM bot_webhook_listener WHERE id=1")[0]?.values[0]?.[0] ?? 0
    )
    const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
      request.on("error", () => {}) // A peer may abort again after body listeners were removed.
      void this.handle(request, response)
    })
    server.maxConnections = 32
    server.requestTimeout = 10_000
    server.headersTimeout = 10_000
    server.keepAliveTimeout = 1000
    server.maxRequestsPerSocket = 1
    server.setTimeout(10_000, (socket) => socket.destroy())
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject)
          resolve()
        })
      })
      if (this.closing) throw new Error("closed")
      const actual = (server.address() as AddressInfo).port
      this.assertOwnership()
      this.store.transaction(() =>
        this.store.db.run(
          "INSERT INTO bot_webhook_listener VALUES(1,?) ON CONFLICT(id) DO UPDATE SET port=excluded.port",
          [actual]
        )
      )
      this.base = `http://127.0.0.1:${actual}`
      this.failure = null
      server.on("error", () => {
        this.base = null
        this.failure = "Webhook 监听异常，请重试启动"
      })
    } catch (error) {
      this.base = null
      this.failure =
        (error as NodeJS.ErrnoException).code === "EADDRINUSE"
          ? "Webhook 固定端口被占用，请释放端口后重试"
          : "Webhook 监听无法启动，请重试"
      server.closeAllConnections()
      server.close()
      if (this.server === server) this.server = null
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const deadline = setTimeout(() => request.destroy(), 10_000)
    try {
      if (this.closing || !this.base) {
        respond(response, 503, { error: "服务正在切换，请稍后重试" })
        return
      }
      if (
        request.socket.remoteAddress !== "127.0.0.1" ||
        request.headers.host !== new URL(this.base).host ||
        request.headers.origin !== undefined
      ) {
        respond(response, 403, { error: "只接受本机直接调用" })
        return
      }
      const window = Math.floor(performance.now() / 1000)
      if (window !== this.requestWindow) {
        this.requestWindow = window
        this.requestCount = 0
      }
      if (++this.requestCount > 120) {
        respond(response, 429, { error: "接收繁忙，请稍后重试" })
        return
      }
      const route = /^\/v1\/routines\/([\w:.-]{1,160})\/events$/.exec(request.url ?? "")
      if (!route || request.method !== "POST") {
        respond(response, 404, { error: "入口不存在" })
        return
      }
      const credential = this.store.webhooks.authorize(route[1], request.headers.authorization)
      if (!credential) {
        respond(response, 401, { error: "无效的 Webhook 凭据" })
        return
      }
      const eventId = request.headers["idempotency-key"]
      if (typeof eventId !== "string" || !/^[\w:.-]{1,160}$/.test(eventId)) {
        respond(response, 400, { error: "需要 Idempotency-Key 事件标识；重试必须沿用原值" })
        return
      }
      if (
        request.headers["content-type"] &&
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"])
      ) {
        respond(response, 415, { error: "请使用 application/json" })
        return
      }
      if (Number(request.headers["content-length"] ?? 0) > MAX_BODY)
        throw fail("webhook_size", "事件正文超过 32 KiB")
      const body = payload(await readBody(request))
      const envelope = this.store.webhooks.requiresVersion(credential.routineId)
        ? botLatestStateEnvelope.safeParse(body.value)
        : undefined
      if (envelope && (!envelope.success || !Object.hasOwn(envelope.data, "payload")))
        throw fail(
          "invalid_input",
          "最新状态正文需要 entityKey、sourceEpoch、安全整数 sequence 和 payload"
        )
      if (this.closing || response.destroyed) {
        respond(response, 503, { error: "服务正在切换，请使用原事件标识重试" })
        return
      }
      this.assertOwnership()
      const accepted = this.store.webhooks.accept(
        credential,
        eventId,
        body.framed,
        envelope?.success
          ? {
              entityKey: envelope.data.entityKey,
              sourceEpoch: envelope.data.sourceEpoch,
              sequence: envelope.data.sequence
            }
          : undefined
      )
      // Acceptance is already durable. Waking the dispatcher cannot turn it into a false failure.
      try {
        this.wake()
      } catch {
        /* The Host's next tick also discovers the queued run. */
      }
      respond(response, 200, { accepted: true, ...accepted })
    } catch (error) {
      const code = error instanceof BotDomainError ? error.code : "internal"
      const status =
        code === "webhook_size"
          ? 413
          : code === "webhook_unauthorized" || code === "not_found"
            ? 401
            : code === "webhook_rate_limit"
              ? 429
              : code === "invalid_input"
                ? 400
                : code === "skill_catalog_unavailable" || code === "host_ownership_lost"
                  ? 503
                  : [
                        "nonce_conflict",
                        "webhook_paused",
                        "webhook_schedule",
                        "event_mode",
                        "event_epoch",
                        "event_version_conflict",
                        "event_capacity",
                        "skill_changed",
                        "skill_unavailable",
                        "skill_unverified"
                      ].includes(code)
                    ? 409
                    : 500
      respond(response, status, {
        error:
          status === 500
            ? "接收失败，请使用原事件标识重试"
            : error instanceof BotDomainError
              ? error.message
              : "事件未接收"
      })
    } finally {
      clearTimeout(deadline)
    }
  }

  async close(): Promise<void> {
    this.closing = true
    await this.starting
    this.base = null
    const server = this.server
    this.server = null
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
