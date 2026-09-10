import { execFileSync } from "child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterAll, describe, expect, it } from "vitest"
import {
  discoverWorkspaceGitRepositories,
  resolveGitOperationPath
} from "./git-repository-discovery"

const roots: string[] = []

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t"
    }
  })
}

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "multi-repo-workspace-"))
  roots.push(workspace)
  return workspace
}

function initRepo(repoPath: string): void {
  mkdirSync(repoPath, { recursive: true })
  gitIn(repoPath, ["init", "-q"])
  writeFileSync(join(repoPath, "README.md"), "# test\n")
  gitIn(repoPath, ["add", "."])
  gitIn(repoPath, ["commit", "-q", "-m", "init"])
}

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe("discoverWorkspaceGitRepositories", () => {
  it("finds sibling Git repositories below a non-Git workspace", async () => {
    const workspace = createWorkspace()
    initRepo(join(workspace, "B"))
    initRepo(join(workspace, "C"))

    const repositories = await discoverWorkspaceGitRepositories(workspace)

    expect(repositories.map((repo) => repo.displayPath)).toEqual(["B", "C"])
    expect(repositories.every((repo) => repo.isWorkspaceRoot === false)).toBe(true)
  })

  it("discovers both a main checkout and its linked worktree below a non-Git parent", async () => {
    const workspace = createWorkspace()
    const mainRepo = join(workspace, "main")
    const linkedWorktree = join(workspace, "linked")
    initRepo(mainRepo)
    gitIn(mainRepo, ["worktree", "add", "-q", "-b", "linked-test", linkedWorktree])

    const repositories = await discoverWorkspaceGitRepositories(workspace)

    expect(repositories.map((repo) => repo.displayPath)).toEqual(["linked", "main"])
    expect(repositories.map((repo) => repo.repoPath)).toEqual([
      realpathSync(linkedWorktree),
      realpathSync(mainRepo)
    ])
  })

  it("keeps the existing single-repo behavior when the workspace itself is a Git repo", async () => {
    const workspace = createWorkspace()
    initRepo(workspace)
    initRepo(join(workspace, "nested"))

    const repositories = await discoverWorkspaceGitRepositories(workspace)

    expect(repositories).toHaveLength(1)
    expect(repositories[0].displayPath).toBe(".")
    expect(repositories[0].isWorkspaceRoot).toBe(true)
  })

  it("requires an explicit target when a workspace contains multiple Git repositories", async () => {
    const workspace = createWorkspace()
    const repoB = join(workspace, "B")
    initRepo(repoB)
    initRepo(join(workspace, "C"))

    await expect(resolveGitOperationPath(workspace)).resolves.toEqual({
      error: "当前工作区包含多个 Git 仓库，请先指定要操作的子仓库"
    })
    await expect(resolveGitOperationPath(workspace, repoB)).resolves.toMatchObject({
      worktreePath: repoB
    })
  })

  it("uses the only child repository when there is no ambiguity", async () => {
    const workspace = createWorkspace()
    const repoB = join(workspace, "B")
    initRepo(repoB)

    await expect(resolveGitOperationPath(workspace)).resolves.toMatchObject({
      worktreePath: repoB
    })
  })

  it("keeps a repository subdirectory as the operation scope", async () => {
    const workspace = createWorkspace()
    const repoB = join(workspace, "B")
    const childDir = join(repoB, "src")
    initRepo(repoB)
    mkdirSync(childDir, { recursive: true })

    await expect(resolveGitOperationPath(workspace, childDir)).resolves.toEqual({
      worktreePath: childDir,
      gitRoot: repoB
    })
    await expect(resolveGitOperationPath(childDir)).resolves.toEqual({
      worktreePath: childDir,
      gitRoot: repoB
    })
  })

  it("rejects a workspace child symlink that escapes to an external repository", async () => {
    const workspace = createWorkspace()
    const externalRepo = createWorkspace()
    const linkPath = join(workspace, "outside-repo")
    initRepo(externalRepo)
    symlinkSync(externalRepo, linkPath, process.platform === "win32" ? "junction" : "dir")

    await expect(resolveGitOperationPath(workspace, linkPath)).resolves.toEqual({
      error: "目标 Git 路径解析后不在当前工作区内"
    })
  })

  it("supports a workspace whose root itself is a symlink or junction", async () => {
    const container = createWorkspace()
    const realRepo = join(container, "real-repo")
    const linkedWorkspace = join(container, "linked-workspace")
    initRepo(realRepo)
    symlinkSync(realRepo, linkedWorkspace, process.platform === "win32" ? "junction" : "dir")

    await expect(resolveGitOperationPath(linkedWorkspace)).resolves.toEqual({
      worktreePath: realpathSync(realRepo),
      gitRoot: realpathSync(realRepo)
    })
  })

  it("does not confuse a dot-prefixed child with parent traversal", async () => {
    const workspace = createWorkspace()
    const repoPath = join(workspace, "..repo")
    initRepo(repoPath)

    await expect(resolveGitOperationPath(workspace, repoPath)).resolves.toMatchObject({
      worktreePath: realpathSync(repoPath)
    })
  })

  it.skipIf(process.platform === "win32")(
    "preserves trailing spaces in a requested repository path",
    async () => {
      const workspace = createWorkspace()
      const spacedRepo = join(workspace, "repo ")
      const plainRepo = join(workspace, "repo")
      initRepo(spacedRepo)
      initRepo(plainRepo)

      await expect(resolveGitOperationPath(workspace, spacedRepo)).resolves.toMatchObject({
        worktreePath: realpathSync(spacedRepo)
      })
    }
  )
})
