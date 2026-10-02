import http from "node:http"
import { randomBytes } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { task as frozenTask, message as frozenMessage } from "../../contracts/bot/v1/fixtures/positive.mjs"
import { requireNode22, validateConfig } from "./config.mjs"

export const limits = Object.freeze({ bodyBytes: 8192, textChars: 512, attachments: 4, records: 16, activeRequests: 8, bodyMs: 300, modelMs: 120 })
const fail = (status, code) => Object.assign(new Error(code), { status, code })
function closed(value, allowed, required = allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) throw fail(400, "INVALID_DEV_ENVELOPE")
}
function text(value, max = limits.textChars) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw fail(400, "INVALID_TEXT")
}
async function body(req) {
  if (req.headers["content-type"] !== "application/json") throw fail(415, "JSON_ONLY")
  const length = req.headers["content-length"]
  if (length && (!/^\d+$/.test(length) || Number(length) > limits.bodyBytes)) throw fail(413, "BODY_LIMIT")
  return new Promise((resolve, reject) => {
    let bytes = 0, chunks = [], finished = false
    const settle = (error, value) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      req.removeListener("data", onData)
      req.removeListener("end", onEnd)
      req.removeListener("aborted", onAborted)
      req.removeListener("error", onError)
      if (error) { req.resume(); reject(error) } else resolve(value)
    }
    const onData = (chunk) => { bytes += chunk.length; if (bytes > limits.bodyBytes) settle(fail(413, "BODY_LIMIT")); else chunks.push(chunk) }
    const onEnd = () => { try { settle(null, JSON.parse(Buffer.concat(chunks).toString("utf8"))) } catch { settle(fail(400, "INVALID_JSON")) } }
    const onAborted = () => settle(fail(400, "ABORTED"))
    const onError = () => settle(fail(400, "READ_FAILED"))
    const timer = setTimeout(() => settle(fail(408, "BODY_TIMEOUT")), limits.bodyMs)
    req.on("data", onData).once("end", onEnd).once("aborted", onAborted).once("error", onError)
  })
}

// This is a dev adapter envelope, not Bot OpenAPI or the formal Zhaohu protocol.
export async function startMockServer(config) {
  requireNode22()
  validateConfig(config)
  const principals = [{ id: "principal-1", spaceId: "space-1" }, { id: "principal-2", spaceId: "space-2" }]
  const credentials = Object.fromEntries(principals.map((principal, index) => [index ? "bob" : "alice", randomBytes(32).toString("base64url")]))
  const sessions = new Map(principals.map((principal, index) => [credentials[index ? "bob" : "alice"], principal]))
  const groups = new Map([
    ["group-private-1", { members: ["principal-1"], numbers: ["T-1024"] }],
    ["group-private-2", { members: ["principal-2"], numbers: ["T-2024"] }],
    ["group-shared", { members: ["principal-1", "principal-2"], numbers: ["T-3001", "T-3002"] }]
  ])
  const tasks = new Map()
  for (const [groupId, group] of groups) for (const number of group.numbers) tasks.set(number, {
    ...structuredClone(frozenTask), id: `task-${number}`, taskNumber: number, groupId,
    spaceId: groupId === "group-private-2" ? "space-2" : "space-1", title: `Synthetic ${number}`
  })
  const messages = new Map([...tasks.keys()].map((number) => [number, []]))
  let active = 0, sequence = 0, closing = false
  const abort = new AbortController()
  const reply = (res, status, payload) => {
    if (!res.destroyed && !res.writableEnded) {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Connection": "close", "X-Content-Type-Options": "nosniff" })
      res.end(JSON.stringify({ mock: true, ...payload }))
    }
  }
  const taskFor = (number, actor) => {
    const task = tasks.get(number)
    if (!task || !groups.get(task.groupId).members.includes(actor.id)) throw fail(403, "TASK_FORBIDDEN")
    return task
  }
  const server = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    let admitted = false
    try {
      if (closing || active >= limits.activeRequests) throw fail(503, "REQUEST_CAPACITY")
      const counts = new Map()
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const key = req.rawHeaders[i].toLowerCase()
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      if (["host", "authorization", "origin", "content-type"].some((key) => (counts.get(key) ?? 0) > 1)) throw fail(400, "DUPLICATE_HEADER")
      if (req.headers.host !== `127.0.0.1:${server.address().port}`) throw fail(403, "HOST_FORBIDDEN")
      if (req.headers.origin !== undefined || (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "none")) throw fail(403, "BROWSER_ORIGIN_FORBIDDEN")
      if (["x-actor-id", "x-space-id", "x-principal-id", "x-forwarded-host", "x-forwarded-for"].some((key) => req.headers[key] !== undefined)) throw fail(400, "UNTRUSTED_IDENTITY_HEADER")
      const auth = req.headers.authorization
      const actor = typeof auth === "string" && /^Bearer [A-Za-z0-9_-]{43}$/.test(auth) ? sessions.get(auth.slice(7)) : undefined
      if (!actor) throw fail(401, "DEV_CREDENTIAL_REQUIRED")
      active++; admitted = true
      if (req.method === "GET" && (req.headers["content-length"] !== undefined || req.headers["transfer-encoding"] !== undefined)) throw fail(400, "GET_BODY_FORBIDDEN")
      if (req.method === "GET" && req.url === "/dev/v1/session") return reply(res, 200, { principalId: actor.id, defaultSpaceId: actor.spaceId })
      if (req.method === "GET" && req.url === "/dev/v1/tasks") return reply(res, 200, { tasks: [...tasks.values()].filter((task) => groups.get(task.groupId).members.includes(actor.id)) })
      const match = /^\/dev\/v1\/tasks\/(T-[0-9]{4})\/messages$/.exec(req.url)
      if (req.method === "GET" && match) { taskFor(match[1], actor); return reply(res, 200, { messages: messages.get(match[1]) }) }
      if (req.method !== "POST" || !["/dev/v1/zhaohu", "/dev/v1/model"].includes(req.url)) throw fail(404, "DEV_ROUTE_NOT_FOUND")
      const input = await body(req)
      if (req.url === "/dev/v1/zhaohu") {
        closed(input, ["groupId", "taskNumber", "text", "attachments"], ["groupId", "text"])
        text(input.groupId, 64); text(input.text)
        const group = groups.get(input.groupId)
        if (!group || !group.members.includes(actor.id)) throw fail(403, "GROUP_FORBIDDEN")
        if (!input.taskNumber) return reply(res, 409, { code: "SELECT_EXPLICIT_TASK", taskNumbers: group.numbers })
        if (!group.numbers.includes(input.taskNumber)) throw fail(403, "TASK_FORBIDDEN")
        const task = taskFor(input.taskNumber, actor)
        const attachments = input.attachments ?? []
        if (!Array.isArray(attachments) || attachments.length > limits.attachments) throw fail(400, "ATTACHMENT_LIMIT")
        for (const attachment of attachments) {
          closed(attachment, ["name", "mediaType", "sizeBytes"])
          text(attachment.name, 64)
          if (/[\\/]|\.\.|:/.test(attachment.name) || !["text/plain", "application/pdf", "image/png"].includes(attachment.mediaType) || !Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes < 0 || attachment.sizeBytes > 1048576) throw fail(400, "INVALID_ATTACHMENT_METADATA")
        }
        const list = messages.get(input.taskNumber)
        if (list.length >= limits.records) throw fail(429, "MESSAGE_CAPACITY")
        const message = { ...structuredClone(frozenMessage), id: `dev-message-${++sequence}`, spaceId: task.spaceId, taskId: task.id, authorPrincipalId: actor.id, text: input.text }
        list.push(message)
        return reply(res, 200, { message, attachments, receipt: { provider: "dev-zhaohu", accepted: true, messageId: message.id, taskNumber: task.taskNumber } })
      }
      closed(input, ["taskNumber", "kind", "fault"], ["taskNumber", "kind"])
      taskFor(input.taskNumber, actor)
      if (!["analysis", "clarification"].includes(input.kind) || ![undefined, "failure", "timeout"].includes(input.fault)) throw fail(400, "INVALID_MODEL_FIXTURE")
      if (input.fault === "failure") throw fail(503, "MOCK_MODEL_FAILURE")
      if (input.fault === "timeout") { await delay(limits.modelMs, undefined, { signal: abort.signal }); throw fail(504, "MOCK_MODEL_TIMEOUT") }
      return reply(res, 200, { taskNumber: input.taskNumber, kind: input.kind, content: input.kind === "analysis" ? "[MOCK] Synthetic analysis: clarify acceptance criteria." : "[MOCK] Which acceptance criterion should be confirmed?", tools: [] })
    } catch (error) { reply(res, error.status ?? 503, { code: error.code && typeof error.code === "string" ? error.code : "DEV_CLOSING" }) }
    finally { if (admitted) active-- }
  })
  server.requestTimeout = 1000
  server.headersTimeout = 1000
  server.maxHeadersCount = 32
  server.maxConnections = 16
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  return {
    url: `http://127.0.0.1:${server.address().port}`, credentials,
    async close() {
      if (closing) return
      closing = true; abort.abort(); sessions.clear()
      const done = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      server.closeAllConnections()
      await done
    }
  }
}
