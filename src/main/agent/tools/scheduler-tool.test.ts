import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  assertCanStart: vi.fn(),
  runHeartbeatNow: vi.fn()
}))

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock("../../storage", () => ({
  getScheduledTasks: vi.fn(() => []),
  upsertScheduledTask: vi.fn(),
  deleteScheduledTask: vi.fn(),
  setScheduledTaskEnabled: vi.fn(),
  getHeartbeatConfig: vi.fn(() => ({ enabled: true })),
  getTaskRunHistory: vi.fn(() => [])
}))
vi.mock("../../services/scheduler", () => ({
  runTaskNow: vi.fn(),
  isTaskRunning: vi.fn(() => false)
}))
vi.mock("../../services/heartbeat", () => ({
  runHeartbeatNow: mocks.runHeartbeatNow,
  isHeartbeatRunning: vi.fn(() => false),
  assertHeartbeatCanStart: mocks.assertCanStart
}))
vi.mock("../runtime", () => ({ getCheckpointer: vi.fn() }))

import { createSchedulerTool } from "./scheduler-tool"

describe("scheduler heartbeat wake", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.runHeartbeatNow.mockResolvedValue(undefined)
  })

  it("returns the heartbeat preflight rejection instead of reporting success", async () => {
    mocks.assertCanStart.mockImplementationOnce(() => {
      throw new Error("Heartbeat workspace is being changed; heartbeat cannot start.")
    })
    const scheduler = createSchedulerTool({ workspacePath: "/workspace" })

    const result = await scheduler.invoke({ action: "wake" })

    expect(result).toContain("Error: Heartbeat workspace is being changed")
    expect(mocks.runHeartbeatNow).not.toHaveBeenCalled()
  })

  it("keeps accepted wake requests asynchronous", async () => {
    const scheduler = createSchedulerTool({ workspacePath: "/workspace" })

    const result = await scheduler.invoke({ action: "wake" })

    expect(JSON.parse(result as string)).toMatchObject({ success: true })
    expect(mocks.runHeartbeatNow).toHaveBeenCalledTimes(1)
  })
})
