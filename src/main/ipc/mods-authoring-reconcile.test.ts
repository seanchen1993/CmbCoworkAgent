import { describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { registerAuthoringReconcileHandlers } from "./mods-authoring-reconcile"
const id = "12345678-1234-4234-8234-123456789abc"
function fixture() {
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>
  >()
  const sender = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false })
  const event = { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent
  let valid = true
  const service = {
    inspectUncertain: vi.fn(() => ({
      operationId: id,
      installationId: id,
      originalState: "unknown",
      catalog: "after" as const,
      configuration: "unchanged" as const,
      inspectionDigest: "a".repeat(64),
      canAccept: true
    })),
    reconcile: vi.fn(async () => ({ operationId: id, state: "reconciled" as const })),
    inspectPreparation: vi.fn(() => ({ state: "none" as const, canRecover: false })),
    recoverPreparation: vi.fn(async () => ({
      state: "recovered" as const,
      versionId: id,
      preserved: "quarantine" as const
    }))
  }
  registerAuthoringReconcileHandlers(
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
  const request = { threadId: "thread", expectedWorkspace: "workspace", operationId: id }
  return {
    service,
    sender,
    event,
    request,
    revoke: () => {
      valid = false
    },
    call: (channel: string, input: unknown, caller = event) =>
      handlers.get("mods:authoring-install:" + channel)!(caller, input)
  }
}
describe("explicit authoring reconciliation IPC", () => {
  it("inspection never invokes a repair and rejects extra authority fields/getters/foreign scope", async () => {
    const f = fixture()
    expect(await f.call("inspect-uncertain", f.request)).toMatchObject({ ok: true })
    expect(f.service.reconcile).not.toHaveBeenCalled()
    expect(await f.call("inspect-uncertain", { ...f.request, grant: true })).toMatchObject({
      ok: false,
      code: "INVALID"
    })
    const getter = vi.fn(() => id)
    expect(
      await f.call("inspect-uncertain", {
        ...f.request,
        get operationId() {
          return getter()
        }
      })
    ).toMatchObject({ ok: false })
    expect(getter).not.toHaveBeenCalled()
    expect(
      await f.call("inspect-uncertain", { ...f.request, expectedWorkspace: "other" })
    ).toMatchObject({ ok: false, code: "STALE" })
    expect(
      await f.call("inspect-uncertain", f.request, {
        ...f.event,
        senderFrame: {}
      } as IpcMainInvokeEvent)
    ).toMatchObject({ ok: false })
  })
  it("holds capacity until cancelled work actually settles and fences late replies", async () => {
    const f = fixture()
    let finish!: () => void
    f.service.reconcile.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ operationId: id, state: "reconciled" })
        })
    )
    const request = { ...f.request, expectedInspectionDigest: "a".repeat(64) }
    const pending = f.call("reconcile", request)
    f.sender.emit("destroyed")
    expect(await f.call("reconcile", request)).toMatchObject({ ok: false, code: "BUSY" })
    finish()
    expect(await pending).toMatchObject({ ok: false, code: "CANCELLED" })
    expect(f.sender.listenerCount("destroyed")).toBe(0)
    expect(f.sender.listenerCount("did-start-navigation")).toBe(0)
  })
  it("validates explicit preparation recovery separately and never repairs during inspection", async () => {
    const f = fixture(),
      scope = { threadId: "thread", expectedWorkspace: "workspace" }
    expect(await f.call("inspect-preparation", scope)).toEqual({
      ok: true,
      value: { state: "none", canRecover: false }
    })
    expect(f.service.recoverPreparation).not.toHaveBeenCalled()
    expect(
      await f.call("recover-preparation", { ...scope, expectedFingerprint: "a".repeat(64) })
    ).toMatchObject({ ok: true, value: { preserved: "quarantine" } })
    f.revoke()
    expect(
      await f.call("recover-preparation", { ...scope, expectedFingerprint: "a".repeat(64) })
    ).toMatchObject({ ok: false })
    expect(f.service.recoverPreparation).toHaveBeenCalledTimes(1)
  })
})
