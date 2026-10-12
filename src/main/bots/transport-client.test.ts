import { EventEmitter } from "node:events"
import { afterEach, expect, it, vi } from "vitest"
import { BotTransportClient } from "./transport-client"
import { encodeBotFrame } from "./rpc"
import { BOT_PROTOCOL_VERSION } from "../../shared/bot-types"

// Control delivery order at the socket boundary; exercise the real framing,
// authentication and client without relying on OS close-event timing.
vi.mock("node:net", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:net")>()),
  createConnection: () => {
    const socket = new TestSocket()
    sockets.push(socket)
    return socket
  }
}))

class TestSocket extends EventEmitter {
  destroyed = false
  closed = false
  backpressure = false
  writeFailure?: Error
  readonly writes: Record<string, unknown>[] = []
  constructor() {
    super()
    this.once("close", () => {
      this.closed = true
    })
  }
  write(bytes: Buffer): boolean {
    if (this.writeFailure) throw this.writeFailure
    this.writes.push(JSON.parse(bytes.subarray(4).toString("utf8")))
    return !this.backpressure
  }
  destroy(): this {
    this.destroyed = true
    return this
  }
  reply(index: number, response: Record<string, unknown>): void {
    this.emit("data", encodeBotFrame({ id: this.writes[index].id, ...response }))
  }
}
const sockets: TestSocket[] = []
const clients: BotTransportClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.close()
  for (const socket of sockets.splice(0)) socket.emit("close")
  vi.useRealTimers()
})

function client() {
  const value = new BotTransportClient({
    version: BOT_PROTOCOL_VERSION,
    pid: process.pid,
    hostId: "fixture-host",
    socketPath: "fixture-socket",
    token: "fixture-token"
  })
  clients.push(value)
  return value
}

async function authenticate(socket: TestSocket) {
  socket.emit("connect")
  await vi.waitFor(() => expect(socket.writes).toHaveLength(1), { interval: 1 })
  expect(socket.writes[0]).toMatchObject({ token: "fixture-token" })
  socket.reply(0, { ok: true, value: null })
}

async function readyClient() {
  const transport = client(),
    ready = transport.connect(),
    socket = sockets.at(-1)!
  await authenticate(socket)
  await ready
  return { transport, socket }
}

it("drains an aborted private file socket without rejecting a concurrent UI request", async () => {
  const { transport, socket } = await readyClient()
  const ui = transport.call("status")
  await vi.waitFor(() => expect(socket.writes).toHaveLength(2), { interval: 1 })
  const file = transport.openIsolatedConnection()
  clients.push(file)
  const connecting = file.connect()
  const privateSocket = sockets.at(-1)!
  await authenticate(privateSocket)
  await connecting
  const pending = file.call("fileChunk", { id: "file", offset: 0 }).catch((error) => error)
  await vi.waitFor(() => expect(privateSocket.writes).toHaveLength(2), { interval: 1 })
  file.close()
  expect(await pending).toMatchObject({ code: "host_disconnected" })
  let drained = false
  const drain = file.closeAndWait().then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  privateSocket.emit("close")
  await drain
  socket.reply(1, { ok: true, value: { hostId: "current" } })
  expect(await ui).toMatchObject({ hostId: "current" })
  expect(socket.destroyed).toBe(false)
})

it("retains the upgrade fence on an isolated file connection", async () => {
  const { transport } = await readyClient()
  transport.upgradePending = "后台待更新"
  const file = transport.openIsolatedConnection()
  clients.push(file)
  const connecting = file.connect()
  const socket = sockets.at(-1)!
  await authenticate(socket)
  await connecting
  await expect(
    file.call("send", { nonce: "new", conversationId: "chat", text: "任务" })
  ).rejects.toMatchObject({ code: "host_upgrade_pending" })
  expect(socket.writes).toHaveLength(1)
})

it("drains FIFO with bounded concurrency and preserves queued mutation bodies", async () => {
  const { transport, socket } = await readyClient()
  const inputs = Array.from({ length: 17 }, (_, index) => ({
    nonce: `send-${index}`,
    conversationId: "conversation",
    text: `原始 ${index}`
  }))
  const results = inputs.map((input) => transport.call("send", input).catch((error) => error))
  await vi.waitFor(() => expect(socket.writes).toHaveLength(9), { interval: 1 })
  inputs[16].text = "随后编辑"
  // A domain error frees a slot just like success; neither disconnects the queue.
  socket.reply(8, { ok: false, error: { code: "fixture_rejected", message: "Rejected" } })
  expect(socket.writes).toHaveLength(10)
  let acknowledged = 1
  for (let index = 1; index <= 17; index++) {
    if (index === 8) continue
    expect(socket.writes.length - 1 - acknowledged).toBeLessThanOrEqual(8)
    socket.reply(index, { ok: true, value: { messageId: `message-${index - 1}`, runIds: [] } })
    acknowledged++
  }
  const settled = await Promise.all(results)
  expect(settled.filter((result) => result.code === "fixture_rejected")).toHaveLength(1)
  expect(settled[16]).toEqual({ messageId: "message-16", runIds: [] })
  expect(socket.writes.slice(1).map((request) => request.input)).toEqual(
    inputs.map((input, index) => ({ ...input, text: `原始 ${index}` }))
  )
  expect(new Set(socket.writes.map((request) => request.id)).size).toBe(18)
  expect(socket.destroyed).toBe(false)
})

it("bounds queued count and releases every request on close without replay on reconnect", async () => {
  const { transport, socket } = await readyClient()
  vi.useFakeTimers()
  const requests = Array.from({ length: 41 }, () =>
    transport.call("status").catch((error: unknown) => error)
  )
  expect(await requests[40]).toMatchObject({ code: "host_busy" })
  expect(socket.writes).toHaveLength(9)
  expect(vi.getTimerCount()).toBe(40)
  transport.close()
  expect(
    (await Promise.all(requests.slice(0, 40))).every(
      (error) =>
        error && typeof error === "object" && "code" in error && error.code === "host_disconnected"
    )
  ).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
  const next = transport.call("status")
  const replacement = sockets.at(-1)!
  await authenticate(replacement)
  await vi.waitFor(() => expect(replacement.writes).toHaveLength(2), { interval: 1 })
  socket.emit("drain")
  socket.reply(1, { ok: true, value: { retired: true } })
  socket.emit("close")
  expect(socket.writes).toHaveLength(9)
  replacement.reply(1, { ok: true, value: { hostId: "new" } })
  expect(await next).toMatchObject({ hostId: "new" })
  expect(replacement.destroyed).toBe(false)
})

it("bounds queued bytes separately from count and rejects oversized frames without disconnecting", async () => {
  const { transport, socket } = await readyClient()
  const active = Array.from({ length: 8 }, () => transport.call("status").catch((error) => error))
  await vi.waitFor(() => expect(socket.writes).toHaveLength(9), { interval: 1 })
  const requests = Array.from({ length: 3 }, (_, index) =>
    transport
      .call("send", {
        nonce: `large-${index}`,
        conversationId: "conversation",
        text: "x".repeat(6 * 1024 * 1024)
      })
      .catch((error) => error)
  )
  expect(await requests[2]).toMatchObject({ code: "host_busy" })
  await expect(
    transport.call("send", {
      nonce: "oversized",
      conversationId: "conversation",
      text: "x".repeat(8 * 1024 * 1024)
    })
  ).rejects.toMatchObject({ code: "response_too_large" })
  expect(socket.writes).toHaveLength(9)
  expect(socket.destroyed).toBe(false)
  transport.close()
  await Promise.all([...active, ...requests])
})

it("honors stream backpressure even when a response frees an RPC slot", async () => {
  const { transport, socket } = await readyClient()
  socket.backpressure = true
  const requests = Array.from({ length: 3 }, () => transport.call("status").catch((error) => error))
  await vi.waitFor(() => expect(socket.writes).toHaveLength(2), { interval: 1 })
  socket.reply(1, { ok: true, value: "first" })
  expect(await requests[0]).toBe("first")
  expect(socket.writes).toHaveLength(2)
  socket.backpressure = false
  socket.emit("drain")
  expect(socket.writes).toHaveLength(4)
  socket.reply(3, { ok: true, value: "third" })
  socket.reply(2, { ok: true, value: "second" })
  expect(await Promise.all(requests)).toEqual(["first", "second", "third"])
})

it("expires unsent requests without closing the connection or retaining queue bytes", async () => {
  const { transport, socket } = await readyClient()
  vi.useFakeTimers()
  socket.backpressure = true
  const first = transport.call("status")
  await vi.advanceTimersByTimeAsync(0)
  socket.reply(1, { ok: true, value: "first" })
  await first
  const input = {
    nonce: "expired",
    conversationId: "conversation",
    text: "x".repeat(6 * 1024 * 1024)
  }
  const queued = Array.from({ length: 2 }, () =>
    transport.call("send", input).catch((error) => error)
  )
  await vi.advanceTimersByTimeAsync(30_000)
  expect(await Promise.all(queued)).toMatchObject([{ code: "host_busy" }, { code: "host_busy" }])
  expect(socket.writes).toHaveLength(2)
  expect(socket.destroyed).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
  socket.backpressure = false
  socket.emit("drain")
  const next = transport.call("send", { ...input, nonce: "next" })
  await vi.advanceTimersByTimeAsync(0)
  socket.reply(2, { ok: true, value: "next" })
  expect(await next).toBe("next")
  expect(vi.getTimerCount()).toBe(0)
})

it("disconnects uncertain in-flight timeouts and discards unsent work", async () => {
  const { transport, socket } = await readyClient()
  vi.useFakeTimers()
  const requests = Array.from({ length: 10 }, () =>
    transport.call("status").catch((error) => error)
  )
  await vi.advanceTimersByTimeAsync(30_000)
  const errors = await Promise.all(requests)
  expect(errors[0]).toMatchObject({ code: "host_timeout" })
  expect(errors.slice(1).every((error) => error.code === "host_disconnected")).toBe(true)
  expect(socket.destroyed).toBe(true)
  expect(socket.writes).toHaveLength(9)
  expect(vi.getTimerCount()).toBe(0)
})

it("cleans up pending and queued requests when a drained write throws", async () => {
  const { transport, socket } = await readyClient()
  vi.useFakeTimers()
  const requests = Array.from({ length: 10 }, () =>
    transport.call("status").catch((error) => error)
  )
  await vi.advanceTimersByTimeAsync(0)
  socket.writeFailure = new Error("fixture write failure")
  socket.reply(1, { ok: true, value: "first" })
  const results = await Promise.all(requests)
  expect(results[0]).toBe("first")
  expect(results[8]).toMatchObject({ message: "fixture write failure" })
  expect(results[9]).toMatchObject({ code: "host_disconnected" })
  expect(socket.writes).toHaveLength(9)
  expect(socket.destroyed).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it("keeps a new authenticated request alive when the closed connection delivers its last event", async () => {
  const transport = client()
  const initial = transport.connect()
  const first = sockets[0]
  await authenticate(first)
  await initial
  const old = transport.call("status").catch((error: unknown) => error)
  await vi.waitFor(() => expect(first.writes).toHaveLength(2), { interval: 1 })
  transport.close()
  const next = transport.call("status").then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  )
  const second = sockets[1]
  await authenticate(second)
  await vi.waitFor(() => expect(second.writes).toHaveLength(2), { interval: 1 })
  first.emit("close")
  second.reply(1, { ok: true, value: { hostId: "fixture-host" } })
  expect(await next).toEqual({ value: { hostId: "fixture-host" } })
  expect(await old).toMatchObject({ code: "host_disconnected" })
  expect(second.destroyed).toBe(false)
  const followup = transport.call("status")
  await vi.waitFor(() => expect(second.writes).toHaveLength(3), { interval: 1 })
  second.reply(2, { ok: true, value: { hostId: "fixture-host" } })
  await expect(followup).resolves.toMatchObject({ hostId: "fixture-host" })
  expect(sockets).toHaveLength(2)
})

it("closes a rejected authentication socket before a later retry", async () => {
  const transport = client()
  const rejected = transport.connect().catch((error: unknown) => error)
  const first = sockets[0]
  first.emit("connect")
  await vi.waitFor(() => expect(first.writes).toHaveLength(1), { interval: 1 })
  first.reply(0, { ok: false, error: { code: "unauthorized", message: "Session revoked" } })
  expect(await rejected).toMatchObject({ code: "unauthorized" })
  expect(first.destroyed).toBe(true)
  const retry = transport.connect()
  const second = sockets[1]
  await authenticate(second)
  await retry
  first.emit("close")
  const ready = transport.connect()
  await ready
  expect(sockets).toHaveLength(2)
})

it.each(["opening", "authenticating"])(
  "settles a cancelled %s connection without clearing its replacement",
  async (phase) => {
    const transport = client()
    const cancelled = transport.connect().catch((error: unknown) => error)
    const first = sockets[0]
    if (phase === "authenticating") {
      first.emit("connect")
      await vi.waitFor(() => expect(first.writes).toHaveLength(1), { interval: 1 })
    }
    transport.close()
    const retry = transport.connect()
    const second = sockets[1]
    await authenticate(second)
    await retry
    first.emit("close")
    expect(await cancelled).toMatchObject({ code: "host_disconnected" })
    await transport.connect()
    expect(sockets).toHaveLength(2)
    expect(second.destroyed).toBe(false)
  }
)
