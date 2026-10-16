import { EventEmitter } from "node:events"
import { afterEach, expect, it, vi } from "vitest"
import type { FunctionRequest } from "../../../shared/mods/v2/protocol"
import type { ModJson } from "../../../shared/mods/types"
import { FunctionGuestRuntime } from "./guest-runtime"

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock("electron", () => ({ utilityProcess: { fork } }))
import { FunctionRuntimeClient } from "./runtime-client"

const clients: FunctionRuntimeClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function fixture(rows: ModJson) {
  const child = new EventEmitter() as EventEmitter & {
    postMessage(message: FunctionRequest): void
    kill(): void
  }
  const messages: FunctionRequest[] = []
  child.kill = () => {}
  child.postMessage = (message) => {
    messages.push(message)
    queueMicrotask(() =>
      child.emit("message", {
        type: "result",
        id: message.id,
        runtimeId: message.runtimeId,
        value:
          message.type === "load"
            ? rows
            : message.type === "match"
              ? message.event.match === true
              : null
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
  return { client, guest, child, messages }
}

it("keeps a healthy utility runtime live across a wall-clock correction", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  const f = await fixture([{ id: "0", pattern: "turn.step", hasCatch: false, hasMatcher: false }])
  const wall = Date.now()
  vi.spyOn(Date, "now").mockReturnValue(wall + 3600000)
  await vi.advanceTimersByTimeAsync(250)
  await expect(f.guest.matches("0", {})).resolves.toBe(true)
})

it("accepts native quiescence proof and keeps legacy registration replies ineligible", async () => {
  const registrations = [{ id: "0", pattern: "command.run", hasCatch: false, hasMatcher: false }]
  const native = await fixture({ registrations, registrationQuiescent: true })
  expect(native.guest.registrationQuiescent).toBe(true)
  expect(native.guest.registrations).toEqual(registrations)
  const legacy = await fixture(registrations)
  expect(legacy.guest.registrationQuiescent).toBe(false)
  const pending = await fixture({ registrations, registrationQuiescent: false })
  expect(pending.guest.registrationQuiescent).toBe(false)
})

it("expires missing utility replies with a frozen wall clock even while heartbeats continue", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] })
  const f = await fixture([{ id: "0", pattern: "command.run", hasCatch: false }])
  f.child.postMessage = () => {}
  vi.spyOn(Date, "now").mockReturnValue(1)
  const heartbeat = setInterval(() => {
    f.child.emit("message", { type: "heartbeat", rss: 0, runtimes: 1, frames: 1, replies: 0 })
  }, 200)
  const pending = f.guest.invoke("0", {}, async () => ({}), {
    event: "command.run",
    origin: { plugin: "engine", tier: "core" },
    capabilities: [],
    plugin: { name: "probe", root: "/probe" },
    timeoutMs: 1
  })
  const rejection = expect(pending).rejects.toThrow("MODS_HOST_TIMEOUT")
  await vi.advanceTimersByTimeAsync(3500)
  await rejection
  clearInterval(heartbeat)
  expect(f.client.stats.pending).toBe(0)
  expect(f.client.stats.calls).toBe(0)
  await expect(f.guest.matches("0", {})).rejects.toThrow("MODS_UNLOADED")
})

it("records matcher absence from the actual QuickJS registration closure", async () => {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("turn.step",($,e,next)=>next(e));
    on("command.run",{command:"check"},($,e,next)=>next(e));
  }}`)
  try {
    expect(guest.registrations).toEqual([
      { id: "0", pattern: "turn.step", hasCatch: false, hasMatcher: false },
      { id: "1", pattern: "command.run", hasCatch: false, hasMatcher: true }
    ])
    expect(guest.matches("0", {})).toBe(true)
    expect(guest.matches("1", { command: "other" })).toBe(false)
  } finally {
    guest.dispose()
  }
})

it("retains the opted-in own meter's utility request beyond the legacy eight-second IPC wall", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] })
  const f = await fixture([{ id: "0", pattern: "command.run", hasCatch: false }])
  f.child.postMessage = (message) => { f.messages.push(message) }
  const heartbeat = setInterval(() => {
    f.child.emit("message", { type: "heartbeat", rss: 0, runtimes: 1, frames: 1, replies: 0 })
  }, 200)
  try {
    const pending = f.guest.invoke("0", {}, async () => ({}), {
      event: "command.run", origin: { plugin: "engine", tier: "core" },
      plugin: { name: "probe", root: "/probe" }, capabilities: [], ownBudgetMs: 10000
    })
    await vi.advanceTimersByTimeAsync(9000)
    expect(f.client.stats.pending).toBe(1)
    const message = f.messages.findLast((row) => row.type === "invoke")!
    f.child.emit("message", { type: "result", id: message.id, runtimeId: message.runtimeId,
      value: { value: "actual" } })
    expect(await pending).toEqual({ value: "actual" })
    expect(f.client.stats.pending).toBe(0)
  } finally {
    clearInterval(heartbeat)
  }
})

it("skips only provably unconditional matcher RPCs and does not trust later metadata mutation", async () => {
  const f = await fixture([
    { id: "0", pattern: "turn.step", hasCatch: false, hasMatcher: false },
    { id: "1", pattern: "command.run", hasCatch: false, hasMatcher: true },
    { id: "2", pattern: "command.run", hasCatch: false }
  ])
  for (let index = 0; index < 20; index++) expect(await f.guest.matches("0", {})).toBe(true)
  expect(f.messages.filter((m) => m.type === "match")).toHaveLength(0)
  Object.assign(f.guest.registrations[1], { hasMatcher: false })
  expect(await f.guest.matches("1", { match: false })).toBe(false)
  expect(await f.guest.matches("1", { match: true })).toBe(true)
  expect(await f.guest.matches("2", { match: false })).toBe(false)
  expect(f.messages.filter((m) => m.type === "match")).toHaveLength(3)
})

it.each(["dispose", "generation", "remote-death"])(
  "does not let the unconditional fast path revive a guest after %s",
  async (reason) => {
    const f = await fixture([{ id: "0", pattern: "turn.step", hasCatch: false, hasMatcher: false }])
    expect(await f.guest.matches("0", {})).toBe(true)
    if (reason === "dispose") await f.guest.dispose()
    if (reason === "generation") f.client.stop()
    if (reason === "remote-death")
      f.child.emit("message", { type: "disposed", runtimeId: f.messages[0].runtimeId })
    await expect(f.guest.matches("0", {})).rejects.toThrow("MODS_UNLOADED")
  }
)

it("retains event JSON bounds even when there is no guest matcher to evaluate", async () => {
  const f = await fixture([{ id: "0", pattern: "turn.step", hasCatch: false, hasMatcher: false }])
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  await expect(f.guest.matches("0", cyclic as never)).rejects.toThrow()
  expect(f.messages.filter((m) => m.type === "match")).toHaveLength(0)
})
