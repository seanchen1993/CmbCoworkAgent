import { describe, expect, it, vi } from "vitest"
import { createDevelopmentBridge } from "./development"

describe("development preload bridge", () => {
  it("routes isolated business trials and original source consent through exact native payloads", async () => {
    const invoke = vi.fn<(channel: string, input: unknown) => Promise<unknown>>(async () => ({}))
    const api = createDevelopmentBridge(invoke, () => () => {}).businessTrial!
    const author = { threadId: "creator", expectedWorkspace: "workspace" }
    const scope = {
      ...author,
      trialId: "creator-business-trial:id",
      digest: "digest",
      expectedVersion: 4
    }
    await api.request({ ...author, planId: "plan", digest: "digest", goal: "Real artifact" })
    await api.prepare(scope)
    await api.context(scope)
    await api.selectContext({
      ...scope,
      selection: { contextFingerprint: "context", deployUnitIds: ["CALC"] }
    })
    await api.start(scope)
    await api.refresh(scope)
    await api.gates(scope)
    await api.decideGate({ ...scope, notificationId: "original-gate", action: "reject" })
    await api.stop(scope)
    await api.feedback({ ...scope, message: "Improve one display" })
    await api.source.read(scope.trialId)
    await api.source.approve({
      projectId: scope.trialId,
      projectVersion: 4,
      packageDigest: "retained-digest",
      compiledDigest: "actual-compiled-digest"
    })
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(
      [
        "request",
        "prepare",
        "context",
        "select-context",
        "start",
        "refresh",
        "gates",
        "decide-gate",
        "stop",
        "feedback",
        "mods-read",
        "mods-approve"
      ].map((action) => `mods:development:business-trial:${action}`)
    )
    expect(invoke.mock.calls[4][1]).toEqual(scope)
    expect(invoke.mock.calls[10][1]).toBe(scope.trialId)
  })
  it("forwards optional planning changes only through scoped native IPC", async () => {
    const invoke = vi.fn(async () => ({}))
    const api = createDevelopmentBridge(invoke, () => () => {})
    const scope = { threadId: "thread", expectedWorkspace: "workspace" }
    await api.planningCatalog!(scope)
    await api.selectPlanning!({ ...scope, expectedRevision: 0, selected: null })
    expect(invoke.mock.calls).toEqual([
      ["mods:development:planning-catalog", scope],
      ["mods:development:select-planning", { ...scope, expectedRevision: 0, selected: null }]
    ])
  })
  it("forwards scoped actions without sending a model message or installing", async () => {
    const invoke = vi.fn(async (channel: string, input: unknown) => {
      void channel
      void input
      return {}
    })
    const api = createDevelopmentBridge(invoke, () => () => {})
    await api.status({ threadId: "thread" })
    await api.setEnabled({ threadId: "thread", expectedWorkspace: "workspace", enabled: true })
    await api.setMode({ threadId: "thread", expectedWorkspace: "workspace", mode: "normal" })
    await api.approve({
      threadId: "thread",
      expectedWorkspace: "workspace",
      id: "component",
      revision: 2,
      digest: "digest"
    })
    await api.stop({ threadId: "thread", expectedWorkspace: "workspace", id: "component" })
    await api.promote({
      threadId: "thread",
      expectedWorkspace: "workspace",
      id: "draft",
      revision: 2
    })
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      "mods:development:status",
      "mods:development:set-enabled",
      "mods:development:set-mode",
      "mods:development:approve",
      "mods:development:stop",
      "mods:development:promote"
    ])
    expect(invoke.mock.calls[2][1]).toMatchObject({ mode: "normal" })
    expect(invoke.mock.calls[3][1]).toMatchObject({ revision: 2, digest: "digest" })
  })
  it("forwards native reuse approval and undo with their exact scoped payloads", async () => {
    const invoke = vi.fn<(channel: string, input: unknown) => Promise<unknown>>(async () => ({}))
    const api = createDevelopmentBridge(invoke, () => () => {})
    const scope = { threadId: "thread", expectedWorkspace: "workspace" }
    const approval = {
      ...scope,
      planId: "plan",
      sourceDigest: "source",
      compiledDigest: "compiled",
      targetProfileDigest: "target"
    }
    await api.requestReuse({ ...scope, id: "draft", revision: 1 })
    await api.approveReuse(approval)
    await api.undoComposition(scope)
    await api.cancelComposition(scope)
    await api.undoTrial(scope)
    expect(invoke.mock.calls).toEqual([
      ["mods:development:request-reuse", { ...scope, id: "draft", revision: 1 }],
      ["mods:development:approve-reuse", approval],
      ["mods:development:undo-composition", scope],
      ["mods:development:cancel-composition", scope],
      ["mods:development:undo-trial", scope]
    ])
  })
  it("forwards only a thread change and exposes owned unsubscribe", () => {
    let deliver: (payload: unknown) => void = () => {}
    const unsubscribe = vi.fn(),
      callback = vi.fn()
    const subscribe = vi.fn((_channel: string, listener: (payload: unknown) => void) => {
      deliver = listener
      return unsubscribe
    })
    const api = createDevelopmentBridge(async () => undefined, subscribe)
    const close = api.onChanged(callback)
    deliver(null)
    deliver({ other: "thread" })
    deliver({ threadId: 7 })
    deliver({ threadId: "thread", raw: "must not forward" })
    expect(callback.mock.calls).toEqual([[{ threadId: "thread" }]])
    expect(subscribe.mock.calls[0][0]).toBe("mods:development-changed")
    close()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
  it("keeps business install/export as exact native scoped actions without model messages", async () => {
    const invoke = vi.fn<(channel: string, input: unknown) => Promise<unknown>>(async () => ({}))
    const api = createDevelopmentBridge(invoke, () => () => {})
    const input = {
      threadId: "chat",
      expectedWorkspace: "workspace",
      planId: "plan",
      digest: "digest"
    }
    await api.approveBusiness(input)
    await api.exportBusiness(input)
    await api.reconcileBusiness(input)
    expect(invoke.mock.calls).toEqual([
      ["mods:development:approve-business", input],
      ["mods:development:export-business", input],
      ["mods:development:reconcile-business", input]
    ])
  })
})
