import { describe, expect, it } from "vitest"
import { assertWorktreeActionPayload } from "./workflow-worktree-payload"

describe("workflow worktree IPC payload", () => {
  it("accepts and normalizes the managed action shape", () => {
    expect(
      assertWorktreeActionPayload({
        threadId: "  thread-1  ",
        runId: "wf_abc123",
        worktreeId: "abc123-a1-1234abcd",
        action: "merge"
      })
    ).toEqual({
      threadId: "thread-1",
      runId: "wf_abc123",
      worktreeId: "abc123-a1-1234abcd",
      action: "merge"
    })
  })

  it.each([
    null,
    {},
    { threadId: " ", runId: "wf_abc123", worktreeId: "valid-id", action: "diff" },
    { threadId: "thread-1", runId: "../run", worktreeId: "valid-id", action: "diff" },
    { threadId: "thread-1", runId: "wf_abc123", worktreeId: "../escape", action: "diff" },
    { threadId: "thread-1", runId: "wf_abc123", worktreeId: "valid-id", action: "force" }
  ])("rejects malformed or expansive input %#", (payload) => {
    expect(() => assertWorktreeActionPayload(payload)).toThrow(TypeError)
  })
})
