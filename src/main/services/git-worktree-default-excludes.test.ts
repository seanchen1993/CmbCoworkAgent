import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"

const temporaryRoots: string[] = []

function makeTemporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim()
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  vi.resetModules()
})

async function verifyImplicitGlobalIgnore(mode: "xdg" | "home"): Promise<void> {
  const configRoot = makeTemporaryRoot(`cmb-wt-${mode}-`)
  const repo = makeTemporaryRoot("cmb-wt-default-ignore-repo-")
  const appDataRoot = makeTemporaryRoot("cmb-wt-default-ignore-data-")
  const globalIgnore =
    mode === "xdg"
      ? join(configRoot, "git", "ignore")
      : join(configRoot, ".config", "git", "ignore")
  mkdirSync(dirname(globalIgnore), { recursive: true })
  writeFileSync(globalIgnore, "*.user-defaultignored\n")

  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
  const previousHome = process.env.HOME
  const previousUserProfile = process.env.USERPROFILE
  if (mode === "xdg") {
    process.env.XDG_CONFIG_HOME = configRoot
  } else {
    delete process.env.XDG_CONFIG_HOME
    process.env.HOME = configRoot
    process.env.USERPROFILE = configRoot
  }
  vi.resetModules()
  try {
    const { createWorkflowWorktree, removeWorkflowWorktree } = await import("./git-worktree")

    git(repo, ["init"])
    git(repo, ["config", "user.name", "Default Ignore Test"])
    git(repo, ["config", "user.email", "default-ignore@example.com"])
    writeFileSync(join(repo, "README.md"), "base\n")
    git(repo, ["add", "README.md"])
    git(repo, ["commit", "-m", "base"])

    const info = await createWorkflowWorktree({
      workspacePath: repo,
      runId: `wf_default_global_ignore_${mode}`,
      appDataRoot
    })
    const combinedExcludes = join(dirname(info.directory), ".cmb-internal-excludes")
    const combinedContents = readFileSync(combinedExcludes, "utf8")
    expect(combinedContents).toContain("*.user-defaultignored")
    expect(combinedContents).toContain("**/.cmbdevclaw/**")

    writeFileSync(join(info.directory, "private.user-defaultignored"), "private\n")
    mkdirSync(join(info.directory, ".cmbdevclaw"), { recursive: true })
    writeFileSync(join(info.directory, ".cmbdevclaw", "runtime.json"), "{}\n")
    const isolatedGitEnv = {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.excludesFile",
      GIT_CONFIG_VALUE_0: combinedExcludes
    }
    git(info.directory, ["add", "-A"], isolatedGitEnv)
    expect(git(info.directory, ["diff", "--cached", "--name-only"], isolatedGitEnv)).toBe("")

    await removeWorkflowWorktree({
      directory: info.directory,
      gitRoot: info.gitRoot,
      branch: info.branch,
      expectedBranchHead: info.baseCommit,
      preserveChanges: true
    })
  } finally {
    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
  }
}

test("worktree private excludes preserve XDG's implicit global ignore file", async () => {
  await verifyImplicitGlobalIgnore("xdg")
})

test("worktree private excludes preserve ~/.config/git/ignore without XDG", async () => {
  await verifyImplicitGlobalIgnore("home")
})
