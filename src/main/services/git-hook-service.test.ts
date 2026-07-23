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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { readFile, readdir } from "fs/promises"
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

import { getCommitMeasurementStatus } from "./adoption-tracker"
import { trackEvent } from "./event-reporter"
import { markInAppCommitProcessed, syncGitHookEvents } from "./git-hook-service"

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
