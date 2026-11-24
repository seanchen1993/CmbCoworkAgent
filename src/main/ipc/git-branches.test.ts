import { execFileSync } from "node:child_process"
import { EventEmitter } from "node:events"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { GitBranchMenuPage, GitBranchMenuResult } from "../../shared/git-branches"
import { registerGitHandlers } from "./git"

type GitHandler = (_: unknown, ...input: unknown[]) => unknown
const handlers = vi.hoisted(() => new Map<string, GitHandler>())
const checkoutProcess = vi.hoisted(() => ({ timeout: undefined as number | undefined }))
const fetchProcess = vi.hoisted(() => ({ timeout: undefined as number | undefined }))

vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, handler: GitHandler) => handlers.set(name, handler)
  }
}))
vi.mock("../services/git-graph-process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/git-graph-process")>()
  const runGitProcessTree: typeof actual.runGitProcessTree = (args, options) => {
    const timeouts: Record<string, number | undefined> = {
      checkout: checkoutProcess.timeout,
      switch: checkoutProcess.timeout,
      fetch: fetchProcess.timeout
    }
    return actual.runGitProcessTree(args, { ...options, timeout: timeouts[args[0]] ?? options.timeout })
  }
  return { runGitProcessTree }
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  }).replace(/\r?\n$/, "")
}

let nextSenderId = 1

function invoke(name: string, ...input: unknown[]): Promise<unknown> {
  const handler = handlers.get(`git:${name}`)
  if (!handler) throw new Error(`Missing Git IPC handler: ${name}`)
  const sender = Object.assign(new EventEmitter(), { id: nextSenderId++ })
  return Promise.resolve(handler({ sender }, ...input)).finally(() => sender.emit("destroyed"))
}

function writeGate(script: string, lastCommand: string): void {
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      'echo started >> "$0.started"',
      "attempts=0",
      'while [ ! -e "$0.release" ] && [ "$attempts" -lt 400 ]; do',
      "  sleep 0.05",
      "  attempts=$((attempts + 1))",
      "done",
      lastCommand
    ].join("\n") + "\n",
    { mode: 0o755 }
  )
}

describe("Git branch IPC", () => {
  let root: string
  let repository: string
  let hooks: string

  beforeAll(() => {
    registerGitHandlers()
  })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cmb-git-branches-"))
    repository = join(root, "repo")
    hooks = join(root, "hooks")
    mkdirSync(repository)
    mkdirSync(hooks)
    git(
      repository,
      "init",
      "--quiet",
      "--initial-branch=main",
      "--separate-git-dir",
      join(root, "admin")
    )
    git(repository, "config", "core.hooksPath", hooks)
    git(repository, "config", "user.name", "Git Branch Test")
    git(repository, "config", "user.email", "git-branch-test@example.test")
    git(repository, "config", "commit.gpgsign", "false")
    writeFileSync(join(repository, "tracked.txt"), "original\n")
    git(repository, "add", "tracked.txt")
    git(repository, "commit", "--quiet", "-m", "Initial commit")
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("distinguishes identically named local and remote refs and returns the actual checked out name", async () => {
    git(repository, "branch", "origin/topic")
    git(repository, "tag", "topic")
    git(repository, "remote", "add", "origin", repository)
    git(repository, "update-ref", "refs/remotes/origin/topic", "HEAD")
    git(repository, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/topic")

    await expect(invoke("readBranchHead", git(repository, "rev-parse", "--absolute-git-dir"))).resolves.toBe("main")
    const menu = await invoke("listBranches", { cwd: repository, forBranchMenu: true, format: "menu" })
    expect(menu).toMatchObject({ success: true, local: "main\norigin/topic", remote: "origin/topic" })
    expect(menu).not.toHaveProperty("choices")
    await expect(invoke("listBranches", repository)).resolves.toMatchObject({
      success: true,
      choices: [
        { name: "main", kind: "local" },
        { name: "origin/topic", kind: "local" },
        { name: "origin/topic", kind: "remote" }
      ]
    })
    await expect(
      invoke("switchBranch", { cwd: repository, branch: "origin/topic", kind: "local" })
    ).resolves.toMatchObject({ success: true, branch: "origin/topic", headChanged: true })
    expect(git(repository, "symbolic-ref", "HEAD")).toBe("refs/heads/origin/topic")
    await expect(
      invoke("switchBranch", { cwd: repository, branch: "origin/topic", kind: "remote" })
    ).resolves.toMatchObject({ success: true, branch: "topic", headChanged: true })
    expect(git(repository, "symbolic-ref", "HEAD")).toBe("refs/heads/topic")
    expect(git(repository, "config", "--get", "branch.topic.merge")).toBe("refs/heads/topic")
    git(repository, "symbolic-ref", "refs/remotes/origin/alias", "refs/remotes/origin/topic")
    await expect(invoke("listBranches", repository)).resolves.toMatchObject({
      choices: expect.arrayContaining([{ name: "origin/alias", kind: "remote" }])
    })
    await expect(invoke("switchBranch", { cwd: repository, branch: "origin/alias", kind: "remote" }))
      .resolves.toMatchObject({ success: true, branch: "alias" })
    expect(git(repository, "config", "--get", "branch.alias.merge")).toBe("refs/heads/topic")
  })

  it("retains a verified checkout when the target changes an included Git config", async () => {
    const config = join(repository, "branch-config.inc")
    writeFileSync(config, "# valid include\n")
    git(repository, "add", "branch-config.inc")
    git(repository, "commit", "--quiet", "-m", "Track branch-specific config")
    git(repository, "checkout", "-q", "-b", "target")
    writeFileSync(config, "[invalid config\n")
    git(repository, "commit", "--quiet", "-am", "Change included config")
    git(repository, "checkout", "-q", "main")
    git(repository, "config", "--local", "include.path", config)

    await expect(invoke("switchBranch", { cwd: repository, branch: "target", kind: "local" }))
      .resolves.toMatchObject({
        success: true, branch: "target", headChanged: true, gitDir: realpathSync(join(root, "admin"))
      })
    expect(readFileSync(join(root, "admin", "HEAD"), "utf8").trim()).toBe("ref: refs/heads/target")
  })

  it("preserves Git-valid Unicode spacing in branch choices and the checked out branch", async () => {
    const local = "\u00a0topic"
    const remote = "topic\u00a0"
    git(repository, "branch", "topic")
    git(repository, "branch", local)
    git(repository, "remote", "add", "origin", repository)
    git(repository, "update-ref", "refs/remotes/origin/topic", "HEAD")
    git(repository, "update-ref", `refs/remotes/origin/${remote}`, "HEAD")

    await expect(invoke("listBranches", repository)).resolves.toMatchObject({
      success: true,
      choices: expect.arrayContaining([
        { name: "topic", kind: "local" },
        { name: local, kind: "local" },
        { name: "origin/topic", kind: "remote" },
        { name: `origin/${remote}`, kind: "remote" }
      ])
    })
    await expect(
      invoke("switchBranch", { cwd: repository, branch: local, kind: "local" })
    ).resolves.toMatchObject({ success: true, branch: local, headChanged: true })
    expect(git(repository, "symbolic-ref", "HEAD")).toBe(`refs/heads/${local}`)

    await expect(
      invoke("switchBranch", { cwd: repository, branch: `origin/${remote}`, kind: "remote" })
    ).resolves.toMatchObject({ success: true, branch: remote, headChanged: true })
    expect(git(repository, "symbolic-ref", "HEAD")).toBe(`refs/heads/${remote}`)
    expect(git(repository, "config", "--get", `branch.${remote}.merge`)).toBe(
      `refs/heads/${remote}`
    )
    await expect(invoke("currentBranch", repository)).resolves.toMatchObject({ branch: remote })
    await expect(invoke("listBranches", repository)).resolves.toMatchObject({ branch: remote })
    const created = "new-topic\u00a0"
    await expect(invoke("createBranch", { cwd: repository, branch: ` ${created} ` }))
      .resolves.toMatchObject({ success: true, branch: created })
    expect(git(repository, "symbolic-ref", "HEAD")).toBe(`refs/heads/${created}`)
  })

  it.skipIf(process.platform === "win32")(
    "keeps the current branch in the list during a concurrent checkout",
    async () => {
      const bin = join(root, "snapshot-bin")
      mkdirSync(bin)
      writeFileSync(
        join(bin, "git"),
        [
          "#!/bin/sh",
          'export PATH="$CMB_TEST_GIT_PATH"',
          'if [ "$1" = for-each-ref ] && [ "$3" = "--format=%(refname)%09%(HEAD)" ]; then',
          '  git "$@" || exit "$?"',
          '  exec git checkout -qb "$CMB_TEST_NEW_BRANCH"',
          "fi",
          'exec git "$@"'
        ].join("\n") + "\n",
        { mode: 0o755 }
      )
      const originalPath = process.env.PATH ?? ""
      vi.stubEnv("CMB_TEST_GIT_PATH", originalPath)
      vi.stubEnv("CMB_TEST_NEW_BRANCH", "concurrent-attached")
      vi.stubEnv("PATH", [bin, originalPath].join(delimiter))
      try {
        await expect(
          invoke("listBranches", { cwd: repository, forBranchMenu: true })
        ).resolves.toMatchObject({
          success: true,
          branch: "main",
          choices: [{ kind: "local", name: "main" }]
        })
        expect(git(repository, "symbolic-ref", "--short", "HEAD")).toBe("concurrent-attached")

        git(repository, "checkout", "-q", "--detach")
        vi.stubEnv("CMB_TEST_NEW_BRANCH", "concurrent-detached")
        await expect(
          invoke("listBranches", { cwd: repository, forBranchMenu: true })
        ).resolves.toMatchObject({
          success: true,
          branch: "concurrent-detached",
          choices: expect.arrayContaining([{ kind: "local", name: "concurrent-detached" }])
        })
        expect(git(repository, "symbolic-ref", "--short", "HEAD")).toBe("concurrent-detached")
      } finally {
        vi.unstubAllEnvs()
      }
    }
  )

  it.skipIf(process.platform === "win32")(
    "keeps a verified repository available when the first HEAD read fails",
    async () => {
      const bin = join(root, "git-bin")
      mkdirSync(bin)
      writeFileSync(
        join(bin, "git"),
        [
          "#!/bin/sh",
          'if [ "$1" = "symbolic-ref" ] && [ "$2" = "--quiet" ] && [ "$3" = "HEAD" ] && [ ! -e "$0.failed" ]; then',
          '  touch "$0.failed"',
          '  echo "temporary failure reading HEAD" >&2',
          '  exit 128',
          'fi',
          'PATH="$CMB_TEST_GIT_PATH" exec git "$@"'
        ].join("\n") + "\n",
        { mode: 0o755 }
      )
      const originalPath = process.env.PATH ?? ""
      vi.stubEnv("CMB_TEST_GIT_PATH", originalPath)
      vi.stubEnv("PATH", [bin, originalPath].join(delimiter))
      try {
        await expect(invoke("currentBranch", repository, true)).resolves.toMatchObject({
          isGitRepo: true,
          isWorktree: false,
          isInsideWorkTree: true,
          gitRoot: realpathSync(repository),
          gitDir: realpathSync(join(root, "admin")),
          branch: null
        })
        expect(existsSync(join(bin, "git.failed"))).toBe(true)
        await expect(
          invoke("listBranches", { cwd: repository, forBranchMenu: true, format: "menu" })
        ).resolves.toMatchObject({ success: true, branch: "main", local: "main" })
        await expect(invoke("getCommitGraph", { cwd: repository })).resolves.toMatchObject({
          commits: [expect.objectContaining({ subject: "Initial commit" })]
        })
      } finally {
        vi.unstubAllEnvs()
      }
    }
  )

  it("reports unborn and detached HEADs without adding a synthetic branch to the list", async () => {
    git(repository, "symbolic-ref", "HEAD", "refs/heads/unborn")
    await expect(invoke("listBranches", repository)).resolves.toMatchObject({
      success: true,
      branch: "unborn",
      choices: [{ name: "main", kind: "local" }]
    })
    git(repository, "checkout", "--detach", "main")
    await expect(invoke("listBranches", repository)).resolves.toMatchObject({
      success: true,
      branch: null,
      choices: [{ name: "main", kind: "local" }]
    })
  })

  it.skipIf(process.platform === "win32")(
    "keeps branch creation and tracking available before Git 2.23",
    async () => {
      git(repository, "branch", "origin/topic")
      git(repository, "remote", "add", "origin", repository)
      git(repository, "update-ref", "refs/remotes/origin/topic", "HEAD")
      const bin = join(root, "legacy-bin")
      mkdirSync(bin)
      writeFileSync(
        join(bin, "git"),
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then echo "git version 2.22.1"; exit 0; fi',
          'if [ "$1" = "switch" ]; then exit 1; fi',
          'PATH="$CMB_TEST_GIT_PATH" exec git "$@"'
        ].join("\n") + "\n",
        { mode: 0o755 }
      )
      const originalPath = process.env.PATH ?? ""
      vi.stubEnv("CMB_TEST_GIT_PATH", originalPath)
      vi.stubEnv("PATH", [bin, originalPath].join(delimiter))
      try {
        for (const [action, name, kind, actual] of [
          ["createBranch", "fresh", "local", "fresh"],
          ["switchBranch", "origin/topic", "local", "origin/topic"],
          ["switchBranch", "origin/topic", "remote", "topic"]
        ]) {
          await expect(
            invoke(action, { cwd: repository, branch: name, kind })
          ).resolves.toMatchObject({
            success: true,
            branch: actual
          })
        }
        expect(git(repository, "rev-parse", "--symbolic-full-name", "@{upstream}")).toBe(
          "refs/remotes/origin/topic"
        )
      } finally {
        vi.unstubAllEnvs()
      }
    }
  )

  it.skipIf(process.platform === "win32")(
    "reports a changed detached HEAD if legacy checkout falls back to a tag in a ref race",
    async () => {
      git(repository, "checkout", "-b", "vanished")
      writeFileSync(join(repository, "tracked.txt"), "tag contents\n")
      git(repository, "commit", "-am", "Tag contents")
      const taggedCommit = git(repository, "rev-parse", "HEAD")
      git(repository, "tag", "vanished")
      git(repository, "checkout", "main")
      const bin = join(root, "legacy-bin")
      mkdirSync(bin)
      writeFileSync(
        join(bin, "git"),
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then echo "git version 2.22.1"; exit 0; fi',
          'if [ "$1" = "checkout" ]; then',
          '  PATH="$CMB_TEST_GIT_PATH" git update-ref -d refs/heads/vanished || exit 1',
          'fi',
          'PATH="$CMB_TEST_GIT_PATH" exec git "$@"'
        ].join("\n") + "\n",
        { mode: 0o755 }
      )
      const originalPath = process.env.PATH ?? ""
      vi.stubEnv("CMB_TEST_GIT_PATH", originalPath)
      vi.stubEnv("PATH", [bin, originalPath].join(delimiter))

      try {
        const input = { cwd: repository, branch: "vanished", kind: "local" }
        for (const start of ["main", "HEAD"]) {
          if (start === "HEAD") git(repository, "checkout", "--detach", "main")
          git(repository, "update-ref", "refs/heads/vanished", taggedCommit)
          await expect(invoke("switchBranch", input)).resolves.toMatchObject({
            success: false,
            branch: null,
            headChanged: true,
            error: expect.stringContaining("游离 HEAD")
          })
          expect(git(repository, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD")
          expect(git(repository, "rev-parse", "HEAD")).toBe(taggedCommit)
          expect(readFileSync(join(repository, "tracked.txt"), "utf8")).toBe("tag contents\n")
        }

        git(repository, "update-ref", "refs/heads/vanished", taggedCommit)
        await expect(invoke("switchBranch", input)).resolves.toEqual({
          success: false,
          branch: null,
          headChanged: false,
          error: expect.stringContaining("游离 HEAD")
        })
      } finally {
        vi.unstubAllEnvs()
      }
    }
  )

  it("rejects malformed arguments, a deleted branch left as a tag, and a stale remote choice", async () => {
    git(repository, "branch", "deleted")
    git(repository, "tag", "deleted")
    git(repository, "branch", "-D", "deleted")
    git(repository, "branch", "stale")
    writeFileSync(join(repository, "tracked.txt"), "working changes\n")

    const inputs = [
      null,
      { cwd: "./repo", branch: "main" },
      { cwd: [repository], branch: "main" },
      { cwd: repository, branch: "--force" },
      { cwd: repository, branch: "@{-1}" },
      { cwd: repository, branch: "main", kind: "invalid" },
      { cwd: repository, branch: "deleted", kind: "local" },
      { cwd: repository, branch: "origin/stale", kind: "remote" }
    ]
    for (const input of inputs) {
      await expect(invoke("switchBranch", input)).resolves.toMatchObject({ success: false })
    }
    await expect(invoke("getChangedFileCount", "./repo")).rejects.toThrow("无效的 Git 工作目录")
    await expect(
      invoke("listBranches", { cwd: repository, refreshRemote: "true" })
    ).resolves.toMatchObject({
      success: false,
      branches: [],
      choices: []
    })
    expect(git(repository, "symbolic-ref", "HEAD")).toBe("refs/heads/main")
    expect(git(repository, "diff", "--name-only")).toBe("tracked.txt")
  })

  it("creates a branch beside uncommitted changes and counts each path once", async () => {
    writeFileSync(join(repository, "tracked.txt"), "staged\n")
    git(repository, "add", "tracked.txt")
    writeFileSync(join(repository, "tracked.txt"), "unstaged\n")
    writeFileSync(join(repository, "untracked.txt"), "new\n")
    await expect(
      Promise.all([
        invoke("getChangedFileCount", repository),
        invoke("getChangedFileCount", repository)
      ])
    ).resolves.toEqual([2, 2])
    await expect(
      invoke("createBranch", { cwd: repository, branch: "feature/元数据" })
    ).resolves.toMatchObject({ success: true, branch: "feature/元数据", headChanged: true })
    await expect(invoke("getChangedFileCount", repository, "feature/元数据")).resolves.toBe(2)
    await expect(
      invoke("createBranch", { cwd: repository, branch: "feature/元数据" })
    ).resolves.toEqual({ success: false, error: "分支已存在" })
  })

  it("does not reuse a count when the expected branch differs and supports detached HEAD", async () => {
    writeFileSync(join(repository, "new.txt"), "changed\n")
    const [stale, current] = await Promise.allSettled([
      invoke("getChangedFileCount", repository, "previous"),
      invoke("getChangedFileCount", repository, "main")
    ])
    expect(stale).toMatchObject({ status: "rejected", reason: expect.any(Error) })
    expect(current).toEqual({ status: "fulfilled", value: 1 })
    git(repository, "switch", "--detach")
    await expect(invoke("getChangedFileCount", repository, null)).resolves.toBe(1)
    await expect(invoke("getChangedFileCount", repository, "main")).rejects.toThrow(
      "工作区分支已变化"
    )
  })

  it("counts changed files without computing divergence from the upstream branch", async () => {
    git(repository, "branch", "upstream")
    git(repository, "branch", "--set-upstream-to=upstream", "main")
    git(repository, "commit", "--quiet", "--allow-empty", "-m", "Ahead of upstream")
    git(repository, "config", "status.aheadBehind", "true")
    writeFileSync(join(repository, "new.txt"), "changed\n")
    const trace = join(root, "trace")

    vi.stubEnv("GIT_TRACE2_EVENT", trace)
    try {
      await expect(invoke("getChangedFileCount", repository, "main")).resolves.toBe(1)
    } finally {
      vi.unstubAllEnvs()
    }
    const command = readFileSync(trace, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find(({ event }) => event === "start")
    expect(command?.argv).toEqual(expect.arrayContaining(["--no-ahead-behind", "--branch"]))
    expect(git(repository, ...command.argv.slice(1))).toContain("## main...upstream [different]\0")
  })

  it.skipIf(process.platform === "win32")(
    "counts changed files on Git without the lock or divergence command options",
    async () => {
      const bin = join(root, "legacy-status-bin")
      mkdirSync(bin)
      writeFileSync(
        join(bin, "git"),
        [
          "#!/bin/sh",
          'if [ "$1" = --no-optional-locks ] || [ "$GIT_OPTIONAL_LOCKS" != 0 ]; then exit 129; fi',
          'for arg in "$@"; do',
          '  if [ "$arg" = --no-ahead-behind ]; then',
          '    echo "error: unknown option: no-ahead-behind" >&2',
          "    exit 129",
          "  fi",
          "done",
          'PATH="$CMB_TEST_GIT_PATH" exec git "$@"',
          ""
        ].join("\n"),
        { mode: 0o755 }
      )
      writeFileSync(join(repository, "new.txt"), "changed\n")
      const originalPath = process.env.PATH ?? ""
      vi.stubEnv("CMB_TEST_GIT_PATH", originalPath)
      vi.stubEnv("PATH", [bin, originalPath].join(delimiter))
      try {
        await expect(invoke("getChangedFileCount", repository, "main")).resolves.toBe(1)
      } finally {
        vi.unstubAllEnvs()
      }
    }
  )

  it("discovers a healthy child repository beneath an invalid workspace gitfile", async () => {
    const group = join(root, "group")
    mkdirSync(group)
    writeFileSync(join(group, ".git"), "invalid gitfile\n")
    const child = join(group, "project")
    git(root, "clone", "--quiet", repository, child)
    await expect(invoke("currentBranch", group)).resolves.toMatchObject({
      isGitRepo: true,
      isMultiRepo: true,
      repositories: [{ path: child, displayPath: "project" }]
    })
    await expect(invoke("getCommitGraph", { cwd: child })).resolves.toMatchObject({
      commits: [{ subject: "Initial commit" }]
    })
  })

  it("uses URL rewrites in the user's global config when refreshing origin", async () => {
    const config = join(root, "user.gitconfig")
    const source = join(root, "source")
    git(root, "clone", "--quiet", repository, source)
    git(source, "branch", "remote-feature")
    const label = "https://git.example.invalid/workspace"
    git(repository, "remote", "add", "origin", label)
    git(root, "config", "--file", config, `url.${pathToFileURL(source).href}.insteadOf`, label)
    vi.stubEnv("GIT_CONFIG_GLOBAL", config)
    vi.stubEnv("GIT_ALLOW_PROTOCOL", "file")
    try {
      const result = await invoke("listBranches", { cwd: repository, refreshRemote: true })
      expect(result).toMatchObject({
        success: true,
        choices: expect.arrayContaining([{ name: "origin/remote-feature", kind: "remote" }])
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("keeps branch checkout available from a symlink to a nested directory", async () => {
    const checkout = join(root, "checkout")
    git(root, "clone", "--quiet", repository, checkout)
    const nested = join(checkout, "nested")
    mkdirSync(nested)
    const alias = join(root, "workspace")
    symlinkSync(nested, alias, "junction")
    const gitDir = realpathSync(join(checkout, ".git"))
    await expect(invoke("currentBranch", checkout)).resolves.toMatchObject({ gitDir })
    await expect(invoke("currentBranch", alias)).resolves.toMatchObject({
      branch: "main",
      isWorktree: false,
      isInsideWorkTree: true,
      gitDir
    })
    await expect(invoke("createBranch", { cwd: alias, branch: "from-link" })).resolves.toMatchObject({
      success: true,
      branch: "from-link",
      gitDir
    })
    expect(git(checkout, "symbolic-ref", "HEAD")).toBe("refs/heads/from-link")
    await expect(invoke("switchBranch", { cwd: alias, branch: "main" })).resolves.toMatchObject({
      success: true,
      branch: "main"
    })
  })

  it("reports linked worktrees through an admin directory outside the repository", async () => {
    const linked = join(root, "linked")
    git(repository, "worktree", "add", "-b", "linked", linked)
    await expect(invoke("currentBranch", repository)).resolves.toMatchObject({
      branch: "main",
      isWorktree: false,
      isInsideWorkTree: true,
      gitDir: realpathSync(join(root, "admin"))
    })
    await expect(invoke("currentBranch", linked)).resolves.toMatchObject({
      branch: "linked",
      isWorktree: true,
      isInsideWorkTree: true,
      gitDir: realpathSync(join(root, "admin", "worktrees", "linked"))
    })
    await expect(invoke("createBranch", { cwd: linked, branch: "blocked" })).resolves.toMatchObject(
      { success: false }
    )
  })

  it("keeps the graph available in Git directories without permitting branch writes", async () => {
    git(repository, "branch", "topic")
    const bare = join(root, "bare.git")
    git(root, "clone", "--bare", repository, bare)
    for (const cwd of [bare, join(root, "admin")]) {
      await expect(invoke("currentBranch", cwd)).resolves.toMatchObject({
        isGitRepo: true,
        branch: "main",
        isWorktree: false,
        isInsideWorkTree: false
      })
      await expect(invoke("getCommitGraph", { cwd })).resolves.toMatchObject({
        commits: [{ subject: "Initial commit" }]
      })
      const unavailable = { success: false, error: "当前目录不在工作树内，无法创建或切换分支" }
      await expect(invoke("createBranch", { cwd, branch: "unexpected" })).resolves.toEqual(unavailable)
      await expect(invoke("switchBranch", { cwd, branch: "topic" })).resolves.toEqual(unavailable)
      expect(git(cwd, "symbolic-ref", "HEAD")).toBe("refs/heads/main")
    }
  })

  it("keeps an in-progress Git operation attached to its branch", async () => {
    mkdirSync(join(root, "admin", "rebase-merge"))
    await expect(
      invoke("createBranch", { cwd: repository, branch: "accidental" })
    ).resolves.toEqual({ success: false, error: "请先完成或中止正在进行的 Git 操作" })
    expect(git(repository, "symbolic-ref", "HEAD")).toBe("refs/heads/main")
  })

  it.skipIf(process.platform === "win32")(
    "preserves newlines in a custom Git directory",
    async () => {
      const alternate = join(root, "alternate")
      const admin = join(root, "admin\nwith-newline")
      mkdirSync(alternate)
      git(alternate, "init", "--quiet", "--initial-branch=main", "--separate-git-dir", admin)
      await expect(invoke("currentBranch", alternate)).resolves.toMatchObject({
        isGitRepo: true,
        isWorktree: false,
        branch: "main"
      })
      await expect(invoke("getChangedFileCount", alternate, "main")).resolves.toBe(0)
      mkdirSync(join(admin, "sequencer"))
      await expect(invoke("createBranch", { cwd: alternate, branch: "blocked" })).resolves.toEqual({
        success: false,
        error: "请先完成或中止正在进行的 Git 操作"
      })
    }
  )

  it("rejects unmerged index entries outside the workspace subdirectory", async () => {
    const nested = join(repository, "nested")
    mkdirSync(nested)
    const hash = git(repository, "rev-parse", ":tracked.txt")
    execFileSync("git", ["update-index", "--index-info"], {
      cwd: repository,
      input: `0 ${"0".repeat(hash.length)}\ttracked.txt\n100644 ${hash} 1\ttracked.txt\n100644 ${hash} 2\ttracked.txt\n`
    })
    await expect(invoke("createBranch", { cwd: nested, branch: "blocked" })).resolves.toEqual({
      success: false,
      error: "请先解决工作区中未合并的冲突"
    })
    expect(git(repository, "symbolic-ref", "HEAD")).toBe("refs/heads/main")
  })

  it.skipIf(process.platform === "win32")("confirms checkout when the target removes the selected directory symlink", async () => {
    mkdirSync(join(repository, "nested"))
    writeFileSync(join(repository, "nested", "tracked"), "keep")
    git(repository, "add", "nested")
    git(repository, "commit", "-qm", "keep physical directory")
    git(repository, "branch", "without-alias")
    const alias = join(repository, "alias")
    symlinkSync("nested", alias)
    git(repository, "add", "alias")
    git(repository, "commit", "-qm", "track directory alias")
    await expect(invoke("switchBranch", { cwd: alias, branch: "without-alias", kind: "local" }))
      .resolves.toMatchObject({
        success: true, headChanged: true, branch: "without-alias", gitRoot: realpathSync(repository)
      })
    expect(existsSync(alias)).toBe(false)
    expect(git(repository, "symbolic-ref", "HEAD")).toBe("refs/heads/without-alias")
  })

  it("lists local branches when a remote-tracking ref points to a missing object", async () => {
    const admin = git(repository, "rev-parse", "--absolute-git-dir")
    const remotes = join(admin, "refs", "remotes", "origin")
    mkdirSync(remotes, { recursive: true })
    writeFileSync(join(remotes, "stale"), "1".repeat(40) + "\n")
    await expect(invoke("listBranches", { cwd: repository, forBranchMenu: true }))
      .resolves.toMatchObject({
        success: true, branch: "main",
        choices: expect.arrayContaining([{ name: "main", kind: "local" }, { name: "origin/stale", kind: "remote" }])
      })
    writeFileSync(join(admin, "refs", "heads", "stale-local"), "2".repeat(40) + "\n")
    await expect(invoke("listBranches", { cwd: repository, forBranchMenu: true }))
      .resolves.toMatchObject({
        success: true, branch: "main",
        choices: expect.arrayContaining([{ name: "main", kind: "local" }, { name: "stale-local", kind: "local" }])
      })
  })

  it("keeps recent ordering for small branch lists and uses name order for large lists", async () => {
    git(repository, "branch", "a-old")
    git(repository, "checkout", "-qb", "z-newest")
    vi.stubEnv("GIT_COMMITTER_DATE", "2030-01-01T00:00:00Z")
    try {
      git(repository, "commit", "--allow-empty", "-qm", "Recent commit")
    } finally {
      vi.unstubAllEnvs()
    }
    git(repository, "checkout", "-q", "main")
    const input = { cwd: repository, forBranchMenu: true, format: "menu" }
    await expect(invoke("listBranches", input)).resolves.toMatchObject({
      success: true, branch: "main", local: "z-newest\na-old\nmain", remote: ""
    })

    const admin = git(repository, "rev-parse", "--absolute-git-dir")
    const head = git(repository, "rev-parse", "HEAD")
    writeFileSync(
      join(admin, "packed-refs"),
      "# pack-refs with: sorted\n" + Array.from({ length: 10001 }, (_, index) =>
        `${head} refs/heads/packed/${String(index).padStart(5, "0")}\n`
      ).join("")
    )
    const result = (await invoke("listBranches", input)) as { success: boolean; branch: string; local: string }
    expect(result).toMatchObject({ success: true, branch: "main", remote: "" })
    const names = result.local.split("\n")
    expect(names).toHaveLength(10004)
    expect(names.slice(0, 3)).toEqual(["a-old", "main", "packed/00000"])
    expect(names.at(-1)).toBe("z-newest")
  })

  it("uses locale ordering for local branches with the same committer date", async () => {
    git(repository, "branch", "Zulu")
    git(repository, "branch", "alpha")
    await expect(invoke("listBranches", { cwd: repository, forBranchMenu: true, format: "menu" }))
      .resolves.toMatchObject({ success: true, branch: "main", local: "alpha\nmain\nZulu" })
  })

  it.skipIf(process.platform === "win32").each(["timeout", "menu closure"])(
    "stops a lazy fetch started by date sorting after %s",
    async (reason) => {
      const origin = join(root, "origin")
      git(root, "clone", "--quiet", repository, origin)
      git(origin, "-c", "user.name=Git Branch Test", "-c", "user.email=test@example.test",
        "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "Promised commit")
      const promisedCommit = git(origin, "rev-parse", "HEAD")
      const admin = git(repository, "rev-parse", "--absolute-git-dir")
      writeFileSync(join(admin, "refs", "heads", "promised"), promisedCommit + "\n")
      const uploadPack = join(root, "sort-upload-pack")
      writeGate(uploadPack, 'echo finished > "$0.finished"\nexec git-upload-pack "$@"')
      git(repository, "config", "core.repositoryformatversion", "1")
      git(repository, "config", "extensions.partialClone", "origin")
      git(repository, "remote", "add", "origin", pathToFileURL(origin).href)
      git(repository, "config", "remote.origin.promisor", "true")
      git(repository, "config", "remote.origin.uploadpack", uploadPack)

      const menu = { sender: Object.assign(new EventEmitter(), { id: nextSenderId++ }) }
      const input = { cwd: repository, forBranchMenu: true, format: "menu" }
      const pending = Promise.resolve(handlers.get("git:listBranches")!(menu, input))
      try {
        await vi.waitFor(() => expect(existsSync(uploadPack + ".started")).toBe(true))
        if (reason === "menu closure") {
          await handlers.get("git:cancelBranchList")!(menu)
          await expect(pending).resolves.toMatchObject({ success: false, error: "已取消分支读取" })
        } else {
          await expect(pending).resolves.toMatchObject({ success: true, local: "main\npromised" })
        }
        writeFileSync(uploadPack + ".release", "")
        await new Promise<void>((resolve) => setTimeout(resolve, 300))
        expect(existsSync(uploadPack + ".finished")).toBe(false)
      } finally {
        writeFileSync(uploadPack + ".release", "")
        menu.sender.emit("destroyed")
        await pending
      }
    }
  )

  it("keeps locale ordering for small remote lists and Git name order for large lists", async () => {
    git(repository, "update-ref", "refs/remotes/origin/Zulu", "HEAD")
    git(repository, "update-ref", "refs/remotes/origin/alpha", "HEAD")
    git(repository, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/alpha")
    const input = { cwd: repository, forBranchMenu: true, format: "menu" }
    await expect(invoke("listBranches", input)).resolves.toMatchObject({
      success: true, branch: "main", local: "main", remote: "origin/alpha\norigin/Zulu"
    })

    const admin = git(repository, "rev-parse", "--absolute-git-dir")
    const head = git(repository, "rev-parse", "HEAD")
    writeFileSync(
      join(admin, "packed-refs"),
      "# pack-refs with: sorted\n" + Array.from({ length: 10001 }, (_, index) =>
        `${head} refs/remotes/origin/packed/${String(index).padStart(5, "0")}\n`
      ).join("")
    )
    const result = (await invoke("listBranches", input)) as { success: boolean; branch: string; remote: string }
    expect(result).toMatchObject({ success: true, branch: "main", local: "main" })
    const names = result.remote.split("\n")
    expect(names).toHaveLength(10003)
    expect(names.slice(0, 3)).toEqual(["origin/Zulu", "origin/alpha", "origin/packed/00000"])
    expect(names.at(-1)).toBe("origin/packed/10000")
  })

  it("streams and pages a branch namespace larger than the command output buffer", { timeout: 15_000 }, async () => {
    const admin = git(repository, "rev-parse", "--absolute-git-dir")
    const head = git(repository, "rev-parse", "HEAD")
    const count = 95_000
    const name = (index: number): string =>
      `packed/${String(index).padStart(5, "0")}${"x".repeat(200)}分支`
    writeFileSync(
      join(admin, "packed-refs"),
      "# pack-refs with: sorted\n" + Array.from({ length: count }, (_, index) =>
        `${head} refs/heads/${name(index)}\n`
      ).join("")
    )
    git(repository, "update-ref", "refs/remotes/origin/topic", "HEAD")

    const list = handlers.get("git:listBranches")!
    const readPage = handlers.get("git:readBranchMenuPage")!
    const cancel = handlers.get("git:cancelBranchList")!
    const sender = { sender: Object.assign(new EventEmitter(), { id: nextSenderId++ }) }
    const other = { sender: Object.assign(new EventEmitter(), { id: nextSenderId++ }) }
    const input = {
      cwd: repository,
      forBranchMenu: true,
      format: "menu",
      paged: true
    }
    try {
      const first = (await list(sender, input)) as GitBranchMenuResult
      expect(first).toMatchObject({ success: true, branch: "main", remote: "" })
      expect(first.next).toBeDefined()
      expect(() => readPage(other, first.next)).toThrow("分支列表已失效")

      const local: string[] = []
      const remote: string[] = []
      let page: GitBranchMenuPage = first
      while (true) {
        expect(page.local.length + page.remote.length).toBeLessThanOrEqual(256 * 1024)
        if (page.local) local.push(...page.local.split("\n"))
        if (page.remote) remote.push(...page.remote.split("\n"))
        if (!page.next) break
        page = readPage(sender, page.next) as GitBranchMenuPage
      }
      expect(local).toHaveLength(count + 1)
      expect(local[0]).toBe("main")
      expect(local.findIndex((branch, index) => index > 0 && branch !== name(index - 1))).toBe(-1)
      expect(remote).toEqual(["origin/topic"])
      expect(() => readPage(sender, first.next)).toThrow("分支列表已失效")

      const partial = (await list(sender, input)) as GitBranchMenuResult
      expect(partial.next).toBeDefined()
      cancel(sender)
      expect(() => readPage(sender, partial.next)).toThrow("分支列表已失效")
    } finally {
      sender.sender.emit("destroyed")
      other.sender.emit("destroyed")
    }
  })

  it("returns an empty branch menu for a repository without a first commit", async () => {
    const empty = join(root, "empty")
    mkdirSync(empty)
    git(empty, "init", "-q", "-b", "main")
    await expect(invoke("listBranches", { cwd: empty, forBranchMenu: true, format: "menu" }))
      .resolves.toEqual({ success: true, branch: "main", local: "", remote: "" })
  })

  it("checks out a symbolic local branch and reports the resolved current branch", async () => {
    git(repository, "symbolic-ref", "refs/heads/alias", "refs/heads/main")
    writeFileSync(join(repository, "new.txt"), "untracked\n")
    const input = { cwd: repository, branch: "alias", kind: "local" }

    await expect(invoke("switchBranch", input)).resolves.toMatchObject({
      success: true,
      branch: "main",
      headChanged: true
    })
    expect(git(repository, "symbolic-ref", "--no-recurse", "HEAD")).toBe("refs/heads/alias")
    expect(git(repository, "status", "--porcelain", "--branch")).toContain("## main\n")
    await expect(invoke("listBranches", repository)).resolves.toMatchObject({ branch: "main" })
    await expect(invoke("getChangedFileCount", repository, "main")).resolves.toBe(1)
    await expect(invoke("switchBranch", input)).resolves.toEqual({
      success: true,
      branch: "main",
      headChanged: false
    })
  })

  it.skipIf(process.platform === "win32")(
    "verifies the direct branch after a failed post-checkout hook",
    async () => {
      git(repository, "symbolic-ref", "refs/heads/alias", "refs/heads/main")
      git(repository, "symbolic-ref", "refs/heads/hook-target", "refs/heads/main")
      const hook = join(hooks, "post-checkout")
      const input = { cwd: repository, branch: "alias", kind: "local" }
      writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 })
      await expect(invoke("switchBranch", input)).resolves.toMatchObject({
        success: true,
        branch: "main",
        warning: expect.any(String)
      })
      expect(git(repository, "symbolic-ref", "--no-recurse", "HEAD")).toBe("refs/heads/alias")

      git(repository, "symbolic-ref", "HEAD", "refs/heads/main")
      writeFileSync(hook, "#!/bin/sh\ngit symbolic-ref HEAD refs/heads/hook-target\nexit 1\n")
      await expect(invoke("switchBranch", input)).resolves.toMatchObject({
        success: false,
        branch: "main",
        headChanged: true,
        error: expect.any(String)
      })
      expect(git(repository, "symbolic-ref", "--no-recurse", "HEAD")).toBe("refs/heads/hook-target")
    }
  )

  it.skipIf(process.platform === "win32")(
    "stops a timed-out checkout hook before allowing the next checkout",
    { timeout: 20_000 },
    async () => {
      const hook = join(hooks, "post-checkout")
      const finished = hook + ".finished"
      writeGate(hook, 'git symbolic-ref --short HEAD > "$0.finished"')
      writeFileSync(hook, readFileSync(hook, "utf8").replace("#!/bin/sh\n", '#!/bin/sh\ntrap "" TERM\n'))
      checkoutProcess.timeout = 3_000
      try {
        await expect(invoke("createBranch", { cwd: repository, branch: "with-slow-hook" }))
          .resolves.toMatchObject({
            success: true,
            branch: "with-slow-hook",
            headChanged: true,
            warning: expect.stringContaining("超时")
          })
        expect(existsSync(hook + ".started")).toBe(true)
        expect(existsSync(finished)).toBe(false)

        // Unlinking a hook does not stop an existing process. A later checkout
        // must be able to proceed without that process resuming against its HEAD.
        rmSync(hook)
        checkoutProcess.timeout = undefined
        await expect(invoke("switchBranch", { cwd: repository, branch: "main" }))
          .resolves.toMatchObject({ success: true, branch: "main", headChanged: true })
        writeFileSync(hook + ".release", "")
        await new Promise<void>((resolve) => setTimeout(resolve, 300))
        expect(existsSync(finished)).toBe(false)
      } finally {
        checkoutProcess.timeout = undefined
        writeFileSync(hook + ".release", "")
      }
    }
  )

  it.skipIf(process.platform === "win32")(
    "allows Git to release its index lock when a checkout filter times out",
    { timeout: 20_000 },
    async () => {
      writeFileSync(join(repository, ".gitattributes"), "asset filter=slow\n")
      git(repository, "add", ".gitattributes")
      git(repository, "commit", "-qm", "Configure asset filter")
      git(repository, "checkout", "-qb", "filtered")
      writeFileSync(join(repository, "asset"), "filtered contents\n")
      git(repository, "add", "asset")
      git(repository, "commit", "-qm", "Add filtered asset")
      git(repository, "checkout", "-q", "main")
      const filter = join(hooks, "smudge")
      writeGate(filter, "cat")
      git(repository, "config", "filter.slow.smudge", `"${filter}"`)
      const lock = join(git(repository, "rev-parse", "--absolute-git-dir"), "index.lock")

      checkoutProcess.timeout = 3_000
      try {
        await expect(invoke("switchBranch", { cwd: repository, branch: "filtered" }))
          .resolves.toMatchObject({ success: false, branch: "main", error: expect.stringContaining("超时") })
        expect(existsSync(filter + ".started")).toBe(true)
        expect(existsSync(lock)).toBe(false)

        checkoutProcess.timeout = undefined
        git(repository, "config", "--unset", "filter.slow.smudge")
        await expect(invoke("switchBranch", { cwd: repository, branch: "filtered" }))
          .resolves.toMatchObject({ success: true, branch: "filtered" })
      } finally {
        checkoutProcess.timeout = undefined
        writeFileSync(filter + ".release", "")
      }
    }
  )

  it.skipIf(process.platform === "win32")(
    "lets the Git for Windows wrapper wait for the checkout to release its index lock",
    { timeout: 20_000 },
    async () => {
      writeFileSync(join(repository, ".gitattributes"), "asset filter=slow\n")
      git(repository, "add", ".gitattributes")
      git(repository, "commit", "-qm", "Configure asset filter")
      git(repository, "checkout", "-qb", "filtered")
      writeFileSync(join(repository, "asset"), "filtered contents\n")
      git(repository, "add", "asset")
      git(repository, "commit", "-qm", "Add filtered asset")
      git(repository, "checkout", "-q", "main")
      const filter = join(hooks, "smudge")
      const filterPidPath = join(root, "filter-pid")
      const killedPath = join(root, "killed-pids")
      const bin = join(root, "bin")
      const lock = join(git(repository, "rev-parse", "--absolute-git-dir"), "index.lock")
      mkdirSync(bin)
      writeFileSync(filter, '#!/bin/sh\nprintf "%s\\n" "$$" > "$CMB_TEST_FILTER_PID"\nexec sleep 30\n', {
        mode: 0o755
      })
      git(repository, "config", "filter.slow.required", "true")
      git(repository, "config", "filter.slow.smudge", `"${filter}"`)
      writeFileSync(join(bin, "git"), [
        "#!/bin/sh",
        'if [ "$1" = switch ]; then',
        '  PATH="$CMB_TEST_ORIGINAL_PATH" git "$@" &',
        "  wait $!",
        "  exit $?",
        "fi",
        'PATH="$CMB_TEST_ORIGINAL_PATH" exec git "$@"'
      ].join("\n") + "\n", { mode: 0o755 })
      writeFileSync(join(bin, "powershell.exe"), [
        "#!/bin/sh",
        'case "$*" in',
        `  *"Name -eq 'git.exe'"*'ParentProcessId = '*) cat "$CMB_TEST_FILTER_PID" ;;`,
        "  *) exit 1 ;;",
        "esac"
      ].join("\n") + "\n", { mode: 0o755 })
      writeFileSync(join(bin, "taskkill"), [
        "#!/bin/sh",
        'printf "%s\\n" "$4" >> "$CMB_TEST_KILLED_PIDS"',
        'kill -KILL "$4"'
      ].join("\n") + "\n", { mode: 0o755 })
      const originalPath = process.env.PATH ?? ""
      const originalPlatform = process.platform
      vi.stubEnv("CMB_TEST_ORIGINAL_PATH", originalPath)
      vi.stubEnv("CMB_TEST_FILTER_PID", filterPidPath)
      vi.stubEnv("CMB_TEST_KILLED_PIDS", killedPath)
      vi.stubEnv("PATH", [bin, originalPath].join(delimiter))
      checkoutProcess.timeout = 3_000
      Object.defineProperty(process, "platform", { value: "win32" })
      try {
        await expect(invoke("switchBranch", { cwd: repository, branch: "filtered" }))
          .resolves.toMatchObject({ success: false, branch: "main", error: expect.stringContaining("超时") })
        expect(readFileSync(killedPath, "utf8")).toBe(readFileSync(filterPidPath, "utf8"))
        expect(existsSync(lock)).toBe(false)
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform })
        checkoutProcess.timeout = undefined
        vi.unstubAllEnvs()
        if (existsSync(filterPidPath)) {
          try {
            process.kill(Number(readFileSync(filterPidPath, "utf8")), "SIGKILL")
          } catch {
            // The simulated taskkill already stopped the filter.
          }
        }
      }
      git(repository, "config", "--unset", "filter.slow.required")
      git(repository, "config", "--unset", "filter.slow.smudge")
      await expect(invoke("switchBranch", { cwd: repository, branch: "filtered" }))
        .resolves.toMatchObject({ success: true, branch: "filtered" })
    }
  )

  it.skipIf(process.platform === "win32")(
    "returns the switched branch when post-checkout fails",
    async () => {
      writeFileSync(join(hooks, "post-checkout"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
      await expect(
        invoke("createBranch", { cwd: repository, branch: "with-hook" })
      ).resolves.toMatchObject({
        success: true,
        branch: "with-hook",
        warning: expect.any(String)
      })
      expect(git(repository, "symbolic-ref", "HEAD")).toBe("refs/heads/with-hook")
    }
  )

  it.skipIf(process.platform === "win32")(
    "cancels a menu's slow refresh wait while other work proceeds and a worktree alias shares its fetch",
    { timeout: 20000 },
    async () => {
      const uploadPack = join(root, "slow-upload-pack")
      writeGate(uploadPack, 'exec git-upload-pack "$@"')
      git(repository, "remote", "add", "origin", repository)
      git(repository, "config", "remote.origin.uploadpack", uploadPack)
      const nested = join(repository, "nested")
      const alias = join(root, "alias")
      mkdirSync(nested)
      symlinkSync(nested, alias, "junction")

      const list = handlers.get("git:listBranches")!
      const cancel = handlers.get("git:cancelBranchList")!
      const firstMenu = { sender: Object.assign(new EventEmitter(), { id: 701 }) }
      const secondMenu = { sender: Object.assign(new EventEmitter(), { id: 702 }) }
      const options = { cwd: repository, refreshRemote: true, forBranchMenu: true }
      const observed = vi.fn()
      const cancelled = Promise.resolve(list(firstMenu, options)).then(observed, observed)
      let fetchFinished = false
      let secondFetch: Promise<unknown> | undefined
      try {
        await vi.waitFor(() => expect(existsSync(uploadPack + ".started")).toBe(true), {
          timeout: 5000
        })
        secondFetch = Promise.resolve(list(secondMenu, { ...options, cwd: alias })).finally(
          () => {
            fetchFinished = true
          }
        )
        await cancel(firstMenu)
        await vi.waitFor(() =>
          expect(observed).toHaveBeenCalledWith(
            expect.objectContaining({ success: false, error: "已取消分支读取" })
          )
        )
        await expect(invoke("listBranches", repository)).resolves.toMatchObject({
          success: true,
          branch: "main"
        })
        await expect(invoke("getChangedFileCount", repository)).resolves.toBe(0)
        await expect(
          invoke("createBranch", { cwd: repository, branch: "during-fetch" })
        ).resolves.toMatchObject({ success: true, branch: "during-fetch", headChanged: true })
        expect(fetchFinished).toBe(false)
      } finally {
        writeFileSync(uploadPack + ".release", "")
        await Promise.all([cancelled, secondFetch])
        firstMenu.sender.emit("destroyed")
        secondMenu.sender.emit("destroyed")
      }
      await expect(secondFetch).resolves.toMatchObject({ success: true, branch: "during-fetch" })
      expect(readFileSync(uploadPack + ".started", "utf-8")).toBe("started\n")
    }
  )

  it.skipIf(process.platform === "win32")(
    "stops a stalled transport after an explicit refresh times out",
    async () => {
      const uploadPack = join(root, "timed-out-upload-pack")
      writeGate(uploadPack, 'echo finished > "$0.finished"\nexec git-upload-pack "$@"')
      git(repository, "remote", "add", "origin", repository)
      git(repository, "config", "remote.origin.uploadpack", uploadPack)

      fetchProcess.timeout = 1_000
      try {
        const input = { cwd: repository, refreshRemote: true, forBranchMenu: true, format: "menu" }
        await expect(invoke("listBranches", input)).resolves.toMatchObject({
          success: false, error: "刷新远程 Git 分支超时", branch: "main", local: "main"
        })
        expect(existsSync(uploadPack + ".started")).toBe(true)
        writeFileSync(uploadPack + ".release", "")
        await new Promise<void>((resolve) => setTimeout(resolve, 300))
        expect(existsSync(uploadPack + ".finished")).toBe(false)
      } finally {
        fetchProcess.timeout = undefined
        writeFileSync(uploadPack + ".release", "")
      }
    }
  )

  it.skipIf(process.platform === "win32")(
    "refreshes unrelated remotes concurrently and returns cached refs when fetch slots are full",
    { timeout: 20000 },
    async () => {
      const uploadPack = join(root, "blocked-upload-pack")
      writeGate(uploadPack, 'exec git-upload-pack "$@"')
      const blocked = [repository]
      const other = join(root, "other")
      git(root, "clone", "--quiet", repository, other)
      for (let index = 1; index < 4; index++) {
        const cwd = join(root, `blocked-${index}`)
        git(root, "clone", "--quiet", repository, cwd)
        blocked.push(cwd)
      }
      git(repository, "remote", "add", "origin", repository)
      for (const cwd of blocked) git(cwd, "config", "remote.origin.uploadpack", uploadPack)

      const menu = { forBranchMenu: true, format: "menu" }
      const refresh = (cwd: string) => invoke("listBranches", { ...menu, cwd, refreshRemote: true })
      const inFlight = blocked.map(refresh)
      const cached = { local: "main", remote: "origin/main", branch: "main" }
      let saturated: Promise<unknown> | undefined
      try {
        await vi.waitFor(
          () => expect(readFileSync(uploadPack + ".started", "utf8")).toBe("started\n".repeat(4)),
          { timeout: 5000 }
        )
        const observed = vi.fn()
        saturated = refresh(other).then(observed, observed)
        await vi.waitFor(
          () => expect(observed).toHaveBeenCalledWith({
            ...cached, success: false, error: "远程分支刷新繁忙，请稍后重试"
          }),
          { timeout: 5000 }
        )
        await expect(invoke("listBranches", { ...menu, cwd: other })).resolves.toMatchObject({
          ...cached, success: true
        })
      } finally {
        writeFileSync(uploadPack + ".release", "")
        await Promise.allSettled([...inFlight, saturated])
      }
      await expect(Promise.all(inFlight)).resolves.toMatchObject(
        blocked.map(() => ({ ...cached, success: true }))
      )
      await expect(refresh(other)).resolves.toMatchObject({ ...cached, success: true })
    }
  )

  it.skipIf(process.platform === "win32")(
    "stops a status clean filter when the branch menu closes",
    { timeout: 10000 },
    async () => {
      const filter = join(hooks, "clean")
      writeGate(filter, 'echo finished > "$0.finished"\ncat')
      writeFileSync(join(repository, ".gitattributes"), "tracked.txt filter=slow\n")
      git(repository, "add", ".gitattributes")
      git(repository, "commit", "-qm", "Configure clean filter")
      git(repository, "config", "filter.slow.clean", `"${filter}"`)
      const tracked = join(repository, "tracked.txt")
      // A same-size change makes Git consult the clean filter to check the contents.
      writeFileSync(tracked, "modified\n")
      utimesSync(tracked, 1, 1)

      const count = handlers.get("git:getChangedFileCount")!
      const cancel = handlers.get("git:cancelBranchList")!
      const menu = { sender: Object.assign(new EventEmitter(), { id: nextSenderId++ }) }
      const pending = Promise.resolve(count(menu, repository, "main")).catch((error: unknown) => error)
      try {
        await vi.waitFor(() => expect(existsSync(filter + ".started")).toBe(true), { timeout: 5000 })
        await cancel(menu)
        await expect(pending).resolves.toMatchObject({ name: "AbortError" })
        writeFileSync(filter + ".release", "")
        await new Promise<void>((resolve) => setTimeout(resolve, 300))
        expect(existsSync(filter + ".finished")).toBe(false)
        git(repository, "config", "--unset", "filter.slow.clean")
        await expect(invoke("getChangedFileCount", repository, "main")).resolves.toBe(1)
      } finally {
        writeFileSync(filter + ".release", "")
        menu.sender.emit("destroyed")
        await pending
      }
    }
  )

  it.skipIf(process.platform === "win32")(
    "stops the other branch enumeration when one command fails",
    async () => {
      const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf-8" }).trim()
      const bin = join(root, "bin")
      const gate = join(bin, "gate")
      mkdirSync(bin)
      writeGate(gate, 'echo finished > "$0.finished"\nexec "$CMB_TEST_REAL_GIT" "$@"')
      writeFileSync(join(bin, "git"), [
        "#!/bin/sh",
        'if [ "$1" = for-each-ref ]; then',
        '  case "$*" in',
        '    *refs/remotes/origin/*) exec "$CMB_TEST_GIT_GATE" "$@" ;;',
        '    *refs/heads/*)',
        '      until [ -s "$CMB_TEST_GIT_GATE.started" ]; do',
        '        if [ -e "$CMB_TEST_GIT_GATE.release" ]; then exit 1; fi',
        '        sleep 0.02',
        '      done',
        '      echo "test local refs failure" >&2',
        '      exit 128 ;;',
        '  esac',
        'fi',
        'exec "$CMB_TEST_REAL_GIT" "$@"',
        ""
      ].join("\n"), { mode: 0o755 })
      vi.stubEnv("PATH", bin + ":" + process.env.PATH)
      vi.stubEnv("CMB_TEST_REAL_GIT", realGit)
      vi.stubEnv("CMB_TEST_GIT_GATE", gate)
      try {
        await expect(invoke("listBranches", { cwd: repository, forBranchMenu: true, format: "menu" }))
          .resolves.toMatchObject({ success: false, error: "test local refs failure" })
        writeFileSync(gate + ".release", "")
        await new Promise<void>((resolve) => setTimeout(resolve, 300))
        expect(existsSync(gate + ".finished")).toBe(false)
      } finally {
        writeFileSync(gate + ".release", "")
        vi.unstubAllEnvs()
      }
    }
  )

  it.skipIf(process.platform === "win32")(
    "cancels superseded branch menu reads and status scans without cancelling another window",
    { timeout: 20000 },
    async () => {
      const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], {
        encoding: "utf-8"
      }).trim()
      const other = join(root, "other")
      git(root, "clone", "--quiet", repository, other)
      writeFileSync(join(other, "untracked.txt"), "new\n")
      const bin = join(root, "bin")
      mkdirSync(bin)
      const gate = join(bin, "gate")
      writeGate(gate, 'exec "$CMB_TEST_REAL_GIT" "$@"')
      writeFileSync(
        join(bin, "git"),
        [
          "#!/bin/sh",
          'if [ "$PWD" = "$CMB_TEST_SLOW_REPOSITORY" ] &&',
          '  { [ "$1" = for-each-ref ] || [ "$3" = status ] || [ "$2" = --git-dir ]; }; then',
          '  exec "$CMB_TEST_GIT_GATE" "$@"',
          "fi",
          'exec "$CMB_TEST_REAL_GIT" "$@"'
        ].join("\n") + "\n",
        { mode: 0o755 }
      )
      vi.stubEnv("PATH", bin + ":" + process.env.PATH)
      vi.stubEnv("CMB_TEST_REAL_GIT", realGit)
      vi.stubEnv("CMB_TEST_SLOW_REPOSITORY", realpathSync(repository))
      vi.stubEnv("CMB_TEST_GIT_GATE", gate)

      const list = handlers.get("git:listBranches")!
      const cancel = handlers.get("git:cancelBranchList")!
      const count = handlers.get("git:getChangedFileCount")!
      const menu = { sender: Object.assign(new EventEmitter(), { id: 801 }) }
      const independentMenu = { sender: Object.assign(new EventEmitter(), { id: 802 }) }
      const pending = Promise.resolve(list(menu, { cwd: repository, forBranchMenu: true }))
      const settled = vi.fn()
      const observed = pending.then(settled, settled)
      try {
        await vi.waitFor(() => expect(existsSync(gate + ".started")).toBe(true), { timeout: 5000 })
        await expect(
          list(independentMenu, { cwd: other, forBranchMenu: true })
        ).resolves.toMatchObject({ success: true, branch: "main" })
        expect(settled).not.toHaveBeenCalled()
        await expect(list(menu, { cwd: other, forBranchMenu: true })).resolves.toMatchObject({
          success: true,
          branch: "main"
        })
        await expect(pending).resolves.toMatchObject({ success: false, error: "已取消分支读取" })

        const reopened = Promise.resolve(list(menu, { cwd: repository, forBranchMenu: true }))
        const closed = expect(reopened).resolves.toMatchObject({
          success: false,
          error: "已取消分支读取"
        })
        await vi.waitFor(
          () => expect(readFileSync(gate + ".started", "utf-8")).toBe("started\nstarted\n"),
          { timeout: 5000 }
        )
        await cancel(menu)
        await closed

        const supersededCount = Promise.resolve(count(menu, repository, "main")).catch(
          (error: unknown) => error
        )
        await vi.waitFor(
          () => expect(readFileSync(gate + ".started", "utf-8")).toBe("started\n".repeat(3)),
          { timeout: 5000 }
        )
        const otherWindowCount = count(independentMenu, other, "main")
        await expect(list(menu, { cwd: other, forBranchMenu: true })).resolves.toMatchObject({
          success: true,
          branch: "main"
        })
        await expect(supersededCount).resolves.toMatchObject({ name: "AbortError" })
        await expect(otherWindowCount).resolves.toBe(1)

        const closedCount = Promise.resolve(count(menu, repository, "main")).catch(
          (error: unknown) => error
        )
        await vi.waitFor(
          () => expect(readFileSync(gate + ".started", "utf-8")).toBe("started\n".repeat(4)),
          { timeout: 5000 }
        )
        await cancel(menu)
        await expect(closedCount).resolves.toMatchObject({ name: "AbortError" })

        const probe = handlers.get("git:currentBranch")!
        const abandoned = Promise.resolve(probe(menu, repository, true))
        await vi.waitFor(
          () => expect(readFileSync(gate + ".started", "utf-8")).toBe("started\n".repeat(5)),
          { timeout: 5000 }
        )
        await expect(probe(menu, other, true)).resolves.toMatchObject({ branch: "main" })
        await expect(abandoned).resolves.toMatchObject({ error: "已取消仓库探测" })
        await expect(probe(menu, other, "invalid")).resolves.toMatchObject({ isGitRepo: false })
      } finally {
        writeFileSync(gate + ".release", "")
        await observed
        menu.sender.emit("destroyed")
        independentMenu.sender.emit("destroyed")
        vi.unstubAllEnvs()
      }
    }
  )

  it.skipIf(process.platform === "win32")(
    "keeps branch reads available during a slow checkout index check",
    { timeout: 20000 },
    async () => {
      const otherRepository = join(root, "other")
      git(repository, "clone", "--quiet", repository, otherRepository)
      const gate = join(root, "index-check")
      writeGate(gate, 'touch "$0.done"')
      const bin = join(root, "bin")
      mkdirSync(bin)
      writeFileSync(
        join(bin, "git"),
        [
          "#!/bin/sh",
          'if [ "$1" = ls-files ]; then "$CMB_TEST_INDEX_GATE"; fi',
          'PATH="$CMB_TEST_GIT_PATH" exec git "$@"'
        ].join("\n") + "\n",
        { mode: 0o755 }
      )
      const originalPath = process.env.PATH ?? ""
      vi.stubEnv("CMB_TEST_GIT_PATH", originalPath)
      vi.stubEnv("CMB_TEST_INDEX_GATE", gate)
      vi.stubEnv("PATH", [bin, originalPath].join(delimiter))
      const checkout = invoke("createBranch", { cwd: repository, branch: "slow-index" })
      try {
        await vi.waitFor(() => expect(existsSync(gate + ".started")).toBe(true), { timeout: 5000 })
        await expect(invoke("currentBranch", otherRepository)).resolves.toMatchObject({
          isGitRepo: true,
          branch: "main"
        })
        await expect(invoke("listBranches", otherRepository)).resolves.toMatchObject({
          success: true,
          branch: "main"
        })
        expect(existsSync(gate + ".done")).toBe(false)
      } finally {
        try {
          writeFileSync(gate + ".release", "")
          await checkout
        } finally {
          vi.unstubAllEnvs()
        }
      }
      await expect(checkout).resolves.toMatchObject({
        success: true,
        branch: "slow-index",
        headChanged: true
      })
    }
  )

  it.skipIf(process.platform === "win32")(
    "keeps local reads available while post-checkout runs",
    { timeout: 20000 },
    async () => {
      const hook = join(hooks, "post-checkout")
      writeGate(hook, "exit 0")
      let checkoutFinished = false
      const checkout = invoke("createBranch", { cwd: repository, branch: "slow-hook" }).finally(
        () => {
          checkoutFinished = true
        }
      )
      try {
        await vi.waitFor(() => expect(existsSync(hook + ".started")).toBe(true), { timeout: 5000 })
        await expect(invoke("listBranches", repository)).resolves.toMatchObject({
          success: true,
          branch: "slow-hook"
        })
        await expect(invoke("getCommitGraph", { cwd: repository })).resolves.toMatchObject({
          commits: [
            expect.objectContaining({
              refs: expect.arrayContaining([
                { kind: "head", name: "HEAD" },
                { kind: "local", name: "slow-hook" }
              ])
            })
          ]
        })
        expect(checkoutFinished).toBe(false)
      } finally {
        writeFileSync(hook + ".release", "")
        await checkout
      }
    }
  )

  it.skipIf(process.platform === "win32")(
    "allows independent checkouts while serializing checkouts of the same worktree",
    { timeout: 20000 },
    async () => {
      const otherRepository = join(root, "other")
      git(repository, "clone", "--quiet", repository, otherRepository)
      git(otherRepository, "config", "core.hooksPath", join(root, "no-hooks"))
      git(otherRepository, "branch", "other-target")
      git(repository, "branch", "alias-target")
      const alias = join(root, "repo-alias")
      symlinkSync(repository, alias, "dir")

      const hook = join(hooks, "post-checkout")
      writeGate(hook, "exit 0")
      const first = invoke("createBranch", { cwd: repository, branch: "slow-hook" })
      let aliasCheckout: Promise<unknown> | undefined
      let otherCheckout: Promise<unknown> | undefined
      try {
        await vi.waitFor(() => expect(existsSync(hook + ".started")).toBe(true), { timeout: 5000 })
        aliasCheckout = invoke("switchBranch", { cwd: alias, branch: "alias-target" })
        otherCheckout = invoke("switchBranch", { cwd: otherRepository, branch: "other-target" })

        await vi.waitFor(
          () => expect(git(otherRepository, "symbolic-ref", "HEAD")).toBe("refs/heads/other-target"),
          { timeout: 5000 }
        )
        await expect(otherCheckout).resolves.toMatchObject({
          success: true,
          branch: "other-target",
          headChanged: true
        })
        expect(git(alias, "symbolic-ref", "HEAD")).toBe("refs/heads/slow-hook")
        expect(readFileSync(hook + ".started", "utf-8")).toBe("started\n")
      } finally {
        writeFileSync(hook + ".release", "")
        await Promise.allSettled([first, aliasCheckout, otherCheckout])
      }
      await expect(first).resolves.toMatchObject({ success: true, branch: "slow-hook", headChanged: true })
      await expect(aliasCheckout).resolves.toMatchObject({
        success: true,
        branch: "alias-target",
        headChanged: true
      })
      expect(git(repository, "symbolic-ref", "HEAD")).toBe("refs/heads/alias-target")
    }
  )
})
