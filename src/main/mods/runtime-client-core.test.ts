import { EventEmitter } from "node:events"
import { setImmediate } from "node:timers/promises"
import { afterEach, expect, it, vi } from "vitest"
import { ModRuntimeClient } from "./runtime-client-core"
import type { ModProcessLauncher } from "./process-contract"
import type { ModRuntimeRequest, ModRuntimeResponse } from "../../shared/mods/types"

class TestProcess extends EventEmitter {
  postMessage = vi.fn<(message: unknown) => void>()
  kill = vi.fn()

  message(message: ModRuntimeResponse): void {
    this.emit("message", message)
  }

  latestRequest(): ModRuntimeRequest {
    return this.postMessage.mock.calls.at(-1)![0] as ModRuntimeRequest
  }

  reply(request: ModRuntimeRequest, value: ModRuntimeResponse["value"] = []): void {
    this.message({ type: "result", id: request.id, runtimeId: request.runtimeId, value })
  }
}

const clients: ModRuntimeClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.stop()
})

function fixture() {
  const children: TestProcess[] = []
  const launch: ModProcessLauncher = () => {
    const child = new TestProcess()
    children.push(child)
    return child
  }
  const client = new ModRuntimeClient("worker.cjs", launch)
  clients.push(client)
  return { client, children }
}

async function start(client: ModRuntimeClient, children: TestProcess[]) {
  const loaded = client.load("plugin", "source")
  const child = children.at(-1)!
  child.message({ type: "ready" })
  await setImmediate()
  child.reply(child.latestRequest())
  await loaded
  return child
}

it.each(["error", "exit", "message"] as const)(
  "ignores a retired worker's %s event while its replacement is serving a request",
  async (event) => {
    const { client, children } = fixture()
    const previous = await start(client, children)
    client.stop()
    const current = await start(client, children)
    const generation = client.version
    const invocation = client.invoke("plugin", "run", {}, async () => null).catch((error) => error)
    await setImmediate()
    const request = current.latestRequest()
    if (event === "error") previous.emit("error", new Error("late IPC send failure"))
    else if (event === "exit") previous.emit("exit", 1)
    else previous.message({ type: "heartbeat", value: { rss: 512 * 1024 * 1024 } })
    expect(current.kill).not.toHaveBeenCalled()
    expect(client.version).toBe(generation)
    expect(client.stats.pending).toBe(1)
    current.reply(request, "replacement result")
    expect(await invocation).toBe("replacement result")
    expect(client.stats.pending).toBe(0)
  }
)

it("rejects current pending requests and releases the active worker on an actual process error", async () => {
  const { client, children } = fixture()
  const child = await start(client, children)
  const generation = client.version
  const invocation = client.invoke("plugin", "run", {}, async () => null).catch((error) => error)
  await setImmediate()
  child.emit("error", new Error("active IPC send failure"))
  expect(await invocation).toMatchObject({ code: "MODS_HOST_ERROR" })
  expect(child.kill).toHaveBeenCalledOnce()
  expect(client.version).toBe(generation + 1)
  expect(client.stats.pending).toBe(0)
  const replacement = await start(client, children)
  expect(replacement.kill).not.toHaveBeenCalled()
})

it.each(["stop", "complete", "cancel"] as const)(
  "does not begin a queued host operation after its invocation is invalidated by %s",
  async (ending) => {
    const { client, children } = fixture()
    const child = await start(client, children)
    const controller = new AbortController()
    const hostCall = vi.fn(async () => "external effect")
    const invocation = client
      .invoke("plugin", "run", {}, hostCall, controller.signal)
      .catch((error) => error)
    await setImmediate()
    const request = child.latestRequest()
    child.message({
      type: "call",
      id: "host-operation",
      requestId: request.id,
      runtimeId: request.runtimeId,
      method: "next",
      value: {}
    })
    if (ending === "stop") client.stop()
    else if (ending === "complete") child.reply(request, "completed")
    else controller.abort()
    await setImmediate()
    expect(hostCall).not.toHaveBeenCalled()
    if (ending === "cancel") {
      child.message({
        type: "error",
        id: request.id,
        runtimeId: request.runtimeId,
        error: "MODS_CANCELLED"
      })
    }
    const result = await invocation
    if (ending === "complete") expect(result).toBe("completed")
    else
      expect(result).toMatchObject({
        code: ending === "stop" ? "MODS_HOST_STOPPED" : "MODS_CANCELLED"
      })
    expect(client.stats.pending).toBe(0)
  }
)

it("executes and replies to a live host operation once", async () => {
  const { client, children } = fixture()
  const child = await start(client, children)
  const hostCall = vi.fn(async () => "external result")
  const invocation = client.invoke("plugin", "run", {}, hostCall)
  await setImmediate()
  const request = child.latestRequest()
  child.message({
    type: "call",
    id: "host-operation",
    requestId: request.id,
    runtimeId: request.runtimeId,
    method: "next",
    value: { path: "allowed.txt" }
  })
  await setImmediate()
  expect(hostCall).toHaveBeenCalledExactlyOnceWith("next", { path: "allowed.txt" })
  expect(child.latestRequest()).toEqual({
    type: "reply",
    id: "host-operation",
    runtimeId: request.runtimeId,
    value: "external result"
  })
  child.reply(request, "done")
  expect(await invocation).toBe("done")
})

it.each(["complete", "cancel"] as const)(
  "discards an in-flight host reply after %s without disrupting another invocation",
  async (ending) => {
    const { client, children } = fixture()
    const child = await start(client, children)
    const controller = new AbortController()
    let release!: (value: string) => void
    const hostCall = vi.fn(() => new Promise<string>((resolve) => (release = resolve)))
    const invocation = client
      .invoke("plugin", "first", {}, hostCall, controller.signal)
      .catch((error) => error)
    await setImmediate()
    const request = child.latestRequest()
    child.message({
      type: "call",
      id: "first-host-operation",
      requestId: request.id,
      runtimeId: request.runtimeId,
      method: "next",
      value: {}
    })
    await setImmediate()
    expect(hostCall).toHaveBeenCalledOnce()
    if (ending === "complete") child.reply(request, "completed")
    else controller.abort()
    const following = client.invoke("plugin", "second", {}, async () => null)
    await setImmediate()
    const followingRequest = child.latestRequest()
    const sent = child.postMessage.mock.calls.length
    release("late result")
    await setImmediate()
    expect(child.postMessage).toHaveBeenCalledTimes(sent)
    if (ending === "cancel") {
      child.message({
        type: "error",
        id: request.id,
        runtimeId: request.runtimeId,
        error: "MODS_CANCELLED"
      })
    }
    await invocation
    child.reply(followingRequest, "second result")
    expect(await following).toBe("second result")
    expect(client.stats.pending).toBe(0)
    expect(child.kill).not.toHaveBeenCalled()
  }
)
