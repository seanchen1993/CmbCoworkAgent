import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import net from "node:net"
import { startMockServer, limits } from "../../../deploy/dev/mock-server.mjs"
import { validator } from "../schema-support.mjs"

const config = { profile: "dev", host: "127.0.0.1", s3: "disabled", es: "disabled" }
function request(server, user, path, input, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = input === undefined ? undefined : typeof input === "string" ? input : JSON.stringify(input)
    const req = http.request(server.url + path, { method: data === undefined ? "GET" : "POST", agent: false, headers: { ...(user ? { Authorization: `Bearer ${server.credentials[user] ?? user}` } : {}), ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, timeout: 2000 }, (res) => {
      let text = ""
      res.on("data", (chunk) => { text += chunk })
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(text) }) } catch (error) { reject(error) } })
    })
    req.on("timeout", () => req.destroy(new Error("test request timeout"))).on("error", reject)
    req.end(data)
  })
}
async function withServer(fn) {
  const server = await startMockServer(config)
  try { await fn(server) } finally { await server.close() }
  await assert.rejects(request(server, "alice", "/dev/v1/session"))
}

test("same instance: identity, private spaces, explicit shared collaboration and F03 DTOs", async () => withServer(async (server) => {
  assert.equal((await request(server, "alice", "/dev/v1/session")).body.principalId, "principal-1")
  assert.equal((await request(server, "bob", "/dev/v1/session")).body.defaultSpaceId, "space-2")
  for (const user of ["alice", "bob"]) {
    const response = await request(server, user, "/dev/v1/tasks")
    assert.equal(response.body.tasks.length, 3)
    for (const task of response.body.tasks) assert.equal(validator("Task")(task), true)
  }
  const post = (user, groupId, taskNumber, text) => request(server, user, "/dev/v1/zhaohu", { groupId, taskNumber, text })
  assert.equal((await post("alice", "group-private-1", "T-1024", "private alice")).status, 200)
  assert.equal((await post("bob", "group-private-2", "T-2024", "private bob")).status, 200)
  assert.equal((await request(server, "bob", "/dev/v1/tasks/T-1024/messages")).status, 403)
  assert.equal((await request(server, "alice", "/dev/v1/tasks/T-2024/messages")).status, 403)
  assert.equal((await post("bob", "group-private-1", "T-1024", "denied")).status, 403)
  assert.equal((await post("alice", "group-private-1", "T-2024", "denied")).status, 403)
  const shared = await post("alice", "group-shared", "T-3001", "shared business")
  assert.equal(validator("TaskMessage")(shared.body.message), true)
  assert.equal(shared.body.message.authorPrincipalId, "principal-1")
  assert.equal((await post("bob", "group-shared", "T-3001", "shared engineering")).status, 200)
  assert.equal((await request(server, "bob", "/dev/v1/tasks/T-3001/messages")).body.messages.length, 2)
  await post("alice", "group-shared", "T-3002", "last task is not a target default")
  const ambiguous = await request(server, "bob", "/dev/v1/zhaohu", { groupId: "group-shared", text: "no task number" })
  assert.equal(ambiguous.status, 409)
  assert.deepEqual(ambiguous.body.taskNumbers, ["T-3001", "T-3002"])
  assert.equal((await request(server, "alice", "/dev/v1/tasks/T-3002/messages")).body.messages.length, 1)
}))

test("HTTP boundary rejects spoofing, unknown identity, browser origin and abnormal Host", async () => withServer(async (server) => {
  for (const user of [undefined, "unknown", "A".repeat(43)]) assert.equal((await request(server, user, "/dev/v1/session")).status, 401)
  assert.equal((await request(server, "alice", "/dev/v1/issue", {})).status, 404)
  for (const headers of [{ Origin: "https://evil.invalid" }, { Origin: server.url }, { Host: "localhost:1234" }, { Host: "evil.invalid" }, { "Sec-Fetch-Site": "cross-site" }]) assert.equal((await request(server, "alice", "/dev/v1/session", undefined, headers)).status, 403)
  for (const headers of [{ "X-Actor-Id": "principal-2" }, { "X-Space-Id": "space-2" }, { "X-Forwarded-For": "127.0.0.1" }]) assert.equal((await request(server, "alice", "/dev/v1/session", undefined, headers)).status, 400)
  for (const extra of [{ actor: "principal-2" }, { spaceId: "space-2" }, { url: "https://evil.invalid" }, { filePath: "/tmp/secret" }]) assert.equal((await request(server, "alice", "/dev/v1/zhaohu", { groupId: "group-private-1", taskNumber: "T-1024", text: "spoof", ...extra })).status, 400)
  assert.equal((await request(server, "alice", "/dev/v1/tasks?spaceId=space-2")).status, 404)
}))

test("bounded bodies, text, attachment metadata, records and slow body deadline", async () => withServer(async (server) => {
  const payload = { groupId: "group-private-1", taskNumber: "T-1024", text: "metadata" }
  assert.equal((await request(server, "alice", "/dev/v1/zhaohu", " ".repeat(limits.bodyBytes + 1))).status, 413)
  assert.equal((await request(server, "alice", "/dev/v1/zhaohu", "{bad")).status, 400)
  assert.equal((await request(server, "alice", "/dev/v1/zhaohu", payload, { "Content-Type": "text/plain" })).status, 415)
  assert.equal((await request(server, "alice", "/dev/v1/zhaohu", { ...payload, text: "x".repeat(limits.textChars + 1) })).status, 400)
  const attachment = { name: "synthetic.pdf", mediaType: "application/pdf", sizeBytes: 20 }
  for (const attachments of [Array(5).fill(attachment), [{ ...attachment, name: "../secret" }], [{ ...attachment, url: "https://evil.invalid" }], [{ ...attachment, sizeBytes: 1048577 }]]) assert.equal((await request(server, "alice", "/dev/v1/zhaohu", { ...payload, attachments })).status, 400)
  const accepted = await request(server, "alice", "/dev/v1/zhaohu", { ...payload, attachments: [attachment] })
  assert.equal(accepted.status, 200)
  assert.deepEqual(accepted.body.attachments, [attachment])
  for (let i = 1; i < limits.records; i++) assert.equal((await request(server, "alice", "/dev/v1/zhaohu", payload)).status, 200)
  assert.equal((await request(server, "alice", "/dev/v1/zhaohu", payload)).status, 429)
  const address = new URL(server.url)
  const response = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: Number(address.port) })
    let output = ""
    socket.setTimeout(2000, () => socket.destroy(new Error("raw test timeout")))
    socket.on("connect", () => socket.write(`POST /dev/v1/model HTTP/1.1\r\nHost: ${address.host}\r\nAuthorization: Bearer ${server.credentials.alice}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`))
    socket.on("data", (chunk) => { output += chunk })
    socket.on("end", () => { socket.destroy(); resolve(output) }).on("error", reject)
  })
  assert.match(response, /^HTTP\/1\.1 408/)
}))

test("deterministic model has no tools, authorization and failure/timeout/capacity boundaries", async () => withServer(async (server) => {
  const input = { taskNumber: "T-3001", kind: "analysis" }
  const first = await request(server, "alice", "/dev/v1/model", input)
  assert.deepEqual(first, await request(server, "bob", "/dev/v1/model", input))
  assert.equal(first.body.mock, true)
  assert.deepEqual(first.body.tools, [])
  assert.match(first.body.content, /^\[MOCK\]/)
  assert.equal((await request(server, "bob", "/dev/v1/model", { ...input, taskNumber: "T-1024" })).status, 403)
  for (const extra of [{ url: "https://evil.invalid" }, { filePath: "/tmp/secret" }, { tools: ["shell"] }]) assert.equal((await request(server, "alice", "/dev/v1/model", { ...input, ...extra })).status, 400)
  assert.equal((await request(server, "alice", "/dev/v1/model", { ...input, kind: "clarification" })).status, 200)
  assert.equal((await request(server, "alice", "/dev/v1/model", { ...input, fault: "failure" })).status, 503)
  const waiting = Array.from({ length: limits.activeRequests }, () => request(server, "alice", "/dev/v1/model", { ...input, fault: "timeout" }))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal((await request(server, "alice", "/dev/v1/session")).status, 503)
  for (const result of await Promise.all(waiting)) assert.equal(result.status, 504)
  assert.equal((await request(server, "alice", "/dev/v1/session")).status, 200)
}))

test("fresh start loses ephemeral state, rotates credentials and closes ports twice", async () => {
  let oldCredential
  for (let iteration = 0; iteration < 2; iteration++) await withServer(async (server) => {
    if (oldCredential) {
      assert.notEqual(server.credentials.alice, oldCredential)
      assert.equal((await request(server, oldCredential, "/dev/v1/session")).status, 401)
    }
    oldCredential = server.credentials.alice
    assert.deepEqual((await request(server, "alice", "/dev/v1/tasks/T-1024/messages")).body.messages, [])
    assert.equal((await request(server, "alice", "/dev/v1/zhaohu", { groupId: "group-private-1", taskNumber: "T-1024", text: "ephemeral" })).status, 200)
  })
})
