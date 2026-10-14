import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { SkillEvaluationBridge } from "../mods/evaluation/skill-bridge"
import type { EvaluationScope } from "../mods/evaluation/runner"
import { registerSkillEvaluationHandlers } from "./mods-skill-evaluation"

function fixture() {
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, value: unknown) => Promise<unknown>
  >()
  const sender = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false })
  const event = { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent
  let workspace = "workspace",
    trusted = true,
    owner: EvaluationScope | undefined,
    finish!: () => void
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  const service = {
    list: vi.fn((scope: EvaluationScope) => {
      scope.assertCurrent()
      return { workspace, records: [], candidates: [] }
    }),
    prepare: vi.fn((_input: unknown, scope: EvaluationScope) => {
      scope.assertCurrent()
      return { id: randomUUID() }
    }),
    start: vi.fn(async (input: { id: string }, scope: EvaluationScope) => {
      owner = scope
      scope.assertCurrent()
      return { id: input.id }
    }),
    change: vi.fn(async (_input: unknown, scope: EvaluationScope) => {
      scope.assertCurrent()
      return { id: randomUUID() }
    }),
    wait: vi.fn(() => done)
  }
  registerSkillEvaluationHandlers(
    {
      handle: (name, callback) => {
        handlers.set(name, callback)
      }
    } as IpcMain,
    service as unknown as SkillEvaluationBridge,
    {
      trusted: () => {
        if (!trusted) throw Error("hidden credential exception")
      },
      threadScope: () => workspace,
      captureThreadFence: () => {
        const captured = workspace
        return () => {
          if (workspace !== captured) throw Error("STALE")
        }
      }
    }
  )
  const start = {
    threadId: "thread",
    expectedWorkspace: "workspace",
    id: randomUUID(),
    expectedDigest: "a".repeat(64),
    tasks: [{ id: "task", goal: "fixed" }],
    budget: { timeoutMs: 1000, maxExecutions: 6 }
  }
  return {
    service,
    sender,
    event,
    start,
    finish,
    owner: () => owner!,
    switch: () => {
      workspace = "other"
    },
    untrust: () => {
      trusted = false
    },
    call: (name: string, value: unknown) =>
      handlers.get("mods:skill-evaluation:" + name)!(event, value)
  }
}
describe("creator Skill bridge IPC", () => {
  it("readonly listing never starts or changes Skill files", async () => {
    const f = fixture()
    expect(await f.call("list", "thread")).toMatchObject({
      ok: true,
      value: { workspace: "workspace" }
    })
    expect(f.service.start).not.toHaveBeenCalled()
    expect(f.service.change).not.toHaveBeenCalled()
  })
  it("validates strict payload, digest and explicit bounded budget", async () => {
    const f = fixture()
    for (const request of [
      { ...f.start, extra: "authority" },
      { ...f.start, expectedDigest: "forged" },
      { ...f.start, budget: { timeoutMs: 1000, maxExecutions: 201 } },
      { ...f.start, tasks: [] }
    ])
      expect(await f.call("start", request)).toEqual({ ok: false, code: "INVALID" })
    expect(f.service.start).not.toHaveBeenCalled()
  })
  it("retains exact sender owner until evaluation drains and rejects scope switch", async () => {
    const f = fixture()
    expect(await f.call("start", f.start)).toMatchObject({ ok: true })
    expect(f.sender.listenerCount("destroyed")).toBe(1)
    f.sender.emit("did-start-navigation", { isMainFrame: false })
    expect(f.owner().signal.aborted).toBe(false)
    f.sender.emit("did-start-navigation", { isMainFrame: true })
    expect(f.owner().signal.aborted).toBe(true)
    f.finish()
    await Promise.resolve()
    await Promise.resolve()
    expect(f.sender.listenerCount("destroyed")).toBe(0)
    f.switch()
    expect(await f.call("start", f.start)).toEqual({ ok: false, code: "STALE" })
  })
  it("errors never echo private exception content or permit a subframe", async () => {
    const f = fixture()
    f.untrust()
    expect(await f.call("list", "thread")).toEqual({ ok: false, code: "FAILED" })
    const second = fixture()
    Object.defineProperty(second.event, "senderFrame", { value: {} })
    expect(await second.call("list", "thread")).toEqual({ ok: false, code: "STALE" })
  })
  it("does not publish a mutation reply after authority revocation", async () => {
    const f = fixture()
    f.service.change.mockImplementationOnce(async () => {
      f.switch()
      return { id: randomUUID() }
    })
    expect(
      await f.call("change", {
        threadId: "thread",
        expectedWorkspace: "workspace",
        id: randomUUID(),
        expectedDigest: "a".repeat(64),
        action: "adopt"
      })
    ).toEqual({ ok: false, code: "STALE" })
    expect(f.sender.listenerCount("destroyed")).toBe(0)
  })
})

it("requires literal recovery-loss acknowledgment for forget-history before dispatch", async () => {
  const f = fixture()
  const request = {
    threadId: "thread",
    expectedWorkspace: "workspace",
    id: randomUUID(),
    expectedDigest: "a".repeat(64),
    action: "forget-history"
  }
  for (const acknowledgeRecoveryLoss of [undefined, false, "true", 1]) {
    expect(await f.call("change", { ...request, acknowledgeRecoveryLoss })).toEqual({
      ok: false,
      code: "INVALID"
    })
  }
  expect(f.service.change).not.toHaveBeenCalled()
  expect(await f.call("change", { ...request, acknowledgeRecoveryLoss: true })).toMatchObject({
    ok: true
  })
  expect(f.service.change).toHaveBeenCalledWith(
    { ...request, acknowledgeRecoveryLoss: true },
    expect.anything()
  )
})
