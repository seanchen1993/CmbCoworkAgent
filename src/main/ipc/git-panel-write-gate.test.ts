import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { prepareGitPanelWrite } from "../services/git-worktree-write-gate"

type Handler = (_event: unknown, payload: unknown) => Promise<unknown>
const { handlers, thread } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  thread: { thread_id: "git-write-gate", created_at: 1, metadata: "{}" }
}))

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "cmb-test", getVersion: () => "0.0.0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: (name: string, handler: Handler) => handlers.set(name, handler), on: vi.fn() }
}))

vi.mock("../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db")>()),
  getThreadCore: () => thread
}))
vi.mock("../thread-metadata-hydration/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../thread-metadata-hydration/client")>()),
  readThreadGitContextInWorker: async () => ({ metadata: JSON.parse(thread.metadata) })
}))
vi.mock("../services/code-adoption-push-updater", () => ({
  scheduleMarkCodeAdoptionCommitsPushed: vi.fn()
}))

const panelBusy = /当前工作树正在切换或创建分支/
const checkoutBusy = /当前工作树正在执行 Git 面板写入/
const branchChanged = /当前工作树已切换分支/

it("excludes overlapping panel writes to the same authorized checkout", async () => {
  const root = mkdtempSync(join(tmpdir(), "authorized-gate-"))
  const first = prepareGitPanelWrite("exclusive-panel")
  const other = prepareGitPanelWrite("exclusive-panel")
  const workspace = prepareGitPanelWrite()
  try {
    const release = await first.reserve(root, Promise.resolve(root))
    try {
      await expect(other.reserve(root, Promise.resolve(root))).rejects.toThrow()
      await expect(workspace.reserve(root, Promise.resolve(root))).rejects.toThrow()
    } finally {
      release()
    }
    const releaseWorkspace = await workspace.reserve(root, Promise.resolve(root))
    try {
      await expect(other.reserve(root, Promise.resolve(root))).rejects.toThrow()
    } finally {
      releaseWorkspace()
    }
  } finally {
    first.dispose()
    other.dispose()
    workspace.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform === "win32")("Git panel and checkout write exclusion", () => {
  let harness: string
  let realGit: string
  let workspace: string
  let repoA: string
  let repoB: string
  let nested: string
  let alias: string
  let source: string
  let expectedTip: string

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync(realGit, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Audit",
        GIT_AUTHOR_EMAIL: "audit@example.test",
        GIT_COMMITTER_NAME: "Audit",
        GIT_COMMITTER_EMAIL: "audit@example.test"
      }
    }).replace(/\r?\n$/, "")

  const invoke = (channel: string, payload: unknown): Promise<unknown> => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`Missing IPC handler ${channel}`)
    return handler(null, payload)
  }
  const panel = (action: string, path?: string, fields: Record<string, unknown> = {}) =>
    invoke(`workspace:${action}`, {
      threadId: thread.thread_id,
      ...fields,
      ...(path && { options: { worktreePath: path } })
    })
  const checkout = (action: "switchBranch" | "createBranch", cwd: string, branch: string) =>
    invoke(`git:${action}`, { cwd, branch, kind: "local" })

  beforeAll(async () => {
    harness = await realpath(mkdtempSync(join(tmpdir(), "cmb-git-write-gate-")))
    realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim()
    writeFileSync(
      join(harness, "git"),
      [
        "#!/bin/sh",
        'if [ "$3:$4" = rev-parse:--absolute-git-dir ]; then',
        '  printf "%s\\n" --absolute-git-dir',
        "  exit 0",
        "fi",
        'gate="$CMB_TEST_GIT_WRITE_GATE"',
        'if [ -f "$gate/command" ]; then',
        '  target="$(cat "$gate/target")"',
        '  actual="$(pwd -P)"',
        '  if [ "$1" = "-C" ]; then actual="$2"; fi',
        '  if [ "$actual" = "$target" ]; then',
        '    wanted="$(cat "$gate/command")"',
        '    case "$1:$3" in -C:pull|-C:push) printf "%s\\n" "$3" >> "$gate/writes" ;; esac',
        '    for arg in "$@"; do',
        '      if [ "$arg" = "$wanted" ]; then',
        '        printf "%s\\n" "$@" > "$gate/args"',
        '        touch "$gate/started"',
        '        i=0',
        '        until [ -f "$gate/release" ] || [ "$i" -ge 200 ]; do',
        '          sleep 0.05; i=$((i+1))',
        '        done',
        '        if [ -f "$gate/fail" ]; then echo "deliberate Git error" >&2; exit 128; fi',
        '        break',
        '      fi',
        '    done',
        '  fi',
        'fi',
        'case "$1:$2:$3:$4" in',
        '  -C:*/nested:rev-parse:--git-dir) printf "%s\\n" ../.git; exit 0 ;;',
        'esac',
        'exec "$CMB_TEST_REAL_GIT" "$@"'
      ].join("\n") + "\n",
      { mode: 0o755 }
    )
    vi.stubEnv("CMB_TEST_GIT_WRITE_GATE", harness)
    vi.stubEnv("CMB_TEST_REAL_GIT", realGit)
    vi.stubEnv("CMB_COWORK_AGENT_HOME", join(harness, "app-data"))
    vi.stubEnv("PATH", [harness, process.env.PATH].join(delimiter))
    const { ipcMain } = await import("electron")
    const { registerGitHandlers } = await import("./git")
    const { registerModelHandlers, invalidateGitPanelHeadCaches } = await import("./models")
    registerGitHandlers(invalidateGitPanelHeadCaches)
    registerModelHandlers(ipcMain)
  })

  beforeEach(() => {
    const root = mkdtempSync(join(harness, "workspaces-"))
    workspace = join(root, "group")
    mkdirSync(workspace)
    source = join(root, "source")
    mkdirSync(source)
    git(source, "init", "-q", "-b", "main")
    git(source, "config", "core.hooksPath", join(root, "no-hooks"))
    git(source, "config", "commit.gpgSign", "false")
    writeFileSync(join(source, "tracked.txt"), "before\n")
    git(source, "add", "tracked.txt")
    git(source, "commit", "-qm", "baseline")
    const remote = join(root, "origin.git")
    git(root, "clone", "-q", "--bare", source, remote)
    repoA = join(workspace, "repo-a")
    repoB = join(workspace, "repo-b")
    for (const repo of [repoA, repoB]) {
      git(root, "clone", "-q", remote, repo)
      git(repo, "config", "core.hooksPath", join(root, "no-hooks"))
      git(repo, "config", "commit.gpgSign", "false")
      git(repo, "branch", "topic")
    }
    git(source, "remote", "add", "origin", remote)
    writeFileSync(join(source, "remote.txt"), "remote\n")
    git(source, "add", "remote.txt")
    git(source, "commit", "-qm", "remote change")
    git(source, "push", "-q", "origin", "main")
    expectedTip = git(source, "rev-parse", "HEAD")
    nested = join(repoA, "nested")
    mkdirSync(nested)
    alias = join(root, "alias")
    symlinkSync(repoA, alias, "dir")
    thread.metadata = JSON.stringify({ workspacePath: workspace })
  })

  afterEach(() => {
    for (const file of ["command", "target", "args", "started", "release", "fail", "writes"]) {
      rmSync(join(harness, file), { force: true })
    }
  })

  afterAll(() => {
    vi.unstubAllEnvs()
    if (harness) rmSync(harness, { force: true, recursive: true })
  })

  async function whileGitRuns(
    target: string,
    command: string,
    action: () => Promise<unknown>,
    during: () => Promise<void>,
    fail = false
  ): Promise<unknown> {
    writeFileSync(join(harness, "target"), target)
    writeFileSync(join(harness, "command"), command)
    if (fail) writeFileSync(join(harness, "fail"), "")
    const pending = action()
    try {
      await vi.waitFor(() => expect(existsSync(join(harness, "started"))).toBe(true), {
        timeout: 5000
      })
      await during()
    } finally {
      writeFileSync(join(harness, "release"), "")
      await pending
    }
    return pending
  }

  it("keeps Pull on its original branch while alias checkouts fail busy and another repo can switch", async () => {
    const result = await whileGitRuns(nested, "pull", () => panel("pullWorktree", nested), async () => {
      await expect(checkout("switchBranch", alias, "topic")).resolves.toMatchObject({
        success: false, error: checkoutBusy
      })
      await expect(checkout("createBranch", alias, "new")).resolves.toMatchObject({
        success: false, error: checkoutBusy
      })
      await expect(checkout("switchBranch", repoB, "topic")).resolves.toMatchObject({ success: true })
      expect(git(repoA, "branch", "--show-current")).toBe("main")
    })
    expect(result).toMatchObject({ success: true })
    expect(git(repoA, "rev-parse", "main")).toBe(expectedTip)
    expect(git(repoA, "rev-parse", "topic")).not.toBe(expectedTip)
    await expect(checkout("createBranch", alias, "new")).resolves.toMatchObject({ success: true })
  }, 15_000)

  it("rejects each panel mutation during checkout and continues a batch Pull for the independent repo", async () => {
    const result = await whileGitRuns(repoA, "switch", () => checkout("switchBranch", alias, "topic"), async () => {
      for (const [action, fields] of [
        ["commitWorktree", { message: "should not run" }],
        ["pushWorktree", {}],
        ["pullWorktree", {}],
        ["rejectWorktreeChanges", {}],
        ["rejectWorktreeFile", { filePath: "tracked.txt" }],
        ["addGitignoreEntry", { targetPath: "ignored.txt", kind: "file" }]
      ] as const) {
        await expect(panel(action, nested, fields)).resolves.toMatchObject({
          success: false, error: panelBusy
        })
      }
      await expect(panel("pullWorktree")).resolves.toMatchObject({
        success: false,
        error: expect.stringMatching(/repo-a: 当前工作树正在切换或创建分支/),
        detail: expect.stringContaining("repo-b: 拉取成功")
      })
      expect(git(repoB, "rev-parse", "HEAD")).toBe(expectedTip)
      expect(existsSync(join(nested, ".gitignore"))).toBe(false)
    })
    expect(result).toMatchObject({ success: true, branch: "topic" })
    await expect(
      panel("addGitignoreEntry", nested, { targetPath: "ignored.txt", kind: "file" })
    ).resolves.toMatchObject({ success: true })
  }, 15_000)

  it.each([
    ["commitWorktree", "commit", { message: "local commit" }],
    ["pushWorktree", "push", {}],
    ["rejectWorktreeChanges", "status", {}],
    ["addGitignoreEntry", "rm", { targetPath: "ignored.txt", kind: "file" }],
    ["pullWorktree", "pull", {}]
  ] as const)("%s blocks checkout and releases after Git fails", async (action, command, fields) => {
    writeFileSync(join(nested, "local.txt"), "local changes\n")
    const result = await whileGitRuns(nested, command, () => panel(action, nested, fields), async () => {
      await expect(checkout("createBranch", alias, "new")).resolves.toMatchObject({
        success: false, error: checkoutBusy
      })
    }, true)
    expect(result).toMatchObject({ success: false })
    await expect(checkout("switchBranch", alias, "topic")).resolves.toMatchObject({ success: true })
  }, 15_000)

  it("pulls and pushes the branch from HEAD when thread metadata names a different branch", async () => {
    thread.metadata = JSON.stringify({ workspacePath: repoA, worktreeBranch: "topic" })
    await expect(panel("pullWorktree")).resolves.toMatchObject({ success: true })
    expect(git(repoA, "rev-parse", "main")).toBe(expectedTip)

    git(repoA, "checkout", "-q", "topic")
    thread.metadata = JSON.stringify({ workspacePath: repoA, worktreeBranch: "main" })
    const result = await whileGitRuns(repoA, "push", () => panel("pushWorktree"), async () => {
      const args = readFileSync(join(harness, "args"), "utf8").trimEnd().split("\n")
      expect(args.slice(2)).toEqual(["push", "-u", "origin", "refs/heads/topic"])
    }, true)
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("deliberate Git error") })
  }, 15_000)

  it("pulls the branch tip when origin has an older tag with the same name", async () => {
    const baseline = git(repoA, "rev-parse", "HEAD")
    git(source, "tag", "main", baseline)
    git(source, "push", "-q", "origin", "refs/tags/main")
    git(repoA, "tag", "main", baseline)

    await expect(panel("pullWorktree", repoA)).resolves.toMatchObject({ success: true })
    expect(git(repoA, "rev-parse", "refs/heads/main")).toBe(expectedTip)
    expect(git(repoA, "rev-parse", "refs/tags/main")).toBe(baseline)
  })

  it("pushes a new branch with a same-named local tag and configures its upstream", async () => {
    git(repoA, "checkout", "-q", "topic")
    git(repoA, "tag", "topic")
    git(repoA, "commit", "--allow-empty", "-qm", "topic change")

    await expect(panel("pushWorktree", repoA)).resolves.toMatchObject({ success: true })
    const remote = git(repoA, "remote", "get-url", "origin")
    expect(git(remote, "rev-parse", "refs/heads/topic")).toBe(git(repoA, "rev-parse", "HEAD"))
    expect(git(remote, "tag", "--list", "topic")).toBe("")
    expect(git(repoA, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/topic")
  })

  it("still pulls origin HEAD while keeping a detached worktree detached", async () => {
    git(repoA, "checkout", "--detach", "-q", "HEAD")

    await expect(panel("pullWorktree", repoA)).resolves.toMatchObject({ success: true })
    expect(git(repoA, "rev-parse", "HEAD")).toBe(expectedTip)
    expect(git(repoA, "branch", "--show-current")).toBe("")
  })

  it.each(["pullWorktree", "pushWorktree"])("%s stops when reading an attached branch fails", async (action) => {
    git(repoA, "checkout", "-q", "topic")
    const topicBefore = git(repoA, "rev-parse", "refs/heads/topic")

    const result = await whileGitRuns(repoA, "symbolic-ref", () => panel(action, repoA), async () => {}, true)

    expect(result).toMatchObject({ success: false, error: expect.stringContaining("deliberate Git error") })
    expect(existsSync(join(harness, "writes"))).toBe(false)
    expect(git(repoA, "symbolic-ref", "HEAD")).toBe("refs/heads/topic")
    expect(git(repoA, "rev-parse", "refs/heads/topic")).toBe(topicBefore)
  })

  it("continues a batch Pull when reading one repository's branch fails", async () => {
    const result = await whileGitRuns(repoA, "symbolic-ref", () => panel("pullWorktree"), async () => {}, true)

    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(/repo-a: deliberate Git error/),
      detail: expect.stringContaining("repo-b: 拉取成功")
    })
    expect(existsSync(join(harness, "writes"))).toBe(false)
    expect(git(repoB, "rev-parse", "refs/heads/main")).toBe(expectedTip)
  })

  it("rejects a commit from main when checkout to topic completes during worktree detection", async () => {
    const mainBefore = git(repoA, "rev-parse", "refs/heads/main")
    const topicBefore = git(repoA, "rev-parse", "refs/heads/topic")
    const file = join(nested, "local.txt")
    writeFileSync(file, "pending changes\n")

    const result = await whileGitRuns(
      nested,
      "--git-dir",
      () => panel("commitWorktree", nested, { filePaths: ["local.txt"], message: "commit from main" }),
      async () => {
        expect(git(repoA, "branch", "--show-current")).toBe("main")
        await expect(checkout("switchBranch", alias, "topic")).resolves.toMatchObject({ success: true })
      }
    )

    expect(result).toMatchObject({ success: false, error: branchChanged })
    expect(git(repoA, "branch", "--show-current")).toBe("topic")
    expect(git(repoA, "rev-parse", "refs/heads/main")).toBe(mainBefore)
    expect(git(repoA, "rev-parse", "refs/heads/topic")).toBe(topicBefore)
    expect(git(repoA, "status", "--porcelain", "--untracked-files=all")).toBe("?? nested/local.txt")
    expect(readFileSync(file, "utf8")).toBe("pending changes\n")
  }, 15_000)

  it("records the actual commit in its original workspace even if the thread switches workspaces", async () => {
    thread.metadata = JSON.stringify({ workspacePath: repoA })
    git(repoA, "config", "user.name", "Audit")
    git(repoA, "config", "user.email", "audit@example.test")
    git(repoB, "checkout", "-q", "topic")
    const otherTip = git(repoB, "rev-parse", "HEAD")
    writeFileSync(join(repoA, "tracked.txt"), "committed in repo-a\n")
    const message = "TEST-1 #comment fix:keep original workspace history #CMBDevClaw"

    const result = await whileGitRuns(
      repoA,
      "commit",
      () => panel("commitWorktree", undefined, { filePaths: ["tracked.txt"], message }),
      async () => {
        thread.metadata = JSON.stringify({ workspacePath: repoB })
      }
    )
    expect(result).toMatchObject({ success: true })
    const commitSha = git(repoA, "rev-parse", "HEAD")
    expect(git(repoA, "log", "-1", "--format=%s")).toBe(message)
    expect(git(repoB, "rev-parse", "HEAD")).toBe(otherTip)
    await expect(invoke("git-panel:getCommitHistory", { threadId: thread.thread_id })).resolves.toMatchObject({
      success: true, projectPath: repoB, records: []
    })

    thread.metadata = JSON.stringify({ workspacePath: repoA })
    await expect(invoke("git-panel:getCommitHistory", { threadId: thread.thread_id })).resolves.toMatchObject({
      success: true,
      projectPath: repoA,
      records: [{ projectPath: repoA, branch: "main", commitSha, fullMessage: message }]
    })
  }, 15_000)

  it("pulls repo-a after checkout in repo-b completes during worktree detection", async () => {
    const result = await whileGitRuns(nested, "--git-dir", () => panel("pullWorktree", nested), async () => {
      await expect(checkout("switchBranch", repoB, "topic")).resolves.toMatchObject({ success: true })
    })

    expect(result).toMatchObject({ success: true })
    expect(git(repoA, "branch", "--show-current")).toBe("main")
    expect(git(repoA, "rev-parse", "refs/heads/main")).toBe(expectedTip)
    expect(git(repoB, "branch", "--show-current")).toBe("topic")
    expect(git(repoB, "rev-parse", "refs/heads/main")).not.toBe(expectedTip)
  }, 15_000)

  it("lets ordinary panel writes overlap and keeps checkout blocked until both have released", async () => {
    rmSync(join(nested, ".gitignore"), { force: true })
    const result = await whileGitRuns(nested, "push", () => panel("pushWorktree", nested), async () => {
      await expect(
        panel("addGitignoreEntry", nested, { targetPath: "ignored.txt", kind: "file" })
      ).resolves.toMatchObject({ success: true })
      expect(readFileSync(join(nested, ".gitignore"), "utf8")).toBe("ignored.txt\n")
      await expect(checkout("switchBranch", alias, "topic")).resolves.toMatchObject({
        success: false, error: checkoutBusy
      })
    }, true)
    expect(result).toMatchObject({ success: false })
    await expect(checkout("switchBranch", alias, "topic")).resolves.toMatchObject({ success: true })
  }, 15_000)
})
