import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { LatestRequestGate } from "./latest-request-gate"
import {
  bindThreadWorkspace,
  bindThreadWorktree,
  findCanonicalPersistedWorkspaceBindingConflict,
  findPersistedWorkspaceBindingConflict,
  matchesExpectedWorktreeIdentity,
  persistedWorkspaceBindingSnapshotEquals,
  resolveCreatedWorktreePublication,
  resolveWorkspaceMutationPublication,
  workspaceIdentityEquals
} from "./workspace-metadata"

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("workspace metadata identity", () => {
  it("finds another durable task binding using canonical workspace identity", () => {
    const bindings = [
      { threadId: "current", workspacePath: "C:\\repo\\main" },
      { threadId: "other", workspacePath: "C:\\Repo\\feature\\" }
    ]

    expect(
      findPersistedWorkspaceBindingConflict(bindings, "c:/repo/feature", "current")
    ).toEqual(bindings[1])
    expect(
      findPersistedWorkspaceBindingConflict(bindings, "C:/repo/main", "current")
    ).toBeNull()
    expect(findPersistedWorkspaceBindingConflict(bindings, null, "current")).toBeNull()
  })

  it("finds a durable binding through a junction or directory symlink alias", async () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-binding-alias-"))
    const target = join(root, "worktree")
    const alias = join(root, "worktree-alias")
    try {
      mkdirSync(target)
      symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir")
      const binding = { threadId: "other", workspacePath: alias }
      await expect(
        findCanonicalPersistedWorkspaceBindingConflict([binding], target)
      ).resolves.toBe(binding)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("fails closed when any durable binding path cannot be canonicalized", async () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-binding-missing-"))
    const target = join(root, "worktree")
    try {
      mkdirSync(target)
      await expect(
        findCanonicalPersistedWorkspaceBindingConflict(
          [{ threadId: "stale", workspacePath: join(root, "missing") }],
          target
        )
      ).rejects.toThrow(/cannot resolve task stale workspace/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("allows rollback identity checks before the attempted target directory exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-binding-rollback-"))
    const existingWorkspace = join(root, "existing")
    try {
      mkdirSync(existingWorkspace)
      await expect(
        findCanonicalPersistedWorkspaceBindingConflict(
          [{ threadId: "other", workspacePath: existingWorkspace }],
          join(root, "not-created-worktree"),
          undefined,
          { allowMissingTarget: true }
        )
      ).resolves.toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("fails closed when the bounded destructive binding scan is over capacity", async () => {
    await expect(
      findCanonicalPersistedWorkspaceBindingConflict(
        [
          { threadId: "a", workspacePath: "C:\\a" },
          { threadId: "b", workspacePath: "C:\\b" }
        ],
        "C:\\target",
        undefined,
        { maxBindings: 1 }
      )
    ).rejects.toThrow(/exceeds its 1-task limit/i)
  })

  it("detects a durable binding change after asynchronous canonicalization", () => {
    const before = [{ threadId: "thread", workspacePath: "C:\\repo-a" }]
    expect(persistedWorkspaceBindingSnapshotEquals(before, [...before])).toBe(true)
    expect(
      persistedWorkspaceBindingSnapshotEquals(before, [
        { threadId: "thread", workspacePath: "C:\\repo-b" }
      ])
    ).toBe(false)
  })

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

  it("returns the latest binding when watcher completion belongs to a stale intent", () => {
    expect(
      resolveWorkspaceMutationPublication(false, "C:\\repo-b", "C:\\repo-a")
    ).toEqual({ currentWorkspacePath: "C:\\repo-b", committed: false })
  })

  it("does not publish stale success when the newer intent has not committed yet", () => {
    expect(
      resolveWorkspaceMutationPublication(false, "C:\\repo-a", "C:\\repo-a")
    ).toEqual({ currentWorkspacePath: "C:\\repo-a", committed: false })
    expect(
      resolveWorkspaceMutationPublication(true, "C:\\repo-a\\", "c:/repo-a")
    ).toEqual({ currentWorkspacePath: "C:\\repo-a\\", committed: true })
  })

  it("rejects an old post-commit response when watcher startup loses the intent race", async () => {
    const gate = new LatestRequestGate()
    const watcher = deferred()
    let workspacePath = "C:\\initial"

    const oldGeneration = gate.begin("thread")
    workspacePath = "C:\\repo-a"
    const oldResponse = (async () => {
      await watcher.promise
      return resolveWorkspaceMutationPublication(
        gate.isCurrent("thread", oldGeneration),
        workspacePath,
        "C:\\repo-a"
      )
    })()

    const newerGeneration = gate.begin("thread")
    watcher.resolve()
    await expect(oldResponse).resolves.toEqual({
      currentWorkspacePath: "C:\\repo-a",
      committed: false
    })
    expect(gate.isCurrent("thread", newerGeneration)).toBe(true)
  })

  it("publishes a durable worktree after a newer picker intent is cancelled", async () => {
    const gate = new LatestRequestGate()
    const watcher = deferred()
    const metadata: Record<string, unknown> = { workspacePath: "C:\\repo" }
    const createGeneration = gate.begin("thread")
    bindThreadWorktree(metadata, {
      workspacePath: "C:\\repo-wt",
      gitRoot: "C:\\repo",
      branch: "latest/branch",
      baseBranch: "latest-main",
      baseCommit: "latest-base"
    })

    const createResponse = (async () => {
      await watcher.promise
      return resolveCreatedWorktreePublication(
        gate.isCurrent("thread", createGeneration),
        metadata,
        {
          workspacePath: "c:/REPO-WT/",
          gitRoot: "C:\\repo",
          branch: "stale/branch",
          baseBranch: "stale-main",
          baseCommit: "stale-base"
        }
      )
    })()

    const cancelledPickerGeneration = gate.begin("thread")
    gate.finish("thread", cancelledPickerGeneration)
    expect(gate.isCurrent("thread", createGeneration)).toBe(false)
    watcher.resolve()

    await expect(createResponse).resolves.toEqual({
      durablyBound: true,
      superseded: true,
      path: "C:\\repo-wt",
      branch: "latest/branch",
      baseBranch: "latest-main",
      baseCommit: "latest-base"
    })
  })

  it("marks a created checkout orphaned only after a newer path is durable", () => {
    expect(
      resolveCreatedWorktreePublication(
        false,
        { workspacePath: "C:\\repo-b" },
        {
          workspacePath: "C:\\repo-a",
          gitRoot: "C:\\repo",
          branch: "feature/a"
        }
      )
    ).toEqual({
      durablyBound: false,
      superseded: true,
      currentWorkspacePath: "C:\\repo-b"
    })
  })
})
