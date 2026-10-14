import { EventEmitter } from "node:events"
import { afterEach, expect, it, vi } from "vitest"
import type { FunctionRequest, FunctionResponse } from "../../../shared/mods/v2/protocol"
import type { FunctionHostReply } from "../../../shared/mods/v2/contracts"
const { fork } = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock("electron", () => ({ utilityProcess: { fork } }))
import { FunctionRuntimeClient } from "./runtime-client"

const clients: FunctionRuntimeClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.stop()
})

async function fixture() {
  const child = new EventEmitter() as EventEmitter & {
    postMessage(message: FunctionRequest): void
    kill(): void
  }
  const messages: FunctionRequest[] = []
  child.kill = vi.fn()
  child.postMessage = (message) => {
    messages.push(message)
    if (message.type === "load" || message.type === "dispose")
      queueMicrotask(() =>
        child.emit("message", {
          type: "result",
          id: message.id,
          runtimeId: message.runtimeId,
          value: message.type === "load" ? [] : null
        })
      )
  }
  fork.mockImplementation(() => {
    queueMicrotask(() => child.emit("message", { type: "ready" }))
    return child
  })
  const client = new FunctionRuntimeClient("fixture")
  clients.push(client)
  const guest = await client.load("fixture")
  const runtimeId = messages[0].runtimeId
  const emit = (message: FunctionResponse) => child.emit("message", message)
  const call = (id: string, owner = runtimeId) =>
    emit({
      type: "module-call",
      id,
      runtimeId: owner,
      method: "resource.pull",
      args: { id: "owned" }
    })
  return { client, guest, child, messages, runtimeId, emit, call }
}

it("fails closed without a binding and does not accept another runtime's principal", async () => {
  const f = await fixture()
  f.call("unbound")
  expect(f.messages.at(-1)).toMatchObject({
    type: "reply",
    error: { code: "MODS_MODULE_HOST_UNAVAILABLE" }
  })
  const host = vi.fn(async () => ({ value: null }))
  f.guest.bindModuleHost!(host)
  f.call("forged", "other-runtime")
  expect(host).not.toHaveBeenCalled()
  expect(() => f.guest.bindModuleHost!(host)).toThrow("MODS_MODULE_HOST_ALREADY_BOUND")
})

it("matches cancellation by both runtime and call id and ignores a late reply", async () => {
  const f = await fixture()
  let signal!: AbortSignal
  let release!: (value: FunctionHostReply) => void
  f.guest.bindModuleHost!((_method, _args, active) => {
    signal = active
    return new Promise((resolve) => {
      release = resolve
    })
  })
  f.call("active")
  await vi.waitFor(() => expect(signal).toBeDefined())
  f.emit({ type: "module-revoke", id: "active", runtimeId: "another" })
  expect(signal.aborted).toBe(false)
  f.emit({ type: "revoke", id: "active", runtimeId: f.runtimeId, requestId: "not-module" })
  expect(signal.aborted).toBe(false)
  f.emit({ type: "module-revoke", id: "active", runtimeId: f.runtimeId })
  expect(signal.aborted).toBe(true)
  release({ value: "late" })
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.messages.some((message) => message.type === "reply" && message.id === "active")).toBe(
    false
  )
  expect(f.client.stats.calls).toBe(0)
})

it.each(["dispose", "crash", "remote-dispose"])(
  "closes bindings exactly once on %s",
  async (action) => {
    const f = await fixture()
    let signal!: AbortSignal
    const cleanup = vi.fn()
    f.guest.bindModuleHost!((_method, _args, active) => {
      signal = active
      return new Promise(() => {})
    }, cleanup)
    f.call("pending")
    await vi.waitFor(() => expect(signal).toBeDefined())
    if (action === "dispose") await f.guest.dispose()
    else if (action === "crash") f.child.emit("exit", 1)
    else f.emit({ type: "disposed", runtimeId: f.runtimeId })
    expect(signal.aborted).toBe(true)
    expect(cleanup).toHaveBeenCalledOnce()
    expect(f.client.stats.calls).toBe(0)
    f.client.stop()
    await f.guest.dispose()
    expect(cleanup).toHaveBeenCalledOnce()
  }
)

it("caps queued module calls per runtime and releases slots after host errors", async () => {
  const f = await fixture()
  const releases: Array<(value: FunctionHostReply) => void> = []
  f.guest.bindModuleHost!(
    () =>
      new Promise((resolve) => {
        releases.push(resolve)
      })
  )
  for (let i = 0; i < 129; i++) f.call(String(i))
  expect(f.client.stats.calls).toBe(128)
  expect(f.messages.at(-1)).toMatchObject({
    id: "128",
    error: { code: "MODS_MODULE_HOST_UNAVAILABLE" }
  })
  await vi.waitFor(() => expect(releases).toHaveLength(128))
  for (const release of releases) release({ value: null })
  await vi.waitFor(() => expect(f.client.stats.calls).toBe(0))
})
