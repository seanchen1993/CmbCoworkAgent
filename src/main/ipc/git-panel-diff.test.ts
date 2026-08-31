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
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "fs"
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
  buildGitPanelMetaState,
  buildGitPanelState,
  collectChangedFileEntriesFromStatus,
  pathExistsForGitAdd,
  resolveSelectedChangedFilesForGitOps,
  shouldUseDefaultGitPush
} from "./models"
import { discoverWorkspaceGitRepositories } from "../services/git-repository-discovery"

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

function createBareRepo(prefix: string): string {
  const repoPath = mkdtempSync(join(tmpdir(), prefix))
  gitIn(repoPath, ["init", "--bare", "-q"])
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

  it("reports zero additions for empty untracked files", async () => {
    const localRepo = createRepo("gitpanel-empty-untracked-")
    try {
      writeFileSync(join(localRepo, "empty.txt"), "")

      const lazy = await buildGitPanelState(localRepo, [], {
        silent: true,
        includeAllWhenNoTracked: true,
        includeDiffs: false,
        includeChangedFiles: true
      })
      const collapsed = lazy.files.find((f) => f.path === "empty.txt")
      expect(collapsed?.additions).toBe(0)
      expect(collapsed?.deletions).toBe(0)

      const expanded = await buildGitPanelFileDiff(localRepo, "empty.txt", { silent: true })
      expect(expanded?.additions).toBe(0)
      expect(expanded?.deletions).toBe(0)
    } finally {
      rmSync(localRepo, { recursive: true, force: true })
    }
  })

  it("matches collapsed numstat for non-ASCII paths (quotepath regression)", async () => {
    // git 默认 core.quotepath=true，会把中文路径输出成 "docs/\346..." 的转义形式。
    // 折叠态走 parseNumstatByPath 按路径命中，必须与 status 一样解码，否则会匹配不到
    // numstat、把已修改文件的行数错误地回退成全文件估算（展开后才修正）。
    const localRepo = createRepo("gitpanel-non-ascii-")
    try {
      // 显式打开 quotepath（git 默认值），让本用例不受开发机全局
      // core.quotepath=false 影响——否则 numstat 会直接吐 UTF-8，bug 无法复现、
      // 测试沦为假通过。被测代码走 `git -C <repo>`，本地配置必然生效。
      gitIn(localRepo, ["config", "core.quotepath", "true"])

      const name = "文档/性能优化.txt"
      mkdirSync(join(localRepo, "文档"), { recursive: true })
      writeFileSync(join(localRepo, name), "第一行\n第二行\n第三行\n")
      gitIn(localRepo, ["add", "."])
      gitIn(localRepo, ["commit", "-q", "-m", "init"])
      // 仅改 1 行：真实 numstat 应为 +1/-1，而非全文件估算。
      writeFileSync(join(localRepo, name), "第一行改\n第二行\n第三行\n")

      const lazy = await buildGitPanelState(localRepo, [], {
        silent: true,
        includeAllWhenNoTracked: true,
        includeDiffs: false,
        includeChangedFiles: true
      })
      const collapsed = lazy.files.find((f) => f.path === name)
      expect(collapsed).toBeDefined()
      expect(collapsed?.additions).toBe(1)
      expect(collapsed?.deletions).toBe(1)

      // 折叠态行数必须与展开后按需加载的精确口径一致。
      const expanded = await buildGitPanelFileDiff(localRepo, name, { silent: true })
      expect(collapsed?.additions).toBe(expanded?.additions)
      expect(collapsed?.deletions).toBe(expanded?.deletions)
    } finally {
      rmSync(localRepo, { recursive: true, force: true })
    }
  })

  it("expands untracked directories to file-level entries (not folder rows)", async () => {
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

      // 未跟踪目录应展开到具体文件，而不是一个光秃秃的 `bulk` 文件夹条目。
      expect(state.files.map((f) => f.path).sort()).toEqual(["bulk/a.txt", "bulk/b.txt"])
      expect(state.files.map((f) => f.path)).not.toContain("bulk")
      expect(state.files[0]?.diffLoaded).toBe(false)
    } finally {
      rmSync(localRepo, { recursive: true, force: true })
    }
  })

  it("excludes UNTRACKED noise dirs but keeps TRACKED changes under them", async () => {
    const localRepo = createRepo("gitpanel-noise-dirs-")
    try {
      // 一个被刻意提交进仓库的 dist 文件：它的真实改动必须照常展示。
      mkdirSync(join(localRepo, "dist"), { recursive: true })
      writeFileSync(join(localRepo, "dist", "keep.js"), "v1\n")
      gitIn(localRepo, ["add", "dist/keep.js"])
      gitIn(localRepo, ["commit", "-q", "-m", "init"])
      writeFileSync(join(localRepo, "dist", "keep.js"), "v2\n")

      // 故意不写 .gitignore：未跟踪的 node_modules / dist 构建产物仍不应进入评审列表，
      // 而用户真实的新建源码目录要展开到文件级。
      mkdirSync(join(localRepo, "node_modules", "pkg"), { recursive: true })
      writeFileSync(join(localRepo, "node_modules", "pkg", "index.js"), "module.exports={}\n")
      writeFileSync(join(localRepo, "dist", "untracked-bundle.js"), "console.log(1)\n")
      mkdirSync(join(localRepo, "src", "feature", "node_modules"), { recursive: true })
      writeFileSync(join(localRepo, "src", "feature", "node_modules", "nested.js"), "x\n")
      writeFileSync(join(localRepo, "src", "feature", "real.ts"), "export const a = 1\n")

      const state = await buildGitPanelState(localRepo, [], {
        silent: true,
        includeAllWhenNoTracked: true,
        includeDiffs: false,
        includeChangedFiles: true
      })

      const paths = state.files.map((f) => f.path)
      // 已跟踪的 dist 改动必须保留（核心 P1 回归点）。
      expect(paths).toContain("dist/keep.js")
      // 用户真实新建源码文件要展开到文件级。
      expect(paths).toContain("src/feature/real.ts")
      // 顶层/嵌套的未跟踪 node_modules、以及未跟踪的 dist 产物都必须被排除。
      expect(paths.some((p) => p.includes("node_modules"))).toBe(false)
      expect(paths).not.toContain("dist/untracked-bundle.js")
    } finally {
      rmSync(localRepo, { recursive: true, force: true })
    }
  })

  it("excludes gitignored untracked files but keeps tracked files matching the same rule", async () => {
    const localRepo = createRepo("gitpanel-gitignore-")
    try {
      writeFileSync(join(localRepo, ".gitignore"), "*.log\n")
      writeFileSync(join(localRepo, "tracked.log"), "before\n")
      gitIn(localRepo, ["add", ".gitignore"])
      gitIn(localRepo, ["add", "-f", "tracked.log"])
      gitIn(localRepo, ["commit", "-q", "-m", "init"])

      writeFileSync(join(localRepo, "tracked.log"), "after\n")
      writeFileSync(join(localRepo, "debug.log"), "ignored\n")
      writeFileSync(join(localRepo, "feature.ts"), "export const feature = true\n")

      const state = await buildGitPanelState(localRepo, [], {
        silent: true,
        includeAllWhenNoTracked: true,
        includeDiffs: false,
        includeChangedFiles: true
      })

      expect(state.changedFiles.sort()).toEqual(["feature.ts", "tracked.log"])
      expect(state.files.map((file) => file.path).sort()).toEqual(["feature.ts", "tracked.log"])

      const selected = await resolveSelectedChangedFilesForGitOps(localRepo, [
        "debug.log",
        "feature.ts",
        "tracked.log"
      ])
      const ignoredOnly = await resolveSelectedChangedFilesForGitOps(localRepo, ["debug.log"])
      expect(selected.sort()).toEqual(["feature.ts", "tracked.log"])
      expect(ignoredOnly).toEqual([])

      // Even if an earlier command force-added an ignored, HEAD-untracked file,
      // the Agent commit backend must not treat that index entry as eligible.
      gitIn(localRepo, ["add", "-f", "debug.log"])
      const forceAddedSelection = await resolveSelectedChangedFilesForGitOps(localRepo, [
        "debug.log",
        "feature.ts",
        "tracked.log"
      ], [], { excludeNewIgnored: true })
      expect(forceAddedSelection.sort()).toEqual(["feature.ts", "tracked.log"])

      const manualSelection = await resolveSelectedChangedFilesForGitOps(localRepo, ["debug.log"])
      expect(manualSelection).toEqual(["debug.log"])
    } finally {
      rmSync(localRepo, { recursive: true, force: true })
    }
  })

  it("preserves leading spaces in untracked file names while filtering noise dirs", async () => {
    const localRepo = createRepo("gitpanel-leading-space-")
    try {
      writeFileSync(join(localRepo, " leading.ts"), "export const spaced = true\n")
      mkdirSync(join(localRepo, "node_modules", "pkg"), { recursive: true })
      writeFileSync(join(localRepo, "node_modules", "pkg", "index.js"), "module.exports={}\n")

      const state = await buildGitPanelState(localRepo, [], {
        silent: true,
        includeAllWhenNoTracked: true,
        includeDiffs: false,
        includeChangedFiles: true
      })

      const paths = state.files.map((f) => f.path)
      expect(paths).toContain(" leading.ts")
      expect(paths).not.toContain("leading.ts")
      expect(paths.some((p) => p.includes("node_modules"))).toBe(false)
    } finally {
      rmSync(localRepo, { recursive: true, force: true })
    }
  })

  it("keeps collapsed numstat accurate for tracked paths with leading spaces", async () => {
    const localRepo = createRepo("gitpanel-leading-space-numstat-")
    try {
      const name = " leading.ts"
      writeFileSync(join(localRepo, name), "one\ntwo\nthree\n")
      gitIn(localRepo, ["add", "."])
      gitIn(localRepo, ["commit", "-q", "-m", "init"])
      // Only touch part of the tracked file. If numstat path matching trims the
      // leading space, lazy mode falls back to whole-file new-file estimation.
      writeFileSync(join(localRepo, name), "one changed\ntwo\nthree\nfour\n")

      const lazy = await buildGitPanelState(localRepo, [], {
        silent: true,
        includeAllWhenNoTracked: true,
        includeDiffs: false,
        includeChangedFiles: true
      })
      const collapsed = lazy.files.find((f) => f.path === name)
      expect(collapsed).toBeDefined()
      expect(collapsed?.additions).toBe(2)
      expect(collapsed?.deletions).toBe(1)

      const expanded = await buildGitPanelFileDiff(localRepo, name, { silent: true })
      expect(collapsed?.additions).toBe(expanded?.additions)
      expect(collapsed?.deletions).toBe(expanded?.deletions)
    } finally {
      rmSync(localRepo, { recursive: true, force: true })
    }
  })

  it("counts a filesystem move as ONE renamed entry (header/list count parity)", async () => {
    const localRepo = createRepo("gitpanel-move-count-")
    try {
      writeFileSync(join(localRepo, "fileA.txt"), "shared content line\n")
      gitIn(localRepo, ["add", "."])
      gitIn(localRepo, ["commit", "-q", "-m", "init"])
      // 未暂存的文件系统重命名：status 里是“删除 fileA + 新增 fileB”两条。
      renameSync(join(localRepo, "fileA.txt"), join(localRepo, "fileB.txt"))

      const state = await buildGitPanelState(localRepo, [], {
        silent: true,
        includeAllWhenNoTracked: true,
        includeDiffs: false,
        includeChangedFiles: true
      })

      // 移动合并后必须是 1 条重命名，且 changedFilesTotal 与实际列表长度一致。
      expect(state.changedFilesTotal).toBe(1)
      expect(state.files).toHaveLength(1)
      expect(state.files[0]?.path).toBe("fileB.txt")
      expect(state.files[0]?.status).toBe("renamed")
      expect(state.files[0]?.previousPath).toBe("fileA.txt")

      // 核心回归点：header 的快速摘要（buildGitPanelMetaState）必须同样合并移动，
      // 算成 1 而不是“删除 + 新增”的 2，否则点开详情前后数量对不上。
      const meta = await buildGitPanelMetaState("thread-test", createGitPanelTestContext(localRepo))
      expect(meta.changedFilesTotal).toBe(1)
    } finally {
      rmSync(localRepo, { recursive: true, force: true })
    }
  })

  it("does not widen an explicit path using filesystem-move heuristics", async () => {
    const localRepo = createRepo("gitpanel-selected-untracked-")
    try {
      writeFileSync(join(localRepo, "unrelated-delete.ts"), "shared content\n")
      gitIn(localRepo, ["add", "."])
      gitIn(localRepo, ["commit", "-q", "-m", "init"])
      rmSync(join(localRepo, "unrelated-delete.ts"))
      writeFileSync(join(localRepo, "selected-new.ts"), "shared content\n")

      const selected = await resolveSelectedChangedFilesForGitOps(localRepo, ["selected-new.ts"])

      expect(selected).toEqual(["selected-new.ts"])
    } finally {
      rmSync(localRepo, { recursive: true, force: true })
    }
  })

  it("keeps both explicitly supplied paths for an indexed rename", async () => {
    const localRepo = createRepo("gitpanel-selected-indexed-rename-")
    try {
      writeFileSync(join(localRepo, "old-name.ts"), "shared content\n")
      gitIn(localRepo, ["add", "."])
      gitIn(localRepo, ["commit", "-q", "-m", "init"])
      renameSync(join(localRepo, "old-name.ts"), join(localRepo, "new-name.ts"))
      gitIn(localRepo, ["add", "-A"])

      const selected = await resolveSelectedChangedFilesForGitOps(localRepo, [
        "old-name.ts",
        "new-name.ts"
      ])

      expect(selected).toEqual(["old-name.ts", "new-name.ts"])
    } finally {
      rmSync(localRepo, { recursive: true, force: true })
    }
  })

  it("does not widen a copied destination to its independently modified source", async () => {
    const localRepo = createRepo("gitpanel-selected-indexed-copy-")
    try {
      writeFileSync(join(localRepo, "source.ts"), "shared content\n")
      gitIn(localRepo, ["add", "."])
      gitIn(localRepo, ["commit", "-q", "-m", "init"])
      gitIn(localRepo, ["config", "status.renames", "copies"])
      copyFileSync(join(localRepo, "source.ts"), join(localRepo, "copy.ts"))
      gitIn(localRepo, ["add", "copy.ts"])
      writeFileSync(join(localRepo, "source.ts"), "independent source edit\n")

      const selected = await resolveSelectedChangedFilesForGitOps(localRepo, ["copy.ts"])

      expect(selected).toEqual(["copy.ts"])
    } finally {
      rmSync(localRepo, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === "win32")(
    "preserves literal quote characters in selected Git paths",
    async () => {
      const localRepo = createRepo("gitpanel-selected-quoted-path-")
      try {
        writeFileSync(join(localRepo, '"quoted.ts"'), "before\n")
        writeFileSync(join(localRepo, "quoted.ts"), "before\n")
        gitIn(localRepo, ["add", "."])
        gitIn(localRepo, ["commit", "-q", "-m", "init"])
        writeFileSync(join(localRepo, '"quoted.ts"'), "selected\n")
        writeFileSync(join(localRepo, "quoted.ts"), "unrelated\n")

        const selected = await resolveSelectedChangedFilesForGitOps(localRepo, ['"quoted.ts"'])

        expect(selected).toEqual(['"quoted.ts"'])
      } finally {
        rmSync(localRepo, { recursive: true, force: true })
      }
    }
  )
})

describe("Git status path projection", () => {
  it("keeps the event loop responsive while projecting 10k status entries", async () => {
    // Warm the request-scoped git-root cache so this specifically measures the
    // cooperative parser/path projection rather than the child git process.
    await collectChangedFileEntriesFromStatus(repo, "?? warm.txt\0", [])
    const statusOutput = `${Array.from(
      { length: 10_000 },
      (_, index) => `?? bulk/file-${index}.txt`
    ).join("\0")}\0`
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)

    try {
      const files = await collectChangedFileEntriesFromStatus(repo, statusOutput, [])
      expect(files).toHaveLength(10_000)
      expect(ticks).toBeGreaterThan(0)
    } finally {
      clearInterval(ticker)
    }
  })

  it("cancels a superseded large projection and preserves containment checks", async () => {
    const statusOutput = `${Array.from(
      { length: 10_000 },
      (_, index) => `?? bulk/file-${index}.txt`
    ).join("\0")}\0?? ../outside.txt\0`
    const controller = new AbortController()
    const projection = collectChangedFileEntriesFromStatus(repo, statusOutput, [], {
      signal: controller.signal
    })
    setTimeout(() => controller.abort(), 0)

    await expect(projection).rejects.toMatchObject({ name: "AbortError" })

    const safe = await collectChangedFileEntriesFromStatus(
      repo,
      "?? inside.txt\0?? ../outside.txt\0",
      []
    )
    expect(safe.map((entry) => entry.path)).toEqual(["inside.txt"])
  })
})

describe("Agent commit path staging", () => {
  it.skipIf(process.platform === "win32")(
    "treats a dangling symlink as an existing Git path",
    async () => {
      const localRepo = createRepo("gitpanel-dangling-symlink-")
      try {
        symlinkSync("missing-target", join(localRepo, "dangling-link"))

        await expect(pathExistsForGitAdd(localRepo, "dangling-link")).resolves.toBe(true)
        await expect(pathExistsForGitAdd(localRepo, "missing-link")).resolves.toBe(false)
      } finally {
        rmSync(localRepo, { recursive: true, force: true })
      }
    }
  )
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

  it("keeps a repository subdirectory workspace scoped to that subdirectory", async () => {
    const localRepo = createRepo("gitpanel-subdir-workspace-")
    try {
      mkdirSync(join(localRepo, "packages", "a"), { recursive: true })
      mkdirSync(join(localRepo, "packages", "b"), { recursive: true })
      writeFileSync(join(localRepo, "packages", "a", "a.txt"), "a1\n")
      writeFileSync(join(localRepo, "packages", "b", "b.txt"), "b1\n")
      gitIn(localRepo, ["add", "."])
      gitIn(localRepo, ["commit", "-q", "-m", "init packages"])

      writeFileSync(join(localRepo, "packages", "a", "a.txt"), "a1\na2\n")
      writeFileSync(join(localRepo, "packages", "b", "b.txt"), "b1\nb2\n")

      const workspacePath = join(localRepo, "packages", "a")
      const state = await buildGitPanelDiffState(
        "thread-subdir",
        createGitPanelTestContext(workspacePath),
        { includeDiffs: false, includeChangedFiles: true }
      )

      expect(state.success).toBe(true)
      expect(state.files.map((file) => file.path)).toEqual(["a.txt"])
      expect(state.changedFiles).toEqual(["a.txt"])
      expect(state.changedFilesTotal).toBe(1)
    } finally {
      rmSync(localRepo, { recursive: true, force: true })
    }
  })

  it("keeps repeated subdirectory prefixes as distinct worktree paths", async () => {
    const localRepo = createRepo("gitpanel-subdir-prefix-")
    try {
      const workspacePath = join(localRepo, "sub")
      mkdirSync(join(workspacePath, "sub"), { recursive: true })
      writeFileSync(join(workspacePath, "x.ts"), "direct\n")
      writeFileSync(join(workspacePath, "sub", "x.ts"), "nested\n")

      const state = await buildGitPanelState(workspacePath, [], {
        silent: true,
        includeAllWhenNoTracked: true,
        includeDiffs: false,
        includeChangedFiles: true
      })
      expect(state.changedFiles.sort()).toEqual(["sub/x.ts", "x.ts"])

      const selected = await resolveSelectedChangedFilesForGitOps(workspacePath, ["sub/x.ts"])
      expect(selected).toEqual(["sub/x.ts"])
    } finally {
      rmSync(localRepo, { recursive: true, force: true })
    }
  })

  it("maps repository-root status output into a symlinked subdirectory workspace", async () => {
    const localRepo = createRepo("gitpanel-symlink-subdir-")
    const linkParent = mkdtempSync(join(tmpdir(), "gitpanel-symlink-workspace-"))
    const linkedWorkspace = join(linkParent, "workspace")
    try {
      mkdirSync(join(localRepo, "sub"), { recursive: true })
      writeFileSync(join(localRepo, "sub", "x.ts"), "before\n")
      gitIn(localRepo, ["add", "sub/x.ts"])
      gitIn(localRepo, ["commit", "-q", "-m", "init"])
      writeFileSync(join(localRepo, "sub", "x.ts"), "after\n")

      try {
        symlinkSync(
          join(localRepo, "sub"),
          linkedWorkspace,
          process.platform === "win32" ? "junction" : "dir"
        )
      } catch {
        return
      }

      const state = await buildGitPanelState(linkedWorkspace, [], {
        silent: true,
        includeAllWhenNoTracked: true,
        includeDiffs: false,
        includeChangedFiles: true
      })
      expect(state.changedFiles).toEqual(["x.ts"])
      await expect(
        resolveSelectedChangedFilesForGitOps(linkedWorkspace, ["x.ts"])
      ).resolves.toEqual(["x.ts"])
    } finally {
      rmSync(linkParent, { recursive: true, force: true })
      rmSync(localRepo, { recursive: true, force: true })
    }
  })

  it("aggregates child repositories below a non-Git workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "gitpanel-multi-repo-"))
    try {
      const repoB = createRepo("gitpanel-child-b-")
      const repoC = createRepo("gitpanel-child-c-")
      const targetB = join(workspace, "B")
      const targetC = join(workspace, "C")
      renameSync(repoB, targetB)
      renameSync(repoC, targetC)

      writeFileSync(join(targetB, "b.txt"), "b1\n")
      gitIn(targetB, ["add", "."])
      gitIn(targetB, ["commit", "-q", "-m", "init b"])
      writeFileSync(join(targetB, "b.txt"), "b1\nb2\n")

      writeFileSync(join(targetC, "c.txt"), "c1\n")
      gitIn(targetC, ["add", "."])
      gitIn(targetC, ["commit", "-q", "-m", "init c"])
      writeFileSync(join(targetC, "c.txt"), "c1\nc2\n")

      const repositories = await discoverWorkspaceGitRepositories(workspace)
      const state = await buildGitPanelDiffState("thread-multi", {
        workspacePath: workspace,
        isGitRepo: true,
        isWorktree: false,
        metadata: {},
        repositories
      } as GitPanelTestContext, { includeDiffs: false })

      expect(state.success).toBe(true)
      expect(state.changedFilesTotal).toBe(2)
      expect(state.files.map((file) => file.path).sort()).toEqual(["B/b.txt", "C/c.txt"])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it("reports worktree metadata for the selected repository instead of the parent workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "gitpanel-worktree-target-"))
    try {
      const temporaryRepo = createRepo("gitpanel-worktree-main-")
      const mainRepo = join(workspace, "main")
      const linkedWorktree = join(workspace, "linked")
      renameSync(temporaryRepo, mainRepo)
      writeFileSync(join(mainRepo, "tracked.txt"), "initial\n")
      gitIn(mainRepo, ["add", "."])
      gitIn(mainRepo, ["commit", "-q", "-m", "initial"])
      gitIn(mainRepo, ["worktree", "add", "-q", "-b", "linked-test", linkedWorktree])
      writeFileSync(join(linkedWorktree, "tracked.txt"), "changed in worktree\n")

      const repositories = await discoverWorkspaceGitRepositories(workspace)
      const context = {
        workspacePath: workspace,
        isGitRepo: true,
        isWorktree: false,
        metadata: {},
        repositories
      } as GitPanelTestContext

      const [mainMeta, linkedMeta, linkedDiff] = await Promise.all([
        buildGitPanelMetaState("thread-main", context, { worktreePath: mainRepo }),
        buildGitPanelMetaState("thread-linked", context, { worktreePath: linkedWorktree }),
        buildGitPanelDiffState("thread-linked", context, {
          worktreePath: linkedWorktree,
          includeDiffs: false
        })
      ])

      expect(mainMeta.isWorktree).toBe(false)
      expect(linkedMeta.isWorktree).toBe(true)
      expect(linkedMeta.worktreeBranch).toBe("linked-test")
      expect(linkedDiff.isWorktree).toBe(true)
      expect(linkedDiff.files.map((file) => file.path)).toContain("tracked.txt")
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it("keeps linked-worktree identity when it is the only repository below a parent", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "gitpanel-single-worktree-parent-"))
    const mainRepo = createRepo("gitpanel-single-worktree-main-")
    const linkedWorktree = join(workspace, "linked")
    try {
      writeFileSync(join(mainRepo, "tracked.txt"), "initial\n")
      gitIn(mainRepo, ["add", "."])
      gitIn(mainRepo, ["commit", "-q", "-m", "initial"])
      gitIn(mainRepo, ["worktree", "add", "-q", "-b", "only-linked", linkedWorktree])

      const repositories = await discoverWorkspaceGitRepositories(workspace)
      const context = {
        workspacePath: workspace,
        isGitRepo: true,
        isWorktree: false,
        metadata: {},
        repositories
      } as GitPanelTestContext

      expect(repositories).toHaveLength(1)
      const [meta, diff] = await Promise.all([
        buildGitPanelMetaState("thread-single-linked", context),
        buildGitPanelDiffState("thread-single-linked", context, { includeDiffs: false })
      ])

      expect(meta.isWorktree).toBe(true)
      expect(meta.worktreeBranch).toBe("only-linked")
      expect(diff.isWorktree).toBe(true)
    } finally {
      try {
        gitIn(mainRepo, ["worktree", "remove", "--force", linkedWorktree])
      } catch {
        // Cleanup still removes both temporary roots if Git already detached the worktree.
      }
      rmSync(workspace, { recursive: true, force: true })
      rmSync(mainRepo, { recursive: true, force: true })
    }
  })

  it("keeps later repositories visible when each repo applies its own file limit", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "gitpanel-multi-repo-limit-"))
    try {
      const repoB = createRepo("gitpanel-child-limit-b-")
      const repoC = createRepo("gitpanel-child-limit-c-")
      const targetB = join(workspace, "B")
      const targetC = join(workspace, "C")
      renameSync(repoB, targetB)
      renameSync(repoC, targetC)

      writeFileSync(join(targetB, "b1.txt"), "b1\n")
      writeFileSync(join(targetB, "b2.txt"), "b2\n")
      gitIn(targetB, ["add", "."])
      gitIn(targetB, ["commit", "-q", "-m", "init b"])
      writeFileSync(join(targetB, "b1.txt"), "b1\nchanged\n")
      writeFileSync(join(targetB, "b2.txt"), "b2\nchanged\n")

      writeFileSync(join(targetC, "c.txt"), "c1\n")
      gitIn(targetC, ["add", "."])
      gitIn(targetC, ["commit", "-q", "-m", "init c"])
      writeFileSync(join(targetC, "c.txt"), "c1\nchanged\n")

      const repositories = await discoverWorkspaceGitRepositories(workspace)
      const state = await buildGitPanelDiffState("thread-multi-limit", {
        workspacePath: workspace,
        isGitRepo: true,
        isWorktree: false,
        metadata: {},
        repositories
      } as GitPanelTestContext, {
        includeDiffs: false,
        visibleFileLimit: 2
      })

      expect(state.success).toBe(true)
      expect(state.changedFilesTotal).toBe(3)
      expect(state.files).toHaveLength(2)
      expect(state.files.some((file) => file.path.startsWith("B/"))).toBe(true)
      expect(state.files.some((file) => file.path.startsWith("C/"))).toBe(true)
      expect(state.omittedFileCount).toBe(1)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
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

describe("buildGitPanelMetaState — pushability", () => {
  it("lists all unpublished commits on a first-push branch, including external IDE commits", async () => {
    const localRepo = createRepo("gitpanel-pushability-local-")
    const remoteRepo = createBareRepo("gitpanel-pushability-remote-")
    try {
      writeFileSync(join(localRepo, "README.md"), "# test\n")
      gitIn(localRepo, ["add", "."])
      gitIn(localRepo, ["commit", "-q", "-m", "init"])
      const baseBranch = gitIn(localRepo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()
      gitIn(localRepo, ["remote", "add", "origin", remoteRepo])
      gitIn(localRepo, ["push", "-u", "origin", baseBranch])

      gitIn(localRepo, ["checkout", "-q", "-b", "feature/no-upstream"])
      writeFileSync(join(localRepo, "idea.txt"), "idea\n")
      gitIn(localRepo, ["add", "."])
      gitIn(localRepo, ["commit", "-q", "-m", "IDEA commit"])
      writeFileSync(join(localRepo, "app.txt"), "app\n")
      gitIn(localRepo, ["add", "."])
      gitIn(localRepo, ["commit", "-q", "-m", "App commit"])

      const meta = await buildGitPanelMetaState(
        "thread-test",
        createGitPanelTestContext(localRepo)
      )

      expect(meta.hasPushableCommit).toBe(true)
      expect(meta.pendingCommits?.map((commit) => commit.message)).toEqual([
        "App commit",
        "IDEA commit"
      ])
    } finally {
      rmSync(localRepo, { recursive: true, force: true })
      rmSync(remoteRepo, { recursive: true, force: true })
    }
  })
})
