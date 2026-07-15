import { execFileSync } from "child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
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
})
