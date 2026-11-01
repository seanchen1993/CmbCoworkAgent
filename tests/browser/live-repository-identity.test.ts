import { afterEach, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { configureLiveRepositoryIdentity } from "../support/live-repository-identity"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    const local = relative(resolve(tmpdir()), root)
    if (local.startsWith("..") || !local.startsWith("live-git-identity-"))
      throw Error("UNSAFE_CLEANUP")
    rmSync(root, { recursive: true, force: true })
  }
})

it("persists only local test identity so a fresh managed worktree can really commit", () => {
  const parent = mkdtempSync(join(tmpdir(), "live-git-identity-"))
  roots.push(parent)
  const isolated = join(parent, "run-test")
  const workspace = join(isolated, "workspace")
  const home = join(parent, "home")
  mkdirSync(workspace, { recursive: true })
  mkdirSync(home)
  const globalConfig = join(home, ".gitconfig")
  writeFileSync(globalConfig, "[safe]\n\tdirectory = untouched\n")
  const original = readFileSync(globalConfig, "utf8")
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1"
  }
  for (const key of [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL"
  ])
    delete env[key]
  const git = (cwd: string, args: string[]) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" })
    expect(result.status, result.stderr).toBe(0)
    return result.stdout.trim()
  }
  git(workspace, ["init"])
  configureLiveRepositoryIdentity(isolated, workspace)
  writeFileSync(join(workspace, "README.md"), "local fixture\n")
  git(workspace, ["add", "README.md"])
  git(workspace, ["commit", "-m", "initial"])
  const worktree = join(isolated, "worktree")
  git(workspace, ["worktree", "add", "-b", "test-implementation", worktree])
  writeFileSync(join(worktree, "implementation.txt"), "real worktree commit\n")
  git(worktree, ["add", "implementation.txt"])
  git(worktree, ["commit", "-m", "implementation"])
  expect(git(worktree, ["log", "-1", "--format=%an <%ae>"])).toBe(
    "Lean Acceptance <lean@example.invalid>"
  )
  expect(readFileSync(globalConfig, "utf8")).toBe(original)
  expect(() => configureLiveRepositoryIdentity(isolated, parent)).toThrow(
    "ISOLATED_WORKSPACE_REQUIRED"
  )
})
