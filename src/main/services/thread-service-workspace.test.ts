import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  validate: vi.fn(async (workspace: string) => workspace),
  stage: vi.fn(),
  context: vi.fn(),
  prepare: vi.fn(
    async () =>
      undefined as
        | undefined
        | {
            workspacePath: string
            launchStage: { name: string; status: string } | null
            assertCurrent(): void
          }
  ),
  create: vi.fn((threadId: string, metadata: Record<string, unknown>) => ({
    thread_id: threadId,
    metadata: JSON.stringify(metadata),
    title: "test",
    created_at: Date.now(),
    updated_at: Date.now()
  }))
}))
vi.mock("electron-store", () => ({
  default: class {
    get() {
      return null
    }
  }
}))
vi.mock("./workspace-validation", () => ({ validateWorkspaceDirectory: mocks.validate }))
vi.mock("../db", () => ({ createThread: mocks.create }))
vi.mock("../storage", () => ({ getOpenworkDir: () => "/unused" }))
vi.mock("../ipc/models", () => ({ getDefaultModel: () => null }))
vi.mock("../ipc/recent-workspace", () => ({ resolveRecentWorkspacePath: async () => "/recent" }))
vi.mock("../harness-board/service", () => ({
  requireHarnessFeatureWorkspace: mocks.resolve,
  resolveHarnessFeatureCurrentStage: mocks.stage,
  buildHarnessFeatureAgentContext: mocks.context,
  prepareHarnessFeatureThreadSession: mocks.prepare,
  DEFAULT_HARNESS_REQUEST_USER_INPUT_CONFIG: {}
}))
import { createThreadService } from "./thread-service"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.resolve.mockResolvedValue("/feature")
  mocks.stage.mockResolvedValue({ name: "Dev-代码实现", status: "进行中" })
  mocks.context.mockResolvedValue(null)
  mocks.prepare.mockResolvedValue(undefined)
})
afterEach(() => vi.restoreAllMocks())
describe("new thread workspace policy", () => {
  it("preserves explicit multi mode while ordinary creation follows the plugin mode", async () => {
    mocks.context.mockResolvedValue({ agentConfig: { agentMode: "workflow" } })
    const metadata = { harnessFeature: { projectId: "p", slug: "f" } }
    await createThreadService({ ...metadata, agentMode: "normal", subagentsEnabled: true })
    expect(mocks.create).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ agentMode: "normal", subagentsEnabled: true })
    )
    await createThreadService(metadata)
    expect(mocks.create).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ agentMode: "workflow" })
    )
  })

  it("uses current feature configuration rather than a stale renderer path", async () => {
    await createThreadService({
      workspacePath: "/old",
      harnessFeature: { projectId: "p", slug: "f" }
    })
    expect(mocks.validate).toHaveBeenCalledWith("/feature")
    expect(mocks.create).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        workspacePath: "/feature",
        harnessFeature: expect.objectContaining({ launchStageName: "Dev-代码实现" })
      })
    )
  })
  it("rejects missing feature configuration before inserting any thread", async () => {
    mocks.resolve.mockRejectedValue(new Error("missing workspace"))
    await expect(
      createThreadService({ harnessFeature: { projectId: "p", slug: "f" } })
    ).rejects.toThrow("missing workspace")
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it("does not allow metadata alone to bypass the creation check", async () => {
    mocks.resolve.mockRejectedValue(new Error("missing workspace"))
    await expect(
      createThreadService({
        workspacePath: "/other",
        harnessFeature: { projectId: "p", slug: "f", runId: "run" }
      })
    ).rejects.toThrow()
  })
  it("preserves an existing managed run's confirmed workspace without requiring current configuration", async () => {
    mocks.resolve.mockRejectedValue(new Error("missing workspace"))
    await createThreadService(
      { workspacePath: "/confirmed", harnessFeature: { projectId: "p", slug: "f", runId: "run" } },
      { managedWorkspace: true }
    )
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.create).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ workspacePath: "/confirmed" })
    )
  })
  it("leaves ordinary non-feature session defaults intact", async () => {
    await createThreadService()
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.create).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ workspacePath: "/recent" })
    )
  })

  it("keeps a native discussion in the selected repository without creating Host execution metadata", async () => {
    const assertCurrent = vi.fn()
    mocks.prepare.mockResolvedValue({
      workspacePath: "/chosen-repository",
      launchStage: { name: "Native draft", status: "未开始" },
      assertCurrent
    })
    const thread = await createThreadService({
      workspacePath: "/stale-renderer-path",
      harnessFeature: { projectId: "native-project", slug: "request" }
    })
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(mocks.stage).not.toHaveBeenCalled()
    expect(mocks.validate).toHaveBeenCalledWith("/chosen-repository")
    expect(thread.metadata).toMatchObject({
      workspacePath: "/chosen-repository",
      harnessFeature: {
        projectId: "native-project",
        slug: "request",
        launchStageName: "Native draft"
      }
    })
    expect(thread.metadata?.hostProjectRuntime).toBeUndefined()
    expect(thread.metadata?.modsAgentRunId).toBeUndefined()
    expect((thread.metadata?.harnessFeature as Record<string, unknown>).runId).toBeUndefined()
    expect(assertCurrent).toHaveBeenCalledOnce()
    expect(assertCurrent.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.context.mock.invocationCallOrder[0]
    )
    expect(assertCurrent.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.create.mock.invocationCallOrder[0]
    )
  })

  it("does not swallow the native final guard when optional context loading fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.context.mockRejectedValue(new Error("Optional context failure"))
    mocks.prepare.mockResolvedValue({
      workspacePath: "/chosen-repository",
      launchStage: null,
      assertCurrent: () => {
        throw Error("HARNESS_NATIVE_BINDING_CHANGED")
      }
    })
    await expect(
      createThreadService({ harnessFeature: { projectId: "p", slug: "f" } })
    ).rejects.toThrow("HARNESS_NATIVE_BINDING_CHANGED")
    expect(mocks.stage).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it("rechecks a binding changed while asynchronous context loading was pending", async () => {
    let release!: (value: null) => void
    let current = true
    mocks.context.mockReturnValueOnce(
      new Promise<null>((resolve) => {
        release = resolve
      })
    )
    mocks.prepare.mockResolvedValue({
      workspacePath: "/chosen-repository",
      launchStage: null,
      assertCurrent: () => {
        if (!current) throw Error("HARNESS_NATIVE_PROJECT_CHANGED")
      }
    })
    const creating = createThreadService({ harnessFeature: { projectId: "p", slug: "f" } })
    await vi.waitFor(() => expect(mocks.context).toHaveBeenCalledOnce())
    current = false
    release(null)
    await expect(creating).rejects.toThrow("HARNESS_NATIVE_PROJECT_CHANGED")
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it("does not fall back to legacy configuration after a native binding preparation failure", async () => {
    mocks.prepare.mockRejectedValue(new Error("HARNESS_NATIVE_FEATURE_MISSING"))
    await expect(
      createThreadService({ harnessFeature: { projectId: "p", slug: "f" } })
    ).rejects.toThrow("HARNESS_NATIVE_FEATURE_MISSING")
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(mocks.stage).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })
})
