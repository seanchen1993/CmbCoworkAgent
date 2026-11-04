import { AsyncLocalStorage } from "node:async_hooks"
import { describe, expect, it, vi } from "vitest"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { ModApprovalInbox, registerModApprovalInbox } from "./mods-approval-inbox"

const source = { workspace: "C:/fixture", threadId: "chat", modId: "any-workbench" }
function setup() {
  const changed = vi.fn()
  const inbox = new ModApprovalInbox(changed)
  const controller = new AbortController()
  const assertCurrent = vi.fn()
  const options = {
    message: "Run git",
    detail: "exact arguments",
    signal: controller.signal,
    buttons: ["拒绝", "允许本次命令", "查看完整请求"]
  }
  const request = (scope = source) => inbox.request(scope, options, assertCurrent)
  const decide = (decision: "allow" | "deny" | "details") =>
    inbox.decide({ requestId: inbox.snapshot().current!.requestId, decision })
  return { inbox, changed, controller, assertCurrent, options, request, decide }
}

describe("non-modal Mod approval inbox", () => {
  it("preserves the original native context when renderer IPC checks a trial request", async () => {
    const local = new AsyncLocalStorage<{ active: boolean }>()
    const state = { active: true }
    const f = setup()
    const guard = () => {
      if (local.getStore() !== state || !state.active) throw Error("native scope revoked")
    }
    const pending = local.run(state, () => f.inbox.request(source, f.options, guard))
    expect(local.getStore()).toBeUndefined()
    const requestId = f.inbox.snapshot().current!.requestId
    f.inbox.decide({ requestId, decision: "allow" })
    await expect(pending).resolves.toEqual({ response: 1 })
    const next = local.run(state, () => f.inbox.request(source, f.options, guard))
    const rejected = expect(next).rejects.toThrow("native scope revoked")
    state.active = false
    f.inbox.prune()
    await rejected
    expect(f.inbox.snapshot().current).toBeNull()
  })

  it("requires a separate decision for every sequential command without opening native dialogs", async () => {
    const f = setup()
    for (let i = 0; i < 17; i++) {
      const operation = f.request()
      expect(f.inbox.snapshot().queued).toBe(0)
      expect(f.inbox.snapshot().current?.detail).toBe("exact arguments")
      f.decide("allow")
      await expect(operation).resolves.toEqual({ response: 1 })
    }
    expect(f.inbox.snapshot().current).toBeNull()
  })
  it("one rejection pauses timer retries and never queues their next popup", async () => {
    const f = setup()
    const pending = f.request()
    f.decide("deny")
    await expect(pending).resolves.toEqual({ response: 0 })
    const notifications = f.changed.mock.calls.length
    for (let tick = 0; tick < 100; tick++) expect(() => f.request()).toThrow("MODS_APPROVAL_PAUSED")
    expect(f.changed).toHaveBeenCalledTimes(notifications)
    expect(f.inbox.snapshot()).toMatchObject({
      current: null,
      queued: 0,
      paused: [{ modId: source.modId }]
    })
  })
  it("scopes pause to one workspace, thread and Mod; resume neither replays nor approves", async () => {
    const f = setup()
    const rejected = f.request()
    f.decide("deny")
    await rejected
    for (const scope of [
      { ...source, threadId: "other" },
      { ...source, modId: "other" },
      { ...source, workspace: "C:/other" }
    ]) {
      const allowed = f.request(scope)
      f.decide("allow")
      await allowed
    }
    const paused = f.inbox.snapshot().paused[0]
    f.inbox.resume(paused.id)
    expect(f.inbox.snapshot()).toEqual({ current: null, queued: 0, paused: [] })
    const next = f.request()
    expect(f.inbox.snapshot().current).not.toBeNull()
    f.decide("deny")
    await next
  })
  it("does not multiply pending requests or reuse one decision for simultaneous commands", async () => {
    const f = setup()
    const first = f.request()
    expect(() => f.request()).toThrow("MODS_APPROVAL_PENDING")
    const other = f.request({ ...source, modId: "another" })
    expect(f.inbox.snapshot().queued).toBe(1)
    f.decide("deny")
    await first
    expect(f.inbox.snapshot().current?.modId).toBe("another")
    f.decide("allow")
    await other
  })
  it("source cancellation removes the request immediately and cannot become a late allow", async () => {
    const f = setup()
    const pending = f.request()
    const rejected = expect(pending).rejects.toThrow("stopped")
    const requestId = f.inbox.snapshot().current!.requestId
    f.controller.abort(Error("stopped"))
    await rejected
    expect(f.inbox.snapshot().current).toBeNull()
    expect(() => f.inbox.decide({ requestId, decision: "allow" })).toThrow("MODS_APPROVAL_STALE")
    expect(f.inbox.snapshot().paused).toEqual([])
  })
  it("rechecks source/owner authority when reading and deciding", async () => {
    for (const action of ["read", "allow"] as const) {
      const f = setup()
      const pending = f.request()
      const rejected = expect(pending).rejects.toThrow("source changed")
      const requestId = f.inbox.snapshot().current!.requestId
      f.assertCurrent.mockImplementation(() => {
        throw Error("source changed")
      })
      if (action === "read") expect(f.inbox.snapshot().current).toBeNull()
      else expect(() => f.inbox.decide({ requestId, decision: "allow" })).toThrow("source changed")
      await rejected
    }
  })
  it("viewing a complete request never counts as approval or pause", async () => {
    const f = setup()
    const pending = f.request()
    f.decide("details")
    await expect(pending).resolves.toEqual({ response: 2 })
    expect(f.inbox.snapshot().paused).toEqual([])
    const second = f.request()
    f.decide("deny")
    await second
  })
  it("reset cancels outstanding requests and clears account-local pauses", async () => {
    const f = setup()
    const declined = f.request()
    f.decide("deny")
    await declined
    const pending = f.request({ ...source, threadId: "other" })
    const rejected = expect(pending).rejects.toThrow("MODS_CANCELLED")
    f.inbox.reset()
    await rejected
    expect(f.inbox.snapshot()).toEqual({ current: null, queued: 0, paused: [] })
  })
  it("fails closed for unknown decisions and duplicate replies", async () => {
    const f = setup()
    const pending = f.request()
    const requestId = f.inbox.snapshot().current!.requestId
    expect(() => f.inbox.decide({ requestId, decision: "allow-all" })).toThrow("MODS_IPC_ARGUMENTS")
    expect(() => f.inbox.decide({ requestId, decision: ["allow"] })).toThrow("MODS_IPC_ARGUMENTS")
    f.decide("allow")
    await pending
    expect(() => f.inbox.decide({ requestId, decision: "allow" })).toThrow("MODS_APPROVAL_STALE")
  })
  it("guards every IPC endpoint before accessing requests or decisions", () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>()
    const ipc = {
      handle: (channel: string, handler: (event: IpcMainInvokeEvent) => unknown) =>
        handlers.set(channel, handler)
    }
    const trusted = vi.fn(() => {
      throw Error("untrusted renderer")
    })
    const f = setup()
    registerModApprovalInbox(ipc as unknown as IpcMain, f.inbox, trusted)
    for (const handler of handlers.values())
      expect(() => handler({} as IpcMainInvokeEvent)).toThrow("untrusted renderer")
    expect(trusted).toHaveBeenCalledTimes(3)
  })
})
