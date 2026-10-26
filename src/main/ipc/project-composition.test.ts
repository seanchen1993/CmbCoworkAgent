import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron"
import type { HostProjectService } from "../harness-board/project-runtime/host-service"
import type { ProjectCompositionServiceDependencies } from "../harness-board/project-runtime/composition-service"
import type { ProjectCompositionDefinition } from "../../shared/project-runtime/composition"
import type { CompositionLegacyDependencies } from "../harness-board/project-runtime/composition-legacy-adapter"
import type { CompositionExecutionContext } from "../harness-board/project-runtime/composition-coordinator"
import { approvalDecisionBroker } from "../agent/approval-decision-broker"
vi.mock("../plugins/capability-catalog-client", () => ({
  capabilityCatalogWorkers: { read: (work: (reader: unknown) => unknown) => work(undefined) }
}))

const state = vi.hoisted(() => ({
  root: "",
  incarnation: "one",
  project: true,
  enabled: true,
  changed: false,
  skill: false,
  revision: "0",
  selections: [] as unknown[],
  admit: vi.fn(),
  scan: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
  approve: vi.fn(),
  approveLegacy: vi.fn(),
  decideLegacy: vi.fn(async () => ({ applied: true, message: "continued" })),
  legacyDecision: undefined as Record<string, unknown> | undefined,
  legacyGate: undefined as Record<string, unknown> | undefined,
  wait: vi.fn(),
  workspace: vi.fn(),
  openPath: vi.fn<(path: string) => Promise<string>>(async () => ""),
  runtimeDeps: undefined as ProjectCompositionServiceDependencies | undefined,
  run: undefined as Record<string, unknown> | undefined,
  registryReads: 0,
  threadReads: 0,
  runReads: 0,
  installedId: "installed"
}))
vi.mock("electron", () => ({ shell: { openPath: state.openPath } }))
vi.mock("../storage", () => ({
  getOpenworkDir: () => state.root,
  getPlugins: () => {
    state.registryReads++
    return [{ id: state.installedId, name: "source", version: "1", path: state.root, enabled: state.enabled }]
  }
}))
vi.mock("../db", () => ({
  getThreadCore: () => {
    state.threadReads++
    return ({
    metadata: {
      workspacePath: state.root,
      cmb_thread_incarnation: state.incarnation,
      ...(state.project ? { harnessProjectSession: { projectId: "parent", kind: "chat" } } : {})
    }
    })
  }
}))
vi.mock("../harness-board/service", () => ({
  getHarnessCapabilityWorkspaces: () => [state.root],
  getHarnessCapabilityFeatureWorkspace: () => undefined
}))
vi.mock("../mods/builtins/project-facts", () => ({
  readBuiltinProjectBinding: () => false,
  readBuiltinProjectFacts: () => ({ facts: { state: "unavailable" } })
}))
vi.mock("../plugins/project-capability-selection", async (importOriginal) => {
  const original = await importOriginal<typeof import("../plugins/project-capability-selection")>()
  return {
    ...original,
    readProjectCapabilitySelection: () => ({ revision: state.revision, sources: state.selections }),
    getProjectCapabilitySelections: () => ({
      save: (_project: string, _workspace: string, revision: string, sources: unknown[]) => {
        if (state.revision !== revision) throw Error("PROJECT_CAPABILITIES_CHANGED")
        state.revision = "saved"
        state.selections = sources
        return { revision: state.revision, sources }
      }
    })
  }
})
vi.mock("../plugins/project-capability-runtime", () => ({
  ProjectCapabilityRuntimeService: class {
    validate = state.admit
    admit = state.admit
  }
}))
vi.mock("../plugins/project-composition-catalog", async (importOriginal) => {
  const original = await importOriginal<typeof import("../plugins/project-composition-catalog")>()
  return { ...original, readProjectCompositionCatalog: state.scan }
})
vi.mock("../harness-board/project-runtime/composition-service", () => ({
  ProjectCompositionService: class {
    store = { unitWorkspace: state.workspace }
    constructor(
      _path: string,
      _host: unknown,
      dependencies: ProjectCompositionServiceDependencies
    ) {
      state.runtimeDeps = dependencies
    }
    recoverInterrupted() {
      return []
    }
    startBackground = state.start
    async prepare(definition: ProjectCompositionDefinition) {
      state.run = { id: "run", definition, version: 1, status: "running", configurationPending: true,
        units: definition.units.map(unit => ({ id: unit.id, status: "pending" })) }
      return state.run
    }
    startPrepared() {
      return state.start(state.run!.definition)
    }
    waitForSettlement = state.wait
    isLegacyUnit() {
      return Boolean(state.legacyGate)
    }
    executionThreadIds(_runId: string, unitId: string) {
      return unitId === "first" ? ["original-internal-thread"] : []
    }
    get() {
      state.runReads++
      return state.run
    }
    cancel = state.cancel
    approve = state.approve
    approveLegacy = state.approveLegacy
    decideLegacy = state.decideLegacy
    waitingLegacyDecision() {
      return state.legacyDecision
    }
    waitingLegacyApproval() {
      return state.legacyGate
    }
    guardWorkspaceMutation(_workspace: string, work: () => unknown) {
      return work()
    }
    waitingOperation() {
      return {
        operationId: "operation",
        projectId: "internal",
        stageId: "review",
        expectedVersion: 2,
        inputFingerprint: "a".repeat(64),
        approval: null
      }
    }
  }
}))
import { registerProjectCompositionHandlers } from "./project-composition"

beforeEach(() => {
  vi.clearAllMocks()
  state.root = mkdtempSync(join(tmpdir(), "composition-ipc-"))
  state.incarnation = "one"
  state.registryReads = state.threadReads = state.runReads = 0
  state.installedId = "installed"
  state.project = true
  state.enabled = true
  state.changed = false
  state.revision = "0"
  state.selections = []
  state.skill = false
  state.admit.mockResolvedValue([])
  state.run = undefined
  state.runtimeDeps = undefined
  state.legacyDecision = undefined
  state.legacyGate = undefined
  state.workspace.mockReset()
  state.openPath.mockResolvedValue("")
  state.wait.mockImplementation(() => new Promise(() => {}))
  state.cancel.mockImplementation(async () => state.run)
  state.scan.mockImplementation(async () => ({
    revision: state.changed ? "changed" : "first",
    diagnostics: [],
    sources: [
      {
        plugin: { id: "installed", name: "source", version: "1", path: state.root, enabled: true },
        capability: {
          id: "flow",
          title: "Flow",
          kind: state.skill ? "skill" : "flow",
          usage: "project",
          entry: "devclaw.project-runtime.json",
          dependsOn: []
        },
        entry: {
          source: { pluginId: "installed", capabilityId: "flow", packageDigest: "a".repeat(64) },
          sourceName: "source",
          title: "Flow",
          kind: state.skill ? "capability" : "flow",
          available: true,
          reasons: [],
          inputs: [],
          outputs: []
        }
      }
    ]
  }))
  state.start.mockImplementation(async (definition) => {
    state.run = { id: "run", definition, version: 1, status: "running" }
    return state.run
  })
})
afterEach(() => rmSync(state.root, { recursive: true, force: true }))
function fixture(legacy = false) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
  const owner = {} as BrowserWindow
  const legacyFactory: NonNullable<Parameters<typeof registerProjectCompositionHandlers>[1]["legacy"]> =
    input => input as unknown as CompositionLegacyDependencies
  registerProjectCompositionHandlers(
    {
      handle: (name: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown) =>
        handlers.set(name, handler)
    } as unknown as IpcMain,
    {
      trusted: () => owner,
      host: () =>
        ({
          retainConfigurationSource: async () => ({ digest: "a".repeat(64), root: state.root }),
          get: () => ({
            manifest: {
              stages: [
                {
                  id: "review",
                  title: "Review",
                  checkIds: ["original-check"],
                  artifactIds: ["result"]
                }
              ]
            }
          })
        }) as unknown as HostProjectService,
      assertWorkspaceIdle: () => {},
      bindOwner: () => {},
      ...(legacy ? { legacy: legacyFactory } : {})
    }
  )
  const scope = { projectId: "parent", threadId: "thread", expectedWorkspace: state.root }
  const call = async (method: string, input: unknown) =>
    handlers.get(`project-composition:${method}`)!(
      { sender: { id: 1 } } as IpcMainInvokeEvent,
      input
    )
  const definition = {
    apiVersion: "devclaw.project-composition/v1" as const,
    parentProjectId: "parent",
    workspace: state.root,
    goal: "生成项目说明，再核对文档中的每条需求",
    units: [
      {
        id: "first",
        kind: "flow" as const,
        source: { pluginId: "installed", capabilityId: "flow", packageDigest: "a".repeat(64) },
        inputs: [],
        outputs: []
      }
    ]
  }
  const preview = async () => {
    await call("catalog", scope)
    return (await call("preview", { scope, catalogRevision: "first", definition })) as {
      id: string
    }
  }
  return { scope, definition, call, preview }
}
describe("project composition IPC", () => {
  it("reads fresh parent and installed authority once without reloading an already validated run", async () => {
    const f = fixture(true)
    const preview = await f.preview()
    await f.call("start", { scope: f.scope, previewId: preview.id, requestId: "request" })
    const definition = state.run!.definition as ProjectCompositionDefinition
    const context: CompositionExecutionContext = { runId: "run", parentProjectId: "parent",
      workspace: state.root, executionWorkspace: state.root, unit: definition.units[0],
      attemptId: "attempt", idempotencyKey: "original", inputs: [] }
    const check = state.runtimeDeps!.legacy!.assertAuthorityCurrent!
    state.registryReads = state.threadReads = state.runReads = 0
    for (let index = 0; index < 100; index++) check(context, definition)
    expect(state.runReads).toBe(0)
    expect(state.registryReads).toBe(100)
    expect(state.threadReads).toBe(100)
    state.runtimeDeps!.legacy!.assertCurrent!(context)
    expect(state.runReads).toBe(1)
    expect(state.registryReads).toBe(101)
    expect(state.threadReads).toBe(101)
    state.enabled = false
    expect(() => check(context, definition)).toThrow("COMPOSITION_SOURCE_CHANGED")
    state.enabled = true
    state.installedId = "different-uuid"
    expect(() => check(context, definition)).toThrow("COMPOSITION_SOURCE_CHANGED")
    state.installedId = "installed"
    state.incarnation = "new-parent-incarnation"
    expect(() => check(context, definition)).toThrow("CONTEXT_CHANGED")
    state.incarnation = "one"
    expect(() => check({ ...context, parentProjectId: "foreign" }, definition))
      .toThrow("COMPOSITION_INTERNAL_SCOPE_CHANGED")
    expect(() => check(context, { ...definition, goal: "changed unauthorized definition" }))
      .toThrow("COMPOSITION_AUTHORIZATION_REQUIRED")
  })
  it("opens only the registered workspace of an owned unit, without accepting a supplied path", async () => {
    const f = fixture()
    state.run = { id: "run", definition: f.definition, units: [{ id: "first" }] }
    state.workspace.mockReturnValue(state.root)
    const input = { scope: f.scope, runId: "run", unitId: "first", path: "C:/untrusted" }
    expect(await f.call("openWorkspace", input)).toEqual({ path: state.root })
    expect(state.workspace).toHaveBeenCalledExactlyOnceWith("run", "first")
    expect(state.openPath).toHaveBeenCalledExactlyOnceWith(state.root)
    state.openPath.mockClear()
    await expect(f.call("openWorkspace", { ...input, unitId: "unknown" })).rejects.toThrow(
      "COMPOSITION_UNIT_UNKNOWN"
    )
    state.run.definition = { ...f.definition, parentProjectId: "other" }
    await expect(f.call("openWorkspace", input)).rejects.toThrow("COMPOSITION_RUN_SCOPE_CHANGED")
    expect(state.openPath).not.toHaveBeenCalled()
  })
  it("does not open an unallocated or replaced directory and reports shell failures", async () => {
    const f = fixture()
    state.run = { id: "run", definition: f.definition, units: [{ id: "first" }] }
    const input = { scope: f.scope, runId: "run", unitId: "first" }
    await expect(f.call("openWorkspace", input)).rejects.toThrow(
      "COMPOSITION_EXECUTION_WORKSPACE_MISSING"
    )
    state.workspace.mockImplementationOnce(() => {
      throw Error("COMPOSITION_WORKSPACE_OWNER_CHANGED")
    })
    await expect(f.call("openWorkspace", input)).rejects.toThrow(
      "COMPOSITION_WORKSPACE_OWNER_CHANGED"
    )
    expect(state.openPath).not.toHaveBeenCalled()
    state.workspace.mockReturnValue(state.root)
    state.openPath.mockResolvedValueOnce("OS rejected")
    await expect(f.call("openWorkspace", input)).rejects.toThrow(
      "COMPOSITION_WORKSPACE_OPEN_FAILED"
    )
  })
  it("preserves a waiting run on a busy catalog and retries its original decision once", async () => {
    const f = fixture()
    state.run = {
      id: "run",
      definition: f.definition,
      version: 7,
      units: [{ id: "first", status: "waiting-approval" }]
    }
    const input = {
      scope: f.scope,
      runId: "run",
      unitId: "first",
      expectedVersion: 7,
      notificationId: "original-notification",
      action: "continue"
    }
    state.scan.mockRejectedValueOnce(Error("COMPOSITION_CATALOG_BUSY"))
    await expect(f.call("decideLegacyDecision", input)).rejects.toThrow("COMPOSITION_CATALOG_BUSY")
    expect(state.decideLegacy).not.toHaveBeenCalled()
    expect(state.start).not.toHaveBeenCalled()
    expect(await f.call("read", { scope: f.scope, runId: "run" })).toMatchObject({
      version: 7,
      units: [{ id: "first", status: "waiting-approval" }]
    })
    await f.call("decideLegacyDecision", input)
    expect(state.decideLegacy).toHaveBeenCalledExactlyOnceWith("run", "first", 7, {
      notificationId: "original-notification",
      action: "continue",
      message: undefined
    })
    expect(state.start).not.toHaveBeenCalled()
  })
  it("checks project and original unit ownership before resolving a tool confirmation", async () => {
    const f = fixture()
    state.run = { id: "run", definition: f.definition, units: [{ id: "first", status: "running" }] }
    const resolve = vi.fn()
    approvalDecisionBroker.register({
      threadId: "original-internal-thread",
      runtimeThreadId: "original-internal-thread",
      resolve,
      request: {
        id: "pending-request",
        tool_call: { id: "original-call", name: "write_file", args: {} },
        allowed_decisions: ["approve", "reject"],
        allowed_approval_types: ["approve", "reject"],
        safety_level: "needs_approval",
        operation: "write_file",
        cwd: state.root
      }
    })
    try {
      expect(await f.call("readToolApprovals", { scope: f.scope, runId: "run" })).toEqual([
        expect.objectContaining({ unitId: "first", requestId: "pending-request" })
      ])
      const input = {
        scope: f.scope,
        runId: "run",
        unitId: "forged",
        requestId: "pending-request",
        decision: "allow"
      }
      await expect(f.call("respondToolApproval", input)).rejects.toThrow("CHANGED")
      state.project = false
      await expect(f.call("respondToolApproval", { ...input, unitId: "first" })).rejects.toThrow()
      expect(resolve).not.toHaveBeenCalled()
      state.project = true
      await f.call("respondToolApproval", {
        ...input,
        unitId: "first",
        threadId: "forged",
        tool_call_id: "forged"
      })
      expect(resolve).toHaveBeenCalledExactlyOnceWith({
        type: "approve",
        tool_call_id: "original-call"
      })
    } finally {
      approvalDecisionBroker.unregister("pending-request")
    }
  })
  it("routes legacy approvals to the original gate with the composition version, not renderer identity", async () => {
    const f = fixture()
    state.run = {
      id: "run",
      definition: f.definition,
      version: 7,
      units: [{ id: "first", status: "waiting-approval" }]
    }
    state.legacyGate = {
      kind: "legacy-human-gate",
      unitId: "first",
      gateId: "original-gate",
      projectId: "real-internal-project",
      featureId: "real-feature",
      message: "请确认测试结果"
    }
    await expect(f.call("waitingApproval", { scope: f.scope, runId: "run" })).resolves.toEqual(
      state.legacyGate
    )
    await f.call("approve", {
      scope: f.scope,
      runId: "run",
      unitId: "first",
      kind: "legacy-human-gate",
      gateId: "original-gate",
      expectedVersion: 7,
      decision: "approved",
      projectId: "forged",
      featureId: "forged"
    })
    expect(state.approveLegacy).toHaveBeenCalledWith("run", "first", "original-gate", 7, "approve")
    expect(state.approve).not.toHaveBeenCalled()
  })
  it("binds original retry proxy to the parent scope and version before original decisions", async () => {
    const f = fixture()
    state.run = {
      id: "run",
      definition: f.definition,
      version: 7,
      units: [{ id: "first", status: "waiting-approval" }]
    }
    state.legacyDecision = {
      unitId: "first",
      notificationId: "retry",
      message: "original decision",
      humanGatePending: false
    }
    await expect(f.call("readLegacyDecision", { scope: f.scope, runId: "run" })).resolves.toEqual(
      state.legacyDecision
    )
    const input = {
      scope: f.scope,
      runId: "run",
      unitId: "first",
      notificationId: "retry",
      expectedVersion: 7,
      action: "continue",
      message: "fix"
    }
    await f.call("decideLegacyDecision", input)
    expect(state.decideLegacy).toHaveBeenCalledWith("run", "first", 7, {
      notificationId: "retry",
      action: "continue",
      message: "fix"
    })
    await expect(f.call("decideLegacyDecision", { ...input, expectedVersion: 6 })).rejects.toThrow(
      "VERSION_CHANGED"
    )
    state.project = false
    await expect(f.call("decideLegacyDecision", input)).rejects.toThrow()
    expect(state.decideLegacy).toHaveBeenCalledTimes(1)
  })
  it("passes the confirmed task to the original engine and releases authorization after settlement", async () => {
    const f = fixture()
    let settle!: () => void
    state.wait.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = () => resolve({ ...state.run, status: "succeeded" })
        })
    )
    const preview = await f.preview()
    await f.call("start", { scope: f.scope, previewId: preview.id, requestId: "task" })
    const source = await state.runtimeDeps!.resolveSource({
      runId: "run",
      unit: f.definition.units[0],
      parentProjectId: "parent",
      workspace: state.root,
      attemptId: "attempt",
      idempotencyKey: "run:first",
      inputs: []
    })
    expect(source.goal).toContain(f.definition.goal)
    expect(source.goal).toContain("Flow")
    settle()
    await Promise.resolve()
    await expect(
      state.runtimeDeps!.authorizeDefinition(state.run!.definition as ProjectCompositionDefinition)
    ).rejects.toThrow("AUTHORIZATION_REQUIRED")
  })

  it("keeps the executing source snapshot intact while cancellation is in progress", async () => {
    const f = fixture()
    const preview = await f.preview()
    await f.call("start", { scope: f.scope, previewId: preview.id, requestId: "task" })
    state.cancel.mockImplementationOnce(async () => {
      await state.runtimeDeps!.authorizeDefinition(
        state.run!.definition as ProjectCompositionDefinition
      )
      return state.run
    })
    await f.call("cancel", { scope: f.scope, runId: "run", expectedVersion: 1 })
    expect(state.cancel).toHaveBeenCalledOnce()
  })
  it("previews capabilities without applying, uses original admission and commits with revision CAS", async () => {
    const f = fixture()
    state.skill = true
    await f.call("catalog", f.scope)
    const preview = (await f.call("previewCapabilities", {
      scope: f.scope,
      catalogRevision: "first",
      sources: [f.definition.units[0].source]
    })) as { id: string; issues: string[] }
    expect(preview.issues).toEqual([])
    expect(state.selections).toEqual([])
    const input = { scope: f.scope, previewId: preview.id, expectedRevision: "0" }
    await f.call("applyCapabilities", input)
    expect(state.selections).toEqual([f.definition.units[0].source])
    expect(state.admit).toHaveBeenCalledTimes(2)
    await f.call("applyCapabilities", input)
    expect(state.admit).toHaveBeenCalledTimes(2)
    state.revision = "external-change"
    await expect(f.call("applyCapabilities", input)).rejects.toThrow("CHANGED")
  })
  it("rejects unavailable conversation capabilities and supports explicit clear without admitting sources", async () => {
    const f = fixture()
    await f.call("catalog", f.scope)
    const denied = (await f.call("previewCapabilities", {
      scope: f.scope,
      catalogRevision: "first",
      sources: [f.definition.units[0].source]
    })) as { id: string; issues: string[] }
    expect(denied.issues.length).toBeGreaterThan(0)
    await expect(
      f.call("applyCapabilities", { scope: f.scope, previewId: denied.id, expectedRevision: "0" })
    ).rejects.toThrow("INVALID")
    const clear = (await f.call("previewCapabilities", {
      scope: f.scope,
      catalogRevision: "first",
      sources: []
    })) as { id: string }
    await f.call("applyCapabilities", {
      scope: f.scope,
      previewId: clear.id,
      expectedRevision: "0"
    })
    expect(state.selections).toEqual([])
    expect(state.admit).not.toHaveBeenCalled()
  })
  it("rejects ordinary chat before scanning or creating runtime state", async () => {
    const f = fixture()
    state.project = false
    await expect(f.call("catalog", f.scope)).rejects.toThrow("PROJECT_REQUIRED")
    expect(state.scan).not.toHaveBeenCalled()
  })
  it("confirms frozen source versions, starts once per request and rejects changed previews", async () => {
    const f = fixture()
    const preview = await f.preview()
    state.changed = true
    await expect(
      f.call("start", { scope: f.scope, previewId: preview.id, requestId: "request" })
    ).rejects.toThrow("CATALOG_CHANGED")
    expect(state.start).not.toHaveBeenCalled()
    state.changed = false
    await f.call("start", { scope: f.scope, previewId: preview.id, requestId: "request" })
    expect(state.start).toHaveBeenCalledOnce()
    await expect(
      f.call("start", { scope: f.scope, previewId: preview.id, requestId: "another" })
    ).rejects.toThrow("ALREADY_USED")
  })
  it("does not accept a preview after the project thread was replaced", async () => {
    const f = fixture()
    const preview = await f.preview()
    state.incarnation = "two"
    await expect(
      f.call("start", { scope: f.scope, previewId: preview.id, requestId: "request" })
    ).rejects.toThrow("CONTEXT_CHANGED")
    expect(state.start).not.toHaveBeenCalled()
  })
  it("binds read, cancellation and approval to the owned project and original stage receipt", async () => {
    const f = fixture()
    state.run = {
      id: "run",
      definition: f.definition,
      version: 3,
      units: [{ id: "first", status: "waiting-approval" }]
    }
    await expect(f.call("read", { scope: f.scope, runId: "run" })).resolves.toMatchObject({
      id: "run"
    })
    await expect(
      f.call("waitingApproval", { scope: f.scope, runId: "run" })
    ).resolves.toMatchObject({ checks: ["original-check"], operationVersion: 2 })
    await f.call("approve", {
      scope: f.scope,
      runId: "run",
      unitId: "first",
      operationId: "operation",
      expectedVersion: 2,
      inputFingerprint: "a".repeat(64),
      decision: "approved",
      actorId: "forged"
    })
    expect(state.approve).toHaveBeenCalledWith("run", "first", "operation", {
      expectedVersion: 2,
      inputFingerprint: "a".repeat(64),
      decision: "approved",
      actorId: "desktop-user"
    })
    state.enabled = false
    await f.call("cancel", { scope: f.scope, runId: "run", expectedVersion: 3 })
    expect(state.cancel).toHaveBeenCalledWith("run")
    state.run.definition = { ...f.definition, parentProjectId: "different" }
    await expect(f.call("read", { scope: f.scope, runId: "run" })).rejects.toThrow("SCOPE_CHANGED")
  })
})
