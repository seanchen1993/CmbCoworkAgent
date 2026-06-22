/**
 * Git Panel lazy-diff behavior.
 *
 * Locks down the performance optimization where opening the Git Panel / Agent
 * commit dialog no longer computes every file's diff up front:
 *   - includeDiffs:false returns the file list + numstat only (diffLoaded:false)
 *   - per-file diffs are fetched on demand via buildGitPanelFileDiff
 *   - untracked new files still report accurate +additions in the lazy list
 *     (they are absent from `git diff --numstat HEAD`, so stats are estimated)
 *
 * Runs against a throwaway git repo. electron is stubbed so importing models.ts
 * (which pulls in electron at module load) doesn't blow up outside Electron.
 */

import { execFileSync } from "child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { basename, dirname, join } from "path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "cmb-test", getVersion: () => "0.0.0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => undefined }
}))

import {
  buildGitPanelDiffState,
  buildGitPanelFileDiff,
  buildGitPanelFileDiffState,
  buildGitPanelState,
  shouldUseDefaultGitPush
} from "./models"

type GitPanelTestContext = Parameters<typeof buildGitPanelDiffState>[1]

let repo: string

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

function git(args: string[]): string {
  return gitIn(repo, args)
}

function createRepo(prefix: string): string {
  const repoPath = mkdtempSync(join(tmpdir(), prefix))
  gitIn(repoPath, ["init", "-q"])
  gitIn(repoPath, ["config", "user.email", "t@t"])
  gitIn(repoPath, ["config", "user.name", "t"])
  return repoPath
}

function createGitPanelTestContext(
  workspacePath: string,
  metadata: Record<string, unknown> = {}
): GitPanelTestContext {
  return {
    workspacePath,
    isGitRepo: true,
    isWorktree: false,
    metadata
  } as GitPanelTestContext
}

beforeAll(() => {
  repo = createRepo("gitpanel-diff-")
  writeFileSync(join(repo, "tracked.txt"), "line1\nline2\nline3\n")
  git(["add", "."])
  git(["commit", "-q", "-m", "init"])

  // Modify a tracked file (numstat HEAD covers this).
  writeFileSync(join(repo, "tracked.txt"), "line1\nline2 changed\nline3\nline4\n")
  // Add an untracked new file (numstat HEAD does NOT cover this — Part B path).
  writeFileSync(join(repo, "fresh.txt"), "new-a\nnew-b\nnew-c\n")
})

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true })
})

describe("buildGitPanelState — lazy mode (includeDiffs:false)", () => {
  it("returns file list + stats without diff bodies", async () => {
    const state = await buildGitPanelState(repo, [], {
      silent: true,
      includeAllWhenNoTracked: true,
      includeDiffs: false,
      includeChangedFiles: true
    })

    const paths = state.files.map((f) => f.path).sort()
    expect(paths).toEqual(["fresh.txt", "tracked.txt"])

    // Core of the optimization: no diff bodies are computed up front.
    for (const file of state.files) {
      expect(file.diffLoaded).toBe(false)
      expect(file.diff).toBe("")
    }

    // includeChangedFiles:true → commit "select all" data is present.
    expect(state.changedFiles.length).toBeGreaterThan(0)
    expect(state.changedFilesTotal).toBe(2)
  })

  it("reports accurate +additions for untracked new files (Part B fix)", async () => {
    const state = await buildGitPanelState(repo, [], {
      silent: true,
      includeAllWhenNoTracked: true,
      includeDiffs: false,
      includeChangedFiles: true
    })

    const fresh = state.files.find((f) => f.path === "fresh.txt")
    const tracked = state.files.find((f) => f.path === "tracked.txt")

    // Untracked file is absent from `git diff --numstat HEAD`; without the
    // estimate it would show +0. It must report its line count instead.
    expect(fresh?.additions).toBeGreaterThan(0)
    // Modified tracked file keeps real numstat values.
    expect(tracked?.additions).toBeGreaterThan(0)
  })

  it("keeps untracked directories collapsed in lightweight list mode", async () => {
    const localRepo = createRepo("gitpanel-untracked-dir-")
    try {
      mkdirSync(join(localRepo, "bulk"), { recursive: true })
      writeFileSync(join(localRepo, "bulk", "a.txt"), "a\n")
      writeFileSync(join(localRepo, "bulk", "b.txt"), "b\n")

      const state = await buildGitPanelState(localRepo, [], {
        silent: true,
        includeAllWhenNoTracked: true,
        includeDiffs: false,
        includeChangedFiles: true,
        statusUntrackedMode: "normal"
      })

      expect(state.files.map((f) => f.path)).toEqual(["bulk"])
      expect(state.changedFiles).toEqual(["bulk"])
      expect(state.files.map((f) => f.path)).not.toContain("bulk/a.txt")
      expect(state.files[0]?.diffLoaded).toBe(false)
    } finally {
      rmSync(localRepo, { recursive: true, force: true })
    }
  })
})

describe("buildGitPanelState — full mode (includeDiffs:true)", () => {
  it("includes diff bodies marked diffLoaded", async () => {
    const state = await buildGitPanelState(repo, [], {
      silent: true,
      includeAllWhenNoTracked: true,
      includeDiffs: true,
      includeChangedFiles: true
    })

    const tracked = state.files.find((f) => f.path === "tracked.txt")
    expect(tracked?.diffLoaded).toBe(true)
    expect(tracked?.diff).toContain("line2 changed")
  })
})

describe("buildGitPanelDiffState — workspace review scope", () => {
  it("includes manual workspace changes even when llmModifiedFiles is present", async () => {
    const localRepo = createRepo("gitpanel-full-scope-")
    try {
      writeFileSync(join(localRepo, "llm.txt"), "base\n")
      writeFileSync(join(localRepo, "manual.txt"), "base\n")
      gitIn(localRepo, ["add", "."])
      gitIn(localRepo, ["commit", "-q", "-m", "init"])

      writeFileSync(join(localRepo, "llm.txt"), "base\nllm\n")
      writeFileSync(join(localRepo, "manual.txt"), "base\nmanual\n")

      const state = await buildGitPanelDiffState(
        "thread-test",
        createGitPanelTestContext(localRepo, { llmModifiedFiles: ["llm.txt"] }),
        { includeDiffs: false, includeChangedFiles: true }
      )

      expect(state.success).toBe(true)
      expect(state.files.map((f) => f.path).sort()).toEqual(["llm.txt", "manual.txt"])
      expect([...(state.changedFiles ?? [])].sort()).toEqual(["llm.txt", "manual.txt"])
      expect(state.changedFilesTotal).toBe(2)
    } finally {
      rmSync(localRepo, { recursive: true, force: true })
    }
  })
})

describe("buildGitPanelFileDiff — on-demand single file", () => {
  it("loads an untracked file's synthesized diff and stats", async () => {
    const result = await buildGitPanelFileDiff(repo, "fresh.txt", { silent: true })
    expect(result).not.toBeNull()
    expect(result?.diffLoaded).toBe(true)
    expect(result?.additions).toBeGreaterThan(0)
    expect(result?.diff).toContain("new-a")
  })

  it("loads a modified tracked file's diff", async () => {
    const result = await buildGitPanelFileDiff(repo, "tracked.txt", { silent: true })
    expect(result?.diffLoaded).toBe(true)
    expect(result?.diff).toContain("line2 changed")
  })

  it("rejects traversal paths before synthesizing untracked file diffs", async () => {
    const localRepo = createRepo("gitpanel-traversal-")
    const outsideName = `${basename(localRepo)}-outside.txt`
    const outsidePath = join(dirname(localRepo), outsideName)
    try {
      mkdirSync(join(localRepo, "safe"), { recursive: true })
      writeFileSync(outsidePath, "outside-secret\n")

      const result = await buildGitPanelFileDiff(localRepo, `safe/../../${outsideName}`, {
        silent: true
      })

      expect(result).toBeNull()
    } finally {
      rmSync(outsidePath, { force: true })
      rmSync(localRepo, { recursive: true, force: true })
    }
  })

  it("rejects traversal paths at the single-file IPC state boundary", async () => {
    const localRepo = createRepo("gitpanel-ipc-traversal-")
    const outsideName = `${basename(localRepo)}-outside.txt`
    const outsidePath = join(dirname(localRepo), outsideName)
    try {
      mkdirSync(join(localRepo, "safe"), { recursive: true })
      writeFileSync(outsidePath, "outside-secret\n")

      const payload = await buildGitPanelFileDiffState(
        "thread-test",
        createGitPanelTestContext(localRepo),
        `safe/../../${outsideName}`
      )

      expect(payload.success).toBe(false)
      expect(payload.error).toContain("不在当前工作区")
    } finally {
      rmSync(outsidePath, { force: true })
      rmSync(localRepo, { recursive: true, force: true })
    }
  })

  it("returns a renderable omitted notice when a diff exceeds the safety buffer", async () => {
    const localRepo = createRepo("gitpanel-large-diff-")
    try {
      writeFileSync(join(localRepo, "large.txt"), `${"a".repeat(900 * 1024)}\n`)
      gitIn(localRepo, ["add", "."])
      gitIn(localRepo, ["commit", "-q", "-m", "large"])
      writeFileSync(join(localRepo, "large.txt"), `${"b".repeat(900 * 1024)}\n`)

      const result = await buildGitPanelFileDiff(localRepo, "large.txt", { silent: true })

      expect(result?.diffLoaded).toBe(true)
      expect(result?.diff).toContain("[diff omitted: output exceeded")
      expect(result?.diff).toContain("@@ -0,0 +1 @@")
      expect(result?.additions).toBeGreaterThan(0)
      expect(result?.deletions).toBeGreaterThan(0)
    } finally {
      rmSync(localRepo, { recursive: true, force: true })
    }
  })
})

describe("shouldUseDefaultGitPush", () => {
  it("only uses default git push when upstream is origin/current-branch", () => {
    expect(shouldUseDefaultGitPush("origin/feature/a", "feature/a")).toBe(true)
    expect(shouldUseDefaultGitPush("origin/main", "feature/a")).toBe(false)
    expect(shouldUseDefaultGitPush("fork/feature/a", "feature/a")).toBe(false)
    expect(shouldUseDefaultGitPush(null, "feature/a")).toBe(false)
    expect(shouldUseDefaultGitPush("origin/HEAD", "HEAD")).toBe(false)
  })
})
