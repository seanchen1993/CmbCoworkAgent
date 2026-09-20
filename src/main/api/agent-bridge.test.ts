import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApprovalRequest } from "../types"

const mocks = vi.hoisted(() => ({
  notifyRenderer: vi.fn()
}))

vi.mock("../renderer-notifications", () => ({ notifyRenderer: mocks.notifyRenderer }))
vi.mock("electron", () => ({ BrowserWindow: class {} }))
vi.mock("uuid", () => ({ v4: vi.fn(() => "uuid") }))
vi.mock("../services/thread-service", () => ({ createThreadService: vi.fn() }))
vi.mock("../ipc/agent", () => ({
  abortAgentRunForApi: vi.fn(),
  getAgentThreadActivity: vi.fn()
}))
vi.mock("../agent/agent-run-service", () => ({
  createBrowserWindowAgentRunDelivery: vi.fn(),
  startAgentRun: vi.fn()
}))
vi.mock("../agent/api-run-flags", () => ({
  setThreadYoloOverride: vi.fn(),
  setThreadSandboxDisabled: vi.fn()
}))
vi.mock("../db", () => ({
  getThread: vi.fn(),
  getThreadMessageCount: vi.fn(),
  getThreadMessages: vi.fn()
}))
import { apiDecideThreadApproval } from "./agent-bridge"
import { approvalDecisionBroker } from "../agent/approval-decision-broker"

const approvalIds = ["approval-a", "approval-owned-by-b", "approval-once"]

function registerApproval(id: string, threadId: string): ReturnType<typeof vi.fn> {
  const resolve = vi.fn()
  const request: ApprovalRequest = {
    id,
    operation: "write_file",
    safety_level: "needs_approval",
    cwd: "/workspace",
    reason: "write a test file",
    allowed_decisions: ["approve", "reject"],
    allowed_approval_types: ["approve", "reject"],
    tool_call: {
      id: `tool-${id}`,
      name: "write_file",
      args: { file_path: "/workspace/result.txt", content: "ok" }
    }
  }
  approvalDecisionBroker.register({
    request,
    threadId,
    runtimeThreadId: threadId,
    resolve
  })
  return resolve
}

describe("HTTP approval bridge", () => {
  beforeEach(() => {
    mocks.notifyRenderer.mockClear()
    for (const id of approvalIds) approvalDecisionBroker.unregister(id)
  })

  afterEach(() => {
    for (const id of approvalIds) approvalDecisionBroker.unregister(id)
  })

  it("closes the matching desktop approval card after a successful decision", () => {
    const resolve = registerApproval("approval-a", "thread-a")
    const result = apiDecideThreadApproval("thread-a", "approval-a", "approve")

    expect(result).toMatchObject({
      accepted: true,
      thread_id: "thread-a",
      approval_id: "approval-a",
      action: "approve"
    })
    expect(mocks.notifyRenderer).toHaveBeenCalledOnce()
    expect(mocks.notifyRenderer).toHaveBeenCalledWith("approval:resolved:thread-a", {
      requestId: "approval-a",
      decision: "approve"
    })
    expect(resolve).toHaveBeenCalledOnce()
    expect(approvalDecisionBroker.get("approval-a")).toBeNull()
  })

  it("rejects a cross-thread decision without consuming the approval", () => {
    const resolve = registerApproval("approval-owned-by-b", "thread-b")

    const result = apiDecideThreadApproval("thread-a", "approval-owned-by-b", "approve")

    expect(result).toMatchObject({
      accepted: false,
      status: 409,
      error: "approval_thread_mismatch"
    })
    expect(resolve).not.toHaveBeenCalled()
    expect(approvalDecisionBroker.get("approval-owned-by-b")).not.toBeNull()
    expect(mocks.notifyRenderer).not.toHaveBeenCalled()
  })

  it("consumes an approval exactly once", () => {
    const resolve = registerApproval("approval-once", "thread-a")

    const first = apiDecideThreadApproval("thread-a", "approval-once", "approve")
    const second = apiDecideThreadApproval("thread-a", "approval-once", "approve")

    expect(first).toMatchObject({ accepted: true })
    expect(second).toMatchObject({
      accepted: false,
      status: 404,
      error: "approval_not_found"
    })
    expect(resolve).toHaveBeenCalledOnce()
    expect(mocks.notifyRenderer).toHaveBeenCalledOnce()
  })
})
