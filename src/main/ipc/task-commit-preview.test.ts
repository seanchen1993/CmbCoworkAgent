import { execFileSync } from "node:child_process"
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ipcMain, type IpcMainInvokeEvent } from "electron"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { buildGitPanelDiffState, buildGitPanelFileDiffState, registerModelHandlers } from "./models"
import { prepareGitPanelWrite } from "../services/git-worktree-write-gate"
import { resolveTaskCommitTarget } from "../services/task-commit-target"
import { resolveGitOperationPath } from "../services/git-repository-discovery"

const mock = vi.hoisted(() => ({
  binding: vi.fn(),
  currentBinding: vi.fn(),
  dbRun: vi.fn(),
  thread: vi.fn(),
  projection: vi.fn(),
  history: vi.fn(),
  adoption: vi.fn()
}))
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "test" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))
vi.mock("../services/task-commit-binding", () => ({
  readTaskCommitBinding: mock.binding,
  readCurrentTaskCommitBinding: mock.currentBinding
}))
vi.mock("../db", async (load) => ({
  ...(await load<typeof import("../db")>()),
  getDb: () => ({ run: mock.dbRun, exec: () => [] }),
  getThreadCore: mock.thread
}))
vi.mock("../thread-metadata-hydration/client", async (load) => ({
  ...(await load<typeof import("../thread-metadata-hydration/client")>()),
  readThreadGitContextInWorker: mock.projection
}))
vi.mock("./git-panel", async (load) => ({
  ...(await load<typeof import("./git-panel")>()),
  recordGitCommitHistoryAsync: mock.history
}))
vi.mock("../services/adoption-tracker", async (load) => ({
  ...(await load<typeof import("../services/adoption-tracker")>()),
  measureForCommit: mock.adoption
}))
vi.mock("../services/git-hook-service", async (load) => ({
  ...(await load<typeof import("../services/git-hook-service")>()),
  markInAppCommitProcessed: vi.fn()
}))

const container = realpathSync(mkdtempSync(path.join(tmpdir(), "task-commit-preview-")))
const workspace = path.join(container, "chat")
const target = path.join(container, "repo")
const sibling = path.join(container, "linked")
const metadata = { workspacePath: workspace, llmModifiedFiles: ["same.txt"] }
const context = {
  metadata,
  workspacePath: workspace,
  isWorktree: false,
  isGitRepo: false,
  worktreeBaseCommit: null,
  worktreeBranch: null,
  repositories: []
}
const options = { worktreePath: target, commitBindingVersion: "v1" }

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim()
}

beforeAll(() => {
  mkdirSync(workspace)
  mkdirSync(target)
  writeFileSync(path.join(workspace, "same.txt"), "chat copy\n")
  git(target, "init", "-q")
  git(target, "config", "user.name", "test")
  git(target, "config", "user.email", "test@invalid.example")
  writeFileSync(path.join(target, "same.txt"), "target original\n")
  git(target, "add", ".")
  git(target, "commit", "-qm", "initial")
  git(target, "worktree", "add", "-qb", "sibling", sibling)
  registerModelHandlers(ipcMain, undefined, (event) => event.sender.id === 77)
})
beforeEach(() => {
  mock.currentBinding.mockReturnValue({ version: "v1" })
  mock.binding.mockResolvedValue({
    version: "v1",
    workspacePath: workspace,
    repositoryPaths: [target],
    cardNumber: "C-1"
  })
  mock.thread.mockReturnValue({ metadata: JSON.stringify(metadata), created_at: 1 })
  mock.projection.mockResolvedValue({ metadata })
  writeFileSync(path.join(target, "same.txt"), "target modified\n")
})
afterAll(() => rmSync(container, { recursive: true, force: true }))

describe("Git panel task repository reads", { timeout: 30_000 }, () => {
  const event = { sender: { id: 77, once: vi.fn() } } as unknown as IpcMainInvokeEvent
  const repository = { worktreePath: target, panelRepository: true }
  function invoke(
    name: string,
    input: Record<string, unknown> = {},
    sender = event
  ) {
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(
      ([channel]) => channel === "workspace:" + name
    )![1]
    return handler(sender, { threadId: "task", ...input })
  }

  it("lists both sources with their branches, deduplicating an authorized workspace checkout", async () => {
    mock.projection.mockResolvedValue({ metadata: { workspacePath: sibling } })
    mock.binding.mockResolvedValue({
      workspacePath: sibling, repositoryPaths: [target, sibling], version: "v1"
    })
    expect(await invoke("listGitPanelRepositories")).toEqual([
      { path: sibling, branch: "sibling", source: "workspace" },
      { path: target, branch: git(target, "symbolic-ref", "--short", "HEAD"), source: "authorized" }
    ])
  })

  it("commits and discards only selected external files and rejects stale or widened writes", async () => {
    const repo = mkdtempSync(path.join(container, "manual-"))
    git(repo, "init", "-q")
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "user.email", "fixture@example.invalid")
    git(repo, "config", "core.autocrlf", "false")
    for (const file of ["same.txt", "other.txt"]) writeFileSync(path.join(repo, file), "base\n")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "base")
    mock.binding.mockResolvedValue({ workspacePath: workspace, version: "v1", repositoryPaths: [repo] })
    const scope = { panelRepository: true, worktreePath: repo }
    async function snapshot() {
      const diff = await invoke("getGitPanelDiffs", { options: { ...scope, includeDiffs: false } })
      expect(diff.success).toBe(true)
      return { ...scope, panelBindingVersion: diff.panelBindingVersion, panelRevision: diff.panelRevision }
    }
    writeFileSync(path.join(repo, "same.txt"), "changed\n")
    writeFileSync(path.join(repo, "other.txt"), "staged\n")
    git(repo, "add", "other.txt")
    const options = await snapshot()
    const message = "C-1 #comment fix:manual selection #CMBDevClaw"
    expect(await invoke("commitWorktree", { options, message })).toMatchObject({ success: false })
    expect(await invoke("commitWorktree", { options, message, filePaths: ["same.txt"] })).toMatchObject({ success: true })
    expect(git(repo, "diff", "HEAD^", "HEAD", "--name-only")).toBe("same.txt")
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("other.txt")
    expect(await invoke("rejectWorktreeChanges", { options, filePaths: ["other.txt"] })).toMatchObject({ success: false })

    const fresh = await snapshot()
    for (const filePaths of [undefined, [], ["."], ["../chat/same.txt"]]) {
      expect(await invoke("rejectWorktreeChanges", { options: fresh, filePaths })).toMatchObject({ success: false })
    }
    expect(await invoke("rejectWorktreeChanges", { options: fresh, filePaths: ["other.txt"] })).toMatchObject({ success: true })
    expect(readFileSync(path.join(repo, "other.txt"), "utf8")).toBe("base\n")
    git(repo, "rm", "--cached", "other.txt")
    writeFileSync(path.join(repo, "other.txt"), "untracked replacement\n")
    expect(await invoke("rejectWorktreeFile", { options: fresh, filePath: "other.txt" })).toMatchObject({ success: true })
    expect(readFileSync(path.join(repo, "other.txt"), "utf8")).toBe("base\n")
    expect(git(repo, "status", "--porcelain", "--", "other.txt")).toBe("")
    expect(readFileSync(path.join(workspace, "same.txt"), "utf8")).toBe("chat copy\n")
    linkSync(path.join(workspace, "same.txt"), path.join(repo, ".gitignore"))
    const ignore = { options: fresh, targetPath: "logs", kind: "directory" }
    expect(await invoke("addGitignoreEntry", ignore)).toMatchObject({ success: false })
    expect(readFileSync(path.join(workspace, "same.txt"), "utf8")).toBe("chat copy\n")
    rmSync(path.join(repo, ".gitignore"))
    expect(await invoke("addGitignoreEntry", ignore)).toMatchObject({ success: true })
    expect(readFileSync(path.join(repo, ".gitignore"), "utf8")).toContain("logs/")
    expect(await invoke("addGitignoreEntry", {
      options: fresh, targetPath: "pages/[id].tsx", kind: "file"
    })).toMatchObject({ success: true })
    expect(git(repo, "check-ignore", "--", "pages/[id].tsx", "pages/i.tsx")).toBe("pages/[id].tsx")
    writeFileSync(path.join(repo, "new.txt"), "must survive a locked index\n")
    git(repo, "add", "new.txt")
    const indexLock = path.join(repo, ".git", "index.lock")
    writeFileSync(indexLock, "other writer", { flag: "wx" })
    try {
      expect(await invoke("rejectWorktreeFile", { options: fresh, filePath: "new.txt" })).toMatchObject({ success: false })
      expect(readFileSync(path.join(repo, "new.txt"), "utf8")).toBe("must survive a locked index\n")
      expect(readFileSync(indexLock, "utf8")).toBe("other writer")
    } finally {
      rmSync(indexLock)
    }
    mock.binding.mockResolvedValue(null)
    expect(await invoke("rejectWorktreeFile", { options: fresh, filePath: ".gitignore" })).toMatchObject({ success: false })
  })

  it("preserves the manual commit's original index on hook failure and honors a native index lock", async () => {
    const repo = mkdtempSync(path.join(container, "manual-hook-"))
    git(repo, "init", "-q")
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "user.email", "fixture@example.invalid")
    git(repo, "config", "core.autocrlf", "false")
    mock.binding.mockResolvedValue({ workspacePath: workspace, version: "v1", repositoryPaths: [repo] })
    const scope = { panelRepository: true, worktreePath: repo }
    const snapshot = async () => {
      const diff = await invoke("getGitPanelDiffs", { options: { ...scope, includeDiffs: false } })
      expect(diff.success).toBe(true)
      return { ...scope, panelBindingVersion: diff.panelBindingVersion, panelRevision: diff.panelRevision }
    }
    writeFileSync(path.join(repo, "partial.txt"), "initial\n")
    expect(await invoke("commitWorktree", {
      message: "manual initial commit", filePaths: ["partial.txt"], options: await snapshot()
    })).toMatchObject({ success: true })
    git(repo, "checkout", "--detach", "-q")
    const head = git(repo, "rev-parse", "HEAD")
    writeFileSync(path.join(repo, "partial.txt"), "staged\n")
    git(repo, "add", "partial.txt")
    writeFileSync(path.join(repo, "partial.txt"), "worktree\n")
    writeFileSync(path.join(repo, "new.txt"), "new\n")
    const options = await snapshot()
    const commit = () => invoke("commitWorktree", {
      message: "C-1 #comment fix:manual selection #CMBDevClaw", filePaths: ["partial.txt", "new.txt"], options
    })
    const staged = git(repo, "ls-files", "--stage")
    const lock = path.join(repo, ".git", "index.lock")
    writeFileSync(lock, "another writer")
    expect(await commit()).toMatchObject({ success: false })
    expect(readFileSync(lock, "utf8")).toBe("another writer")
    rmSync(lock)
    const hook = path.join(repo, ".git", "hooks", "pre-commit")
    writeFileSync(hook, "#!/bin/sh\ngit diff --cached --name-only > hook-selection\nexit 1\n", { mode: 0o755 })
    git(repo, "config", "core.hooksPath", path.dirname(hook))
    expect(await commit()).toMatchObject({ success: false })
    expect(readFileSync(path.join(repo, "hook-selection"), "utf8").trim().split(/\r?\n/)).toEqual(["new.txt", "partial.txt"])
    expect(git(repo, "rev-parse", "HEAD")).toBe(head)
    expect(git(repo, "ls-files", "--stage")).toBe(staged)
    expect(git(repo, "show", ":partial.txt")).toBe("staged")
    rmSync(hook)
    writeFileSync(path.join(repo, "index-only.txt"), "only indexed copy\n")
    git(repo, "add", "index-only.txt")
    rmSync(path.join(repo, "index-only.txt"))
    expect(await invoke("commitWorktree", {
      message: "selected file has disappeared", filePaths: ["index-only.txt"], options
    })).toMatchObject({ success: false })
    expect(git(repo, "show", ":index-only.txt")).toBe("only indexed copy")
    expect(await commit()).toMatchObject({ success: true })
    expect(git(repo, "show", "HEAD:partial.txt")).toBe("worktree")
    expect(git(repo, "show", ":new.txt")).toBe("new")
  })

  it("preserves the scope of a nested workspace and distinguishes a detached linked checkout", async () => {
    const nested = path.join(target, "session-folder")
    mkdirSync(nested)
    git(sibling, "checkout", "--detach", "-q")
    try {
      mock.projection.mockResolvedValue({ metadata: { workspacePath: nested } })
      mock.binding.mockResolvedValue({
        workspacePath: nested, repositoryPaths: [nested, sibling], version: "v1"
      })
      expect(await invoke("listGitPanelRepositories")).toEqual([
        { path: nested, branch: git(target, "symbolic-ref", "--short", "HEAD"), source: "workspace" },
        { path: sibling, branch: "HEAD（分离）", source: "authorized" }
      ])
    } finally {
      git(sibling, "checkout", "-q", "sibling")
      rmSync(nested, { recursive: true, force: true })
    }
  })

  it("opens changes in an authorized checkout from a plain session without issuing a commit preview", async () => {
    const branch = git(target, "symbolic-ref", "--short", "HEAD")
    expect(await invoke("listGitPanelRepositories")).toEqual([
      { path: target, branch, source: "authorized" }
    ])
    expect(await invoke("getGitPanelMeta", { options: repository })).toMatchObject({
      success: true, worktreeBranch: branch, repositoryRoots: [target]
    })
    expect(await invoke("getGitPanelDiffs", {
      options: { ...repository, includeCommitTarget: true, includeDiffs: false }
    })).toMatchObject({ success: true, changedFiles: ["same.txt"], commitPreviewRevision: undefined })
    const detail = await invoke("getGitPanelFileDiff", {
      filePath: "same.txt", options: repository
    })
    expect(detail.file.diff).toContain("+target modified")
    expect(detail.file.diff).not.toContain("chat copy")
    for (const filePath of [".git/config", "../chat/same.txt", "."]) {
      expect(await invoke("getGitPanelFileDiff", { filePath, options: repository })).toMatchObject({
        success: false
      })
    }
    expect(await invoke("getGitPanelDiffs", {
      options: { worktreePath: sibling, panelRepository: true }
    })).toMatchObject({ success: false })
  })

  it("rejects untrusted renderers, revoked bindings and stale in-flight results", async () => {
    const other = { sender: { id: 78, once: vi.fn() } } as unknown as IpcMainInvokeEvent
    await expect(invoke("listGitPanelRepositories", {}, other)).rejects.toThrow()
    expect(await invoke("getGitPanelDiffs", { options: repository }, other)).toMatchObject({
      success: false
    })
    mock.currentBinding.mockReturnValue(null)
    expect(await invoke("listGitPanelRepositories")).toEqual([])
    expect(await invoke("getGitPanelFileDiff", {
      filePath: "same.txt", options: repository
    })).toMatchObject({ success: false })
    mock.binding.mockResolvedValue(null)
    expect(await invoke("getGitPanelMeta", { options: repository })).toMatchObject({ success: false })
  })

  it("pushes the reviewed external branch and pulls only from its own origin", async () => {
    const fixture = mkdtempSync(path.join(container, "remote-"))
    const local = path.join(fixture, "local")
    const other = path.join(fixture, "other")
    const bare = path.join(fixture, "origin.git")
    git(fixture, "init", "--bare", "-q", bare)
    git(fixture, "clone", "-q", target, local)
    git(local, "remote", "set-url", "origin", bare)
    git(local, "checkout", "-qb", "panel-topic")
    // The current branch tracks an unrelated branch with the same tip; origin/panel-topic
    // still needs to be published and the preview must offer that first push.
    const originalBranch = git(target, "symbolic-ref", "--short", "HEAD")
    git(local, "branch", "--set-upstream-to", `origin/${originalBranch}`, "panel-topic")
    git(local, "branch", "unreviewed")
    git(local, "config", "remote.origin.push", "refs/heads/unreviewed:refs/heads/unreviewed")
    const head = git(local, "rev-parse", "HEAD")
    const workspaceHead = git(sibling, "rev-parse", "HEAD")
    const readOptions = { panelRepository: true, worktreePath: local, includePushability: true }
    mock.binding.mockResolvedValue({
      version: "v1", workspacePath: workspace, repositoryPaths: [local], cardNumber: "CARD"
    })
    const meta = await invoke("getGitPanelMeta", { options: readOptions })
    expect(meta).toMatchObject({
      success: true, worktreeBranch: "panel-topic", panelCardNumber: "CARD", hasPushableCommit: true
    })
    const writeOptions = { ...readOptions, panelBindingVersion: meta.panelBindingVersion, panelRevision: meta.panelRevision }
    expect(await invoke("pullWorktree", { options: { panelRepository: true } })).toMatchObject({ success: false })
    expect(await invoke("pushWorktree", { options: { ...writeOptions, worktreePath: sibling } })).toMatchObject({ success: false })
    expect(await invoke("pushWorktree", { options: writeOptions }, {
      sender: { id: 999 }
    } as IpcMainInvokeEvent)).toMatchObject({ success: false })
    git(local, "checkout", "-q", "unreviewed")
    expect(await invoke("pushWorktree", { options: writeOptions })).toMatchObject({ success: false })
    git(local, "checkout", "-q", "panel-topic")
    const preparation = prepareGitPanelWrite()
    const release = await preparation.reserve(local, Promise.resolve(git(local, "rev-parse", "--absolute-git-dir")))
    try {
      expect(await invoke("pushWorktree", { options: writeOptions })).toMatchObject({ success: false })
    } finally {
      release()
      preparation.dispose()
    }
    expect(git(bare, "for-each-ref", "refs/heads")).toBe("")
    expect(await invoke("pushWorktree", { options: writeOptions })).toMatchObject({ success: true })
    expect(git(bare, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/panel-topic")
    expect(git(bare, "rev-parse", "refs/heads/panel-topic")).toBe(head)
    expect(git(local, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/panel-topic")

    git(fixture, "clone", "-q", "-b", "panel-topic", bare, other)
    git(other, "-c", "user.name=test", "-c", "user.email=test@invalid.example",
      "commit", "--allow-empty", "-qm", "new remote work")
    git(other, "push", "-q", "origin", "panel-topic")
    mock.currentBinding.mockReturnValue(null)
    expect(await invoke("pullWorktree", { options: writeOptions })).toMatchObject({ success: false })
    expect(git(local, "rev-parse", "HEAD")).toBe(head)
    mock.currentBinding.mockReturnValue({ version: "v1" })
    writeFileSync(path.join(local, "same.txt"), "pending local edit\n")
    git(local, "config", "rebase.autoStash", "false")
    expect(await invoke("pullWorktree", { options: writeOptions })).toMatchObject({ success: false })
    expect(git(local, "rev-parse", "HEAD")).toBe(head)
    git(local, "config", "rebase.autoStash", "true")
    git(local, "config", "user.name", "test")
    git(local, "config", "user.email", "test@invalid.example")
    expect(await invoke("pullWorktree", { options: writeOptions })).toMatchObject({ success: true })
    expect(readFileSync(path.join(local, "same.txt"), "utf8").trim()).toBe("pending local edit")
    expect(git(local, "rev-parse", "HEAD")).toBe(git(other, "rev-parse", "HEAD"))
    expect(git(sibling, "rev-parse", "HEAD")).toBe(workspaceHead)
    expect(await invoke("pushWorktree", { options: writeOptions })).toMatchObject({ success: false })
  })

  it("rechecks a same-tip branch switch and authorization after the external pull fetch", async () => {
    const fixture = mkdtempSync(path.join(container, "pull-race-"))
    const writer = path.join(fixture, "writer")
    const bare = path.join(fixture, "origin.git")
    const repo = path.join(fixture, "local")
    git(fixture, "clone", "-q", target, writer)
    git(writer, "checkout", "-qb", "selected")
    git(fixture, "clone", "--bare", "-q", writer, bare)
    git(fixture, "clone", "-q", bare, repo)
    git(repo, "branch", "same-tip")
    const original = git(repo, "rev-parse", "HEAD")
    git(writer, "-c", "user.name=QA", "-c", "user.email=qa@invalid.example", "commit", "--allow-empty", "-qm", "remote change")
    git(writer, "push", "-q", bare, "selected")
    const server = path.join(fixture, "upload-pack")
    writeFileSync(server, [
      "#!/bin/sh",
      ': > "$0.started"',
      'while test ! -f "$0.resume"; do sleep 0.1; done',
      'exec git-upload-pack "$@"', ""
    ].join("\n"), { mode: 0o755 })
    git(repo, "config", "remote.origin.uploadpack", "'" + server.split(path.sep).join("/").replaceAll("'", "'\\''") + "'")
    mock.binding.mockResolvedValue({ version: "v1", workspacePath: workspace, repositoryPaths: [repo] })
    const scope = { panelRepository: true, worktreePath: repo }
    const meta = await invoke("getGitPanelMeta", { options: scope })
    const options = { ...scope, panelBindingVersion: meta.panelBindingVersion, panelRevision: meta.panelRevision }
    for (const change of ["switch", "revoke"]) {
      git(repo, "checkout", "-q", "selected")
      rmSync(server + ".started", { force: true })
      rmSync(server + ".resume", { force: true })
      const pull = invoke("pullWorktree", { options })
      try {
        await vi.waitFor(() => expect(existsSync(server + ".started")).toBe(true), { timeout: 12_000 })
        if (change === "switch") git(repo, "checkout", "-q", "same-tip")
        else mock.currentBinding.mockReturnValue(null)
      } finally {
        writeFileSync(server + ".resume", "")
        await pull
      }
      expect(await pull).toMatchObject({ success: false })
      expect(git(repo, "rev-parse", "selected")).toBe(original)
      expect(git(repo, "rev-parse", "same-tip")).toBe(original)
      expect(git(repo, "for-each-ref", "refs/cmbdevclaw/pull/")).toBe("")
    }
  }, 60_000)

  it("keeps a workspace commit preview alive through an authorized panel read and unmount", async () => {
    const previewContext = { metadata: { workspacePath: target } }
    mock.projection.mockResolvedValue(previewContext)
    const cancelPanel = vi.mocked(ipcMain.handle).mock.calls.find(
      ([channel]) => channel === "workspace:cancelGitPanelReads"
    )![1]
    const previewOptions = { worktreePath: target, includeCommitTarget: true, includeDiffs: false }
    const list = await invoke("getGitPanelDiffs", { options: previewOptions })
    expect(list.commitPreviewRevision).toBeTruthy()

    for (const [channel, preview] of [
      ["getGitPanelDiffs", { options: previewOptions }],
      ["getGitPanelFileDiff", { filePath: "same.txt", options: {
        worktreePath: target, commitPreviewRevision: list.commitPreviewRevision
      } }]
    ] as const) {
      let release!: () => void
      mock.projection.mockImplementationOnce(() => new Promise((resolve) => {
        release = () => resolve(previewContext)
      }))
      const result = Promise.allSettled([invoke(channel, preview)])
      try {
        const panel = await invoke(channel, { filePath: "same.txt", options: repository })
        expect(panel.success).toBe(true)
        cancelPanel(event, "panel")
      } finally {
        release()
      }
      await expect(result).resolves.toMatchObject([{ status: "fulfilled", value: { success: true } }])
    }
  })
})

describe("task-bound commit review", { timeout: 30_000 }, () => {
  it("reads only the registered worktree's changed files from a non-Git conversation", async () => {
    const list = await buildGitPanelDiffState("task", context, { ...options, includeDiffs: false })
    expect(list).toMatchObject({ success: true, changedFiles: ["same.txt"] })
    expect(list.commitPreviewRevision).toBeTruthy()
    expect(list.commitPreviewTarget).toEqual({
      root: target,
      scope: target,
      branch: git(target, "branch", "--show-current")
    })
    const reviewed = { ...options, commitPreviewRevision: list.commitPreviewRevision }
    const detail = await buildGitPanelFileDiffState("task", context, "same.txt", reviewed)
    expect(detail.file?.diff).toContain("+target modified")
    expect(detail.file?.diff).not.toContain("chat copy")
    expect(
      (await buildGitPanelFileDiffState("task", context, ".git/config", reviewed)).success
    ).toBe(false)
    expect((await buildGitPanelDiffState("task", context, { worktreePath: target })).success).toBe(
      false
    )
    expect(await resolveGitOperationPath(workspace, target)).toHaveProperty("error")
    expect(await resolveTaskCommitTarget("task", workspace, sibling, "v1")).toHaveProperty("error")
    expect(await resolveTaskCommitTarget("task", workspace, target, "v0")).toHaveProperty("error")
  })

  it("requires the bound repository even when a sibling is inside the conversation workspace", async () => {
    mock.binding.mockResolvedValue({
      version: "v1",
      workspacePath: container,
      repositoryPaths: [target],
      cardNumber: "C-1"
    })
    expect(await resolveTaskCommitTarget("task", container, sibling, "v1")).toHaveProperty("error")
    expect(await resolveTaskCommitTarget("task", container, sibling)).toMatchObject({
      worktreePath: sibling,
      external: false
    })
    expect(await resolveTaskCommitTarget("task", container, undefined, "v1")).toMatchObject({
      worktreePath: target,
      external: false
    })
    const boundedContext = { ...context, workspacePath: container, isGitRepo: true }
    const diff = await buildGitPanelDiffState("task", boundedContext, {
      commitBindingVersion: "v1"
    })
    expect(diff.commitPreviewTarget?.root).toBe(target)
  })

  it("keeps a nested session review scoped to its directory inside the Git root", async () => {
    const root = path.join(container, "subdir-test")
    const scope = path.join(root, "nested")
    mkdirSync(scope, { recursive: true })
    git(root, "init", "-q")
    git(root, "config", "user.name", "test")
    git(root, "config", "user.email", "test@invalid.example")
    writeFileSync(path.join(root, "outside.txt"), "original\n")
    git(root, "add", ".")
    git(root, "commit", "-qm", "initial")
    writeFileSync(path.join(root, "outside.txt"), "parent change\n")
    writeFileSync(path.join(scope, "only.txt"), "nested file\n")
    mock.binding.mockResolvedValue({
      version: "v1",
      workspacePath: scope,
      repositoryPaths: [scope],
      checkoutRoots: { [scope]: root },
      cardNumber: "C-1"
    })
    const localMetadata = { workspacePath: scope, llmModifiedFiles: [] }
    mock.thread.mockReturnValue({ metadata: JSON.stringify(localMetadata), created_at: 1 })
    mock.projection.mockResolvedValue({ metadata: localMetadata })
    const localContext = {
      ...context,
      workspacePath: scope,
      isGitRepo: true,
      metadata: localMetadata
    }
    const review = await buildGitPanelDiffState("task", localContext, {
      commitBindingVersion: "v1"
    })
    expect(review.commitPreviewTarget).toMatchObject({ root, scope })
    expect(review.changedFiles).toEqual(["only.txt"])
    const reviewed = {
      worktreePath: scope,
      commitBindingVersion: "v1",
      commitPreviewRevision: review.commitPreviewRevision
    }
    expect(
      (await buildGitPanelFileDiffState("task", localContext, "only.txt", reviewed)).file?.diff
    ).toContain("+nested file")
    expect(await resolveTaskCommitTarget("task", scope, root, "v1")).toHaveProperty("error")
    expect(
      (await buildGitPanelFileDiffState("task", localContext, "../outside.txt", reviewed)).success
    ).toBe(false)
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([name]) => name === "workspace:commitWorktree")![1]
    const result = await handler({} as IpcMainInvokeEvent, {
      threadId: "task",
      message: "C-1 #comment fix:nested #CMBDevClaw",
      filePaths: ["only.txt"],
      options: reviewed
    })
    expect(result).toMatchObject({ success: true })
    expect(git(root, "show", "--format=", "--name-only", "HEAD")).toBe("nested/only.txt")
    expect(git(root, "show", "HEAD:outside.txt")).toBe("original")
  })

  it("refuses a directory junction into a sibling worktree", async () => {
    const junction = path.join(target, "alias")
    symlinkSync(sibling, junction, process.platform === "win32" ? "junction" : "dir")
    try {
      expect(await resolveTaskCommitTarget("task", workspace, junction, "v1")).toHaveProperty(
        "error"
      )
      const diff = await buildGitPanelFileDiffState("task", context, "alias/same.txt", options)
      expect(diff.file?.diff || "").not.toContain("target original")
    } finally {
      rmSync(junction, { recursive: true, force: true })
    }
  })

  it("pins both the displayed diff and the bytes authorized for publication", async () => {
    const preview = await buildGitPanelDiffState("task", context, options)
    const reviewed = { ...options, commitPreviewRevision: preview.commitPreviewRevision }
    const parent = git(target, "rev-parse", "HEAD")
    writeFileSync(path.join(target, "same.txt"), "late content\n")
    const detail = await buildGitPanelFileDiffState("task", context, "same.txt", reviewed)
    expect(detail.file?.diff).toContain("+target modified")
    expect(detail.file?.diff).not.toContain("late content")
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([name]) => name === "workspace:commitWorktree")![1]
    const result = await handler({} as IpcMainInvokeEvent, {
      threadId: "task",
      message: "C-1 #comment fix:change #CMBDevClaw",
      filePaths: ["same.txt"],
      options: reviewed
    })
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("内容") })
    expect(git(target, "rev-parse", "HEAD")).toBe(parent)
  })

  it("keeps the other reviewable files when a staged addition was deleted from disk", async () => {
    const vanished = path.join(target, "vanished.txt")
    writeFileSync(vanished, "staged\n")
    git(target, "add", "vanished.txt")
    rmSync(vanished)
    try {
      const preview = await buildGitPanelDiffState("task", context, options)
      expect(preview).toMatchObject({ success: true, changedFiles: ["same.txt"], unavailableFileCount: 1 })
      expect(preview.files.map(file => file.path)).toEqual(["same.txt"])
      expect(git(target, "show", ":vanished.txt")).toBe("staged")
    } finally {
      git(target, "reset", "-q", "HEAD", "--", "vanished.txt")
    }
  })

  it("only authorizes files displayed in this preview", async () => {
    const extra = path.join(target, "another-change.txt")
    writeFileSync(extra, "outside the visible selection\n")
    try {
      const preview = await buildGitPanelDiffState("task", context, {
        ...options,
        visibleFileLimit: 1
      })
      expect(preview.changedFiles).toHaveLength(1)
      expect(preview.omittedFileCount).toBe(1)
      const omitted = preview.changedFiles?.[0] === "same.txt" ? "another-change.txt" : "same.txt"
      const reviewed = { ...options, commitPreviewRevision: preview.commitPreviewRevision }
      expect((await buildGitPanelFileDiffState("task", context, omitted, reviewed)).success).toBe(
        false
      )
      const handler = vi
        .mocked(ipcMain.handle)
        .mock.calls.find(([name]) => name === "workspace:commitWorktree")![1]
      const result = await handler({} as IpcMainInvokeEvent, {
        threadId: "task",
        message: "C-1 #comment fix:change #CMBDevClaw",
        filePaths: [omitted],
        options: reviewed
      })
      expect(result.success).toBe(false)
      const expanded = await buildGitPanelDiffState("task", context, {
        ...options,
        visibleFileLimit: 2
      })
      expect(expanded.changedFiles).toContain(omitted)
    } finally {
      rmSync(extra, { force: true })
    }
  })

  it("rejects hooks which add unrelated files to a confirmed selection", async () => {
    const hooks = path.join(container, "enlarging-hooks")
    mkdirSync(hooks)
    writeFileSync(
      path.join(hooks, "pre-commit"),
      "#!/bin/sh\necho extra > extra.txt\ngit add extra.txt\n",
      { mode: 0o755 }
    )
    git(target, "config", "core.hooksPath", hooks)
    const original = git(target, "rev-parse", "HEAD")
    const stagedTree = git(target, "write-tree")
    try {
      const preview = await buildGitPanelDiffState("task", context, options)
      const handler = vi
        .mocked(ipcMain.handle)
        .mock.calls.find(([name]) => name === "workspace:commitWorktree")![1]
      const result = await handler({} as IpcMainInvokeEvent, {
        threadId: "task",
        message: "C-1 #comment fix:change #CMBDevClaw",
        filePaths: ["same.txt"],
        options: { ...options, commitPreviewRevision: preview.commitPreviewRevision }
      })
      expect(result).toMatchObject({ success: false, error: expect.stringContaining("钩子") })
      expect(git(target, "rev-parse", "HEAD")).toBe(original)
      expect(git(target, "write-tree")).toBe(stagedTree)
    } finally {
      git(target, "config", "--unset", "core.hooksPath")
      rmSync(path.join(target, "extra.txt"), { force: true })
    }
  })

  it("revalidates the reviewed branch and binding, writes the selected file and records its SHA", async () => {
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([name]) => name === "workspace:commitWorktree")![1]
    const preview = await buildGitPanelDiffState("task", context, {
      ...options,
      includeDiffs: false
    })
    const request = {
      threadId: "task",
      message: "C-1 #comment fix:change #CMBDevClaw",
      filePaths: ["same.txt"],
      options: {
        ...options,
        agentInitiated: true,
        commitPreviewRevision: preview.commitPreviewRevision
      }
    }
    const commit = () => handler({} as IpcMainInvokeEvent, request)
    const invalid = await handler({} as IpcMainInvokeEvent, {
      ...request,
      message: "#comment fix:oops #CMBDevClaw"
    })
    expect(invalid).toMatchObject({ success: false, error: expect.stringContaining("任务卡") })
    const original = git(target, "rev-parse", "HEAD")
    const branch = git(target, "branch", "--show-current")
    git(target, "checkout", "-qb", "other-same-sha")
    expect(await commit()).toMatchObject({ success: false })
    git(target, "checkout", "-q", branch)
    mock.binding.mockResolvedValueOnce(null)
    expect(await commit()).toMatchObject({ success: false })
    writeFileSync(path.join(target, "unrelated.txt"), "pre-staged\n")
    git(target, "add", "unrelated.txt")
    expect(await commit()).toMatchObject({ success: true })
    const sha = git(target, "rev-parse", "HEAD")
    expect(sha).not.toBe(original)
    expect(git(target, "show", "--pretty=format:", "--name-only", sha)).toBe("same.txt")
    expect(git(target, "diff", "--cached", "--name-only")).toBe("unrelated.txt")
    expect(git(sibling, "rev-parse", "HEAD")).toBe(original)
    expect(mock.dbRun).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM task_commit_edits"),
      expect.arrayContaining(["task", "v1"])
    )
    expect(mock.adoption).toHaveBeenCalledWith([], sha, expect.any(Number), target)
    expect(mock.history).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: target, commitSha: sha })
    )
  })

  it("preserves partially staged content when a repository hook rejects a reviewed commit", async () => {
    const hooks = path.join(container, "rejecting-hooks")
    mkdirSync(hooks)
    writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    git(target, "config", "core.hooksPath", hooks)
    writeFileSync(path.join(target, "same.txt"), "approved slice\n")
    git(target, "add", "same.txt")
    writeFileSync(path.join(target, "same.txt"), "approved slice\nworktree only\n")
    const original = git(target, "rev-parse", "HEAD")
    const stagedTree = git(target, "write-tree")
    const preview = await buildGitPanelDiffState("task", context, {
      ...options,
      includeDiffs: false
    })
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([name]) => name === "workspace:commitWorktree")![1]
    const result = await handler({} as IpcMainInvokeEvent, {
      threadId: "task",
      message: "C-1 #comment fix:change #CMBDevClaw",
      filePaths: ["same.txt"],
      options: {
        ...options,
        agentInitiated: true,
        commitPreviewRevision: preview.commitPreviewRevision
      }
    })
    expect(result.success).toBe(false)
    expect(git(target, "write-tree")).toBe(stagedTree)
    expect(git(target, "rev-parse", "HEAD")).toBe(original)
  })
})
