import { EventEmitter } from "node:events"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { ModRuntimeRequest } from "../../../shared/mods/types"
import type { FunctionRequest } from "../../../shared/mods/v2/protocol"
import { ModRuntimeClient } from "../runtime-client"
import { FunctionRuntimeClient } from "./runtime-client"

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock("electron", () => ({ utilityProcess: { fork } }))

const nativeSetInterval = globalThis.setInterval
const nativeClearInterval = globalThis.clearInterval
const nativeSetImmediate = globalThis.setImmediate
const nativeClearImmediate = globalThis.clearImmediate
type ClientKind = "legacy" | "function"
type Request = ModRuntimeRequest | FunctionRequest
const clients: Array<ModRuntimeClient | FunctionRuntimeClient> = []
const intervals: Array<() => void> = []
const immediates: Array<{
  handle: ReturnType<typeof setImmediate>
  run(): void
  unrefCalls(): number
  cleared: boolean
}> = []
let now = 0

beforeEach(() => {
  now = 0
  intervals.length = 0
  immediates.length = 0
  fork.mockReset()
  vi.spyOn(Date, "now").mockImplementation(() => now)
  vi.spyOn(performance, "now").mockImplementation(() => now)
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(globalThis, "setInterval").mockImplementation((callback) => {
    // Use actual Node handles, but only this test decides when the captured callback runs.
    const handle = nativeSetInterval(() => {}, 60000)
    nativeClearInterval(handle)
    intervals.push(() => callback())
    return handle
  })
  vi.spyOn(globalThis, "setImmediate").mockImplementation((callback) => {
    const handle = nativeSetImmediate(() => {})
    nativeClearImmediate(handle)
    const unref = vi.spyOn(handle, "unref")
    immediates.push({
      handle,
      run: () => callback(),
      unrefCalls: () => unref.mock.calls.length,
      cleared: false
    })
    return handle
  })
  vi.spyOn(globalThis, "clearImmediate").mockImplementation((handle) => {
    const scheduled = immediates.find((entry) => entry.handle === handle)
    if (scheduled) scheduled.cleared = true
    nativeClearImmediate(handle)
  })
})

afterEach(() => {
  for (const client of clients.splice(0)) client.stop()
  vi.restoreAllMocks()
})

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve()
}

function utility() {
  class Child extends EventEmitter {
    readonly messages: Request[] = []
    readonly kill = vi.fn(() => {})
    postMessage(message: Request): void {
      this.messages.push(message)
    }
  }
  const child = new Child()
  fork.mockImplementationOnce(() => {
    queueMicrotask(() => child.emit("message", { type: "ready" }))
    return child
  })
  return child
}

function heartbeat(child: ReturnType<typeof utility>, kind: ClientKind): void {
  child.emit(
    "message",
    kind === "legacy"
      ? { type: "heartbeat", value: { rss: 1 } }
      : { type: "heartbeat", rss: 1, runtimes: 1, frames: 0, replies: 0 }
  )
}

function finishLoad(child: ReturnType<typeof utility>): void {
  const request = child.messages.find((message) => message.type === "load")
  if (!request) throw Error("ACTUAL_LOAD_REQUEST_REQUIRED")
  child.emit("message", {
    type: "result",
    id: request.id,
    runtimeId: request.runtimeId,
    value: []
  })
}

async function fixture(kind: ClientKind) {
  const child = utility()
  const client =
    kind === "legacy" ? new ModRuntimeClient("fixture") : new FunctionRuntimeClient("fixture")
  clients.push(client)
  const load = () =>
    client instanceof ModRuntimeClient
      ? client.load("fixture-runtime", "fixture source")
      : client.load("fixture source")
  const loading = load()
  // Observe the real pending request immediately, including rejection before test awaits it.
  const settled = loading.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason })
  )
  await flush()
  const tick = intervals.at(-1)
  if (!tick) throw Error("ACTUAL_WATCHDOG_CALLBACK_REQUIRED")
  expect(child.messages.filter((message) => message.type === "load")).toHaveLength(1)
  return { child, client, load, loading, settled, tick }
}

function advanceQuietTicks(tick: () => void, target: number): void {
  while (now + 250 < target) {
    now += 250
    tick()
  }
  now = target
  tick()
}

it.each(["legacy", "function"] as const)(
  "%s keeps the exact two-second boundary and terminates silence after one coalesced recheck",
  async (kind) => {
    const f = await fixture(kind)
    now = 2000
    f.tick()
    expect(immediates).toHaveLength(0)
    expect(f.child.kill).not.toHaveBeenCalled()
    now = 2250
    f.tick()
    f.tick()
    expect(immediates).toHaveLength(1)
    expect(immediates[0].handle.hasRef()).toBe(false)
    expect(immediates[0].unrefCalls()).toBe(1)
    expect(f.child.kill).not.toHaveBeenCalled()
    immediates[0].run()
    expect(f.child.kill).toHaveBeenCalledTimes(1)
    expect(await f.settled).toMatchObject({
      status: "rejected",
      reason: { code: "MODS_HOST_UNRESPONSIVE" }
    })
    expect(immediates).toHaveLength(1)
  }
)

it.each(["legacy", "function"] as const)(
  "%s accepts an actual queued heartbeat and completes the original pending reply",
  async (kind) => {
    const f = await fixture(kind)
    now = 2250
    f.tick()
    expect(immediates).toHaveLength(1)
    queueMicrotask(() => heartbeat(f.child, kind))
    await flush()
    immediates[0].run()
    expect(f.child.kill).not.toHaveBeenCalled()
    finishLoad(f.child)
    expect((await f.settled).status).toBe("fulfilled")
    // A successful recheck does not grant permanent liveness to the same physical child.
    advanceQuietTicks(f.tick, 4501)
    expect(immediates).toHaveLength(2)
    immediates[1].run()
    expect(f.child.kill).toHaveBeenCalledTimes(1)
  }
)

it.each(["legacy", "function"] as const)(
  "%s clears its recheck on stop and a retained old callback cannot clear or kill its replacement",
  async (kind) => {
    const f = await fixture(kind)
    now = 2250
    f.tick()
    const old = immediates[0]
    f.client.stop()
    expect(old.cleared).toBe(true)
    expect(f.child.kill).toHaveBeenCalledTimes(1)
    expect(await f.settled).toMatchObject({
      status: "rejected",
      reason: { code: "MODS_HOST_STOPPED" }
    })
    const replacement = utility()
    const loading = f.load()
    const settled = loading.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason })
    )
    await flush()
    const tick = intervals.at(-1)
    if (!tick) throw Error("ACTUAL_REPLACEMENT_WATCHDOG_REQUIRED")
    now = 4501
    tick()
    expect(immediates).toHaveLength(2)
    old.run()
    tick()
    expect(immediates).toHaveLength(2)
    expect(immediates[1].cleared).toBe(false)
    expect(replacement.kill).not.toHaveBeenCalled()
    heartbeat(replacement, kind)
    immediates[1].run()
    finishLoad(replacement)
    expect((await settled).status).toBe("fulfilled")
    expect(replacement.kill).not.toHaveBeenCalled()
  }
)

it.each(["legacy", "function"] as const)(
  "%s still retires error, exit and memory overflow immediately while a heartbeat recheck is pending",
  async (kind) => {
    for (const fault of ["error", "exit", "memory"] as const) {
      now = 0
      const f = await fixture(kind)
      now = 2250
      f.tick()
      const scheduled = immediates.at(-1)
      if (!scheduled) throw Error("ACTUAL_PENDING_RECHECK_REQUIRED")
      if (fault === "memory") {
        f.child.emit(
          "message",
          kind === "legacy"
            ? { type: "heartbeat", value: { rss: 385 * 1024 * 1024 } }
            : { type: "heartbeat", rss: 385 * 1024 * 1024, runtimes: 1, frames: 0, replies: 0 }
        )
      } else f.child.emit(fault)
      expect(f.child.kill).toHaveBeenCalledTimes(1)
      expect(scheduled.cleared).toBe(true)
      const code =
        fault === "memory"
          ? "MODS_HOST_MEMORY"
          : fault === "exit"
            ? "MODS_HOST_EXITED"
            : "MODS_HOST_ERROR"
      expect(await f.settled).toMatchObject({ status: "rejected", reason: { code } })
      scheduled.run()
      expect(f.child.kill).toHaveBeenCalledTimes(1)
    }
  }
)

it.each([false, true])(
  "function request expiry terminates on the original tick before heartbeat deferral: pending recheck=%s",
  async (queued) => {
    const f = await fixture("function")
    if (queued) {
      now = 2250
      f.tick()
      expect(immediates).toHaveLength(1)
    }
    now = 10001
    f.tick()
    expect(f.child.kill).toHaveBeenCalledTimes(1)
    expect(await f.settled).toMatchObject({
      status: "rejected",
      reason: { code: "MODS_HOST_TIMEOUT" }
    })
    expect(immediates).toHaveLength(queued ? 1 : 0)
    if (queued) {
      expect(immediates[0].cleared).toBe(true)
      immediates[0].run()
      expect(f.child.kill).toHaveBeenCalledTimes(1)
    }
  }
)

it("function deferred recheck reads the actual pending expiry before the stale heartbeat", async () => {
  const f = await fixture("function")
  now = 2250
  f.tick()
  expect(immediates).toHaveLength(1)
  now = 10001
  immediates[0].run()
  expect(f.child.kill).toHaveBeenCalledTimes(1)
  expect(await f.settled).toMatchObject({
    status: "rejected",
    reason: { code: "MODS_HOST_TIMEOUT" }
  })
  expect(immediates).toHaveLength(1)
})

it.each(["legacy", "function"] as const)(
  "%s allows one bounded grace after a delayed Main tick and never renews it for another pause",
  async (kind) => {
    const f = await fixture(kind)
    now = 2250
    f.tick()
    immediates[0].run()
    expect(f.child.kill).not.toHaveBeenCalled()
    now = 4249
    f.tick()
    immediates[1].run()
    expect(f.child.kill).not.toHaveBeenCalled()
    // A second Main pause cannot move the original 4250 cutoff forward.
    now = 6500
    f.tick()
    immediates[2].run()
    expect(f.child.kill).toHaveBeenCalledTimes(1)
    expect(await f.settled).toMatchObject({
      status: "rejected",
      reason: { code: "MODS_HOST_UNRESPONSIVE" }
    })
  }
)

it.each(["legacy", "function"] as const)(
  "%s ends a silent guest exactly when its fixed pause grace expires",
  async (kind) => {
    const f = await fixture(kind)
    now = 2250
    f.tick()
    immediates[0].run()
    now = 4249
    f.tick()
    immediates[1].run()
    expect(f.child.kill).not.toHaveBeenCalled()
    now = 4250
    f.tick()
    immediates[2].run()
    expect(f.child.kill).toHaveBeenCalledTimes(1)
    expect(await f.settled).toMatchObject({
      status: "rejected",
      reason: { code: "MODS_HOST_UNRESPONSIVE" }
    })
  }
)

it.each(["legacy", "function"] as const)(
  "%s recognizes a Main pause while its single recheck was waiting without extending it later",
  async (kind) => {
    const f = await fixture(kind)
    advanceQuietTicks(f.tick, 2250)
    expect(immediates).toHaveLength(1)
    now = 4501
    immediates[0].run()
    expect(f.child.kill).not.toHaveBeenCalled()
    now = 6500
    f.tick()
    immediates[1].run()
    expect(f.child.kill).not.toHaveBeenCalled()
    now = 6501
    f.tick()
    immediates[2].run()
    expect(f.child.kill).toHaveBeenCalledTimes(1)
    expect(await f.settled).toMatchObject({
      status: "rejected",
      reason: { code: "MODS_HOST_UNRESPONSIVE" }
    })
  }
)

it.each(["legacy", "function"] as const)(
  "%s resets pause grace only on a real heartbeat and later still terminates quiet-host silence",
  async (kind) => {
    const f = await fixture(kind)
    now = 2250
    f.tick()
    immediates[0].run()
    heartbeat(f.child, kind)
    now = 4501
    f.tick()
    immediates[1].run()
    expect(f.child.kill).not.toHaveBeenCalled()
    heartbeat(f.child, kind)
    finishLoad(f.child)
    expect((await f.settled).status).toBe("fulfilled")
    advanceQuietTicks(f.tick, 6751)
    immediates[2].run()
    expect(f.child.kill).toHaveBeenCalledTimes(1)
  }
)

it.each(["legacy", "function"] as const)(
  "%s does not reset an active grace when the original pending result arrives",
  async (kind) => {
    const f = await fixture(kind)
    now = 2250
    f.tick()
    immediates[0].run()
    finishLoad(f.child)
    expect((await f.settled).status).toBe("fulfilled")
    now = 4250
    f.tick()
    immediates[1].run()
    expect(f.child.kill).toHaveBeenCalledTimes(1)
  }
)

it.each(["legacy", "function"] as const)(
  "%s retains immediate error, exit, memory and Stop during an actual pause grace",
  async (kind) => {
    for (const fault of ["error", "exit", "memory", "stop"] as const) {
      now = 0
      const f = await fixture(kind)
      now = 2250
      f.tick()
      const first = immediates.at(-1)
      if (!first) throw Error("ACTUAL_GRACE_RECHECK_REQUIRED")
      first.run()
      expect(f.child.kill).not.toHaveBeenCalled()
      if (fault === "memory") {
        f.child.emit(
          "message",
          kind === "legacy"
            ? { type: "heartbeat", value: { rss: 385 * 1024 * 1024 } }
            : { type: "heartbeat", rss: 385 * 1024 * 1024, runtimes: 1, frames: 0, replies: 0 }
        )
      } else if (fault === "stop") f.client.stop()
      else f.child.emit(fault)
      const code =
        fault === "memory"
          ? "MODS_HOST_MEMORY"
          : fault === "exit"
            ? "MODS_HOST_EXITED"
            : fault === "error"
              ? "MODS_HOST_ERROR"
              : "MODS_HOST_STOPPED"
      expect(f.child.kill).toHaveBeenCalledTimes(1)
      expect(await f.settled).toMatchObject({ status: "rejected", reason: { code } })
    }
  }
)

it("function pending expiry still wins while a fixed pause grace is active", async () => {
  const f = await fixture("function")
  now = 9000
  f.tick()
  immediates[0].run()
  expect(f.child.kill).not.toHaveBeenCalled()
  now = 10001
  f.tick()
  expect(f.child.kill).toHaveBeenCalledTimes(1)
  expect(await f.settled).toMatchObject({
    status: "rejected",
    reason: { code: "MODS_HOST_TIMEOUT" }
  })
})
