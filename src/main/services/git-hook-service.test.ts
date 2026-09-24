/**
 * markInAppCommitProcessed (src/main/services/git-hook-service.ts).
 *
 * In-app commit paths (git panel `workspace:commitWorktree`, agent
 * auto-commit) emit their own `git.commit.created` AND leave a durable
 * adoption commit job behind. The hook/reconcile backstop treats an existing
 * job as "recovered commit that still needs its event", so those paths must
 * record their sha in the repo's processed-commits.json — otherwise every
 * in-app commit with adoption measurements is re-emitted by the backstop as a
 * duplicate event (in monorepos even under a different repository name,
 * because the backstop reports the resolved git root while the in-app event
 * reports the worktree path).
 *
 * These tests lock down the marker's core contract:
 *  - the sha lands in processed-commits.json keyed by the RESOLVED git root
 *    (worktree subdirectory input must map to the same repo dir as the root);
 *  - idempotent; normalizes case; rejects garbage shas; no-ops outside a repo.
 *
 * Heavy imports (electron storage, sql.js adoption tracker, telemetry) are
 * mocked; git operations run against real throwaway repos.
 */

import { execFileSync } from "child_process"
import { createHash } from "crypto"
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "fs"
import { readFile, readdir, stat } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { afterAll, describe, expect, it, vi } from "vitest"

const openworkDir = mkdtempSync(join(tmpdir(), "cmbdevclaw-hook-test-"))

vi.mock("../storage", () => ({
  getOpenworkDir: () => openworkDir
}))
vi.mock("./adoption-tracker", () => ({
  getCommitMeasurementStatus: vi.fn(async (): Promise<string | null> => null),
  hasPendingGenerationsForCommit: vi.fn(() => false),
  isCodeFile: vi.fn(() => true),
  measureForCommit: vi.fn(async () => true)
}))
vi.mock("./code-adoption-push-updater", () => ({
  scheduleMarkCodeAdoptionCommitsPushed: vi.fn()
}))
vi.mock("./event-reporter", () => ({
  trackEvent: vi.fn()
}))
// repos.json 的写入计数器：一轮扫描该只写一次，与仓库数无关。
const reposWrites = { count: 0, bytes: 0 }
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>()
  return {
    ...actual,
    readdir: vi.fn(actual.readdir),
    stat: vi.fn(actual.stat),
    writeFile: async (path: unknown, data: unknown, ...rest: unknown[]) => {
      if (String(path).endsWith("repos.json")) {
        reposWrites.count += 1
        reposWrites.bytes += Buffer.byteLength(String(data))
      }
      return (actual.writeFile as (...a: unknown[]) => Promise<void>)(path, data, ...rest)
    }
  }
})

import {
  getCommitMeasurementStatus,
  hasPendingGenerationsForCommit,
  measureForCommit
} from "./adoption-tracker"
import { trackEvent } from "./event-reporter"
import {
  getGitHookStatus,
  installGitHooks,
  markInAppCommitProcessed,
  scheduleAutoInstallGitHooksForPath,
  syncGitHookEvents,
  syncRegisteredGitHookEvents
} from "./git-hook-service"

const tempRoots: string[] = [openworkDir]

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true })
  }
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim()
}

/** Create a throwaway repo with one commit; returns its root and HEAD sha. */
function makeRepo(): { repoRoot: string; sha: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), "cmbdevclaw-repo-"))
  tempRoots.push(repoRoot)
  git(repoRoot, "init", "-q")
  git(repoRoot, "config", "user.email", "test@example.com")
  git(repoRoot, "config", "user.name", "Test")
  // Seed with the (unique) repo path — identical trees committed in the same
  // second across throwaway repos would otherwise share a commit sha.
  writeFileSync(join(repoRoot, "a.ts"), `export const seed = ${JSON.stringify(repoRoot)}\n`)
  git(repoRoot, "add", ".")
  git(repoRoot, "commit", "-q", "-m", "init")
  return { repoRoot, sha: git(repoRoot, "rev-parse", "HEAD") }
}

const eventsDir = join(openworkDir, "git-hooks", "events")

async function listRepoEventDirs(): Promise<string[]> {
  try {
    return await readdir(eventsDir)
  } catch {
    return []
  }
}

async function readProcessedSet(repoDirName: string): Promise<string[]> {
  const raw = await readFile(join(eventsDir, repoDirName, "processed-commits.json"), "utf-8")
  return JSON.parse(raw) as string[]
}

describe("markInAppCommitProcessed", () => {
  it("records the sha under the resolved git root, including from a subdirectory worktree path", async () => {
    const { repoRoot, sha } = makeRepo()
    const subdir = join(repoRoot, "packages", "app")
    mkdirSync(subdir, { recursive: true })

    // Call with the SUBDIRECTORY (the monorepo case: the git panel commits from
    // a sub-path while the backstop scans the repo root).
    await markInAppCommitProcessed(subdir, sha)

    const dirs = await listRepoEventDirs()
    expect(dirs).toHaveLength(1)
    expect(await readProcessedSet(dirs[0])).toContain(sha)

    // Marking again via the ROOT path must hit the SAME repo dir (no split key)
    // and stay idempotent.
    await markInAppCommitProcessed(repoRoot, sha)
    const dirsAfter = await listRepoEventDirs()
    expect(dirsAfter).toEqual(dirs)
    const set = await readProcessedSet(dirs[0])
    expect(set.filter((entry) => entry === sha)).toHaveLength(1)
  })

  it("normalizes the sha to lowercase so it matches git rev-list output", async () => {
    const { repoRoot, sha } = makeRepo()
    await markInAppCommitProcessed(repoRoot, sha.toUpperCase())

    const dirs = await listRepoEventDirs()
    const sets = await Promise.all(dirs.map(readProcessedSet))
    expect(sets.some((set) => set.includes(sha))).toBe(true)
  })

  it("appends to an existing processed set without dropping prior entries", async () => {
    const { repoRoot, sha } = makeRepo()
    writeFileSync(join(repoRoot, "b.ts"), "export const b = 2\n")
    git(repoRoot, "add", ".")
    git(repoRoot, "commit", "-q", "-m", "second")
    const sha2 = git(repoRoot, "rev-parse", "HEAD")

    await markInAppCommitProcessed(repoRoot, sha)
    await markInAppCommitProcessed(repoRoot, sha2)

    const dirs = await listRepoEventDirs()
    const sets = await Promise.all(dirs.map(readProcessedSet))
    const set = sets.find((entries) => entries.includes(sha))
    expect(set).toBeDefined()
    expect(set).toContain(sha2)
  })

  it("ignores missing or malformed shas", async () => {
    const { repoRoot } = makeRepo()
    const before = (await listRepoEventDirs()).length

    await markInAppCommitProcessed(repoRoot, undefined)
    await markInAppCommitProcessed(repoRoot, "")
    await markInAppCommitProcessed(repoRoot, "not-a-sha")

    expect((await listRepoEventDirs()).length).toBe(before)
  })

  it("no-ops outside a git repository", async () => {
    const plainDir = mkdtempSync(join(tmpdir(), "cmbdevclaw-plain-"))
    tempRoots.push(plainDir)
    const before = (await listRepoEventDirs()).length

    await expect(markInAppCommitProcessed(plainDir, "a".repeat(40))).resolves.toBeUndefined()

    expect((await listRepoEventDirs()).length).toBe(before)
  })
})

// End-to-end through syncGitHookEvents: the reconcile backstop must re-emit
// git.commit.created for commits it recovers (durable job, no in-app event) but
// must NOT duplicate commits already reported in-app — even when the marker's
// file write was lost to a concurrent sweep (in-memory overlay).
describe("reconcile backstop vs in-app commits", () => {
  function commitChange(repoRoot: string, content: string): string {
    writeFileSync(join(repoRoot, "a.ts"), content)
    git(repoRoot, "add", ".")
    git(repoRoot, "commit", "-q", "-m", "change")
    return git(repoRoot, "rev-parse", "HEAD")
  }

  function commitEvents(): Array<Record<string, unknown>> {
    return vi
      .mocked(trackEvent)
      .mock.calls.filter(([eventName]) => eventName === "git.commit.created")
      .map(([, , properties]) => properties as Record<string, unknown>)
  }

  it("re-emits an unmarked commit with a durable job (recovered backstop commit)", async () => {
    vi.mocked(trackEvent).mockClear()
    const { repoRoot } = makeRepo()
    const resolvedRoot = git(repoRoot, "rev-parse", "--show-toplevel")

    // First sweep baselines the commit cursor — no backfill.
    expect(await syncGitHookEvents(repoRoot)).toBe("synced")
    await new Promise((resolve) => setTimeout(resolve, 25))
    const sha = commitChange(repoRoot, "export const changed = 1\n")

    // A durable commit job exists (as if a prior measurement was interrupted),
    // and no in-app path marked the sha — the backstop must report it.
    vi.mocked(getCommitMeasurementStatus).mockResolvedValue("completed")
    try {
      expect(await syncGitHookEvents(repoRoot)).toBe("synced")
    } finally {
      vi.mocked(getCommitMeasurementStatus).mockResolvedValue(null)
    }

    const events = commitEvents()
    expect(events).toHaveLength(1)
    expect(events[0].commitSha).toBe(sha)
    expect(events[0].repoPath).toBe(resolvedRoot)
    expect(events[0].triggeredBy).toBe("external-reconcile")
  })

  it("does not duplicate an in-app commit, even when the marker's file write was lost", async () => {
    vi.mocked(trackEvent).mockClear()
    const { repoRoot } = makeRepo()

    expect(await syncGitHookEvents(repoRoot)).toBe("synced")
    await new Promise((resolve) => setTimeout(resolve, 25))
    const sha = commitChange(repoRoot, "export const changed = 2\n")

    await markInAppCommitProcessed(repoRoot, sha)
    // Locate this repo's events dir via its processed set containing the sha.
    let markedDir: string | undefined
    for (const dir of await listRepoEventDirs()) {
      const set = await readProcessedSet(dir).catch(() => [] as string[])
      if (set.includes(sha)) markedDir = dir
    }
    expect(markedDir).toBeDefined()

    // Simulate the marker's write being clobbered by a concurrent sweep save.
    rmSync(join(eventsDir, markedDir as string, "processed-commits.json"), { force: true })

    // The in-app path also left a durable commit job behind — previously this
    // made the backstop treat the commit as "still needs its event".
    vi.mocked(getCommitMeasurementStatus).mockResolvedValue("completed")
    try {
      expect(await syncGitHookEvents(repoRoot)).toBe("synced")
    } finally {
      vi.mocked(getCommitMeasurementStatus).mockResolvedValue(null)
    }

    expect(commitEvents()).toHaveLength(0)
    // The overlay hit must repair the on-disk processed set.
    expect(await readProcessedSet(markedDir as string)).toContain(sha)
  })
})

/**
 * Snapshot schema compatibility.
 *
 * The hook helper and the app upgrade independently: the helper lives in the
 * user's data dir and is rewritten on app start, so there is always a window
 * where a v1 snapshot (no commit stats, no common dir) is read by a v2-aware
 * app — and, after a rollback, the reverse. Neither may lose the event.
 *
 * v1 keeps the old behaviour exactly: ask live git, using the snapshot's own
 * gitRoot. v2 reads what the hook recorded and never goes back to the repo,
 * which is what lets a removed worktree still report real numbers instead of
 * a silently zeroed event.
 */
describe("ready snapshot schema compatibility", () => {
  function repoEventsDir(gitRoot: string): string {
    const key = createHash("sha1")
      .update(gitRoot.trim().replace(/\\/g, "/").toLowerCase())
      .digest("hex")
    return join(eventsDir, key)
  }

  /** Drop a ready snapshot straight into the bucket, as the hook helper would. */
  function writeReadySnapshot(
    gitRoot: string,
    meta: Record<string, unknown>,
    files: Array<{ relPath: string; content: string }>
  ): void {
    const dir = join(repoEventsDir(gitRoot), "ready", `snap-${Math.random().toString(16).slice(2)}`)
    mkdirSync(join(dir, "files"), { recursive: true })
    const entries = files.map((file, index) => {
      const blobFile = `files/${String(index).padStart(4, "0")}.blob`
      writeFileSync(join(dir, blobFile), file.content)
      return {
        absPath: join(gitRoot, file.relPath),
        relPath: file.relPath,
        status: "A",
        deleted: false,
        blobFile
      }
    })
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ ...meta, gitRoot, files: entries }))
  }

  function lastCommitEvent(): Record<string, unknown> | undefined {
    const calls = vi
      .mocked(trackEvent)
      .mock.calls.filter(([eventName]) => eventName === "git.commit.created")
    return calls.at(-1)?.[2] as Record<string, unknown> | undefined
  }

  /** Force the emit path: a durable job stands in for a real measurement. */
  async function syncWithDurableJob(path: string): Promise<void> {
    vi.mocked(getCommitMeasurementStatus).mockResolvedValue("completed")
    try {
      await syncGitHookEvents(path)
    } finally {
      vi.mocked(getCommitMeasurementStatus).mockResolvedValue(null)
    }
  }

  it("still consumes a v1 snapshot by asking live git", async () => {
    vi.mocked(trackEvent).mockClear()
    const { repoRoot } = makeRepo()
    // Bucket keys come from `rev-parse --show-toplevel`, which resolves symlinks
    // (/var → /private/var on macOS). Use the same spelling the hook would.
    const root = git(repoRoot, "rev-parse", "--show-toplevel")
    writeFileSync(join(repoRoot, "v1.ts"), "export const a = 1\nexport const b = 2\n")
    git(repoRoot, "add", ".")
    git(repoRoot, "commit", "-q", "-m", "v1 commit")
    const sha = git(repoRoot, "rev-parse", "HEAD")

    // Exactly what the old helper wrote: no stats, no remote, no common dir.
    writeReadySnapshot(
      root,
      { schemaVersion: 1, snapshotId: "v1", commitSha: sha, branch: "v1-branch" },
      [{ relPath: "v1.ts", content: "export const a = 1\n" }]
    )

    await syncWithDurableJob(root)

    const event = lastCommitEvent()
    expect(event?.commitSha).toBe(sha)
    expect(event?.triggeredBy).toBe("external-hook")
    expect(event?.branch).toBe("v1-branch")
    // The whole point of the v1 path: numbers still come from the repository.
    expect(event?.filesChanged).toBe(1)
    expect(event?.insertions).toBe(2)
    expect(await readdir(join(repoEventsDir(root), "ready"))).toHaveLength(0)
  })

  it.each([false, true])("reports a removed worktree's v2 snapshot (cached=%s)", async (cached) => {
    vi.mocked(trackEvent).mockClear()
    const { repoRoot } = makeRepo()
    const worktree = join(mkdtempSync(join(tmpdir(), "cmbdevclaw-wt-")), "wt")
    git(repoRoot, "worktree", "add", "-q", "-b", "feat", worktree)
    writeFileSync(join(worktree, "w.ts"), "export const w = 1\n")
    git(worktree, "add", ".")
    git(worktree, "commit", "-q", "-m", "worktree commit")
    const sha = git(worktree, "rev-parse", "HEAD")
    // Capture both the way the hook would, while the worktree still exists.
    const wtRoot = git(worktree, "rev-parse", "--show-toplevel")
    const commonDir = git(worktree, "rev-parse", "--git-common-dir")
    if (cached) await syncGitHookEvents(wtRoot)

    writeReadySnapshot(
      wtRoot,
      {
        schemaVersion: 2,
        snapshotId: "v2",
        commitSha: sha,
        branch: "feat",
        gitCommonDir: commonDir,
        commitTimeMs: Date.now(),
        filesChanged: 1,
        insertions: 1,
        deletions: 0,
        remoteUrl: ""
      },
      [{ relPath: "w.ts", content: "export const w = 1\n" }]
    )

    git(repoRoot, "merge", "--no-ff", "-q", "-m", "merge feat", "feat")
    git(repoRoot, "worktree", "remove", "--force", worktree)
    expect(existsSync(worktree)).toBe(false)

    await syncWithDurableJob(wtRoot)

    const event = lastCommitEvent()
    expect(event?.commitSha).toBe(sha)
    // repoPath stays the worktree: adoption rows are keyed on paths under it.
    expect(event?.repoPath).toBe(wtRoot)
    expect(event?.branch).toBe("feat")
    expect(event?.filesChanged).toBe(1)
    expect(event?.insertions).toBe(1)
    expect(await readdir(join(repoEventsDir(wtRoot), "ready"))).toHaveLength(0)
  })

  it("never borrows the main checkout's branch for a removed worktree", async () => {
    // The branch is per-work-tree, unlike the commit stats and the remote. If
    // the common-dir fallback were allowed to answer it, a commit made on the
    // worktree's branch would be reported under whatever the main checkout
    // happens to have checked out — a wrong value is worse than an empty one.
    vi.mocked(trackEvent).mockClear()
    const { repoRoot } = makeRepo()
    git(repoRoot, "checkout", "-q", "-b", "main-side")
    const worktree = join(mkdtempSync(join(tmpdir(), "cmbdevclaw-wt-detached-")), "wt")
    git(repoRoot, "worktree", "add", "-q", "--detach", worktree)
    writeFileSync(join(worktree, "d.ts"), "export const d = 1\n")
    git(worktree, "add", ".")
    git(worktree, "commit", "-q", "-m", "detached commit")
    const sha = git(worktree, "rev-parse", "HEAD")
    const wtRoot = git(worktree, "rev-parse", "--show-toplevel")
    const commonDir = git(worktree, "rev-parse", "--git-common-dir")

    // Detached HEAD at pre-commit time, so the hook recorded no branch.
    writeReadySnapshot(
      wtRoot,
      {
        schemaVersion: 2,
        snapshotId: "v2-detached",
        commitSha: sha,
        branch: "",
        gitCommonDir: commonDir,
        commitTimeMs: Date.now(),
        filesChanged: 1,
        insertions: 1,
        deletions: 0,
        remoteUrl: ""
      },
      [{ relPath: "d.ts", content: "export const d = 1\n" }]
    )

    git(repoRoot, "merge", "--no-ff", "-q", "-m", "merge detached", sha)
    git(repoRoot, "worktree", "remove", "--force", worktree)

    await syncWithDurableJob(wtRoot)

    const event = lastCommitEvent()
    expect(event?.commitSha).toBe(sha)
    expect(event?.branch).toBe("")
    expect(event?.branch).not.toBe("main-side")
  })

  it("leaves an unreadable snapshot's handling unchanged", async () => {
    vi.mocked(trackEvent).mockClear()
    const { repoRoot } = makeRepo()
    const root = git(repoRoot, "rev-parse", "--show-toplevel")
    const dir = join(repoEventsDir(root), "ready", "broken")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "meta.json"), "{ not json")

    await syncGitHookEvents(root)

    expect(await readdir(join(repoEventsDir(root), "ready"))).toHaveLength(0)
    expect(await readdir(join(repoEventsDir(root), "skipped"))).toContain("broken")
    expect(
      vi.mocked(trackEvent).mock.calls.filter(([name]) => name === "git.commit.created")
    ).toHaveLength(0)
  })
})

describe("失效注册清理的缓存和并发保护", () => {
  const registryPath = join(openworkDir, "git-hooks", "repos.json")
  const oldUpdatedAt = "2026-01-01T00:00:00.000+08:00"

  function writeRegistry(roots: string[]): void {
    mkdirSync(join(openworkDir, "git-hooks"), { recursive: true })
    writeFileSync(
      registryPath,
      JSON.stringify(
        roots.map((gitRoot) => ({
          gitRoot,
          enabled: true,
          registeredAt: oldUpdatedAt,
          updatedAt: oldUpdatedAt
        }))
      )
    )
  }

  function readRegistry(): Array<{ gitRoot: string; updatedAt: string; lastError?: string }> {
    return JSON.parse(readFileSync(registryPath, "utf-8"))
  }

  function bucketFor(root: string): string {
    const key = createHash("sha1").update(root.replace(/\\/g, "/").toLowerCase()).digest("hex")
    return join(eventsDir, key)
  }

  function missingRoot(): string {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "cmbdevclaw-reused-")))
    tempRoots.push(parent)
    return join(parent, "wt")
  }

  function recreate(root: string): void {
    mkdirSync(root, { recursive: true })
    git(root, "init", "-q")
    writeFileSync(join(root, "generated.ts"), "export const fresh = 1\n")
  }

  async function autoRegister(root: string): Promise<void> {
    scheduleAutoInstallGitHooksForPath(root, "generated.ts")
    await vi.waitFor(
      async () => {
        const registered = readRegistry().find((repo) => repo.gitRoot === root)
        expect(registered).toBeDefined()
        expect(registered?.updatedAt).not.toBe(oldUpdatedAt)
        expect((await getGitHookStatus(root)).installed).toBe(true)
      },
      { timeout: 3000 }
    )
  }

  // Hold the second repository after the first has produced a forget outcome.
  // This makes the race deterministic without sleeps or private service exports.
  async function duringPausedSweep(slowRoot: string, action: () => Promise<void>): Promise<void> {
    const readyPath = join(bucketFor(slowRoot), "ready")
    mkdirSync(readyPath, { recursive: true })
    const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
    let release!: () => void
    let reached!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      reached = resolve
    })
    let gated = false
    vi.mocked(readdir).mockImplementation(async (...args) => {
      if (String(args[0]) === readyPath && !gated) {
        gated = true
        reached()
        await barrier
      }
      return actual.readdir(...args)
    })
    const sweep = syncRegisteredGitHookEvents()
    try {
      await Promise.race([
        blocked,
        sweep.then(() => {
          throw new Error("sweep finished before reaching the barrier")
        })
      ])
      await action()
    } finally {
      release()
      try {
        await sweep
      } finally {
        vi.mocked(readdir).mockImplementation(actual.readdir)
      }
    }
  }

  it("清理已缓存且已消费完的 worktree，下一轮不再写注册表", async () => {
    const { repoRoot } = makeRepo()
    const worktree = missingRoot()
    git(repoRoot, "worktree", "add", "-q", "--detach", worktree)
    const root = git(worktree, "rev-parse", "--show-toplevel")
    writeRegistry([root])
    await syncRegisteredGitHookEvents()
    mkdirSync(join(bucketFor(root), "processed", "snapshot"), { recursive: true })
    writeFileSync(join(bucketFor(root), "processed-commits.json"), JSON.stringify(["a".repeat(40)]))
    git(repoRoot, "worktree", "remove", "--force", worktree)

    reposWrites.count = 0
    await syncRegisteredGitHookEvents()
    expect(readRegistry()).toEqual([])
    expect(reposWrites.count).toBe(1)
    await syncRegisteredGitHookEvents()
    expect(reposWrites.count).toBe(1)
    expect(existsSync(join(bucketFor(root), "processed", "snapshot"))).toBe(true)
  })

  it.each([false, true])("保留扫描期间同路径的新注册（再次删除=%s）", async (removeAgain) => {
    const root = missingRoot()
    const slow = git(makeRepo().repoRoot, "rev-parse", "--show-toplevel")
    writeRegistry([root, slow])
    let updatedAt: string | undefined
    await duringPausedSweep(slow, async () => {
      recreate(root)
      await autoRegister(root)
      updatedAt = readRegistry().find((repo) => repo.gitRoot === root)?.updatedAt
      if (removeAgain) rmSync(root, { recursive: true, force: true })
    })

    expect(readRegistry().find((repo) => repo.gitRoot === root)?.updatedAt).toBe(updatedAt)
    expect(readRegistry().map((repo) => repo.gitRoot)).toContain(root)
  })

  it("保留扫描期间恢复但尚未重新注册的目录", async () => {
    const root = missingRoot()
    const slow = git(makeRepo().repoRoot, "rev-parse", "--show-toplevel")
    writeRegistry([root, slow])
    await duringPausedSweep(slow, async () => {
      recreate(root)
    })

    expect(readRegistry().map((repo) => repo.gitRoot)).toContain(root)
  })

  it.each(["ready", "push-intents"])("保留扫描期间收到 %s 事件的注册", async (subdir) => {
    const root = missingRoot()
    const slow = git(makeRepo().repoRoot, "rev-parse", "--show-toplevel")
    writeRegistry([root, slow])
    await duringPausedSweep(slow, async () => {
      const dir = join(bucketFor(root), subdir)
      mkdirSync(dir, { recursive: true })
      if (subdir === "ready") mkdirSync(join(dir, "late-snapshot"))
      else writeFileSync(join(dir, "late-push.json"), "{}")
    })

    expect(readRegistry().map((repo) => repo.gitRoot)).toContain(root)
  })

  it("清理后立即重建的路径可重新注册，不受旧的安装 TTL 阻挡", async () => {
    const root = missingRoot()
    writeRegistry([])
    recreate(root)
    await autoRegister(root)
    await syncRegisteredGitHookEvents()
    rmSync(root, { recursive: true, force: true })
    await syncRegisteredGitHookEvents()
    expect(readRegistry()).toEqual([])

    recreate(root)
    await autoRegister(root)
    expect(readRegistry().map((repo) => repo.gitRoot)).toContain(root)
  })

  it.each(["EACCES", "EBUSY"])("目录检查遇到 %s 时保留注册并记录失败", async (code) => {
    const root = git(makeRepo().repoRoot, "rev-parse", "--show-toplevel")
    writeRegistry([root])
    await syncRegisteredGitHookEvents()
    const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
    vi.mocked(stat).mockImplementation(async (...args) => {
      if (String(args[0]) === root) throw Object.assign(new Error(code), { code })
      return actual.stat(...args)
    })
    try {
      await syncRegisteredGitHookEvents()
      expect(readRegistry()).toEqual([expect.objectContaining({ gitRoot: root, lastError: code })])
    } finally {
      vi.mocked(stat).mockImplementation(actual.stat)
    }
  })

  it("事件目录读取失败时不把待处理队列当作空队列", async () => {
    const root = missingRoot()
    writeRegistry([root])
    const readyPath = join(bucketFor(root), "ready")
    const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
    vi.mocked(readdir).mockImplementation(async (...args) => {
      if (String(args[0]) === readyPath)
        throw Object.assign(new Error("EACCES"), { code: "EACCES" })
      return actual.readdir(...args)
    })
    try {
      await syncRegisteredGitHookEvents()
      expect(readRegistry()).toEqual([
        expect.objectContaining({ gitRoot: root, lastError: "EACCES" })
      ])
    } finally {
      vi.mocked(readdir).mockImplementation(actual.readdir)
    }
  })
})

/**
 * Registered-repo housekeeping.
 *
 * A script-driven flow registers one throwaway worktree per run, so dead
 * entries must not accumulate — every sweep would spawn a doomed git for each.
 * But the drop has to be narrow: it may only happen once the directory is gone
 * AND its bucket holds nothing, or an unconsumed snapshot would be stranded.
 */
describe("registered repo housekeeping", () => {
  async function registeredRoots(): Promise<string[]> {
    const raw = await readFile(join(openworkDir, "git-hooks", "repos.json"), "utf-8").catch(
      () => "[]"
    )
    return (JSON.parse(raw) as Array<{ gitRoot: string }>).map((repo) => repo.gitRoot)
  }

  async function register(gitRoot: string): Promise<void> {
    const path = join(openworkDir, "git-hooks", "repos.json")
    const current = await readFile(path, "utf-8").catch(() => "[]")
    const repos = JSON.parse(current) as unknown[]
    repos.push({ gitRoot, enabled: true, registeredAt: "now", updatedAt: "now" })
    mkdirSync(join(openworkDir, "git-hooks"), { recursive: true })
    writeFileSync(path, JSON.stringify(repos))
  }

  it("drops a registration whose directory is gone and bucket is empty", async () => {
    const { repoRoot } = makeRepo()
    const gone = join(mkdtempSync(join(tmpdir(), "cmbdevclaw-gone-")), "removed")
    await register(repoRoot)
    await register(gone)

    await syncRegisteredGitHookEvents()

    const roots = await registeredRoots()
    expect(roots).toContain(repoRoot)
    expect(roots).not.toContain(gone)
  })

  it("keeps a registration whose directory is gone while its bucket still has work", async () => {
    const gone = join(mkdtempSync(join(tmpdir(), "cmbdevclaw-gone-kept-")), "removed")
    const key = createHash("sha1").update(gone.toLowerCase()).digest("hex")
    // An UNCONSUMED snapshot keeps the entry alive so it still gets its chance.
    // An empty `ready` directory would not: the test is "is there work", not
    // "does the bucket exist", precisely because a consumed bucket keeps its
    // directories forever and could never be retired.
    mkdirSync(join(eventsDir, key, "ready", "snap-1"), { recursive: true })
    await register(gone)

    await syncRegisteredGitHookEvents()

    expect(await registeredRoots()).toContain(gone)
  })
})

/**
 * A snapshot whose whole repository is gone has nothing to run git in. Inside
 * the attribution window it must be retried (the repo may come back); past it
 * there is no generation left to match, so retrying forever is how the orphaned
 * backlog built up in the first place.
 */
describe("snapshots whose repository disappeared entirely", () => {
  function bucketFor(gitRoot: string): string {
    const key = createHash("sha1")
      .update(gitRoot.trim().replace(/\\/g, "/").toLowerCase())
      .digest("hex")
    return join(eventsDir, key)
  }

  function writeOrphan(gitRoot: string, committedAt: string): void {
    const dir = join(bucketFor(gitRoot), "ready", `orphan-${Math.random().toString(16).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        schemaVersion: 1,
        snapshotId: "orphan",
        gitRoot,
        commitSha: "b".repeat(40),
        committedAt,
        files: [{ absPath: join(gitRoot, "x.ts"), relPath: "x.ts", deleted: true }]
      })
    )
  }

  it("retires one that is past the attribution window", async () => {
    const gone = join(mkdtempSync(join(tmpdir(), "cmbdevclaw-orphan-old-")), "removed")
    writeOrphan(gone, new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString())

    await syncGitHookEvents(gone)

    expect(await readdir(join(bucketFor(gone), "ready"))).toHaveLength(0)
    expect(await readdir(join(bucketFor(gone), "skipped"))).toHaveLength(1)
  })

  it("keeps retrying one that is still inside the window", async () => {
    const gone = join(mkdtempSync(join(tmpdir(), "cmbdevclaw-orphan-new-")), "removed")
    writeOrphan(gone, new Date(Date.now() - 3600 * 1000).toISOString())

    // It has to get past the "no pending code_gen" gate to reach the retry
    // decision at all, and measurement cannot complete with no repo to ask.
    vi.mocked(hasPendingGenerationsForCommit).mockReturnValue(true)
    vi.mocked(measureForCommit).mockResolvedValue(false)
    try {
      await syncGitHookEvents(gone)
    } finally {
      vi.mocked(hasPendingGenerationsForCommit).mockReturnValue(false)
      vi.mocked(measureForCommit).mockResolvedValue(true)
    }

    // Still in ready: a repository can come back (remount, restore, re-clone).
    expect(await readdir(join(bucketFor(gone), "ready"))).toHaveLength(1)
  })
})

/**
 * The hook helper is one shared file, written by every install and by the
 * startup refresh. Those all run concurrently in a single process — one install
 * per registered repository, plus the refresh — so the staging file each write
 * goes through must be unique per call. When it is not, the first rename moves
 * the file out from under the others, they throw before reaching
 * installOneHook, and those repositories silently end up with no hooks at all.
 */
describe("concurrent hook helper installs", () => {
  it("installs every repository when many install at once", async () => {
    const repos = Array.from({ length: 20 }, () => {
      const root = mkdtempSync(join(tmpdir(), "cmbdevclaw-parallel-"))
      tempRoots.push(root)
      git(root, "init", "-q")
      return root
    })

    const results = await Promise.allSettled(repos.map((repo) => installGitHooks(repo)))

    const rejected = results.filter((result) => result.status === "rejected")
    expect(rejected.map((result) => String((result as PromiseRejectedResult).reason))).toEqual([])
    const notInstalled = results
      .map((result, index) =>
        result.status === "fulfilled" && result.value.installed ? null : repos[index]
      )
      .filter(Boolean)
    expect(notInstalled).toEqual([])

    // And the surviving helper has to be a complete, runnable script — a
    // truncated one would make every hook a silent no-op.
    const helper = join(openworkDir, "git-hooks", "cmbdevclaw-git-hook.cjs")
    execFileSync("node", ["--check", helper])

    // No staging files left behind.
    const leftovers = (await readdir(join(openworkDir, "git-hooks"))).filter((name) =>
      name.endsWith(".tmp")
    )
    expect(leftovers).toEqual([])
  })
})

/**
 * Helper writes on Windows.
 *
 * Production runs on Windows, where replacing a file another process holds
 * open fails outright (antivirus scanners and the very hook that is executing
 * this script both hold handles). The mitigation is to not write at all in the
 * steady state: every install and the startup refresh reach ensureHookHelper,
 * and only a genuine version change may touch the file.
 */
describe("hook helper writes", () => {
  const helperPath = join(openworkDir, "git-hooks", "cmbdevclaw-git-hook.cjs")

  it("does not rewrite the helper when it is already current", async () => {
    const first = makeRepo()
    await installGitHooks(first.repoRoot)
    const before = statSync(helperPath).mtimeMs

    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = makeRepo()
    await installGitHooks(second.repoRoot)
    await installGitHooks(first.repoRoot)

    expect(statSync(helperPath).mtimeMs).toBe(before)
  })

  it("still replaces a helper left over from an older build", async () => {
    const { repoRoot } = makeRepo()
    await installGitHooks(repoRoot)
    const current = readFileSync(helperPath, "utf-8")

    writeFileSync(helperPath, "// helper from an older build\n")
    await installGitHooks(repoRoot)

    expect(readFileSync(helperPath, "utf-8")).toBe(current)
  })
})

/**
 * 注册表是一整个文件读改写。以前每个仓库同步完都单独标记一次，N 个仓库就是 N 次
 * 全量读 + N 次全量写，而文件大小本身也随 N 增长——脚本化流程每跑一次注册一个
 * 临时 worktree，N 正好是会涨的那个数。
 */
describe("注册表扫描的写放大", () => {
  it("一轮扫描只写一次 repos.json，与仓库数无关", async () => {
    const reposPath = join(openworkDir, "git-hooks", "repos.json")
    const repos = Array.from({ length: 12 }, () => makeRepo().repoRoot)
    mkdirSync(join(openworkDir, "git-hooks"), { recursive: true })
    writeFileSync(
      reposPath,
      JSON.stringify(
        repos.map((gitRoot) => ({
          gitRoot,
          enabled: true,
          registeredAt: "2026-09-21 00:00:00",
          updatedAt: "2026-09-21 00:00:00"
        }))
      )
    )

    reposWrites.count = 0
    reposWrites.bytes = 0
    await syncRegisteredGitHookEvents()

    expect(reposWrites.count).toBe(1)
    // 每条都记上了同步时间，说明批量写没有漏掉任何一个仓库。
    const saved = JSON.parse(await readFile(reposPath, "utf-8")) as Array<{
      gitRoot: string
      lastSyncedAt?: string
    }>
    expect(saved).toHaveLength(repos.length)
    expect(saved.every((repo) => !!repo.lastSyncedAt)).toBe(true)
  })

  it("目录已删且桶里没有待处理事件的注册会被清掉", async () => {
    const reposPath = join(openworkDir, "git-hooks", "repos.json")
    const alive = makeRepo().repoRoot
    const gone = join(mkdtempSync(join(tmpdir(), "cmbdevclaw-consumed-")), "removed")
    // 消费完成的桶：只剩归档和去重账本，ready / push-intents 都是空的。
    const key = createHash("sha1").update(gone.toLowerCase()).digest("hex")
    mkdirSync(join(eventsDir, key, "processed", "snap-1"), { recursive: true })
    writeFileSync(join(eventsDir, key, "processed-commits.json"), JSON.stringify(["a".repeat(40)]))
    writeFileSync(
      reposPath,
      JSON.stringify(
        [alive, gone].map((gitRoot) => ({
          gitRoot,
          enabled: true,
          registeredAt: "x",
          updatedAt: "x"
        }))
      )
    )

    await syncRegisteredGitHookEvents()

    const saved = JSON.parse(await readFile(reposPath, "utf-8")) as Array<{ gitRoot: string }>
    const roots = saved.map((repo) => repo.gitRoot)
    expect(roots).toContain(alive)
    // 以前这里判的是「事件目录存不存在」，而 processed/ 会永远留着，于是永远清不掉。
    expect(roots).not.toContain(gone)
  })

  it("桶里还有 ready 快照时不清，哪怕目录已经删了", async () => {
    const reposPath = join(openworkDir, "git-hooks", "repos.json")
    const gone = join(mkdtempSync(join(tmpdir(), "cmbdevclaw-unconsumed-")), "removed")
    const key = createHash("sha1").update(gone.toLowerCase()).digest("hex")
    mkdirSync(join(eventsDir, key, "ready", "snap-1"), { recursive: true })
    writeFileSync(
      reposPath,
      JSON.stringify([{ gitRoot: gone, enabled: true, registeredAt: "x", updatedAt: "x" }])
    )

    await syncRegisteredGitHookEvents()

    const saved = JSON.parse(await readFile(reposPath, "utf-8")) as Array<{ gitRoot: string }>
    expect(saved.map((repo) => repo.gitRoot)).toContain(gone)
  })
})
