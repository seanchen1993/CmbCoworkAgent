import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  hasUnsettledWorkspaceShell,
  registerWorkspaceShell,
  tryAcquireWorkspaceAutoCommit
} from "./shell-auto-commit-lock"

describe("Bash and auto-commit admission", () => {
  it("skips Git admission until all overlapping shell lifetimes settle", () => {
    const workspace = path.resolve("workspace")
    const unrelated = path.resolve("unrelated")
    const first = registerWorkspaceShell(workspace)
    const second = registerWorkspaceShell(path.join(workspace, "nested"))
    try {
      expect(first.blockedByAutoCommit).toBeUndefined()
      expect(second.blockedByAutoCommit).toBeUndefined()
      expect(hasUnsettledWorkspaceShell(workspace)).toBe(true)
      expect(tryAcquireWorkspaceAutoCommit(workspace)).toBeUndefined()
      const releaseUnrelated = tryAcquireWorkspaceAutoCommit(unrelated)
      expect(releaseUnrelated).toBeTypeOf("function")
      releaseUnrelated?.()
    } finally {
      first.release()
      second.release()
    }

    expect(hasUnsettledWorkspaceShell(workspace)).toBe(false)
    const release = tryAcquireWorkspaceAutoCommit(workspace)
    expect(release).toBeTypeOf("function")
    release?.()
  })

  it("admits new Bash only after an already admitted Git write settles", async () => {
    const workspace = path.resolve("workspace")
    const releaseGit = tryAcquireWorkspaceAutoCommit(workspace)
    expect(releaseGit).toBeTypeOf("function")
    const shell = registerWorkspaceShell(path.join(workspace, "nested"))
    const admitted = vi.fn()
    try {
      expect(shell.blockedByAutoCommit).toBeInstanceOf(Promise)
      void shell.blockedByAutoCommit?.then(admitted)
      await Promise.resolve()
      expect(admitted).not.toHaveBeenCalled()
    } finally {
      releaseGit?.()
    }

    try {
      await shell.blockedByAutoCommit
      expect(admitted).toHaveBeenCalledOnce()
      expect(tryAcquireWorkspaceAutoCommit(workspace)).toBeUndefined()
    } finally {
      shell.release()
    }
  })
})
