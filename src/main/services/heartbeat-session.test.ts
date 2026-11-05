import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  retire: vi.fn(),
  purgeParent: vi.fn(),
  purgeWorkers: vi.fn(),
  purgeWorkflow: vi.fn(),
  deleteManaged: vi.fn(),
  deleteDbThread: vi.fn()
}))

vi.mock("../agent/runtime", () => ({ retireThreadCheckpointers: mocks.retire }))
vi.mock("../storage", () => ({
  purgeThreadCheckpointArtifacts: mocks.purgeParent,
  deleteThreadWorkerCheckpoints: mocks.purgeWorkers,
  deleteThreadWorkflowCheckpoints: mocks.purgeWorkflow
}))
vi.mock("../agent/context-history-path", () => ({
  deleteProjectThreadDataDirectory: mocks.deleteManaged
}))
vi.mock("../db", () => ({ deleteThread: mocks.deleteDbThread }))

import { HEARTBEAT_THREAD_ID, resetHeartbeatSessionForWorkspaceChange } from "./heartbeat-session"

describe("heartbeat workspace session reset", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.retire.mockResolvedValue(undefined)
    mocks.deleteManaged.mockResolvedValue(undefined)
  })

  it("retires the fixed-id checkpoint before deleting its old workspace artifacts and DB row", async () => {
    await resetHeartbeatSessionForWorkspaceChange("/workspace/old")

    expect(mocks.retire).toHaveBeenCalledWith(HEARTBEAT_THREAD_ID)
    expect(mocks.purgeParent).toHaveBeenCalledWith(HEARTBEAT_THREAD_ID)
    expect(mocks.purgeWorkers).toHaveBeenCalledWith(HEARTBEAT_THREAD_ID)
    expect(mocks.purgeWorkflow).toHaveBeenCalledWith(HEARTBEAT_THREAD_ID)
    expect(mocks.deleteManaged).toHaveBeenCalledWith("/workspace/old", HEARTBEAT_THREAD_ID)
    expect(mocks.deleteDbThread).toHaveBeenCalledWith(HEARTBEAT_THREAD_ID)
    expect(mocks.retire.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteManaged.mock.invocationCallOrder[0]
    )
    expect(mocks.deleteManaged.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteDbThread.mock.invocationCallOrder[0]
    )
  })

  it("keeps the DB row when managed-artifact cleanup fails", async () => {
    mocks.deleteManaged.mockRejectedValueOnce(new Error("cleanup failed"))

    await expect(resetHeartbeatSessionForWorkspaceChange("/workspace/old")).rejects.toThrow(
      "cleanup failed"
    )
    expect(mocks.deleteDbThread).not.toHaveBeenCalled()
  })
})
