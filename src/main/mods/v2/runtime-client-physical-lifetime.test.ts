import { EventEmitter } from "node:events"
import { afterEach, expect, it, vi } from "vitest"
import type { FunctionRequest } from "../../../shared/mods/v2/protocol"
import { FunctionUiResolveMainQuota } from "./ui-resolve-main-quota"
import { aliasFunctionUiResolveRuntime, functionUiResolveRuntimeBinding } from "./ui-resolve-runtime-binding"

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock("electron", () => ({ utilityProcess: { fork } }))
import { FunctionRuntimeClient } from "./runtime-client"

const clients: FunctionRuntimeClient[] = []
afterEach(() => { for (const client of clients.splice(0)) client.stop(); vi.restoreAllMocks() })
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

function utility() {
  const child = new EventEmitter() as EventEmitter & {
    postMessage(message: FunctionRequest): void
    kill(): void
  }
  const messages: FunctionRequest[] = []
  child.kill = vi.fn()
  child.postMessage = message => {
    messages.push(message)
    if (message.type !== "load") return
    queueMicrotask(() => child.emit("message", {
      type: "result", id: message.id, runtimeId: message.runtimeId,
      value: [{ id: "0", pattern: "ui.render", hasCatch: false, hasMatcher: false }]
    }))
  }
  fork.mockImplementationOnce(() => {
    queueMicrotask(() => child.emit("message", { type: "ready" }))
    return child
  })
  return { child, messages }
}

it.each(["call", "module-call"] as const)(
  "keeps actual main %s host finally occupied after stop, map clearing and true exit", async kind => {
    const f = utility()
    const client = new FunctionRuntimeClient("fixture")
    clients.push(client)
    const guest = await client.load("fixture")
    const lifetime = client.captureUiResolvePhysicalLifetime()
    const pool = new FunctionUiResolveMainQuota()
    const lease = pool.register(lifetime)
    const credit = pool.reserve(lease, { handles: 64, roots: 1, branches: 1, reactions: 1 })
    pool.acknowledge(lease, credit, f.child)
    let finish!: () => void
    const held = new Promise<void>(resolve => { finish = resolve })
    const host = vi.fn(async () => { await held; return { value: "actual" } })
    const runtimeId = f.messages[0].runtimeId
    let pending: Promise<unknown> | undefined
    if (kind === "module-call") guest.bindModuleHost!(host)
    else {
      pending = guest.invoke("0", {}, host, {
        event: "ui.render", origin: { plugin: "engine", tier: "core" },
        capabilities: [], plugin: { name: "probe", root: "/probe" }
      })
      void pending.catch(() => undefined)
      await tick()
    }
    const invocation = f.messages.find(row => row.type === "invoke")
    f.child.emit("message", {
      type: kind, id: "actual-host-call", runtimeId,
      ...(kind === "call" ? { requestId: invocation!.id } : {}), method: "store.get", args: []
    })
    await tick()
    expect(host).toHaveBeenCalledTimes(1)
    client.stop()
    expect(client.stats.calls).toBe(0)
    f.child.emit("exit", 0)
    await lifetime.disposed
    await tick()
    expect(pool.stats.handles).toBe(64)
    finish()
    await pool.whenReleased(lease)
    expect(pool.stats.handles).toBe(0)
    expect(f.messages.some(row => row.type === "reply")).toBe(false)
    if (pending) await expect(pending).rejects.toMatchObject({ code: "MODS_HOST_STOPPED" })
  }
)

it("settles an old physical receipt after replacement without stopping its new child", async () => {
  const old = utility()
  const client = new FunctionRuntimeClient("fixture")
  clients.push(client)
  await client.load("old")
  const oldLife = client.captureUiResolvePhysicalLifetime()
  client.stop()
  const fresh = utility()
  const newGuest = await client.load("new")
  const newLife = client.captureUiResolvePhysicalLifetime()
  old.child.emit("exit", 0)
  await oldLife.disposed
  expect(newLife.owner).toBe(fresh.child)
  expect(newLife.owner).not.toBe(oldLife.owner)
  expect(() => newLife.assertCurrent()).not.toThrow()
  await expect(newGuest.matches("0", {})).resolves.toBe(true)
  expect(fresh.child.kill).not.toHaveBeenCalled()
})

it("uses exact loaded guest identity and immutable registrations across a native activity alias", async () => {
  const f = utility()
  const client = new FunctionRuntimeClient("fixture")
  clients.push(client)
  const guest = await client.load("fixture")
  const actual = functionUiResolveRuntimeBinding(guest)
  expect(actual.physical.owner).toBe(f.child)
  expect(actual.runtimeId).toBe(f.messages[0].runtimeId)
  expect(() => functionUiResolveRuntimeBinding({ ...guest })).toThrow("MODS_UI_RESOLVE_TRANSPORT_REQUIRED")
  const alias = new Proxy(guest, {})
  aliasFunctionUiResolveRuntime(guest, alias)
  expect(functionUiResolveRuntimeBinding(alias)).toBe(actual)
  Object.assign(guest.registrations[0], { id: "forged", pattern: "*" })
  expect(actual.registrations[0]).toEqual({
    id: "0", pattern: "ui.render", hasCatch: false, hasMatcher: false
  })
  client.stop()
  expect(() => functionUiResolveRuntimeBinding(alias)).toThrow("MODS_UI_RESOLVE_RETIRED")
})

it("awaits actual exit and host-call settlement when a development generation is retired", async () => {
  const f = utility()
  const client = new FunctionRuntimeClient("fixture")
  clients.push(client)
  const guest = await client.load("fixture")
  let finish!: () => void
  const held = new Promise<void>(resolve => { finish = resolve })
  const host = vi.fn(async () => { await held; return {} })
  guest.bindModuleHost!(host)
  f.child.emit("message", { type: "module-call", id: "held", runtimeId: f.messages[0].runtimeId,
    method: "store.get", args: [] })
  await tick()
  expect(host).toHaveBeenCalledOnce()
  let retired = false
  const drained = client.stopAndDrain().then(() => { retired = true })
  expect(f.child.kill).toHaveBeenCalledOnce()
  await tick()
  expect(retired).toBe(false)
  f.child.emit("exit", 0)
  await tick()
  expect(retired).toBe(false)
  finish()
  await drained
  expect(retired).toBe(true)
})
