import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
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
vi.mock("../db", () => ({ createThread: mocks.create }))
vi.mock("../storage", () => ({ getOpenworkDir: () => "/unused" }))
vi.mock("../ipc/models", () => ({ getDefaultModel: () => null }))
vi.mock("../ipc/recent-workspace", () => ({ resolveRecentWorkspacePath: async () => "/recent" }))
vi.mock("../harness-board/service", () => ({
  requireHarnessFeatureWorkspace: mocks.resolve,
  buildHarnessFeatureAgentContext: async () => null,
  DEFAULT_HARNESS_REQUEST_USER_INPUT_CONFIG: {}
}))
import { createThreadService } from "./thread-service"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.resolve.mockResolvedValue("/feature")
})
describe("new thread workspace policy", () => {
  it("uses current feature configuration rather than a stale renderer path", async () => {
    await createThreadService({
      workspacePath: "/old",
      harnessFeature: { projectId: "p", slug: "f" }
    })
    expect(mocks.create).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ workspacePath: "/feature" })
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
    expect(mocks.create).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ workspacePath: "/confirmed" })
    )
  })
  it("leaves ordinary non-feature session defaults intact", async () => {
    await createThreadService()
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(mocks.create).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ workspacePath: "/recent" })
    )
  })
})
