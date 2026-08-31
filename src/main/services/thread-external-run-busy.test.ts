import { beforeEach, describe, expect, it, vi } from "vitest"

const ownerMocks = vi.hoisted(() => ({
  hasActiveBackgroundTasks: vi.fn<(threadId: string) => boolean>(),
  isChatXThreadRunning: vi.fn<(threadId: string) => boolean>(),
  isHeartbeatRunning: vi.fn<() => boolean>(),
  isTaskRunning: vi.fn<(taskId: string) => boolean>()
}))

vi.mock("../agent/local-sandbox", () => ({
  LocalSandbox: {
    hasActiveBackgroundTasks: ownerMocks.hasActiveBackgroundTasks
  }
}))
vi.mock("./chatx", () => ({ isChatXThreadRunning: ownerMocks.isChatXThreadRunning }))
vi.mock("./heartbeat", () => ({ isHeartbeatRunning: ownerMocks.isHeartbeatRunning }))
vi.mock("./heartbeat-session", () => ({ HEARTBEAT_THREAD_ID: "heartbeat" }))
vi.mock("./scheduler", () => ({ isTaskRunning: ownerMocks.isTaskRunning }))

import { isExternallyManagedThreadRunBusy } from "./thread-external-run-busy"

describe("isExternallyManagedThreadRunBusy", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ownerMocks.hasActiveBackgroundTasks.mockReturnValue(false)
    ownerMocks.isChatXThreadRunning.mockReturnValue(false)
    ownerMocks.isHeartbeatRunning.mockReturnValue(false)
    ownerMocks.isTaskRunning.mockReturnValue(false)
  })

  it("blocks the exact thread owned by a ChatX run", () => {
    ownerMocks.isChatXThreadRunning.mockImplementation((threadId) => threadId === "chatx")

    expect(isExternallyManagedThreadRunBusy("chatx", {})).toBe(true)
    expect(isExternallyManagedThreadRunBusy("other", {})).toBe(false)
  })

  it("blocks only the fixed heartbeat thread while heartbeat is running", () => {
    ownerMocks.isHeartbeatRunning.mockReturnValue(true)

    expect(isExternallyManagedThreadRunBusy("heartbeat", {})).toBe(true)
    expect(isExternallyManagedThreadRunBusy("ordinary", { isHeartbeat: true })).toBe(false)
  })

  it("uses the persisted scheduled task id without treating invalid metadata as busy", () => {
    ownerMocks.isTaskRunning.mockImplementation((taskId) => taskId === "task-1")

    expect(
      isExternallyManagedThreadRunBusy("scheduled", { scheduledTaskId: " task-1 " })
    ).toBe(true)
    expect(isExternallyManagedThreadRunBusy("scheduled", { scheduledTaskId: 1 })).toBe(false)
    expect(ownerMocks.isTaskRunning).toHaveBeenCalledWith("task-1")
  })

  it("blocks a detached LocalSandbox command after the foreground turn has ended", () => {
    ownerMocks.hasActiveBackgroundTasks.mockImplementation(
      (threadId) => threadId === "background"
    )

    expect(isExternallyManagedThreadRunBusy("background", {})).toBe(true)
    expect(isExternallyManagedThreadRunBusy("idle", {})).toBe(false)
  })

  it("returns false when none of the external owners is active", () => {
    expect(
      isExternallyManagedThreadRunBusy("idle", { scheduledTaskId: "inactive-task" })
    ).toBe(false)
  })
})
