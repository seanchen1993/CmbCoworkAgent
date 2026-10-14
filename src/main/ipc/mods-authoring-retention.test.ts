import { describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { registerAuthoringRetentionHandlers } from "./mods-authoring-retention"
import { createAuthoringInstallBridge } from "../../preload/authoring-install"
const id = "12345678-1234-4234-8234-123456789abc"
function fixture() {
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>
  >()
  const sender = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false })
  const event = { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent
  let valid = true
  const view = {
    fingerprint: "a".repeat(64),
    usedVersions: 0,
    limit: 16,
    versions: [],
    pendingVersionIds: [],
    retiredVersions: 0
  }
  const service = { inspectRetention: vi.fn(() => view), retireVersions: vi.fn(async () => view) }
  registerAuthoringRetentionHandlers(
    {
      handle: (
        name: string,
        handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>
      ) => handlers.set(name, handler)
    } as unknown as IpcMain,
    service,
    {
      trusted: () => {
        if (!valid) throw Error("STALE")
      },
      threadScope: () => "workspace",
      captureThreadFence: () => () => {
        if (!valid) throw Error("STALE")
      }
    }
  )
  const request = { threadId: "thread", expectedWorkspace: "workspace" }
  return {
    service,
    sender,
    event,
    request,
    view,
    revoke: () => {
      valid = false
    },
    call: (channel: string, input: unknown, caller = event) =>
      handlers.get(`mods:authoring-install:${channel}`)!(caller, input)
  }
}
describe("explicit global authoring source retirement IPC", () => {
  it("separates read-only inspection from acknowledged retirement and validates exact scope", async () => {
    const f = fixture()
    expect(await f.call("inspect-retention", f.request)).toMatchObject({ ok: true })
    expect(f.service.retireVersions).not.toHaveBeenCalled()
    expect(
      await f.call("retire-versions", {
        ...f.request,
        expectedFingerprint: "a".repeat(64),
        versionIds: [id],
        acknowledgeLostRollback: false
      })
    ).toMatchObject({ ok: false, code: "INVALID" })
    expect(
      await f.call("inspect-retention", { ...f.request, expectedWorkspace: "other" })
    ).toMatchObject({ ok: false, code: "STALE" })
    expect(
      await f.call("inspect-retention", f.request, {
        ...f.event,
        senderFrame: {}
      } as IpcMainInvokeEvent)
    ).toMatchObject({ ok: false })
    const getter = vi.fn(() => "thread")
    expect(
      await f.call("inspect-retention", {
        ...f.request,
        get threadId() {
          return getter()
        }
      })
    ).toMatchObject({ ok: false })
    expect(getter).not.toHaveBeenCalled()
    const nested = [id]
    Object.defineProperty(nested, "0", { get: getter, enumerable: true })
    expect(
      await f.call("retire-versions", {
        ...f.request,
        expectedFingerprint: "a".repeat(64),
        versionIds: nested,
        acknowledgeLostRollback: true
      })
    ).toMatchObject({ ok: false, code: "INVALID" })
    expect(getter).not.toHaveBeenCalled()
  })
  it("fences a late completion after frame navigation and retains its busy slot until settled", async () => {
    const f = fixture()
    let finish!: () => void
    f.service.retireVersions.mockImplementation(
      () =>
        new Promise((done) => {
          finish = () => done(f.view)
        })
    )
    const request = {
      ...f.request,
      expectedFingerprint: "a".repeat(64),
      versionIds: [id],
      acknowledgeLostRollback: true
    }
    const pending = f.call("retire-versions", request)
    f.sender.emit("did-start-navigation", { isMainFrame: true })
    expect(await f.call("retire-versions", request)).toMatchObject({ ok: false, code: "BUSY" })
    finish()
    expect(await pending).toMatchObject({ ok: false, code: "CANCELLED" })
    expect(f.sender.listenerCount("did-start-navigation")).toBe(0)
  })
  it("bridges both retirement channels with the unchanged exact user acknowledgment", async () => {
    const invoke = vi.fn(async () => ({ ok: true, value: fixture().view }))
    const bridge = createAuthoringInstallBridge(invoke)
    const scope = { threadId: "thread", expectedWorkspace: "workspace" }
    await bridge.inspectRetention(scope)
    const request = {
      ...scope,
      expectedFingerprint: "a".repeat(64),
      versionIds: [id],
      acknowledgeLostRollback: true as const
    }
    await bridge.retireVersions(request)
    expect(invoke.mock.calls).toEqual([
      ["mods:authoring-install:inspect-retention", scope],
      ["mods:authoring-install:retire-versions", request]
    ])
  })
})
