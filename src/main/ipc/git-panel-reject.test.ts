import { execFileSync } from "child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

const dbMock = vi.hoisted(() => {
  let metadata = "{}"
  let getCount = 0
  let beforeGet: ((count: number) => void) | null = null
  return {
    getThreadCore: vi.fn(() => {
      getCount += 1
      beforeGet?.(getCount)
      return { thread_id: "thread-test", created_at: 1, metadata }
    }),
    updateThread: vi.fn((_threadId: string, updates: { metadata?: string }) => {
      if (typeof updates.metadata === "string") metadata = updates.metadata
      return { thread_id: "thread-test", metadata }
    }),
    setMetadata: (next: Record<string, unknown>) => {
      metadata = JSON.stringify({ ...next, cmb_thread_incarnation: "test-incarnation" })
    },
    getMetadata: () => JSON.parse(metadata) as Record<string, unknown>,
    setBeforeGet: (callback: ((count: number) => void) | null) => {
      beforeGet = callback
      getCount = 0
    },
    reset: () => {
      metadata = "{}"
      getCount = 0
      beforeGet = null
    }
  }
})

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock("../db", () => ({
  getThreadCore: dbMock.getThreadCore,
  updateThread: dbMock.updateThread
}))

vi.mock("../storage", () => ({
  getOpenworkDir: () => tmpdir()
}))

import { registerGitPanelHandlers } from "./git-panel"

type Handler = (_event: unknown, payload: unknown) => Promise<unknown>

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

function createRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix))
  roots.push(repo)
  gitIn(repo, ["init", "-q"])
  gitIn(repo, ["config", "user.email", "t@t"])
  gitIn(repo, ["config", "user.name", "t"])
  gitIn(repo, ["config", "core.autocrlf", "false"])
  return repo
}

function createNestedRepo(workspacePrefix: string, repoName: string): { workspace: string; repo: string } {
  const workspace = mkdtempSync(join(tmpdir(), workspacePrefix))
  roots.push(workspace)
  const repo = join(workspace, repoName)
  mkdirSync(repo, { recursive: true })
  gitIn(repo, ["init", "-q"])
  gitIn(repo, ["config", "user.email", "t@t"])
  gitIn(repo, ["config", "user.name", "t"])
  gitIn(repo, ["config", "core.autocrlf", "false"])
  return { workspace, repo }
}

function commitFile(repo: string, filePath: string, content: string): void {
  const absPath = join(repo, filePath)
  mkdirSync(join(absPath, ".."), { recursive: true })
  writeFileSync(absPath, content)
  gitIn(repo, ["add", "."])
  gitIn(repo, ["commit", "-q", "-m", `add ${filePath}`])
}

function createRejectHandler(): Handler {
  const handlers = new Map<string, Handler>()
  registerGitPanelHandlers({
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    }
  } as never)
  const handler = handlers.get("workspace:rejectWorktreeChanges")
  if (!handler) throw new Error("workspace:rejectWorktreeChanges handler not registered")
  return handler
}

async function rejectChanges(params: {
  workspacePath: string
  worktreePath?: string
  filePaths?: string[]
  metadataFilePaths?: string[]
}): Promise<{ success: boolean; error?: string; revertedFileCount?: number }> {
  const {
    workspacePath,
    worktreePath = workspacePath,
    filePaths,
    metadataFilePaths = filePaths
  } = params
  const trackedPaths = metadataFilePaths ?? ["tracked.txt", "deleted.txt", "staged-new.txt", "fresh.txt"]
  dbMock.setMetadata({
    workspacePath,
    llmModifiedFiles: trackedPaths,
    llmFileHistory: Object.fromEntries(
      trackedPaths.map((filePath) => [
        filePath,
        [{ exists: true, content: "previous\n" }]
      ])
    ),
    llmRecentlyRevertedFiles: []
  })

  const handler = createRejectHandler()
  return await handler(null, {
    threadId: "thread-test",
    filePaths,
    options: { worktreePath }
  }) as { success: boolean; error?: string; revertedFileCount?: number }
}

afterEach(() => {
  dbMock.reset()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe("git panel reject handlers", () => {
  it("does not clean new worktree metadata when Git context changes during reject", async () => {
    const repo = createRepo("gitpanel-reject-context-race-")
    commitFile(repo, "tracked.txt", "base\n")
    writeFileSync(join(repo, "tracked.txt"), "changed\n")
    dbMock.setMetadata({
      workspacePath: repo,
      gitRoot: repo,
      isWorktree: true,
      worktreeBranch: "old-branch",
      llmModifiedFiles: ["tracked.txt"],
      llmFileHistory: { "tracked.txt": [{ exists: true, content: "old" }] },
      llmRecentlyRevertedFiles: []
    })
    dbMock.setBeforeGet((count) => {
      if (count !== 2) return
      dbMock.setMetadata({
        workspacePath: repo,
        gitRoot: join(repo, "new-context"),
        isWorktree: true,
        worktreeBranch: "new-branch",
        llmModifiedFiles: ["new-context.txt"],
        llmFileHistory: { "new-context.txt": [{ exists: true, content: "new" }] },
        llmRecentlyRevertedFiles: []
      })
    })

    const handler = createRejectHandler()
    const result = await handler(null, {
      threadId: "thread-test",
      filePaths: ["tracked.txt"],
      options: { worktreePath: repo }
    }) as { success: boolean }

    expect(result.success).toBe(true)
    expect(dbMock.getMetadata()).toMatchObject({
      gitRoot: join(repo, "new-context"),
      worktreeBranch: "new-branch",
      llmModifiedFiles: ["new-context.txt"]
    })
  })

  it("restores tracked changes and removes added or untracked files", async () => {
    const repo = createRepo("gitpanel-reject-basic-")
    commitFile(repo, "tracked.txt", "base\n")
    commitFile(repo, "deleted.txt", "delete-me\n")

    writeFileSync(join(repo, "tracked.txt"), "changed\n")
    rmSync(join(repo, "deleted.txt"))
    writeFileSync(join(repo, "staged-new.txt"), "staged\n")
    gitIn(repo, ["add", "staged-new.txt"])
    writeFileSync(join(repo, "fresh.txt"), "fresh\n")

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    try {
      const result = await rejectChanges({
        workspacePath: repo,
        filePaths: ["tracked.txt", "deleted.txt", "staged-new.txt", "fresh.txt"]
      })

      expect(result).toMatchObject({ success: true })
      expect(readFileSync(join(repo, "tracked.txt"), "utf-8")).toBe("base\n")
      expect(readFileSync(join(repo, "deleted.txt"), "utf-8")).toBe("delete-me\n")
      expect(existsSync(join(repo, "staged-new.txt"))).toBe(false)
      expect(existsSync(join(repo, "fresh.txt"))).toBe(false)
      expect(gitIn(repo, ["status", "--porcelain", "--untracked-files=all"])).toBe("")

      const metadata = dbMock.getMetadata()
      expect(metadata.llmModifiedFiles).toEqual([])
      expect(metadata.llmFileHistory).toEqual({})
      expect((metadata.llmRecentlyRevertedFiles as string[]).slice().sort()).toEqual([
        "tracked.txt",
        "deleted.txt",
        "staged-new.txt",
        "fresh.txt"
      ].sort())

      const execLogs = [
        ...logSpy.mock.calls.flat(),
        ...warnSpy.mock.calls.flat(),
        ...errorSpy.mock.calls.flat()
      ].filter((value): value is string => typeof value === "string" && value.includes("[GitPanel][exec]"))
      expect(execLogs.some((line) => line.includes(" status --porcelain"))).toBe(true)
      expect(execLogs.some((line) => line.includes(" restore --source HEAD --staged --worktree"))).toBe(true)
      expect(execLogs.some((line) => line.includes(" reset HEAD"))).toBe(true)
      expect(execLogs.some((line) => line.includes(" clean -f"))).toBe(true)
      expect(execLogs.some((line) => line.includes("[GitPanel][exec][ok]"))).toBe(true)
    } finally {
      logSpy.mockRestore()
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it("reverts a moved file by restoring the previous path and cleaning the new path", async () => {
    const repo = createRepo("gitpanel-reject-move-")
    mkdirSync(join(repo, "src"), { recursive: true })
    commitFile(repo, "src/old.txt", "base\n")

    mkdirSync(join(repo, "dst"), { recursive: true })
    gitIn(repo, ["mv", "src/old.txt", "dst/new.txt"])

    const result = await rejectChanges({
      workspacePath: repo,
      filePaths: ["src/old.txt", "dst/new.txt"]
    })

    expect(result).toMatchObject({ success: true })
    expect(readFileSync(join(repo, "src/old.txt"), "utf-8")).toBe("base\n")
    expect(existsSync(join(repo, "dst/new.txt"))).toBe(false)
    expect(gitIn(repo, ["status", "--porcelain", "--untracked-files=all"])).toBe("")

    const metadata = dbMock.getMetadata()
    expect(metadata.llmModifiedFiles).toEqual([])
    expect(metadata.llmFileHistory).toEqual({})
    expect((metadata.llmRecentlyRevertedFiles as string[]).slice().sort()).toEqual([
      "dst/new.txt",
      "src/old.txt"
    ].sort())
  })

  it("prefers the nested-repo relative path and keeps stage-level diagnostics", async () => {
    const { workspace, repo } = createNestedRepo("gitpanel-reject-workspace-", "OSA_Monitor")
    commitFile(repo, "src/layout/components/Sidebar/Logo.vue", "<template>base</template>\n")

    writeFileSync(
      join(repo, "src/layout/components/Sidebar/Logo.vue"),
      "<template>changed</template>\n"
    )

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    try {
      const result = await rejectChanges({
        workspacePath: workspace,
        worktreePath: repo,
        filePaths: ["OSA_Monitor/src/layout/components/Sidebar/Logo.vue"],
        metadataFilePaths: ["OSA_Monitor/src/layout/components/Sidebar/Logo.vue"]
      })

      expect(result).toMatchObject({ success: true, revertedFileCount: 1 })
      expect(readFileSync(join(repo, "src/layout/components/Sidebar/Logo.vue"), "utf-8")).toBe(
        "<template>base</template>\n"
      )
      expect(gitIn(repo, ["status", "--porcelain", "--untracked-files=all"])).toBe("")

      const metadata = dbMock.getMetadata()
      expect(metadata.llmModifiedFiles).toEqual([])
      expect(metadata.llmFileHistory).toEqual({})
      expect(metadata.llmRecentlyRevertedFiles).toEqual([
        "OSA_Monitor/src/layout/components/Sidebar/Logo.vue"
      ])

      const execLogs = [
        ...logSpy.mock.calls.flat(),
        ...warnSpy.mock.calls.flat(),
        ...errorSpy.mock.calls.flat()
      ].filter((value): value is string => typeof value === "string" && value.includes("[GitPanel][exec]"))
      expect(execLogs.some((line) => line.includes(" status --porcelain"))).toBe(true)
      expect(execLogs.some((line) => line.includes(" restore --source HEAD --staged --worktree"))).toBe(true)

      const stageLogs = logSpy.mock.calls
        .flat()
        .filter((value): value is string => typeof value === "string" && value.includes("[GitPanel][thread-test][reject_all]"))
      expect(stageLogs.some((line) => line.includes("路径解析完成：1 个 pathspec"))).toBe(true)
      expect(stageLogs.some((line) => line.includes("状态扫描完成：1 个改动"))).toBe(true)
      expect(stageLogs.some((line) => line.includes("回退计划：restore=1，clean=0"))).toBe(true)
    } finally {
      logSpy.mockRestore()
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it("strips a duplicated repository-name prefix when the workspace is the repo root", async () => {
    const { repo } = createNestedRepo("gitpanel-reject-root-", "OSA_Monitor")
    commitFile(repo, "src/App.vue", "base\n")
    writeFileSync(join(repo, "src/App.vue"), "changed\n")

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    try {
      const result = await rejectChanges({
        workspacePath: repo,
        worktreePath: repo,
        filePaths: ["OSA_Monitor/src/App.vue"],
        metadataFilePaths: ["OSA_Monitor/src/App.vue"]
      })

      expect(result).toMatchObject({ success: true, revertedFileCount: 1 })
      expect(readFileSync(join(repo, "src/App.vue"), "utf-8")).toBe("base\n")
      expect(gitIn(repo, ["status", "--porcelain", "--untracked-files=all"])).toBe("")

      const execLogs = [
        ...logSpy.mock.calls.flat(),
        ...warnSpy.mock.calls.flat(),
        ...errorSpy.mock.calls.flat()
      ].filter((value): value is string => typeof value === "string" && value.includes("[GitPanel][exec]"))
      const mutatingLogs = execLogs.filter(
        (line) => line.includes(" restore ") || line.includes(" checkout ")
      )
      expect(execLogs.some((line) => line.includes("-- src/App.vue"))).toBe(true)
      expect(mutatingLogs.some((line) => line.includes("-- OSA_Monitor/src/App.vue"))).toBe(false)
    } finally {
      logSpy.mockRestore()
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it("does not strip a real top-level directory that matches the repository name", async () => {
    const { repo } = createNestedRepo("gitpanel-reject-real-prefix-", "OSA_Monitor")
    commitFile(repo, "OSA_Monitor/src/App.vue", "base\n")
    writeFileSync(join(repo, "OSA_Monitor/src/App.vue"), "changed\n")

    const result = await rejectChanges({
      workspacePath: repo,
      worktreePath: repo,
      filePaths: ["OSA_Monitor/src/App.vue"],
      metadataFilePaths: ["OSA_Monitor/src/App.vue"]
    })

    expect(result).toMatchObject({ success: true, revertedFileCount: 1 })
    expect(readFileSync(join(repo, "OSA_Monitor/src/App.vue"), "utf-8")).toBe("base\n")
    expect(gitIn(repo, ["status", "--porcelain", "--untracked-files=all"])).toBe("")
  })
})
