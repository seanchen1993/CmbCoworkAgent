import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { beforeEach, expect, it, vi } from "vitest"
import type { HostProjectService } from "../harness-board/project-runtime/host-service"
import type { LegacyProjectRuntimeService } from "../harness-board/project-runtime/legacy-runtime-service"

const state = vi.hoisted(() => ({
  workflow: vi.fn(),
  flow: vi.fn(),
  background: vi.fn(),
  leases: vi.fn(),
  thread: vi.fn(),
  review: vi.fn(),
  listAdapters: vi.fn(),
  reviewAdapter: vi.fn(),
  resumeReview: vi.fn(),
  confirm: vi.fn()
}))
vi.mock("../agent/workflow/run-manager", () => ({
  workflowRunManager: {
    assertWorkspaceResourcesSettled: state.workflow
  }
}))
vi.mock("../harness-board/project-action-runtime", () => ({
  getProjectActionRuntime: () => ({
    flows: { assertWorkspaceResourcesSettled: state.flow }
  })
}))
vi.mock("../agent/local-sandbox", () => ({
  LocalSandbox: {
    hasActiveBackgroundTasksInWorkspace: state.background
  }
}))
vi.mock("../agent/thread-run-lease", () => ({ listLocalThreadRunLeases: state.leases }))
vi.mock("../db", () => ({ getThreadCore: state.thread }))
vi.mock("../harness-board/project-runtime/legacy-import-service", () => ({
  reviewImportStageEligibility: () => [],
  HostLegacyImportService: class {
    constructor(
      _legacy: unknown,
      _host: unknown,
      private deps: {
        authorize(...workspaces: string[]): Promise<{ assertCurrent(): void }>
      }
    ) {}
    async listAdapters(id: string) { return state.listAdapters(id) }
    async resumeReview(id: string) {
      const guard = await this.deps.authorize("C:/source", "C:/target")
      const review = state.resumeReview(id)
      guard.assertCurrent()
      return review
    }
    async reviewAdapter(input: unknown) {
      const guard = await this.deps.authorize("C:/source", "C:/target")
      state.reviewAdapter(input)
      guard.assertCurrent()
      return input
    }
    async review(input: unknown) {
      const guard = await this.deps.authorize("C:/source", "C:/target")
      state.review(input)
      guard.assertCurrent()
      return input
    }
    async confirm(input: unknown) {
      const guard = await this.deps.authorize("C:/source", "C:/target")
      state.confirm(input)
      guard.assertCurrent()
      return { projectId: "imported" }
    }
  }
}))
import { registerProjectImportHandlers } from "./project-runtime-import"

beforeEach(() => {
  vi.resetAllMocks()
  state.workflow.mockResolvedValue({ assertCurrent: vi.fn() })
  state.flow.mockReturnValue({ assertCurrent: vi.fn() })
  state.background.mockReturnValue(false)
  state.leases.mockReturnValue([])
  state.listAdapters.mockResolvedValue([])
})

function fixture() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const trusted = vi.fn()
  const source = { projectId: "old", packageId: "plugin", workspace: "C:/source", frozen: false }
  const listImportSources = vi.fn(() => [source])
  const assertCurrent = vi.fn()
  const reviewImportTarget = vi.fn(async () => ({
    assertCurrent,
    snapshot: {
      manifest: { stages: [], artifacts: [] }
    }
  }))
  const view = vi.fn(() => ({ project: { projectId: "imported" }, operations: [] }))
  registerProjectImportHandlers(
    {
      handle: (name: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(name, handler)
      }
    } as unknown as IpcMain,
    {
      trusted,
      legacy: { listImportSources } as unknown as LegacyProjectRuntimeService,
      host: () => ({ reviewImportTarget }) as unknown as HostProjectService,
      view: view as never
    }
  )
  const invoke = (name: string, input?: unknown) =>
    handlers.get(`project-runtime:import-${name}`)!({} as IpcMainInvokeEvent, input)
  return { invoke, trusted, listImportSources, assertCurrent, reviewImportTarget, view }
}

it("rejects an untrusted renderer before reading source or touching an import", async () => {
  const f = fixture()
  f.trusted.mockImplementation(() => {
    throw Error("untrusted")
  })
  expect(() => f.invoke("sources")).toThrow("untrusted")
  await expect(f.invoke("review", {})).rejects.toThrow("untrusted")
  await expect(f.invoke("review-adapter", {})).rejects.toThrow("untrusted")
  await expect(f.invoke("resume-review", "old")).rejects.toThrow("untrusted")
  await expect(f.invoke("confirm", {})).rejects.toThrow("untrusted")
  expect(f.listImportSources).not.toHaveBeenCalled()
  expect(state.workflow).not.toHaveBeenCalled()
})

it("resumes only the persisted review through source guards without accepting renderer mappings", async () => {
  const f = fixture()
  const saved = { target: { projectId: "original-target" }, reviewDigest: "original-review" }
  state.resumeReview.mockReturnValue(saved)
  await expect(f.invoke("resume-review", "old")).resolves.toEqual(saved)
  expect(state.resumeReview).toHaveBeenCalledExactlyOnceWith("old")
  expect(state.workflow.mock.calls).toEqual([["C:/source"], ["C:/target"]])
  state.resumeReview.mockImplementation(() => { throw Error("PROJECT_HOST_IMPORT_SOURCE_CHANGED") })
  await expect(f.invoke("resume-review", "old")).rejects.toThrow("IMPORT_SOURCE_CHANGED")
  expect(state.confirm).not.toHaveBeenCalled()
})

it("publishes adapter descriptions only after target and renderer authority are rechecked", async () => {
  const f = fixture()
  const adapters = [{ id: "legacy-records", title: "从原记录导入", parameters: [{ id: "feature", label: "特性编号" }] }]
  state.listAdapters.mockResolvedValue(adapters)
  await expect(f.invoke("target", "installed")).resolves.toEqual({ stages: [], adapters })
  expect(state.listAdapters).toHaveBeenCalledExactlyOnceWith("installed")
  state.listAdapters.mockImplementation(async () => {
    f.trusted.mockImplementation(() => { throw Error("renderer replaced") })
    return adapters
  })
  await expect(f.invoke("target", "installed")).rejects.toThrow("renderer replaced")
})

it("adapter review uses the original workspace guards and rechecks authority before publication", async () => {
  const f = fixture()
  const input = { sourceProjectId: "old", adapterId: "legacy-records", parameters: { feature: "one" } }
  await expect(f.invoke("review-adapter", input)).resolves.toEqual(input)
  expect(state.reviewAdapter).toHaveBeenCalledExactlyOnceWith(input)
  expect(state.workflow.mock.calls).toEqual([["C:/source"], ["C:/target"]])
  state.reviewAdapter.mockImplementation(() => {
    f.trusted.mockImplementation(() => { throw Error("renderer replaced") })
  })
  await expect(f.invoke("review-adapter", input)).rejects.toThrow("renderer replaced")
  expect(state.confirm).not.toHaveBeenCalled()
})

it("reads the original registry and rechecks target identity after async resolution", async () => {
  const f = fixture()
  expect(f.invoke("sources")).toEqual(f.listImportSources.mock.results[0].value)
  f.assertCurrent.mockImplementation(() => {
    throw Error("changed target")
  })
  await expect(f.invoke("target", "installed")).rejects.toThrow("changed target")
  expect(f.reviewImportTarget).toHaveBeenCalledWith("installed")
  expect(state.confirm).not.toHaveBeenCalled()
})

it("checks original workflow, Flow and background work in both workspaces", async () => {
  const f = fixture()
  state.background.mockImplementation((path) => path === "C:/source")
  await expect(f.invoke("review", {})).rejects.toThrow("PROJECT_BACKGROUND_TASKS_ACTIVE")
  expect(state.workflow.mock.calls).toEqual([["C:/source"], ["C:/target"]])
  expect(state.flow.mock.calls).toEqual([["C:/source"], ["C:/target"]])
  expect(state.review).not.toHaveBeenCalled()
})

it("blocks another active thread in a nested target workspace", async () => {
  const f = fixture()
  state.leases.mockReturnValue([{ threadId: "another" }])
  state.thread.mockReturnValue({ metadata: JSON.stringify({ workspacePath: "C:/target/nested" }) })
  await expect(f.invoke("confirm", {})).rejects.toThrow("PROJECT_WORKSPACE_BUSY")
  expect(state.confirm).not.toHaveBeenCalled()
})

it("rechecks native authority and resource guards after review and publishes only service state", async () => {
  const f = fixture()
  const guard = vi.fn()
  state.workflow.mockResolvedValue({ assertCurrent: guard })
  await f.invoke("confirm", { reviewDigest: "reviewed" })
  expect(state.confirm).toHaveBeenCalledExactlyOnceWith({ reviewDigest: "reviewed" })
  expect(guard).toHaveBeenCalledTimes(4)
  expect(f.trusted).toHaveBeenCalledTimes(4)
  expect(f.view).toHaveBeenCalledExactlyOnceWith("imported")
})
