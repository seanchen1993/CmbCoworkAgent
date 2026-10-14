import { EventEmitter } from "node:events"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { afterEach, expect, it, vi } from "vitest"
import { AuthoringDraftStore } from "../mods/devtools/authoring-store"
import { createAuthoringSourceBundle } from "../mods/devtools/authoring-bundle"
import type { previewAuthoringSource } from "../mods/devtools/authoring-preview"
import { registerModsAuthoringPreviewHandlers } from "./mods-authoring-preview"
import { createAuthoringPreviewBridge } from "../../preload/authoring-preview"
vi.mock("../mods/devtools/authoring-preview", () => ({ previewAuthoringSource: vi.fn() }))
vi.mock("../mods/devtools/authoring-preview-backend", () => ({
  createAuthoringPreviewBackend: vi.fn()
}))
afterEach(() => vi.useRealTimers())
const source = createAuthoringSourceBundle([{ path: "plugin.json", text: "{}" }])
const input = {
  threadId: "thread",
  expectedWorkspace: "workspace",
  id: "demo",
  revision: 1,
  sourceDigest: source.digest,
  requestId: "request-1",
  action: { kind: "inspect" as const, target: "", input: "" }
}
function report() {
  return {
    sourceDigest: source.digest,
    compiledDigest: "b".repeat(64),
    action: "inspect",
    failures: 0,
    commands: [{ name: "example", description: "Example" }],
    tools: [],
    result: null,
    typecheck: { valid: true, diagnostics: [] },
    compatibility: { strictCompatible: true, diagnostics: [] },
    sdkCompatibility: { strictCompatible: true, diagnostics: [] },
    panes: [
      {
        title: "Static",
        key: "PRIVATE_HANDLE",
        generation: "PRIVATE_HANDLE",
        tree: { type: "Button", press: { handle: "PRIVATE_HANDLE" }, children: ["Sample text"] }
      }
    ]
  } as unknown as Awaited<ReturnType<typeof previewAuthoringSource>>
}
function setup() {
  const settings = new Map<string, string>()
  const store = new AuthoringDraftStore({
    getSetting: (key, fallback = "") => settings.get(key) ?? fallback,
    compareAndSetSetting: (key, expected, value) => {
      if (settings.get(key) !== expected) return false
      settings.set(key, value)
      return true
    }
  })
  store.save({
    workspace: "workspace",
    id: "demo",
    name: "Demo",
    expectedRevision: 0,
    source,
    assertCurrent: () => undefined
  })
  const sender = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false })
  const event = { sender } as unknown as IpcMainInvokeEvent
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>
  >()
  const trusted = vi.fn(() => undefined),
    threadScope = vi.fn(() => "workspace"),
    assertThread = vi.fn(() => undefined)
  const run = vi.fn<typeof previewAuthoringSource>(async () => report())
  registerModsAuthoringPreviewHandlers(
    { handle: (name, handler) => handlers.set(name, handler) } as unknown as IpcMain,
    store,
    { trusted, threadScope, captureThreadFence: () => assertThread },
    {
      run,
      backend: () => ({
        preflight: async () => {
          throw Error("not used")
        },
        load: async () => {
          throw Error("not used")
        },
        stop: async () => undefined
      })
    }
  )
  const call = (kind: string, payload: unknown, owner = event) =>
    handlers.get(`mods:authoring-preview-${kind}`)!(owner, payload)
  const bridge = createAuthoringPreviewBridge(async (channel, payload) =>
    handlers.get(channel)!(event, payload)
  )
  return { run, call, bridge, sender, event, trusted, threadScope, assertThread, store }
}
it("uses exact saved source and returns static pane text without callback identifiers", async () => {
  const { run, bridge, sender } = setup()
  const value = await bridge.start(input)
  expect(run.mock.calls[0][0]).toEqual(source)
  expect(value).toMatchObject({
    id: "demo",
    revision: 1,
    requestId: "request-1",
    sourceDigest: source.digest,
    action: "inspect"
  })
  expect(value.panes).toEqual([{ title: "Static", text: "Sample text" }])
  expect(JSON.stringify(value)).not.toContain("PRIVATE_HANDLE")
  expect(sender.listenerCount("destroyed")).toBe(0)
  expect(sender.listenerCount("did-start-navigation")).toBe(0)
})
it.each([
  { ...input, sourceDigest: "a".repeat(64) },
  { ...input, revision: 2 },
  { ...input, extra: true },
  { ...input, expectedWorkspace: "other" },
  { ...input, action: { ...input.action, extra: true } }
])("rejects stale or malformed requests before runner creation", async (payload) => {
  const { call, run } = setup()
  await expect(call("start", payload)).rejects.toThrow(/^AUTHORING_PREVIEW_/)
  expect(run).not.toHaveBeenCalled()
})
it("keeps one pending owner and waits for cleanup when cancelling after scope revocation", async () => {
  const { run, call, threadScope } = setup()
  let release!: () => void,
    cancelled = false
  run.mockImplementationOnce(async (_source, _action, options) => {
    await new Promise<void>((resolve) => {
      release = resolve
      options.signal.addEventListener(
        "abort",
        () => {
          cancelled = true
        },
        { once: true }
      )
    })
    options.signal.throwIfAborted()
    return report()
  })
  const started = call("start", input).catch((error) => error)
  await expect(call("start", { ...input, requestId: "duplicate" })).rejects.toThrow(
    "AUTHORING_PREVIEW_BUSY"
  )
  threadScope.mockReturnValue("other")
  let done = false
  const cancel = call("cancel", {
    threadId: "thread",
    expectedWorkspace: "workspace",
    requestId: "request-1"
  }).then(() => {
    done = true
  })
  await Promise.resolve()
  expect(cancelled).toBe(true)
  expect(done).toBe(false)
  release()
  await cancel
  expect(await started).toMatchObject({ message: "AUTHORING_PREVIEW_CANCELLED" })
})
it("another sender or mismatched handle cannot cancel an active owner", async () => {
  const { run, call, event } = setup()
  let release!: () => void, signal!: AbortSignal
  run.mockImplementationOnce(async (_source, _action, options) => {
    signal = options.signal
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return report()
  })
  const started = call("start", input)
  await call("cancel", { threadId: "thread", expectedWorkspace: "workspace", requestId: "other" })
  await call(
    "cancel",
    { threadId: "thread", expectedWorkspace: "workspace", requestId: "request-1" },
    { ...event, sender: {} } as IpcMainInvokeEvent
  )
  expect(signal.aborted).toBe(false)
  release()
  await started
})
it.each(["destroyed", "navigation", "incarnation", "scope"])(
  "invalidates %s while preview is pending",
  async (kind) => {
    vi.useFakeTimers()
    const { run, call, sender, assertThread, threadScope } = setup()
    run.mockImplementationOnce(async (_source, _action, options) => {
      await new Promise<void>((_resolve, reject) =>
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true
        })
      )
      return report()
    })
    const started = call("start", input).catch((error) => error)
    if (kind === "destroyed") sender.emit("destroyed")
    else if (kind === "navigation") sender.emit("did-start-navigation", { isMainFrame: true })
    else {
      if (kind === "incarnation")
        assertThread.mockImplementation(() => {
          throw Error("PRIVATE")
        })
      else threadScope.mockReturnValue("other")
      await vi.advanceTimersByTimeAsync(251)
    }
    expect(await started).toMatchObject({ message: "AUTHORING_PREVIEW_CANCELLED" })
    expect(vi.getTimerCount()).toBe(0)
  }
)
it("checks latest source revision again after actual runner cleanup", async () => {
  const { run, call, store } = setup()
  run.mockImplementationOnce(async () => {
    store.save({
      workspace: "workspace",
      id: "demo",
      name: "Demo",
      expectedRevision: 1,
      source,
      assertCurrent: () => undefined
    })
    return report()
  })
  await expect(call("start", input)).rejects.toThrow("AUTHORING_PREVIEW_SOURCE_CHANGED")
  await expect(call("start", { ...input, revision: 2 })).resolves.toMatchObject({ revision: 2 })
})
it("normalizes raw runner failures and releases ownership", async () => {
  const { run, call } = setup()
  run.mockRejectedValueOnce(Error("PRIVATE_PROVIDER_SECRET"))
  await expect(call("start", input)).rejects.toThrow(/^AUTHORING_PREVIEW_FAILED$/)
  await expect(call("start", input)).resolves.toMatchObject({ requestId: "request-1" })
})

it("limits concurrent analysis across threads and windows until real cleanup settles", async () => {
  const { run, call } = setup()
  const releases: (() => void)[] = []
  run.mockImplementation(async () => {
    await new Promise<void>((resolve) => releases.push(resolve))
    return report()
  })
  const other = {
    sender: Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false })
  } as unknown as IpcMainInvokeEvent
  const first = call("start", input)
  const second = call("start", { ...input, threadId: "second" }, other)
  await expect(call("start", { ...input, threadId: "third" })).rejects.toThrow(
    "AUTHORING_PREVIEW_BUSY"
  )
  expect(run).toHaveBeenCalledTimes(2)
  releases[0]!()
  await first
  const third = call("start", { ...input, threadId: "third" })
  expect(run).toHaveBeenCalledTimes(3)
  releases[1]!()
  releases[2]!()
  await Promise.all([second, third])
})

it("rejects untrusted callers before reading source or creating lifecycle resources", async () => {
  const { trusted, call, run, store, sender } = setup()
  const read = vi.spyOn(store, "list")
  trusted.mockImplementation(() => {
    throw Error("PRIVATE_TRUST_FAILURE")
  })
  await expect(call("start", input)).rejects.toThrow(/^AUTHORING_PREVIEW_FAILED$/)
  expect(read).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
  expect(sender.eventNames()).toEqual([])
})

it("rejects accessor actions without executing caller code", async () => {
  const { call, run } = setup()
  const getter = vi.fn(() => "inspect")
  const action = Object.defineProperty({ target: "", input: "" }, "kind", {
    get: getter,
    enumerable: true
  })
  await expect(call("start", { ...input, action })).rejects.toThrow("AUTHORING_PREVIEW_INPUT")
  expect(getter).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
})
it("preserves recovered invocation failures and bounded diagnostics instead of reporting a clean result", async () => {
  const { run, call } = setup()
  const value = report()
  value.failures = 2
  value.sdkCompatibility.diagnostics = Array.from({ length: 80 }, () => ({
    code: "MODS_SDK_UNVERIFIED",
    file: "main.ts",
    line: 1,
    column: 1,
    message: "Diagnostic"
  })) as typeof value.sdkCompatibility.diagnostics
  run.mockResolvedValueOnce(value)
  await expect(call("start", input)).resolves.toMatchObject({
    failures: 2,
    omittedDiagnostics: 16,
    diagnostics: expect.any(Array)
  })
})
