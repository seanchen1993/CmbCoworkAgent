import { describe, expect, it, vi } from "vitest"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { ModDevelopmentService } from "../mods/devtools/development-service"
import { registerModsDevelopmentHandlers } from "./mods-development"

function fixture() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
  const service = {
    status: vi.fn(),
    refreshReuse: vi.fn(),
    setEnabled: vi.fn(),
    setMode: vi.fn(),
    approve: vi.fn(),
    stop: vi.fn(),
    promote: vi.fn(),
    requestReuse: vi.fn(),
    approveReuse: vi.fn(),
    planningCatalog: vi.fn(),
    selectPlanning: vi.fn()
  }
  service.status.mockReturnValue({ workspace: "workspace" })
  const actions = {
    undoComposition: vi.fn(),
    cancelComposition: vi.fn(),
    undoTrial: vi.fn(),
    approveBusiness: vi.fn(),
    exportBusiness: vi.fn(),
    reconcileBusiness: vi.fn(),
    prepareProjectDelivery: vi.fn(), installProjectDelivery: vi.fn(),
    exportProjectDelivery: vi.fn(), reconcileProjectDelivery: vi.fn(), approveModularization: vi.fn()
  }
  const trustedEvent = {} as IpcMainInvokeEvent
  registerModsDevelopmentHandlers(
    {
      handle: (name: string, handler: typeof handlers extends Map<string, infer T> ? T : never) =>
        handlers.set(name, handler)
    } as unknown as IpcMain,
    service as unknown as ModDevelopmentService,
    (event) => {
      if (event !== trustedEvent) throw Error("UNTRUSTED")
    },
    actions
  )
  return {
    service,
    actions,
    run: (name: string, input: unknown, event = trustedEvent) =>
      handlers.get(`mods:development:${name}`)!(event, input)
  }
}

describe("development IPC authority", () => {
  it("admits only exact native delivery and modularization identities without caller paths or PASS facts", () => {
    const f = fixture()
    const scope = { threadId: "creator", expectedWorkspace: "workspace" }
    const requestId = "3e901082-1468-4c56-962c-d48e60d9c9b6"
    const digest = "a".repeat(64)
    const cases = [
      ["prepare-project-delivery", f.actions.prepareProjectDelivery,
        { ...scope, requestId, digest, name: "new-project", version: "1.0.0" }],
      ["install-project-delivery", f.actions.installProjectDelivery,
        { ...scope, deliveryId: requestId, digest }],
      ["export-project-delivery", f.actions.exportProjectDelivery,
        { ...scope, deliveryId: requestId, digest }],
      ["reconcile-project-delivery", f.actions.reconcileProjectDelivery,
        { ...scope, deliveryId: requestId, digest }],
      ["approve-modularization", f.actions.approveModularization,
        { ...scope, requestId, sourceDigest: digest }]
    ] as const
    for (const [channel, action, input] of cases) {
      expect(() => f.run(channel, input, {} as IpcMainInvokeEvent)).toThrow("UNTRUSTED")
      for (const extra of [{ sourceRoot: "C:/other" }, { output: "C:/out.zip" },
        { passed: true }, { confirmed: true }, { permissions: ["process.exec"] }])
        expect(() => f.run(channel, { ...input, ...extra })).toThrow("DEVELOPMENT_INPUT")
      expect(action).not.toHaveBeenCalled()
      f.run(channel, input)
      expect(action).toHaveBeenCalledExactlyOnceWith(input)
    }
  })
  it("admits exact native planning selection and withdrawal without accepting tool, grant or result facts", () => {
    const f = fixture(),
      scope = { threadId: "thread", expectedWorkspace: "workspace" }
    const selected = { pluginId: "installed", name: "planner", digest: "a".repeat(64) }
    f.run("planning-catalog", scope)
    expect(f.service.planningCatalog).toHaveBeenCalledWith("thread", "workspace")
    f.run("select-planning", { ...scope, expectedRevision: 0, selected })
    f.run("select-planning", { ...scope, expectedRevision: 1, selected: null })
    expect(f.service.selectPlanning.mock.calls).toEqual([
      ["thread", "workspace", 0, selected],
      ["thread", "workspace", 1, null]
    ])
    for (const extra of [{ capabilities: ["fs.write"] }, { approved: true }, { result: "active" }])
      expect(() =>
        f.run("select-planning", { ...scope, expectedRevision: 0, selected, ...extra })
      ).toThrow("DEVELOPMENT_INPUT")
    expect(() =>
      f.run("select-planning", {
        ...scope,
        expectedRevision: 0,
        selected: { ...selected, digest: "latest" }
      })
    ).toThrow("DEVELOPMENT_INPUT")
  })
  it("refreshes unknown reuse receipts through read-only reconciliation", async () => {
    const f = fixture()
    const receipt = { reuse: { phase: "unknown" } }
    f.service.refreshReuse.mockResolvedValue(receipt)
    expect(await f.run("status", { threadId: "thread" })).toBe(receipt)
    expect(f.service.refreshReuse).toHaveBeenCalledExactlyOnceWith("thread")
    expect(f.service.status).not.toHaveBeenCalledWith("thread")
  })
  it("rejects untrusted callers before reading or changing any state", () => {
    const f = fixture()
    f.service.status.mockClear()
    for (const name of [
      "status",
      "set-enabled",
      "set-mode",
      "approve",
      "stop",
      "promote",
      "request-reuse",
      "approve-reuse",
      "approve-business",
      "export-business",
      "undo-composition",
      "cancel-composition",
      "undo-trial",
      "planning-catalog",
      "select-planning"
    ])
      expect(() => f.run(name, {}, {} as IpcMainInvokeEvent)).toThrow("UNTRUSTED")
    for (const method of Object.values(f.service)) expect(method).not.toHaveBeenCalled()
    for (const method of Object.values(f.actions)) expect(method).not.toHaveBeenCalled()
  })
  it("forwards an explicit conversation mode and rejects unknown modes or authority fields", () => {
    const f = fixture()
    const input = { threadId: "thread", expectedWorkspace: "workspace", mode: "normal" }
    f.run("set-mode", input)
    expect(f.service.setMode).toHaveBeenCalledWith("thread", "workspace", "normal")
    for (const extra of [{ mode: "auto" }, { enabled: true }, { capabilities: ["fs.write"] }])
      expect(() => f.run("set-mode", { ...input, ...extra })).toThrow("DEVELOPMENT_INPUT")
  })
  it("rejects model-supplied capabilities and malformed revisions", () => {
    const f = fixture()
    const input = {
      threadId: "thread",
      expectedWorkspace: "workspace",
      id: "demo",
      revision: 1,
      digest: "a".repeat(64)
    }
    for (const change of [
      { capabilities: ["process.exec"] },
      { revision: 0 },
      { digest: "not-a-digest" },
      { id: "../other" }
    ])
      expect(() => f.run("approve", { ...input, ...change })).toThrow("DEVELOPMENT_INPUT")
    expect(f.service.approve).not.toHaveBeenCalled()
    f.run("approve", input)
    expect(f.service.approve).toHaveBeenCalledExactlyOnceWith(
      "thread",
      "workspace",
      "demo",
      1,
      "a".repeat(64),
      undefined
    )
  })
  it("carries exact source bytes for real consent but rejects an injected validation or target", () => {
    const f = fixture()
    const input = {
      threadId: "thread",
      expectedWorkspace: "workspace",
      id: "demo",
      revision: 2,
      digest: "a".repeat(64),
      sourceDigest: "b".repeat(64)
    }
    f.run("approve", input)
    expect(f.service.approve).toHaveBeenCalledWith(
      "thread",
      "workspace",
      "demo",
      2,
      input.digest,
      input.sourceDigest
    )
    for (const extra of [
      { sourceDigest: "invalid" },
      { validation: "authorized-real" },
      { target: { workspace: "other" } }
    ])
      expect(() => f.run("approve", { ...input, ...extra })).toThrow("DEVELOPMENT_INPUT")
  })
  it("binds stop and promotion to the caller's visible workspace and revision", () => {
    const f = fixture()
    f.run("stop", { threadId: "thread", expectedWorkspace: "workspace", id: "demo" })
    f.run("promote", {
      threadId: "thread",
      expectedWorkspace: "workspace",
      id: "demo",
      revision: 3
    })
    expect(f.service.stop).toHaveBeenCalledWith("thread", "workspace", "demo")
    expect(f.service.promote).toHaveBeenCalledWith("thread", "workspace", "demo", 3)
  })
  it("binds one reuse approval to the exact source, compiled version and target selection", () => {
    const f = fixture()
    const input = {
      threadId: "thread",
      expectedWorkspace: "workspace",
      planId: "3e901082-1468-4c56-962c-d48e60d9c9b6",
      sourceDigest: "a".repeat(64),
      compiledDigest: "b".repeat(64),
      targetProfileDigest: "c".repeat(64)
    }
    f.run("approve-reuse", input)
    expect(f.service.approveReuse).toHaveBeenCalledWith("thread", "workspace", input)
    for (const extra of [
      { targetProfileDigest: undefined },
      { capabilities: ["fs.write"] },
      { planId: "other" },
      { sourceDigest: "bad" }
    ])
      expect(() => f.run("approve-reuse", { ...input, ...extra })).toThrow("DEVELOPMENT_INPUT")
    f.run("request-reuse", {
      threadId: "thread",
      expectedWorkspace: "workspace",
      id: "demo",
      revision: 1
    })
    expect(f.service.requestReuse).toHaveBeenCalledWith("thread", "demo", 1)
    expect(() =>
      f.run("request-reuse", {
        threadId: "thread",
        expectedWorkspace: "other",
        id: "demo",
        revision: 1
      })
    ).toThrow("DEVELOPMENT_SCOPE_CHANGED")
  })
  it("keeps undo and cancellation restricted to native scoped controls", () => {
    const f = fixture()
    const input = { threadId: "thread", expectedWorkspace: "workspace" }
    for (const [channel, method] of [
      ["undo-composition", f.actions.undoComposition],
      ["cancel-composition", f.actions.cancelComposition],
      ["undo-trial", f.actions.undoTrial]
    ] as const) {
      f.run(channel, input)
      expect(method).toHaveBeenCalledWith(input)
      expect(() => f.run(channel, { ...input, revision: 1 })).toThrow("DEVELOPMENT_INPUT")
    }
  })
  it("binds business install and export to a native reviewed plan without accepting paths or grants", () => {
    const f = fixture()
    const input = {
      threadId: "thread",
      expectedWorkspace: "workspace",
      planId: "3e901082-1468-4c56-962c-d48e60d9c9b6",
      digest: "a".repeat(64)
    }
    for (const [channel, action] of [
      ["approve-business", f.actions.approveBusiness],
      ["export-business", f.actions.exportBusiness],
      ["reconcile-business", f.actions.reconcileBusiness]
    ] as const) {
      for (const extra of [
        { output: "C:/model-chosen.zip" },
        { permissions: ["process.exec"] },
        { planId: "unknown" },
        { digest: "bad" },
        { sourceRoot: "C:/other-plugin" }
      ])
        expect(() => f.run(channel, { ...input, ...extra })).toThrow("DEVELOPMENT_INPUT")
      expect(action).not.toHaveBeenCalled()
      f.run(channel, input)
      expect(action).toHaveBeenCalledExactlyOnceWith(input)
    }
  })
})
