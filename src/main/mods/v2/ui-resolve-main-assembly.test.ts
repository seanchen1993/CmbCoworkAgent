import { EventEmitter } from "node:events"
import { afterEach, expect, it, vi } from "vitest"
import type { FunctionRequest } from "../../../shared/mods/v2/protocol"
import type { FunctionPlugin } from "./dispatcher"
import { FunctionUiResolveMainAssembly } from "./ui-resolve-main-assembly"
import { FunctionUiResolveMainQuota } from "./ui-resolve-main-quota"
import { FunctionSessionActivity } from "./session-activity"
import { FunctionSessionInitializer } from "./session-initializer"
import { FunctionUiResolveDrawing } from "./ui-resolve-drawing"
import { FunctionSharedWallCut } from "./shared-wall-cut"

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock("electron", () => ({ utilityProcess: { fork } }))
import { FunctionRuntimeClient } from "./runtime-client"

const clients: FunctionRuntimeClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.stop()
  vi.restoreAllMocks()
})
const tick = async () => {
  for (let i = 0; i < 16; i++) await Promise.resolve()
}

async function fixture(
  options: {
    quota?: FunctionUiResolveMainQuota
    initializer?: FunctionSessionInitializer
    held?: Promise<void>
    nativeOnly?: boolean
    initializationCall?: boolean
  } = {}
) {
  const child = new EventEmitter() as EventEmitter & {
    postMessage(message: FunctionRequest): void
    kill(): void
  }
  const messages: FunctionRequest[] = []
  const ids: string[] = []
  let preparing: Extract<FunctionRequest, { type: "prepare-ui-resolve" }> | undefined
  const prepared = () => {
    const actual = preparing!
    child.emit("message", {
      type: "result",
      id: actual.id,
      runtimeId: actual.runtimeId,
      value: {
        assembly: actual.assembly,
        preparedToken: "actual-prepared",
        sources: {
          [ids[0]]: {
            Pane: options.nativeOnly
              ? []
              : [
                  { runtimeId: ids[1], registration: "0" },
                  { runtimeId: ids[2], registration: "0" }
                ]
          }
        }
      }
    })
  }
  child.kill = vi.fn()
  child.postMessage = (message) => {
    messages.push(message)
    if (message.type === "load") {
      ids.push(message.runtimeId)
      queueMicrotask(() =>
        child.emit("message", {
          type: "result",
          id: message.id,
          runtimeId: message.runtimeId,
          value: [
            {
              id: "0",
              pattern: ids.length === 1 ? "ui.render" : "ui.resolve",
              hasCatch: false,
              hasMatcher: false
            },
            { id: "1", pattern: "ui.resolve", hasCatch: false, hasMatcher: true }
          ]
        })
      )
    } else if (message.type === "prepare-ui-resolve") {
      preparing = message
      queueMicrotask(() => {
        child.emit("message", {
          type: "ui-resolve-credit-ack",
          assembly: message.assembly,
          revision: message.credit.revision
        })
        if (options.nativeOnly) prepared()
        else
          child.emit("message", {
            type: "ui-resolve-credit-request",
            assembly: message.assembly,
            id: "actual-credit-growth",
            limits: { handles: 64, roots: 16, branches: 512, reactions: 512 }
          })
      })
    } else if (message.type === "ui-resolve-credit-reply") {
      queueMicrotask(() => {
        if (message.error)
          child.emit("message", {
            type: "error",
            id: preparing!.id,
            runtimeId: preparing!.runtimeId,
            error: message.error
          })
        else {
          child.emit("message", {
            type: "ui-resolve-credit-ack",
            assembly: message.assembly,
            revision: message.credit!.revision
          })
          if (options.initializationCall)
            child.emit("message", {
              type: "ui-resolver-call",
              assembly: message.assembly,
              id: "actual-initialization",
              requestId: preparing!.id,
              runtimeId: ids[1],
              registration: "0",
              method: "store.get",
              args: []
            })
          prepared()
        }
      })
    } else if (message.type === "adopt-ui-resolve")
      queueMicrotask(() =>
        child.emit("message", {
          type: "result",
          id: message.id,
          runtimeId: message.runtimeId,
          value: null
        })
      )
  }
  fork.mockImplementationOnce(() => {
    queueMicrotask(() => child.emit("message", { type: "ready" }))
    return child
  })
  const client = new FunctionRuntimeClient("native-fixture")
  clients.push(client)
  const plugins: FunctionPlugin[] = []
  for (const name of ["Q", "P", "R"])
    plugins.push({
      name,
      root: "/" + name,
      tier: "user",
      capabilities: ["store.get", "store.set"],
      guest: await client.load(name)
    })
  const activity = new FunctionSessionActivity()
  const controller = new AbortController()
  const effects: string[] = []
  const execute = vi.fn(
    async (
      plugin: FunctionPlugin,
      _registration: string,
      _method: string,
      _args: unknown,
      _signal: AbortSignal
    ) => {
      expect(_registration).toBe("0")
      expect(typeof _method).toBe("string")
      expect(_args).toBeDefined()
      expect(_signal).toBeInstanceOf(AbortSignal)
      effects.push(plugin.name)
      await options.held
      return { value: plugin.name }
    }
  )
  const assembly = new FunctionUiResolveMainAssembly(
    plugins,
    options.quota ?? new FunctionUiResolveMainQuota(),
    {
      activity,
      initializer: options.initializer,
      signal: controller.signal,
      assertCurrent() {
        /* Definition changes are exercised by exact native binding tests. */
      },
      capabilities: (plugin) => plugin.capabilities,
      captureExecution: () => ({
        workspace: "/project",
        threadId: "thread",
        agentId: "actual-agent",
        turnId: "actual-turn",
        runtimeAuthority: undefined,
        assertCurrent() {
          /* This fixture retains its actual execution owner. */
        }
      }),
      execute
    }
  )
  const prepare = () =>
    assembly.prepare(FunctionSharedWallCut.after(120000).expiresAtNs, controller.signal)
  return { assembly, prepare, plugins, ids, child, client, messages, activity, effects, execute }
}

function open(f: Awaited<ReturnType<typeof fixture>>, scopeId = "scope") {
  const drawing = new FunctionUiResolveDrawing("Pane", "generation", "pane", () => {})
  const wire = f.assembly.bindDrawing(f.ids[0], drawing)
  f.assembly.receive({
    type: "ui-constructor-open",
    assembly: f.assembly.assembly,
    scopeId,
    consumerRuntimeId: f.ids[0],
    drawToken: wire.token,
    runtimeId: f.ids[1],
    registration: "0"
  })
  return drawing
}

it("only a canceled native root may become a retained retirement resource", async () => {
  const quota = new FunctionUiResolveMainQuota()
  const f = await fixture({ quota })
  await f.prepare()
  const drawing = open(f)
  const quiet = {
    type: "ui-constructor-quiescent" as const,
    assembly: f.assembly.assembly,
    scopeId: "scope"
  }
  expect(() => f.assembly.receive({ ...quiet, scopeId: "invented" })).toThrow(
    "MODS_UI_RESOLVE_IDENTITY"
  )
  expect(() => f.assembly.receive(quiet)).toThrow("MODS_UI_RESOLVE_IDENTITY")
  expect(f.activity.foregroundSize).toBe(1)
  const reserved = { ...quota.stats }
  drawing.close()
  // A close alone cannot claim that pending guest reactions are quiescent.
  expect(f.activity.pauseIfIdle(false)).toBe(false)
  f.assembly.receive(quiet)
  expect(f.activity.foregroundSize).toBe(0)
  expect(f.activity.size).toBe(1)
  expect(quota.stats).toEqual(reserved)
  expect(f.activity.pauseIfIdle()).toBe(false)
  expect(f.activity.pauseIfIdle(false)).toBe(true)
  expect(() => f.assembly.receive(quiet)).toThrow("MODS_UI_RESOLVE_IDENTITY")
  f.activity.resume()
  f.client.stop()
  await tick()
  expect(f.activity.size).toBe(1)
  expect(quota.stats).toMatchObject({ roots: 16 })
  f.child.emit("exit", 0)
  await tick()
  expect(f.activity.size).toBe(0)
  expect(quota.stats).toMatchObject({ handles: 0, roots: 0, branches: 0, reactions: 0 })
})

it("quiescence arriving before main finally cannot release or demote actual host work", async () => {
  const held = Promise.withResolvers<void>()
  const f = await fixture({ held: held.promise })
  await f.prepare()
  const drawing = open(f)
  f.assembly.receive({
    type: "ui-constructor-call",
    assembly: f.assembly.assembly,
    scopeId: "scope",
    id: "actual-held-finally",
    runtimeId: f.ids[1],
    registration: "0",
    method: "store.get",
    args: []
  })
  await tick()
  drawing.close()
  f.assembly.receive({
    type: "ui-constructor-quiescent",
    assembly: f.assembly.assembly,
    scopeId: "scope"
  })
  expect(f.activity.size).toBe(1)
  expect(f.activity.foregroundSize).toBe(1)
  expect(f.activity.pauseIfIdle(false)).toBe(false)
  held.resolve()
  await tick()
  expect(f.effects).toEqual(["P"])
  expect(f.activity.size).toBe(1)
  expect(f.activity.foregroundSize).toBe(0)
  expect(f.activity.pauseIfIdle()).toBe(false)
  expect(f.activity.pauseIfIdle(false)).toBe(true)
  f.activity.resume()
  f.assembly.receive({
    type: "ui-constructor-drained",
    assembly: f.assembly.assembly,
    scopeId: "scope"
  })
  expect(f.activity.size).toBe(0)
})

it("binds each nested SDK to an actual admitted definition for the original Q/component", async () => {
  const f = await fixture()
  await f.prepare()
  open(f)
  f.assembly.receive({
    type: "ui-constructor-call",
    assembly: f.assembly.assembly,
    scopeId: "scope",
    id: "actual-P",
    runtimeId: f.ids[1],
    registration: "0",
    method: "store.get",
    args: [{ plugin: "Q" }]
  })
  f.assembly.receive({
    type: "ui-constructor-call",
    assembly: f.assembly.assembly,
    scopeId: "scope",
    id: "actual-R",
    runtimeId: f.ids[2],
    registration: "0",
    method: "store.get",
    args: []
  })
  await tick()
  expect(f.effects).toEqual(["P", "R"])
  expect(() =>
    f.assembly.receive({
      type: "ui-constructor-call",
      assembly: f.assembly.assembly,
      scopeId: "scope",
      id: "unresolved-registration",
      runtimeId: f.ids[2],
      registration: "1",
      method: "store.get",
      args: []
    })
  ).toThrow("MODS_UI_RESOLVE_IDENTITY")
  expect(() =>
    f.assembly.receive({
      type: "ui-constructor-call",
      assembly: f.assembly.assembly,
      scopeId: "scope",
      id: "wrong-Q",
      runtimeId: f.ids[0],
      registration: "1",
      method: "store.get",
      args: []
    })
  ).toThrow("MODS_UI_RESOLVE_IDENTITY")
  expect(f.effects).toEqual(["P", "R"])
  f.assembly.receive({
    type: "ui-constructor-drained",
    assembly: f.assembly.assembly,
    scopeId: "scope"
  })
  await tick()
  expect(f.activity.size).toBe(0)
})

it("fences drained scopes immediately but retains activity until actual host finally", async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture({ held })
  await f.prepare()
  open(f)
  f.assembly.receive({
    type: "ui-constructor-call",
    assembly: f.assembly.assembly,
    scopeId: "scope",
    id: "held",
    runtimeId: f.ids[1],
    registration: "0",
    method: "store.get",
    args: []
  })
  await tick()
  f.assembly.receive({
    type: "ui-constructor-drained",
    assembly: f.assembly.assembly,
    scopeId: "scope"
  })
  expect(f.activity.size).toBe(1)
  expect(f.activity.pauseIfIdle()).toBe(false)
  expect(() =>
    f.assembly.receive({
      type: "ui-constructor-call",
      assembly: f.assembly.assembly,
      scopeId: "scope",
      id: "after-drain",
      runtimeId: f.ids[1],
      registration: "0",
      method: "store.set",
      args: []
    })
  ).toThrow("MODS_UI_RESOLVE_IDENTITY")
  expect(f.effects).toEqual(["P"])
  release()
  await tick()
  expect(f.activity.size).toBe(0)
})

it("closes an old drawing without borrowing a newer receipt for its SDK", async () => {
  const f = await fixture()
  await f.prepare()
  const original = open(f)
  original.close()
  const newer = new FunctionUiResolveDrawing("Pane", "new-generation", "pane", () => {})
  f.assembly.bindDrawing(f.ids[0], newer)
  f.assembly.receive({
    type: "ui-constructor-call",
    assembly: f.assembly.assembly,
    scopeId: "scope",
    id: "old",
    runtimeId: f.ids[1],
    registration: "0",
    method: "store.set",
    args: []
  })
  await tick()
  expect(f.effects).toEqual([])
  expect(f.messages.some((row) => row.type === "reply" && row.id === "old" && row.error)).toBe(true)
})

it("leaves an old live assembly usable when a candidate cannot reserve credit", async () => {
  const quota = new FunctionUiResolveMainQuota({
    handles: 4096,
    roots: 16,
    branches: 512,
    reactions: 512
  })
  const old = await fixture({ quota })
  await old.prepare()
  const next = await fixture({ quota })
  await expect(next.prepare()).rejects.toMatchObject({ code: "MODS_UI_RESOLVE_QUOTA_CAPACITY" })
  await expect(next.prepare()).rejects.toMatchObject({ code: "MODS_UI_RESOLVE_RETIRED" })
  expect(next.messages.filter((row) => row.type === "prepare-ui-resolve")).toHaveLength(1)
  expect(next.effects).toEqual([])
  open(old)
  old.assembly.receive({
    type: "ui-constructor-call",
    assembly: old.assembly.assembly,
    scopeId: "scope",
    id: "still-live",
    runtimeId: old.ids[1],
    registration: "0",
    method: "store.get",
    args: []
  })
  await tick()
  expect(old.effects).toEqual(["P"])
  expect(quota.stats.roots).toBe(16)
})

it("adopts a native-only candidate without foreign credit while a live utility fills the pool", async () => {
  const quota = new FunctionUiResolveMainQuota({
    handles: 64,
    roots: 16,
    branches: 512,
    reactions: 512
  })
  const old = await fixture({ quota })
  await old.prepare()
  const native = await fixture({ quota, nativeOnly: true })
  await native.prepare()
  expect(quota.stats).toMatchObject({
    handles: 64,
    roots: 16,
    branches: 512,
    reactions: 512,
    leases: 2
  })
  expect(native.messages.some((row) => row.type === "ui-resolve-credit-reply")).toBe(false)
  const drawing = new FunctionUiResolveDrawing("Pane", "native-generation", "pane", () => {})
  expect(native.assembly.bindDrawing(native.ids[0], drawing).assembly).toBe(
    native.assembly.assembly
  )
  expect(native.effects).toEqual([])
})

it("keeps a captured candidate branch read-only after activation", async () => {
  const initializer = new FunctionSessionInitializer(true)
  const f = await fixture({ initializer })
  await f.prepare()
  open(f)
  initializer.activate()
  f.assembly.receive({
    type: "ui-constructor-call",
    assembly: f.assembly.assembly,
    scopeId: "scope",
    id: "late-write",
    runtimeId: f.ids[1],
    registration: "0",
    method: "store.set",
    args: []
  })
  await tick()
  expect(f.effects).toEqual([])
  const reply = f.messages.find((row) => row.type === "reply" && row.id === "late-write")
  expect(reply).toMatchObject({ error: { code: "MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED" } })
  expect(() => initializer.assertReady()).toThrow("参数已保存")
})

it("requires true utility exit and main finally to release abandoned scope activity", async () => {
  let release!: () => void
  const f = await fixture({
    held: new Promise<void>((resolve) => {
      release = resolve
    })
  })
  await f.prepare()
  open(f)
  f.assembly.receive({
    type: "ui-constructor-call",
    assembly: f.assembly.assembly,
    scopeId: "scope",
    id: "ignored-abort",
    runtimeId: f.ids[1],
    registration: "0",
    method: "store.get",
    args: []
  })
  await tick()
  expect(f.activity.pauseIfIdle(false)).toBe(false)
  expect(f.activity.pauseForRetirement()).toBe(true)
  const settled = vi.fn()
  const drain = f.client.stopAndDrain().then(settled)
  expect(f.activity.size).toBe(1)
  f.child.emit("exit", 0)
  await tick()
  expect(f.activity.size).toBe(1)
  expect(settled).not.toHaveBeenCalled()
  release()
  await tick()
  expect(f.activity.size).toBe(0)
  await drain
  expect(settled).toHaveBeenCalledOnce()
})

it("quarantines a partially failed release without retrying on repeated drain or exit", async () => {
  const f = await fixture()
  await f.prepare()
  let effects = 0
  vi.spyOn(f.activity, "retainRetirableUiResource").mockImplementation(() => ({
    ready() {
      /* This failure fixture tests release, without native quiescence. */
    },
    closing() {
      /* This failure fixture never retires an active resource. */
    },
    release() {
      effects++
      f.assembly.receive({
        type: "ui-constructor-drained",
        assembly: f.assembly.assembly,
        scopeId: "scope"
      })
      throw new Error("actual partial release failure")
    }
  }))
  open(f)
  expect(() =>
    f.assembly.receive({
      type: "ui-constructor-drained",
      assembly: f.assembly.assembly,
      scopeId: "scope"
    })
  ).toThrow("actual partial release failure")
  expect(() =>
    f.assembly.receive({
      type: "ui-constructor-drained",
      assembly: f.assembly.assembly,
      scopeId: "scope"
    })
  ).not.toThrow()
  f.child.emit("exit", 0)
  await tick()
  expect(effects).toBe(1)
})

it("waits for actual initialization host finally before adopting a prepared table", async () => {
  const gate = Promise.withResolvers<void>()
  const f = await fixture({ held: gate.promise, initializationCall: true })
  const preparing = f.prepare()
  await vi.waitFor(() => expect(f.effects).toEqual(["P"]))
  expect(f.messages.some((row) => row.type === "adopt-ui-resolve")).toBe(false)
  gate.resolve()
  await preparing
  expect(f.messages.filter((row) => row.type === "adopt-ui-resolve")).toHaveLength(1)
  expect(
    f.messages.some(
      (row) => row.type === "reply" && row.id === "actual-initialization" && !row.error
    )
  ).toBe(true)
})

it("revokes only the actual call source and keeps its host occupancy until finally", async () => {
  const gate = Promise.withResolvers<void>()
  const f = await fixture({ held: gate.promise })
  await f.prepare()
  open(f)
  f.assembly.receive({
    type: "ui-constructor-call",
    assembly: f.assembly.assembly,
    scopeId: "scope",
    id: "actual-call",
    runtimeId: f.ids[1],
    registration: "0",
    method: "store.get",
    args: []
  })
  await vi.waitFor(() => expect(f.effects).toEqual(["P"]))
  const signal = f.execute.mock.calls[0][4] as AbortSignal
  f.assembly.receive({
    type: "ui-resolve-call-revoke",
    assembly: f.assembly.assembly,
    id: "actual-call",
    runtimeId: f.ids[2],
    registration: "0"
  })
  expect(signal.aborted).toBe(false)
  f.assembly.receive({
    type: "ui-resolve-call-revoke",
    assembly: f.assembly.assembly,
    id: "actual-call",
    runtimeId: f.ids[1],
    registration: "1"
  })
  expect(signal.aborted).toBe(false)
  f.assembly.receive({
    type: "ui-resolve-call-revoke",
    assembly: f.assembly.assembly,
    id: "actual-call",
    runtimeId: f.ids[1],
    registration: "0"
  })
  expect(signal.aborted).toBe(true)
  f.assembly.receive({
    type: "ui-constructor-drained",
    assembly: f.assembly.assembly,
    scopeId: "scope"
  })
  expect(f.activity.size).toBe(1)
  gate.resolve()
  await vi.waitFor(() => expect(f.activity.size).toBe(0))
  expect(f.messages.find((row) => row.type === "reply" && row.id === "actual-call")).toMatchObject({
    error: { code: "MODS_CANCELLED" }
  })
})

it("does not refill the same physical quota after stop or exit before actual host finally", async () => {
  const quota = new FunctionUiResolveMainQuota({
    handles: 4096,
    roots: 16,
    branches: 512,
    reactions: 512
  })
  const gate = Promise.withResolvers<void>()
  const old = await fixture({ quota, held: gate.promise })
  await old.prepare()
  open(old)
  old.assembly.receive({
    type: "ui-constructor-call",
    assembly: old.assembly.assembly,
    scopeId: "scope",
    id: "old-held",
    runtimeId: old.ids[1],
    registration: "0",
    method: "store.get",
    args: []
  })
  await vi.waitFor(() => expect(old.effects).toEqual(["P"]))
  old.client.stop()
  const beforeExit = await fixture({ quota })
  await expect(beforeExit.prepare()).rejects.toMatchObject({
    code: "MODS_UI_RESOLVE_QUOTA_CAPACITY"
  })
  old.child.emit("exit", 0)
  const beforeFinally = await fixture({ quota })
  await expect(beforeFinally.prepare()).rejects.toMatchObject({
    code: "MODS_UI_RESOLVE_QUOTA_CAPACITY"
  })
  expect(quota.stats.roots).toBe(16)
  gate.resolve()
  await vi.waitFor(() => expect(quota.stats.roots).toBe(0))
  const replacement = await fixture({ quota })
  await replacement.prepare()
  expect(quota.stats.roots).toBe(16)
})
