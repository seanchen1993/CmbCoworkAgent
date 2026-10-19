import { EventEmitter } from "node:events"
import { beforeEach, expect, it, vi } from "vitest"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { ModsManager } from "../mods/manager"
import type { FunctionModsManager } from "../mods/v2/manager"
import { assertOrdinaryFlowMetadata, registerModsFlowHandlers } from "./mods-flows"
import { FlowStore } from "../mods/flows/store"
import { FlowManager } from "../mods/flows/manager"

const state = vi.hoisted(() => ({
  metadata: {} as Record<string, unknown>,
  present: true,
  mcp: vi.fn(async () => []),
  skills: vi.fn(async () => []),
  featureOpen: vi.fn(),
  featureRead: vi.fn(),
  featureClose: vi.fn(async () => undefined)
}))
vi.mock("../mods/claw-skills", () => ({ listClawSkillSources: state.skills }))
vi.mock("../mods/flows/native-mcp", () => ({ listNativeMcpTools: state.mcp }))
vi.mock("../db", () => ({
  getThreadCore: () =>
    state.present ? { created_at: 1, metadata: JSON.stringify(state.metadata) } : undefined
}))
vi.mock("../mods/flows/native-host", () => ({
  NativeFlowHost: class {
    constructor(
      private manager: { isEnabled(): boolean },
      _functions: unknown,
      private access: { scope(id: string): string }
    ) {}
    assertScope(workspace: string, id: string) {
      if (this.access.scope(id) !== workspace) throw Error("scope")
      if (!this.manager.isEnabled()) throw Error("MODS_DISABLED")
    }
    changed() {
      return undefined
    }
  }
}))
vi.mock("../agent/agent-registry", () => ({ loadAgentProfilesAsync: async () => [] }))
vi.mock("../models/registry", () => ({ getModelConfigs: () => [] }))
vi.mock("../services/stable-file-handle", () => ({
  openStableFileHandle: state.featureOpen,
  readStableFileHandleBounded: state.featureRead
}))

beforeEach(() => {
  vi.restoreAllMocks()
  state.metadata = { workspacePath: "project" }
  state.present = true
  state.mcp.mockReset().mockResolvedValue([])
  state.skills.mockReset().mockResolvedValue([])
  state.featureOpen.mockReset().mockRejectedValue(Object.assign(Error("missing"), { code: "ENOENT" }))
  state.featureRead.mockReset()
  state.featureClose.mockClear()
})
it("requires a trusted exact resume payload and a lowercase SHA256 source digest", async () => {
  const f = fixture()
  const resume = vi
    .spyOn(FlowManager.prototype, "resume")
    .mockResolvedValue({ id: "child" } as never)
  const valid = { threadId: "thread", runId: "run", expectedSourceDigest: "a".repeat(64) }
  for (const input of [
    null,
    [],
    "run",
    {},
    { ...valid, prefix: [] },
    { ...valid, expectedSourceDigest: "A".repeat(64) },
    { ...valid, expectedSourceDigest: "a".repeat(63) },
    { ...valid, expectedSourceDigest: "a".repeat(65) },
    { ...valid, expectedSourceDigest: "g".repeat(64) },
    { ...valid, runId: "" }
  ]) {
    await expect(f.call("resume", input)).rejects.toThrow()
  }
  await expect(f.call("resume", valid, {} as IpcMainInvokeEvent)).rejects.toThrow("MODS_IPC_SENDER")
  expect(resume).not.toHaveBeenCalled()
  expect(await f.call("resume", valid)).toEqual({ id: "child" })
  expect(resume).toHaveBeenCalledExactlyOnceWith(
    "project",
    "thread",
    "run",
    valid.expectedSourceDigest
  )
})

it("rejects cross-scope resume replies and forwards host failures without a new start", async () => {
  const f = fixture()
  const start = vi.spyOn(FlowManager.prototype, "start")
  const resume = vi.spyOn(FlowManager.prototype, "resume").mockImplementation(async () => {
    state.metadata.workspacePath = "other"
    return { id: "child" } as never
  })
  const payload = { threadId: "thread", runId: "run", expectedSourceDigest: "a".repeat(64) }
  await expect(f.call("resume", payload)).rejects.toThrow("FLOW_SCOPE_CHANGED")
  state.metadata = { workspacePath: "project", harnessFeature: "feature" }
  await expect(f.call("resume", payload)).rejects.toThrow()
  expect(resume).toHaveBeenCalledTimes(1)
  state.metadata = { workspacePath: "project" }
  resume.mockRejectedValueOnce(Error("FLOW_RECOVERY_STALE"))
  await expect(f.call("resume", payload)).rejects.toThrow("FLOW_RECOVERY_STALE")
  expect(start).not.toHaveBeenCalled()
})
const definition = {
  schemaVersion: 1,
  id: "demo",
  name: "Demo",
  plugin: "plugin",
  goal: "Work",
  timeoutMs: 10000,
  maxExecutions: 32,
  steps: [{ id: "a", name: "A", enabled: true, kind: "agent", prompt: "work" }]
}

it("does not save a repaired flow into a project different from the reviewed workspace", () => {
  const f = fixture()
  expect(() =>
    f.call("save", {
      threadId: "thread",
      definition,
      expectedRevision: 0,
      expectedWorkspace: "other-project"
    })
  ).toThrow("FLOW_SCOPE_CHANGED")
  expect(f.store.setSetting).not.toHaveBeenCalled()
})

it("diagnoses interrupted history through trusted IPC without mutating records", async () => {
  const f = fixture()
  vi.mocked(f.manager.isEnabled).mockReturnValue(true)
  const flowStore = new FlowStore(f.store)
  const flow = flowStore.save("project", definition, 0)
  flowStore.put({
    id: "run",
    workspace: "project",
    threadId: "thread",
    flow,
    status: "running",
    startedAt: 1,
    epoch: 0,
    attempts: [],
    failureCounts: {}
  })
  f.store.setSetting.mockClear()
  const result = await f.call("recovery", { threadId: "thread", runId: "run" })
  expect(result).toMatchObject({ schemaVersion: 1, runId: "run", status: "blocked" })
  expect(flowStore.run("project", "thread", "run")?.status).toBe("running")
  expect(f.store.setSetting).not.toHaveBeenCalled()
  expect(f.functions.status).not.toHaveBeenCalled()
  expect(state.mcp).not.toHaveBeenCalled()
  await expect(
    f.call("recovery", { threadId: "thread", runId: "run" }, {} as IpcMainInvokeEvent)
  ).rejects.toThrow("MODS_IPC_SENDER")
  await expect(f.call("recovery", { threadId: "thread", runId: "x".repeat(201) })).rejects.toThrow(
    "FLOW_ID_INVALID"
  )
  await expect(f.call("recovery", { threadId: "other", runId: "run" })).rejects.toThrow(
    "FLOW_RUN_MISSING"
  )
})

function fixture(ownerScope?: (threadId: string) => string) {
  const entries = new Map<string, string>()
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
  const webContents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false })
  const sender = {
    sender: webContents,
    senderFrame: webContents.mainFrame
  } as unknown as IpcMainInvokeEvent
  const store = {
    completionEvidenceByIds: vi.fn(
      (_workspace: string, _threadId: string, _runId: string, ids: readonly string[]) => ({
        records: [],
        missingIds: [...ids],
        invalidIds: [],
        limitedIds: []
      })
    ),
    getSetting: (key: string, fallback = "") => entries.get(key) ?? fallback,
    setSetting: vi.fn((key: string, value: string) => entries.set(key, value)),
    grant: vi.fn(),
    revoke: vi.fn()
  }
  const manager = {
    store,
    isEnabled: vi.fn(() => false),
    publish: async (_workspace: string, value: unknown) => value
  } as unknown as ModsManager
  const functions = {
    status: vi.fn(async () => []),
    effectiveStatus: vi.fn(async () => []),
    actionCatalog: vi.fn(async () => []),
    setCompletionPolicy: vi.fn()
  } as unknown as FunctionModsManager
  registerModsFlowHandlers(
    {
      handle: (channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown) =>
        handlers.set(channel, handler)
    } as unknown as IpcMain,
    manager,
    functions,
    {
      trusted: (event) => {
        if (event !== sender) throw Error("MODS_IPC_SENDER")
      },
      threadScope: ownerScope ?? (() => String(state.metadata.workspacePath)),
      changed: vi.fn()
    }
  )
  return {
    webContents,
    store,
    manager,
    functions,
    call: (channel: string, input: unknown, event = sender) =>
      handlers.get(`mods:flow-${channel}`)!(event, input)
  }
}

it("reads scoped historical evidence while Mods are off without repairing or preparing a run", () => {
  const f = fixture()
  const store = new FlowStore(f.store)
  const flow = store.save("project", definition, 0)
  store.put({
    id: "evidence-run",
    workspace: "project",
    threadId: "thread",
    flow,
    status: "running",
    startedAt: 1,
    epoch: 0,
    failureCounts: {},
    attempts: [
      {
        executionId: "attempt",
        stepId: "a",
        attempt: 1,
        epoch: 0,
        status: "passed",
        startedAt: 1,
        finishedAt: 2,
        result: {
          source: "native-check",
          passed: true,
          summary: "PRIVATE_DETAIL",
          evidenceIds: ["missing"]
        }
      }
    ]
  })
  f.store.setSetting.mockClear()
  const repair = vi.spyOn(FlowManager.prototype, "runs")
  const view = f.call("evidence", { threadId: "thread", runId: "evidence-run" })
  expect(view).toMatchObject({
    currentArtifacts: "not-rechecked",
    attempts: [{ checks: [{ id: "missing", state: "missing" }] }]
  })
  expect(JSON.stringify(view)).not.toContain("PRIVATE_DETAIL")
  expect(f.store.completionEvidenceByIds).toHaveBeenCalledExactlyOnceWith(
    "project",
    "thread",
    "evidence-run",
    ["missing"]
  )
  expect(f.store.setSetting).not.toHaveBeenCalled()
  expect(repair).not.toHaveBeenCalled()
  expect(store.run("project", "thread", "evidence-run")?.status).toBe("running")
  expect(state.mcp).not.toHaveBeenCalled()
  expect(f.functions.status).not.toHaveBeenCalled()
  expect(() =>
    f.call("evidence", { threadId: "thread", runId: "evidence-run" }, {} as IpcMainInvokeEvent)
  ).toThrow("MODS_IPC_SENDER")
  expect(() => f.call("evidence", { threadId: "other", runId: "evidence-run" })).toThrow(
    "FLOW_RUN_MISSING"
  )
  for (const input of [
    null,
    [],
    {},
    { threadId: "thread", runId: "evidence-run", ids: ["foreign"] },
    { threadId: "thread", runId: "x".repeat(201) }
  ])
    expect(() => f.call("evidence", input)).toThrow()
  f.store.completionEvidenceByIds.mockImplementation(() => {
    state.metadata.workspacePath = "other"
    return { records: [], missingIds: [], invalidIds: [], limitedIds: [] }
  })
  expect(() => f.call("evidence", { threadId: "thread", runId: "evidence-run" })).toThrow(
    "FLOW_SCOPE_CHANGED"
  )
})

it("returns a fixed diagnostic for corrupt history without exposing the raw storage fragment", () => {
  const f = fixture()
  vi.spyOn(f.store, "getSetting").mockReturnValue("PRIVATE_HISTORY_FRAGMENT")
  expect(() => f.call("evidence", { threadId: "thread", runId: "run" })).toThrow(
    "FLOW_EVIDENCE_HISTORY_INVALID"
  )
  try {
    f.call("evidence", { threadId: "thread", runId: "run" })
  } catch (error) {
    expect(String(error)).not.toContain("PRIVATE_HISTORY_FRAGMENT")
  }
})

it("saves ordinary user definitions while off without granting plugins or changing application policy", async () => {
  const f = fixture()
  expect(f.call("save", { threadId: "thread", definition, expectedRevision: 0 })).toMatchObject({
    revision: 1
  })
  expect(f.call("list", "thread")).toHaveLength(1)
  expect(f.store.grant).not.toHaveBeenCalled()
  expect(f.functions.setCompletionPolicy).not.toHaveBeenCalled()
  await expect(
    f.call("start", { threadId: "thread", flowId: "demo", revision: 1 })
  ).rejects.toThrow("MODS_DISABLED")
  expect(await f.call("catalog", "thread")).toMatchObject({
    available: true,
    hostAvailable: false,
    reason: "请先开启灵件功能；使用内置流程无需另装灵件。"
  })
})

it("checks trusted IPC sender before any saved state can be written", () => {
  const f = fixture()
  expect(() =>
    f.call(
      "save",
      { threadId: "thread", definition, expectedRevision: 0 },
      {} as IpcMainInvokeEvent
    )
  ).toThrow("MODS_IPC_SENDER")
  expect(f.store.setSetting).not.toHaveBeenCalled()
})

it("discovers workspace candidates once without restricting discovery to the current Claw", async () => {
  const f = fixture()
  vi.mocked(f.manager.isEnabled).mockReturnValue(true)
  expect(await f.call("catalog", "thread")).toMatchObject({ hostAvailable: true, plugins: [] })
  expect(f.functions.status).toHaveBeenCalledExactlyOnceWith("project")
  expect(f.functions.effectiveStatus).not.toHaveBeenCalled()
  expect(f.functions.actionCatalog).toHaveBeenCalledExactlyOnceWith("project", "thread", [])
  expect(state.mcp).not.toHaveBeenCalled()
})

it("keeps ordinary flow discovery available when optional business state is invalid", async () => {
  const f = fixture()
  vi.mocked(f.manager.isEnabled).mockReturnValue(true)
  state.featureOpen.mockResolvedValue({ handle: { close: state.featureClose } })
  state.featureRead.mockResolvedValue(Buffer.from("PRIVATE_INVALID_STATE"))
  const catalog = await f.call("catalog", "thread")
  expect(catalog).toMatchObject({
    available: true,
    hostAvailable: true,
    features: [],
    diagnostics: [{ code: "OPTIONAL_FLOW_CATALOG_UNAVAILABLE" }]
  })
  expect(f.functions.actionCatalog).toHaveBeenCalledExactlyOnceWith("project", "thread", [])
  expect(state.featureClose).toHaveBeenCalledOnce()
  expect(JSON.stringify(catalog)).not.toContain("PRIVATE_INVALID_STATE")
  expect(f.store.grant).not.toHaveBeenCalled()
})

it("does not hide a changed catalog scope behind optional discovery recovery", async () => {
  const f = fixture()
  state.featureOpen.mockResolvedValue({ handle: { close: state.featureClose } })
  state.featureRead.mockImplementation(async () => {
    state.metadata.workspacePath = "other"
    throw Error("optional read failed")
  })
  await expect(f.call("catalog", "thread")).rejects.toThrow("FLOW_SCOPE_CHANGED")
  expect(f.functions.actionCatalog).not.toHaveBeenCalled()
  expect(f.store.grant).not.toHaveBeenCalled()
})

it("requires explicit enabled and trusted MCP discovery", async () => {
  const f = fixture()
  await expect(f.call("mcp-tools", "thread")).rejects.toThrow("MODS_DISABLED")
  expect(state.mcp).not.toHaveBeenCalled()
  vi.mocked(f.manager.isEnabled).mockReturnValue(true)
  await expect(f.call("mcp-tools", "thread", {} as IpcMainInvokeEvent)).rejects.toThrow(
    "MODS_IPC_SENDER"
  )
  expect(state.mcp).not.toHaveBeenCalled()
  expect(await f.call("mcp-tools", "thread")).toEqual([])
  expect(state.mcp).toHaveBeenCalledOnce()
})

it("rejects late tool discovery after thread incarnation changes", async () => {
  const f = fixture()
  vi.mocked(f.manager.isEnabled).mockReturnValue(true)
  state.mcp.mockImplementationOnce(async () => {
    state.metadata.cmb_thread_incarnation = "replacement"
    return []
  })
  await expect(f.call("mcp-tools", "thread")).rejects.toThrow("FLOW_SCOPE_CHANGED")
})

it("rejects late tool discovery after the same thread switches Claw binding", async () => {
  const f = fixture()
  vi.mocked(f.manager.isEnabled).mockReturnValue(true)
  state.mcp.mockImplementationOnce(async () => {
    const { ClawStore } = await import("../mods/claw-store")
    new ClawStore(f.store).apply("project", JSON.stringify(["thread", "legacy"]), null, 0)
    return []
  })
  await expect(f.call("mcp-tools", "thread")).rejects.toThrow("FLOW_SCOPE_CHANGED")
})

it.each([
  { agentMode: "workflow" },
  { agentMode: "coordinator" },
  { harnessFeature: {} },
  { harnessProjectSession: {} },
  { parentThreadId: "parent" },
  { remoteThread: true },
  { targetKind: "thread" },
  { remoteState: "suspended" },
  { scheduledTaskId: "job" },
  { isHeartbeat: true },
  { workflowRunId: "workflow" },
  { imDeliveryContext: {} }
])("rejects unsupported contexts: %j", (metadata) => {
  expect(() => assertOrdinaryFlowMetadata(metadata)).toThrow("普通本地项目")
  const f = fixture()
  state.metadata = { workspacePath: "project", ...metadata }
  expect(() => f.call("list", "thread")).toThrow("普通本地项目")
})

it("rejects deleted threads and malformed revision/decision inputs", () => {
  const f = fixture()
  expect(() => f.call("save", { threadId: "thread", definition, expectedRevision: -1 })).toThrow(
    "FLOW_REVISION_INVALID"
  )
  expect(() =>
    f.call("decide", { threadId: "thread", runId: "run", nonce: "n", approve: "yes" })
  ).toThrow("FLOW_DECISION_INVALID")
  state.present = false
  expect(() => f.call("list", "thread")).toThrow("MODS_THREAD_MISSING")
})

it("permits host workflows when the project has no Function Mod capability", async () => {
  const f = fixture()
  vi.mocked(f.manager.isEnabled).mockReturnValue(true)
  expect(await f.call("catalog", "thread")).toMatchObject({
    hostAvailable: true,
    plugins: []
  })
  expect(await f.call("catalog", "thread")).not.toHaveProperty("reason")
})

it("explicit reviewed workspace rejects same-name Flow in another project before start", () => {
  const f = fixture()
  const start = vi.spyOn(FlowManager.prototype, "start")
  expect(() =>
    f.call("start", {
      threadId: "thread",
      flowId: "demo",
      revision: 1,
      expectedWorkspace: "previous-project"
    })
  ).toThrow("FLOW_SCOPE_CHANGED")
  expect(start).not.toHaveBeenCalled()
})

it.each(["workspace", "incarnation", "frame", "navigation"])(
  "explicit Flow start carries a live %s fence through delayed execution and cleans listeners",
  async (mode) => {
    const f = fixture()
    let guard!: () => void
    let finish!: () => void
    const drained = new Promise<void>((resolve) => {
      finish = resolve
    })
    vi.spyOn(FlowManager.prototype, "waitForSettlement").mockReturnValue(drained)
    vi.spyOn(FlowManager.prototype, "start").mockImplementation(
      async (_w, _t, _id, _rev, _task, assertCurrent) => {
        guard = assertCurrent!
        guard()
        return { id: "queued-run" } as never
      }
    )
    await f.call("start", {
      threadId: "thread",
      flowId: "demo",
      revision: 1,
      expectedWorkspace: "project"
    })
    expect(f.webContents.listenerCount("did-start-navigation")).toBe(1)
    if (mode === "workspace") state.metadata.workspacePath = "other"
    if (mode === "incarnation") state.metadata.cmb_thread_incarnation = "replacement"
    if (mode === "frame") f.webContents.mainFrame = {}
    if (mode === "navigation") f.webContents.emit("did-start-navigation", { isMainFrame: true })
    expect(guard).toThrow("FLOW_SCOPE_CHANGED")
    finish()
    await Promise.resolve()
    await Promise.resolve()
    expect(f.webContents.listenerCount("did-start-navigation")).toBe(0)
  }
)


it("returns a scope-checked active summary without exposing the task or mutating runs", () => {
  const f = fixture()
  const summary = {runId: "active", threadId: "owner", flowName: "Review", status: "waiting" as const}
  const read = vi.spyOn(FlowManager.prototype, "activeSummary").mockReturnValue(summary)
  expect(f.call("active", "thread")).toEqual(summary)
  expect(read).toHaveBeenCalledWith("project", "thread")
  expect(f.store.setSetting).not.toHaveBeenCalled()
  expect(() => f.call("active", "thread", {} as IpcMainInvokeEvent)).toThrow("MODS_IPC_SENDER")
  read.mockImplementation(() => { state.present = false; return summary })
  expect(() => f.call("active", "thread")).toThrow()
})

it("rejects an active owner whose workspace changed and returns null when no owner exists", () => {
  const f = fixture(id => id === "owner" ? "foreign" : "project")
  const read = vi.spyOn(FlowManager.prototype, "activeSummary").mockReturnValue({
    runId: "active", threadId: "owner", flowName: "Review", status: "waiting"
  })
  expect(() => f.call("active", "thread")).toThrow("FLOW_SCOPE_CHANGED")
  read.mockReturnValue(null)
  expect(f.call("active", "thread")).toBeNull()
})
