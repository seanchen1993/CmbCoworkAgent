import { describe, expect, it } from "vitest"
import {
  bindThreadWorkspace,
  bindThreadWorktree,
  matchesExpectedWorktreeIdentity,
  workspaceIdentityEquals
} from "./workspace-metadata"

describe("workspace metadata identity", () => {
  it("treats equivalent Windows separators, casing, and trailing slashes as one workspace", () => {
    expect(workspaceIdentityEquals("C:\\Repo\\Task\\", "c:/repo/task")).toBe(true)
  })

  it("clears every old workspace-derived field when leaving a worktree", () => {
    const metadata: Record<string, unknown> = {
      workspacePath: "C:\\repo-wt-a",
      isWorktree: true,
      gitRoot: "C:\\repo",
      worktreeBranch: "feature/a",
      worktreeBaseBranch: "main",
      worktreeBaseCommit: "abc",
      gitContext: { workspacePath: "C:\\repo-wt-a" },
      cachedGitRoot: "C:\\repo",
      llmModifiedFiles: ["src/a.ts"],
      llmFileHistory: { "src/a.ts": [] },
      llmRecentlyRevertedFiles: ["src/b.ts"]
    }

    bindThreadWorkspace(metadata, "C:\\ordinary")

    expect(metadata).toEqual({ workspacePath: "C:\\ordinary" })
  })

  it("publishes path and worktree context together and rejects stale expected identities", () => {
    const metadata: Record<string, unknown> = { workspacePath: "C:\\repo" }
    bindThreadWorktree(metadata, {
      workspacePath: "C:\\repo-wt-feature",
      gitRoot: "C:\\repo",
      branch: "feature/test",
      baseBranch: "main",
      baseCommit: "abc"
    })

    expect(metadata).toMatchObject({
      workspacePath: "C:\\repo-wt-feature",
      isWorktree: true,
      gitRoot: "C:\\repo",
      worktreeBranch: "feature/test",
      worktreeBaseBranch: "main",
      worktreeBaseCommit: "abc"
    })
    expect(
      matchesExpectedWorktreeIdentity(metadata, {
        workspacePath: "C:\\other",
        gitRoot: "C:\\repo",
        branch: "feature/test"
      })
    ).toBe(false)
  })
})
