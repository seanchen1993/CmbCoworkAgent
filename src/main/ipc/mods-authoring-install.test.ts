import { EventEmitter } from "node:events"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  registerAuthoringInstallHandlers,
  type AuthoringInstallService,
  type AuthoringInstallServiceScope
} from "./mods-authoring-install"
import { createAuthoringInstallBridge } from "../../preload/authoring-install"

const senders: EventEmitter[] = []
afterEach(async () => {
  for (const sender of senders.splice(0)) sender.emit("destroyed")
  await Promise.resolve()
  await Promise.resolve()
})
const result = () => ({
  handle: "handle",
  installationId: "installation",
  versionId: "version",
  name: "Example",
  sourceDigest: "a".repeat(64),
  compiledDigest: "b".repeat(64),
  catalogDigest: "c".repeat(64),
  configuration: "unchanged" as const
})
const request = (threadId = "thread") => ({
  threadId,
  expectedWorkspace: "project",
  requestId: "request",
  draftId: "draft",
  revision: 1,
  sourceDigest: "a".repeat(64)
})
function setup() {
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>
  >()
  const sender = () => {
    const emitter = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false })
    senders.push(emitter)
    return emitter
  }
  const primary = sender()
  const event = (value = primary) =>
    ({ sender: value, senderFrame: value.mainFrame }) as unknown as IpcMainInvokeEvent
  let workspace = "project",
    incarnation = 1
  const service: AuthoringInstallService = {
    resolveInstalled: vi.fn(async () => null),
    list: vi.fn(async () => ({ installations: [] })),
    prepare: vi.fn(async () => result()),
    rollbackPrepare: vi.fn(async () => result()),
    discardPrepared: vi.fn(async () => {}),
    apply: vi.fn(async () => ({
      operationId: "operation",
      installationId: "installation",
      versionId: "version",
      state: "settled" as const
    }))
  }
  registerAuthoringInstallHandlers(
    {
      handle: (
        name: string,
        handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>
      ) => handlers.set(name, handler)
    } as unknown as IpcMain,
    service,
    {
      trusted: (e) => {
        if (e.senderFrame !== e.sender.mainFrame) throw Error("untrusted")
      },
      threadScope: () => workspace,
      captureThreadFence: () => {
        const initial = incarnation
        return () => {
          if (initial !== incarnation) throw Error("STALE")
        }
      }
    }
  )
  const invoke = (name: string, input: unknown, e = event()) =>
    handlers.get("mods:authoring-install:" + name)!(e, input) as Promise<Record<string, unknown>>
  return {
    service,
    invoke,
    event,
    sender,
    primary,
    setWorkspace: (value: string) => {
      workspace = value
    },
    changeIncarnation: () => {
      incarnation++
    }
  }
}
const apply = () => ({
  threadId: "thread",
  expectedWorkspace: "project",
  handle: "handle",
  expectedCatalogDigest: "c".repeat(64)
})
const cancel = () => ({ threadId: "thread", expectedWorkspace: "project", requestId: "request" })
describe("authoring install IPC boundary", () => {
  it("resolves only exact scoped installed facts without granting or creating a candidate", async () => {
    const f = setup()
    const receipt = { installationId: "installation", versionId: "version", name: "Example",
      sourceDigest: "a".repeat(64), compiledDigest: "b".repeat(64) }
    vi.mocked(f.service.resolveInstalled).mockResolvedValue({ ...receipt, handle: "hidden" } as typeof receipt)
    const input = { threadId: "thread", expectedWorkspace: "project", draftId: "draft",
      revision: 1, sourceDigest: "a".repeat(64) }
    expect(await f.invoke("resolve-installed", input)).toEqual({ ok: true, value: receipt })
    expect(f.service.prepare).not.toHaveBeenCalled()
    expect(f.service.apply).not.toHaveBeenCalled()
    expect(await f.invoke("resolve-installed", { ...input, expectedWorkspace: "other" }))
      .toMatchObject({ ok: false, code: "STALE" })
    expect(await f.invoke("resolve-installed", { ...input, revision: 0 }))
      .toMatchObject({ ok: false, code: "INVALID" })
    expect(await f.invoke("resolve-installed", { ...input, handle: "injected" }))
      .toMatchObject({ ok: false, code: "INVALID" })
  })
  it.each(["workspace", "incarnation", "frame"])(
    "withholds restored installation facts after %s changes during verification", async change => {
      const f = setup()
      const read = Promise.withResolvers<null>()
      vi.mocked(f.service.resolveInstalled).mockReturnValue(read.promise)
      const pending = f.invoke("resolve-installed", { threadId: "thread",
        expectedWorkspace: "project", draftId: "draft", revision: 1,
        sourceDigest: "a".repeat(64) })
      if (change === "workspace") f.setWorkspace("other")
      if (change === "incarnation") f.changeIncarnation()
      if (change === "frame") f.primary.mainFrame = {}
      read.resolve(null)
      expect(await pending).toMatchObject({ ok: false, code: "STALE" })
    }
  )
  it("forwards the read-only installation resolution through preload", async () => {
    const invoke = vi.fn(async () => ({ ok: true, value: null }))
    const bridge = createAuthoringInstallBridge(invoke)
    const input = { threadId: "thread", expectedWorkspace: "project", draftId: "draft",
      revision: 1, sourceDigest: "a".repeat(64) }
    expect(await bridge.resolveInstalled(input)).toEqual({ ok: true, value: null })
    expect(invoke).toHaveBeenCalledExactlyOnceWith("mods:authoring-install:resolve-installed", input)
  })
  it("passes scoped exact draft input and exposes only version metadata", async () => {
    const { service, invoke } = setup()
    vi.mocked(service.prepare).mockResolvedValue({ ...result(), raw: "not-for-ui" } as ReturnType<
      typeof result
    >)
    const prepared = await invoke("prepare", request())
    expect(prepared).toEqual({ ok: true, value: result() })
    expect(service.prepare).toHaveBeenCalledWith(
      { draftId: "draft", revision: 1, sourceDigest: "a".repeat(64) },
      expect.objectContaining({ workspace: "project", assertCurrent: expect.any(Function) })
    )
    expect(await invoke("apply", apply())).toEqual({
      ok: true,
      value: {
        operationId: "operation",
        installationId: "installation",
        versionId: "version",
        state: "settled"
      }
    })
    expect(service.discardPrepared).toHaveBeenCalledWith("handle")
  })
  it("rejects extra keys, getters, invalid digest and untrusted frames before service work", async () => {
    const { invoke, service, event } = setup()
    for (const input of [
      { ...request(), raw: "x" },
      { ...request(), sourceDigest: "bad" },
      Object.defineProperty({ ...request() }, "revision", {
        enumerable: true,
        get: () => {
          throw Error("must not invoke")
        }
      })
    ])
      expect(await invoke("prepare", input)).toMatchObject({ ok: false, code: "INVALID" })
    expect(
      await invoke("prepare", request(), { ...event(), senderFrame: {} } as IpcMainInvokeEvent)
    ).toMatchObject({ ok: false })
    expect(service.prepare).not.toHaveBeenCalled()
  })
  it("isolates handle ownership across windows and thread incarnations", async () => {
    const { invoke, event, sender, changeIncarnation, service } = setup()
    await invoke("prepare", request())
    expect(await invoke("apply", apply(), event(sender()))).toMatchObject({
      ok: false,
      code: "STALE"
    })
    changeIncarnation()
    expect(await invoke("apply", apply())).toMatchObject({ ok: false, code: "STALE" })
    expect(service.apply).not.toHaveBeenCalled()
  })
  it("rejects stale expected workspace and stale catalog without applying", async () => {
    const { invoke, service } = setup()
    expect(await invoke("prepare", { ...request(), expectedWorkspace: "old" })).toMatchObject({
      ok: false,
      code: "STALE"
    })
    await invoke("prepare", request())
    expect(
      await invoke("apply", { ...apply(), expectedCatalogDigest: "d".repeat(64) })
    ).toMatchObject({ ok: false, code: "STALE" })
    expect(service.apply).not.toHaveBeenCalled()
  })
  it("retains the prepared candidate on a busy global catalog and permits explicit retry", async () => {
    const { invoke, service } = setup()
    vi.mocked(service.apply).mockRejectedValueOnce(Error("MODS_CATALOG_BUSY"))
    await invoke("prepare", request())
    expect(await invoke("apply", apply())).toMatchObject({ ok: false, code: "BUSY" })
    expect(service.discardPrepared).not.toHaveBeenCalled()
    expect(await invoke("apply", apply())).toMatchObject({ ok: true })
  })
  it("cancels owned preparation after workspace changes and waits for real completion", async () => {
    const { invoke, service, setWorkspace } = setup()
    let release!: () => void, scope!: AuthoringInstallServiceScope
    vi.mocked(service.prepare).mockImplementation(async (_input, value) => {
      scope = value
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return result()
    })
    const preparing = invoke("prepare", request())
    setWorkspace("other")
    let done = false
    const cancelled = invoke("cancel", cancel()).then((value) => {
      done = true
      return value
    })
    await Promise.resolve()
    expect(scope.signal.aborted).toBe(true)
    expect(done).toBe(false)
    release()
    expect(await preparing).toMatchObject({ ok: false, code: "CANCELLED" })
    expect(await cancelled).toMatchObject({ ok: true })
    expect(service.discardPrepared).toHaveBeenCalledWith("handle")
  })
  it("prevents duplicate preparation and caps actual workers across threads/windows", async () => {
    const { invoke, service, event, sender } = setup()
    const releases: (() => void)[] = []
    vi.mocked(service.prepare).mockImplementation(async () => {
      await new Promise<void>((resolve) => releases.push(resolve))
      return result()
    })
    const first = invoke("prepare", request()),
      second = invoke("prepare", request("two"), event(sender()))
    expect(await invoke("prepare", request())).toMatchObject({ ok: false, code: "BUSY" })
    expect(await invoke("prepare", request("three"), event(sender()))).toMatchObject({
      ok: false,
      code: "BUSY"
    })
    releases.forEach((release) => release())
    await Promise.all([first, second])
  })
  it("navigation during preparation prevents publication and discards the stale handle", async () => {
    const { invoke, service, primary } = setup()
    vi.mocked(service.prepare).mockImplementation(async () => {
      primary.emit("did-start-navigation", { isMainFrame: true })
      return result()
    })
    expect(await invoke("prepare", request())).toMatchObject({ ok: false, code: "CANCELLED" })
    expect(service.discardPrepared).toHaveBeenCalledWith("handle")
  })
  it("list strips host-only fields and rejects late scope changes", async () => {
    const { invoke, service, setWorkspace } = setup()
    const item = {
      installationId: "installation",
      name: "Example",
      versions: [],
      raw: "not-for-ui"
    }
    vi.mocked(service.list).mockResolvedValueOnce({ installations: [item] })
    expect(await invoke("list", "thread")).toEqual({
      ok: true,
      value: {
        workspace: "project",
        installations: [{ installationId: "installation", name: "Example", versions: [] }]
      }
    })
    vi.mocked(service.list).mockImplementation(async () => {
      setWorkspace("other")
      return { installations: [item] }
    })
    expect(await invoke("list", "thread")).toMatchObject({ ok: false, code: "STALE" })
  })
  it("forwards explicit rollback intent and rejects inconsistent backend identity", async () => {
    const { invoke, service } = setup()
    const request = {
      ...cancel(),
      installationId: "installation",
      versionId: "version",
      restoreConfiguration: true
    }
    vi.mocked(service.rollbackPrepare).mockResolvedValueOnce({
      ...result(),
      versionId: "new-prepared-version",
      restoredFromVersionId: "version",
      configuration: "restore"
    })
    expect(await invoke("rollback-prepare", request)).toMatchObject({ ok: true })
    await invoke("cancel", cancel())
    vi.mocked(service.rollbackPrepare).mockResolvedValueOnce({
      ...result(),
      restoredFromVersionId: "other",
      configuration: "restore"
    })
    expect(await invoke("rollback-prepare", request)).toMatchObject({ ok: false, code: "STALE" })
  })
  it("preserves partial/unknown outcomes without promoting them or leaking thrown diagnostics", async () => {
    const { invoke, service } = setup()
    vi.mocked(service.apply).mockResolvedValueOnce({
      operationId: "operation",
      installationId: "installation",
      versionId: "version",
      state: "partial"
    })
    await invoke("prepare", request())
    expect(await invoke("apply", apply())).toMatchObject({ ok: true, value: { state: "partial" } })
    vi.mocked(service.prepare).mockRejectedValueOnce(Error("sensitive backend diagnostic"))
    expect(await invoke("prepare", request())).toEqual({ ok: false, code: "FAILED" })
  })
  it("preload exposes fixed channels and returns structured results", async () => {
    const invoke = vi
      .fn<(channel: string, input: unknown) => Promise<unknown>>()
      .mockResolvedValue({
        ok: true,
        value: undefined
      })
    const api = createAuthoringInstallBridge(invoke)
    await api.prepare(request())
    await api.cancel(cancel())
    expect(invoke.mock.calls.map((row) => row[0])).toEqual([
      "mods:authoring-install:prepare",
      "mods:authoring-install:cancel"
    ])
  })
})
