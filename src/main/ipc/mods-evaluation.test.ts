import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { EvaluationRunner, EvaluationScope } from "../mods/evaluation/runner"
import { registerEvaluationHandlers } from "./mods-evaluation"

function fixture() {
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>
  >()
  const sender = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false })
  const event = { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent
  let workspace = "workspace",
    valid = true,
    finish!: () => void
  const settled = new Promise<void>((resolve) => {
    finish = resolve
  })
  const service = {
    start: vi.fn(async (_request: unknown, scope: EvaluationScope) => {
      scope.assertCurrent()
      return { id: "evaluation" }
    }),
    list: vi.fn(() => []),
    wait: vi.fn(() => settled),
    discard: vi.fn(() => {}),
    cancel: vi.fn(async () => {})
  }
  registerEvaluationHandlers(
    {
      handle: (name, callback) => {
        handlers.set(name, callback)
      }
    } as IpcMain,
    service as unknown as EvaluationRunner,
    {
      trusted: () => {
        if (!valid) throw Error("private-secret-error")
      },
      threadScope: () => workspace,
      captureThreadFence: () => {
        const captured = workspace
        return () => {
          if (captured !== workspace) throw Error("STALE")
        }
      }
    }
  )
  const request = {
    threadId: "thread",
    expectedWorkspace: "workspace",
    baseline: { id: "baseline", revision: 1, digest: "a".repeat(64) },
    candidate: { id: "candidate", revision: 1, digest: "b".repeat(64) },
    tasks: [{ id: "task", goal: "Do the fixed task" }],
    budget: { timeoutMs: 1000, maxExecutions: 6 }
  }
  return {
    service,
    sender,
    event,
    request,
    finish,
    workspace: (value: string) => {
      workspace = value
    },
    untrust: () => {
      valid = false
    },
    invoke: (name: string, input: unknown) => handlers.get("mods:evaluation:" + name)!(event, input)
  }
}
describe("evaluation IPC scope and explicit start", () => {
  it("list is read-only and start retains its owner through settlement", async () => {
    const f = fixture()
    expect(await f.invoke("list", "thread")).toEqual({
      ok: true,
      value: { workspace: "workspace", evaluations: [] }
    })
    expect(f.service.start).not.toHaveBeenCalled()
    expect(await f.invoke("start", f.request)).toEqual({ ok: true, value: { id: "evaluation" } })
    expect(f.sender.listenerCount("destroyed")).toBe(1)
    f.finish()
    await Promise.resolve()
    await Promise.resolve()
    expect(f.sender.listenerCount("destroyed")).toBe(0)
  })
  it.each([
    { provider: "real" },
    { baseline: { id: "baseline", revision: 1, digest: "A".repeat(64) } },
    { tasks: [] },
    { budget: { timeoutMs: Infinity, maxExecutions: 6 } }
  ])(
    "rejects extra provenance, noncanonical digest and invalid budget before execution",
    async (change) => {
      const f = fixture()
      expect(await f.invoke("start", { ...f.request, ...change })).toEqual({
        ok: false,
        code: "INVALID"
      })
      expect(f.service.start).not.toHaveBeenCalled()
    }
  )
  it("rejects getters without invoking them", async () => {
    const f = fixture(),
      getter = vi.fn(() => "thread")
    Object.defineProperty(f.request, "threadId", { get: getter, enumerable: true })
    expect(await f.invoke("start", f.request)).toEqual({ ok: false, code: "INVALID" })
    expect(getter).not.toHaveBeenCalled()
  })
  it("different workspace or frame cannot start; backend errors expose fixed codes only", async () => {
    const f = fixture()
    f.workspace("elsewhere")
    expect(await f.invoke("start", f.request)).toEqual({ ok: false, code: "STALE" })
    f.workspace("workspace")
    f.sender.mainFrame = {}
    expect(await f.invoke("start", f.request)).toEqual({ ok: false, code: "STALE" })
    f.untrust()
    expect(JSON.stringify(await f.invoke("list", "thread"))).not.toContain("private-secret")
    expect(f.service.start).not.toHaveBeenCalled()
  })
  it("main-frame navigation aborts owned execution while a subframe does not", async () => {
    const f = fixture()
    await f.invoke("start", f.request)
    const scope = f.service.start.mock.calls[0][1]
    f.sender.emit("did-start-navigation", { isMainFrame: false })
    expect(scope.signal.aborted).toBe(false)
    f.sender.emit("did-start-navigation", { isMainFrame: true })
    expect(scope.signal.aborted).toBe(true)
    f.finish()
  })
  it("failed post-start scope publication aborts and awaits actual owned settlement", async () => {
    const f = fixture()
    f.service.start.mockImplementationOnce(async (_request, scope) => {
      f.workspace("elsewhere")
      f.finish()
      expect(scope.signal.aborted).toBe(false)
      return { id: "evaluation" }
    })
    expect(await f.invoke("start", f.request)).toEqual({ ok: false, code: "STALE" })
    expect(f.service.start.mock.calls[0][1].signal.aborted).toBe(true)
    expect(f.service.wait).toHaveBeenCalledWith("workspace", "thread", "evaluation")
    expect(f.sender.listenerCount("destroyed")).toBe(0)
  })
})


it("report discard is explicitly trusted, scope-bound and digest-bound", async () => {
  const f = fixture()
  const request = { threadId: "thread", expectedWorkspace: "workspace",
    evaluationId: "report", expectedDigest: "a".repeat(64) }
  expect(await f.invoke("discard", { ...request, expectedDigest: "bad" }))
    .toEqual({ ok: false, code: "INVALID" })
  expect(f.service.discard).not.toHaveBeenCalled()
  f.workspace("other")
  expect(await f.invoke("discard", request)).toEqual({ ok: false, code: "STALE" })
  expect(f.service.discard).not.toHaveBeenCalled()
  f.workspace("workspace")
  expect(await f.invoke("discard", request)).toEqual({ ok: true, value: undefined })
  expect(f.service.discard).toHaveBeenCalledOnce()
  f.untrust()
  expect(await f.invoke("discard", request)).toMatchObject({ ok: false })
  expect(f.service.discard).toHaveBeenCalledOnce()
})
