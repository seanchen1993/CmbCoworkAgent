import { describe, expect, it, vi } from "vitest"
import { ApprovalDecisionBroker } from "../../agent/approval-decision-broker"
import type { ApprovalRequest } from "../../types"
import { CompositionToolApprovals } from "./composition-tool-approvals"

function fixture(operation: ApprovalRequest["operation"] = "write_file") {
  const broker = new ApprovalDecisionBroker()
  const resolve = vi.fn()
  broker.register({
    threadId: "internal",
    runtimeThreadId: "internal",
    request: {
      id: "request",
      tool_call: { id: "original-call", name: "write_file", args: {} },
      allowed_decisions: ["approve", "reject"],
      allowed_approval_types: ["approve", "reject"],
      safety_level: "needs_approval",
      operation,
      filePath: "result.md",
      cwd: "C:/owned-unit"
    },
    resolve
  })
  return { approvals: new CompositionToolApprovals(broker), broker, resolve }
}

describe("composition original tool approvals", () => {
  it("lists only the host-owned unit and resolves the exact original request once", () => {
    const f = fixture()
    expect(f.approvals.list([{ unitId: "other", threadIds: ["unrelated"] }])).toEqual([])
    expect(f.approvals.list([{ unitId: "one", threadIds: ["internal"] }])).toEqual([
      expect.objectContaining({ unitId: "one", requestId: "request", allow: true })
    ])
    const input = {
      requestId: "request",
      threadIds: ["internal"],
      decision: "allow" as const,
      webContentsId: 1
    }
    f.approvals.respond(input)
    expect(f.resolve).toHaveBeenCalledExactlyOnceWith({
      type: "approve",
      tool_call_id: "original-call"
    })
    expect(() => f.approvals.respond(input)).toThrow("CHANGED")
  })

  it("rejects cross-unit and persistent decisions without consuming the request", () => {
    const f = fixture()
    const input = {
      requestId: "request",
      threadIds: ["other"],
      decision: "deny" as const,
      webContentsId: 1
    }
    expect(() => f.approvals.respond(input)).toThrow("CHANGED")
    expect(() =>
      f.approvals.respond({
        ...input,
        threadIds: ["internal"],
        decision: "approve_permanent" as "allow"
      })
    ).toThrow("INVALID")
    expect(f.resolve).not.toHaveBeenCalled()
    f.approvals.respond({ ...input, threadIds: ["internal"] })
    expect(f.resolve).toHaveBeenCalledExactlyOnceWith({
      type: "reject",
      tool_call_id: "original-call"
    })
  })

  it.each(["git_commit", "git_push"] as const)(
    "does not invent renderer results for %s",
    (operation) => {
      const f = fixture(operation)
      expect(f.approvals.list([{ unitId: "one", threadIds: ["internal"] }])[0].allow).toBe(false)
      expect(() =>
        f.approvals.respond({
          requestId: "request",
          threadIds: ["internal"],
          decision: "allow",
          webContentsId: 1
        })
      ).toThrow("UNSUPPORTED")
      expect(f.resolve).not.toHaveBeenCalled()
    }
  )
})
