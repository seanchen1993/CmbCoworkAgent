import { describe, expect, it, vi } from "vitest"
import type { ThreadRow } from "../../db"

vi.mock("../../agent/coordinator-worker-manager", () => ({ coordinatorWorkerManager: {} }))
vi.mock("../../agent/workflow/run-manager", () => ({ workflowRunManager: {} }))
vi.mock("../../agent/runtime", () => ({ hasPendingApprovalForRuntimeThread: vi.fn() }))
vi.mock("../user-input", () => ({ hasPendingUserInputForRuntimeThread: vi.fn() }))
vi.mock("../../agent/standard-thread-turn", () => ({
  parseStandardThreadMetadata: (value: string) => {
    const metadata = JSON.parse(value)
    return { metadata, agentMode: metadata.agentMode, workspacePath: metadata.workspacePath }
  }
}))

import { readImThreadActivity } from "./thread-activity"

function fixture(agentMode = "normal") {
  const thread = {
    thread_id: "parent",
    status: "idle",
    metadata: JSON.stringify({ agentMode, workspacePath: "/workspace" })
  } as ThreadRow
  const dependencies = {
    lease: vi.fn(() => undefined),
    coordinator: {
      hasRunningWorkersForThread: vi.fn(() => false),
      hasTerminalWorkerAwaitingNotificationForThread: vi.fn(() => false),
      hasAutoRunnableNotifications: vi.fn(() => false)
    },
    workflow: {
      isActive: vi.fn(() => false),
      isBusyForThreadAsync: vi.fn(async () => false)
    },
    approval: vi.fn(() => false),
    userInput: vi.fn(() => false)
  }
  return { thread, dependencies }
}

describe("IM execution status with detached children", () => {
  it("reports Team work when the main thread is idle and has no lease", async () => {
    const { thread, dependencies } = fixture("coordinator")
    dependencies.coordinator.hasRunningWorkersForThread.mockReturnValue(true)
    expect(await readImThreadActivity(thread, false, dependencies)).toMatchObject({
      busy: true,
      label: "Team 子代理执行中"
    })
    expect(dependencies.coordinator.hasRunningWorkersForThread).toHaveBeenCalledWith("parent")
    expect(dependencies.workflow.isBusyForThreadAsync).not.toHaveBeenCalled()
  })

  it("reports active Workflow work without reading persisted history", async () => {
    const { thread, dependencies } = fixture("workflow")
    dependencies.workflow.isActive.mockReturnValue(true)
    expect(await readImThreadActivity(thread, false, dependencies)).toMatchObject({
      busy: true,
      label: "Workflow 子任务执行中"
    })
    expect(dependencies.workflow.isBusyForThreadAsync).not.toHaveBeenCalled()
  })

  it("keeps terminal child results pending until the parent can summarize", async () => {
    const team = fixture("coordinator")
    team.dependencies.coordinator.hasTerminalWorkerAwaitingNotificationForThread.mockReturnValue(
      true
    )
    expect((await readImThreadActivity(team.thread, false, team.dependencies)).label).toContain(
      "待汇总"
    )
    const workflow = fixture("workflow")
    workflow.dependencies.workflow.isBusyForThreadAsync.mockResolvedValue(true)
    expect(
      (await readImThreadActivity(workflow.thread, false, workflow.dependencies)).label
    ).toContain("待汇总")
    expect(workflow.dependencies.workflow.isBusyForThreadAsync).toHaveBeenCalledWith(
      "parent",
      "/workspace"
    )
  })

  it("surfaces a required answer or approval ahead of generic running status", async () => {
    const { thread, dependencies } = fixture("coordinator")
    dependencies.coordinator.hasRunningWorkersForThread.mockReturnValue(true)
    dependencies.userInput.mockReturnValue(true)
    expect(await readImThreadActivity(thread, true, dependencies)).toMatchObject({
      busy: true,
      label: expect.stringContaining("等待补充回答"),
      interaction: expect.any(String)
    })
    dependencies.approval.mockReturnValue(true)
    expect((await readImThreadActivity(thread, true, dependencies)).label).toContain("等待审批")
  })

  it("does not let a stale persisted busy flag override live idleness", async () => {
    const { thread, dependencies } = fixture()
    thread.status = "busy"
    expect(await readImThreadActivity(thread, false, dependencies)).toEqual({
      busy: false,
      label: "空闲",
      interaction: null
    })
  })
})
