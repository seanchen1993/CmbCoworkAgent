import { execFileSync } from "child_process"
import { existsSync, fsyncSync } from "fs"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { gunzipSync } from "zlib"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { AdoptionWorktrees } from "./adoption-worktree"
import {
  findPendingGensForFile,
  flushAdoptionIndex,
  setAdoptionIndexSnapshotFsyncForTest,
  listDueGenerationRepoChecks,
  trimGeneratedSourceTextToByteCap
} from "./adoption-index"
import {
  flushAdoptionEventOutbox,
  hasPendingGenerationsForCommit,
  initializeAdoptionTracker,
  measureForCommit,
  recordGen,
  retryGenerationRepoChecks,
  shutdownAdoptionTrackerAfterWrites,
  shutdownAdoptionTracker,
  waitForAdoptionRecordGenIdleForTest
} from "./adoption-tracker"
import { setEventReporter, type CoworkEvent } from "./event-reporter"

const fixture = vi.hoisted(() => ({ root: "" }))
vi.mock("../storage", () => ({ getOpenworkDir: () => fixture.root, getUserInfo: () => null }))
const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim()
const report = vi.fn<(event: CoworkEvent) => Promise<{ ok: true; status: number }>>(async () => ({
  ok: true,
  status: 200
}))

beforeEach(async () => {
  fixture.root = await realpath(await mkdtemp(join(tmpdir(), "adoption-worktree-")))
  vi.stubEnv("GIT_CEILING_DIRECTORIES", "")
  report.mockClear()
  setEventReporter({ report })
})

afterEach(async () => {
  setAdoptionIndexSnapshotFsyncForTest(null)
  shutdownAdoptionTracker()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await rm(fixture.root, { force: true, recursive: true })
})

async function registeredRepo(): Promise<string> {
  const root = join(fixture.root, "workspace", "nested")
  git(["init", "-q", root])
  const registry = join(fixture.root, "git-hooks", "repos.json")
  await mkdir(dirname(registry), { recursive: true })
  await writeFile(registry, JSON.stringify([{ gitRoot: root, enabled: true }]))
  return root
}

it("collects concurrent writes to 100 fresh sibling directories in a registered nested repo without spawning Git", async () => {
  const repo = await registeredRepo()
  const tracker = new AdoptionWorktrees()
  const files = await Promise.all(
    Array.from({ length: 100 }, async (_, i) => {
      const dir = join(repo, "案例管理", "bizclaw", "M29", `m29-case-${i}`)
      await mkdir(dir, { recursive: true })
      return join(dir, "AttackCase.java")
    })
  )
  const trace = join(fixture.root, "git-processes.jsonl")
  vi.stubEnv("GIT_TRACE2_EVENT", trace)
  expect(new Set(await Promise.all(files.map((f) => tracker.check(f))))).toEqual(
    new Set(["inside"])
  )
  expect(existsSync(trace)).toBe(false)
  expect(await initializeAdoptionTracker()).toBe(true)
  for (const file of files) {
    recordGen({
      tool: "write_file",
      threadId: "batch",
      filePath: file,
      workspacePath: dirname(repo),
      generatedContent: "class AttackCase {}"
    })
  }
  await waitForAdoptionRecordGenIdleForTest()
  for (const file of files) expect(findPendingGensForFile(file, 0)).toHaveLength(1)
  for (let batch = 0; batch < 5; batch++) await flushAdoptionEventOutbox()
  const generations = report.mock.calls
    .map(([event]) => event)
    .filter((event) => event.eventName === "code_gen")
  expect(generations).toHaveLength(100)
  expect(new Set(generations.map((event) => event.properties?.eventId)).size).toBe(100)
  expect(existsSync(trace)).toBe(false)
})

it("shares one Git probe for a previously unregistered linked worktree", async () => {
  const main = await registeredRepo()
  git([
    "-C",
    main,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "base"
  ])
  const linked = join(fixture.root, "linked")
  git(["-C", main, "worktree", "add", "--detach", "-q", linked])
  const paths = await Promise.all(
    Array.from({ length: 40 }, async (_, i) => {
      const dir = join(linked, String(i))
      await mkdir(dir)
      return join(dir, "a.py")
    })
  )
  const trace = join(fixture.root, "git-processes.jsonl")
  vi.stubEnv("GIT_TRACE2_EVENT", trace)
  const tracker = new AdoptionWorktrees()
  expect(new Set(await Promise.all(paths.map((f) => tracker.check(f))))).toEqual(
    new Set(["inside"])
  )
  const starts = (await readFile(trace, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((row) => row.event === "start")
  expect(starts).toHaveLength(1)
})

it("handles paths outside the checkout, including a symlink and a stale registration", async () => {
  const repo = await registeredRepo(),
    outside = join(fixture.root, "outside")
  await mkdir(outside)
  await symlink(outside, join(repo, "redirect"), "junction")
  const tracker = new AdoptionWorktrees()
  expect(await tracker.check(join(repo, "redirect", "a.py"))).toBe("outside")
  expect(await tracker.check(join(dirname(repo), "a.py"))).toBe("outside")
  await rm(join(repo, ".git"), { recursive: true })
  expect(await tracker.check(join(repo, "a.py"))).toBe("outside")
  git(["init", "-q", repo])
  expect(await tracker.check(join(repo, "a.py"))).toBe("inside")
})

it("retains an unknown write on restart and confirms it exactly once from its commit", async () => {
  const repo = join(fixture.root, "unregistered")
  git(["init", "-q", repo])
  const file = join(repo, "a.py"),
    content = "answer = 42\n"
  await writeFile(file, content)
  expect(await initializeAdoptionTracker()).toBe(true)
  vi.stubEnv("PATH", join(fixture.root, "missing-git"))
  recordGen({
    tool: "write_file",
    threadId: "retry",
    filePath: file,
    workspacePath: repo,
    generatedContent: content
  })
  await waitForAdoptionRecordGenIdleForTest()
  expect(listDueGenerationRepoChecks(Infinity, 10).map((row) => row.file)).toEqual([file])
  expect(findPendingGensForFile(file, 0)).toHaveLength(0)
  // Simulate a full source-text budget before the commit confirms this row.
  trimGeneratedSourceTextToByteCap(0)
  shutdownAdoptionTracker()
  vi.unstubAllEnvs()
  git(["-C", repo, "add", "a.py"])
  git([
    "-C",
    repo,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "add example"
  ])
  const sha = git(["-C", repo, "rev-parse", "HEAD"])
  expect(await initializeAdoptionTracker()).toBe(true)
  const snapshots = [{ absPath: file, stagedContent: Buffer.from(content) }]
  expect(hasPendingGenerationsForCommit(snapshots, Date.now())).toBe(true)
  for (let i = 0; i < 2; i++)
    expect(await measureForCommit(snapshots, sha, Date.now(), repo)).toBe(true)
  await flushAdoptionEventOutbox()
  expect(listDueGenerationRepoChecks(Infinity, 10)).toEqual([])
  const names = report.mock.calls.map(([event]) => event.eventName)
  expect(names.filter((n) => n === "code_gen")).toHaveLength(1)
  expect(names.filter((n) => n === "code_adopt")).toHaveLength(1)
})

it("drains a write on quit and retries it after restart even without a commit", async () => {
  const repo = join(fixture.root, "was-unavailable")
  git(["init", "-q", repo])
  const file = join(repo, "hello.py")
  const generatedContent = "greeting = 'original'\n"
  await writeFile(file, generatedContent)
  expect(await initializeAdoptionTracker()).toBe(true)
  vi.stubEnv("PATH", join(fixture.root, "missing-git"))
  recordGen({
    tool: "write_file",
    threadId: "retry-on-start",
    filePath: file,
    workspacePath: repo,
    generatedContent
  })
  await shutdownAdoptionTrackerAfterWrites()

  await writeFile(file, "greeting = 'changed since generation'\n")
  vi.unstubAllEnvs()
  const later = Date.now() + 60_000
  vi.spyOn(Date, "now").mockReturnValue(later)
  expect(await initializeAdoptionTracker()).toBe(true)
  await vi.waitFor(() => expect(findPendingGensForFile(file, 0)).toHaveLength(1))
  const [baseline] = findPendingGensForFile(file, 0)
  expect(JSON.parse(gunzipSync(baseline.generated_lines_blob!).toString("utf8"))).toEqual([
    generatedContent.trimEnd()
  ])
  await retryGenerationRepoChecks()
  await flushAdoptionEventOutbox()
  expect(report.mock.calls.filter(([event]) => event.eventName === "code_gen")).toHaveLength(1)
  expect(listDueGenerationRepoChecks(later, 10)).toHaveLength(0)
})

it("limits failed background retries and restores a multi-batch backlog when the commit arrives", async () => {
  const repo = join(fixture.root, "outage")
  git(["init", "-q", repo])
  const file = join(repo, "sample.py")
  const generatedContent = "value = 42\n"
  await writeFile(file, generatedContent)
  expect(await initializeAdoptionTracker()).toBe(true)
  const originalPath = process.env.PATH
  vi.stubEnv("PATH", join(fixture.root, "missing-git"))
  for (let i = 0; i < 25; i++)
    recordGen({
      tool: "write_file",
      threadId: "outage",
      filePath: file,
      workspacePath: repo,
      generatedContent
    })
  await waitForAdoptionRecordGenIdleForTest()
  expect(listDueGenerationRepoChecks(Infinity, 30)).toHaveLength(25)
  expect(flushAdoptionIndex()).toBe(true)
  const fsync = vi.fn(fsyncSync)
  setAdoptionIndexSnapshotFsyncForTest(fsync)
  const retryAt = Date.now() + 6000
  vi.spyOn(Date, "now").mockReturnValue(retryAt)
  await Promise.all(Array.from({ length: 20 }, () => retryGenerationRepoChecks()))
  expect(listDueGenerationRepoChecks(retryAt, 30)).toHaveLength(17)
  expect(flushAdoptionIndex()).toBe(true)
  expect(fsync).not.toHaveBeenCalled()
  vi.stubEnv("PATH", originalPath)
  git(["-C", repo, "add", "sample.py"])
  git([
    "-C",
    repo,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "changes"
  ])
  const sha = git(["-C", repo, "rev-parse", "HEAD"])
  const snapshots = [{ absPath: file, stagedContent: Buffer.from(generatedContent) }]
  expect(await measureForCommit(snapshots, sha, retryAt, repo)).toBe(true)
  expect(listDueGenerationRepoChecks(Infinity, 30)).toHaveLength(0)
  for (let batch = 0; batch < 4; batch++) await flushAdoptionEventOutbox()
  const gens = report.mock.calls.map(([e]) => e).filter((e) => e.eventName === "code_gen")
  expect(gens).toHaveLength(25)
  expect(new Set(gens.map((e) => e.eventId)).size).toBe(25)
})
