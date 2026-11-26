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
  rememberAdoptionPush,
  trimGeneratedSourceTextToByteCap
} from "./adoption-index"
import {
  flushAdoptionEventOutbox,
  hasPendingGenerationsForCommit,
  initializeAdoptionTracker,
  readLocalCommitAdoptionLines,
  getCommitMeasurementStatus,
  wasEmptyTransferProbe,
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

async function createTransferFixture() {
  const main = await registeredRepo()
  git(["-C", main, "config", "user.name", "fixture"])
  git(["-C", main, "config", "user.email", "fixture@example.invalid"])
  git(["-C", main, "commit", "--allow-empty", "-qm", "base"])
  const base = git(["-C", main, "rev-parse", "HEAD"])
  const linked = (name: string, from = base) => {
    const root = join(fixture.root, name)
    git(["-C", main, "worktree", "add", "--detach", "-q", root, from])
    return root
  }
  expect(await initializeAdoptionTracker()).toBe(true)
  const commit = async (root: string, lines: string[], generate?: string[]) => {
    const absPath = join(root, "sample.py")
    const content = lines.join("\n") + "\n"
    await writeFile(absPath, content)
    if (generate) {
      recordGen({
        tool: "write_file",
        threadId: "transfer",
        filePath: absPath,
        workspacePath: root,
        generatedContent: generate.join("\n") + "\n"
      })
      await waitForAdoptionRecordGenIdleForTest()
    }
    git(["-C", root, "add", "sample.py"])
    git(["-C", root, "commit", "-qm", "sample " + root])
    const sha = git(["-C", root, "rev-parse", "HEAD"])
    const snap = [{ absPath, stagedContent: Buffer.from(content) }]
    const time = Number(git(["-C", root, "show", "-s", "--format=%ct", sha])) * 1000
    await getCommitMeasurementStatus(root, sha)
    const pending = hasPendingGenerationsForCommit(snap, time, root)
    const measurementSnapshots = generate ? snap : [{ absPath, stagedContent: undefined }]
    expect(await measureForCommit(measurementSnapshots, sha, time, root)).toBe(true)
    await flushAdoptionEventOutbox()
    return { sha, snap, time, pending }
  }
  const events = () => [
    ...new Map(report.mock.calls.map(([event]) => [event.eventId, event])).values()
  ]
  const byCommit = (sha: string, name: string) =>
    events().filter((e) => e.eventName === name && e.properties?.commitSha === sha)
  return { main, linked, commit, events, byCommit }
}

it("moves only the 50 independently added lines out of 80, persists the correction and keeps push attribution per SHA", async () => {
  const { main, linked, commit, events, byCommit } = await createTransferFixture()
  const lines = Array.from({ length: 80 }, (_, i) => `result_${i} = transform_${i}(payload)`)
  const source = linked("task")
  const a = await commit(source, lines, lines)
  const original = byCommit(a.sha, "code_adopt")[0]
  expect(original.properties?.adoptedLineCount).toBe(80)
  rememberAdoptionPush([a.sha], {
    pushOperationId: "push-a",
    pushedAt: new Date().toISOString(),
    remoteUrl: "origin",
    repositoryHost: "h",
    repositoryName: "r",
    repositoryFullName: "g/r",
    repositoryWebUrl: "https://h/g/r",
    commitUrlTemplate: "https://h/g/r/commit/{sha}"
  })
  shutdownAdoptionTracker()
  expect(await initializeAdoptionTracker()).toBe(true)
  git(["-C", main, "worktree", "remove", source])
  const b = await commit(main, lines.slice(0, 50))
  expect(b.pending).toBe(true)
  expect(wasEmptyTransferProbe(main, b.sha)).toBe(false)
  expect(await measureForCommit(b.snap, b.sha, b.time, main)).toBe(true)
  await flushAdoptionEventOutbox()
  expect(events().filter((e) => e.eventName === "code_gen")).toHaveLength(1)
  for (const [sha, count, ranges] of [
    [a.sha, 30, ["51-80"]],
    [b.sha, 50, ["1-50"]]
  ] as const) {
    const rows = byCommit(sha, "code_adopt")
    expect(rows).toHaveLength(1)
    expect(rows[0].properties).toMatchObject({
      adoptedLineCount: count,
      effectiveGeneratedLineCount: count,
      generatedLineCount: count
    })
    const files = byCommit(sha, "code_commit_file")
    expect(files).toHaveLength(1)
    expect(files[0].properties).toMatchObject({
      agentLineCount: count,
      agentLineRanges: ranges,
      fileDeleted: false
    })
    const [detail] = await readLocalCommitAdoptionLines(sha, [
      String(original.properties?.genEventId)
    ])
    expect(detail).toMatchObject({
      available: true,
      matchedLineCount: count,
      generatedLineCount: count
    })
  }
  expect(byCommit(a.sha, "code_adopt")[0]).toMatchObject({
    eventId: original.eventId,
    properties: { pushed: true, commitUrl: `https://h/g/r/commit/${a.sha}` }
  })
  expect(byCommit(b.sha, "code_adopt")[0].properties?.pushed).toBeUndefined()
  // A later commit retains the first 50 unchanged and adds the remaining 30.
  // It must only receive the new 30, even when the source has since disappeared.
  const later = await commit(main, lines)
  expect(byCommit(later.sha, "code_adopt")[0].properties?.adoptedLineCount).toBe(30)
  expect(byCommit(b.sha, "code_adopt")[0].properties?.adoptedLineCount).toBe(50)
  expect(byCommit(a.sha, "code_adopt")[0].properties?.adoptedLineCount).toBe(0)
  expect(
    (await readLocalCommitAdoptionLines(a.sha, [String(original.properties?.genEventId)]))[0]
      .matchedLineCount
  ).toBe(0)
})

it("keeps inherited lines with the ancestor and rejects multiple possible source worktrees", async () => {
  const { main, linked, commit, byCommit } = await createTransferFixture()
  const lines = [
    "keep_one = transform_one()",
    "keep_two = transform_two()",
    "keep_three = transform_three()"
  ]
  const a = await commit(linked("source"), lines, lines)
  // A normal checkout based on A inherits all three lines, even if it later
  // deletes and independently reintroduces them in a new diff.
  const child = linked("child", a.sha)
  await commit(child, ["unrelated_value = 42"])
  const inherited = await commit(child, lines)
  expect(wasEmptyTransferProbe(child, inherited.sha)).toBe(true)
  expect(byCommit(inherited.sha, "code_adopt")).toEqual([])
  const other = await commit(linked("other"), lines, lines)
  const b = await commit(main, lines)
  expect(byCommit(b.sha, "code_adopt")).toEqual([])
  expect(wasEmptyTransferProbe(main, b.sha)).toBe(true)
  for (const sha of [a.sha, other.sha])
    expect(byCommit(sha, "code_adopt")[0].properties?.adoptedLineCount).toBe(3)
})

it("gives a receiver's own generation priority and never claims the same physical lines twice", async () => {
  const { main, linked, commit, byCommit } = await createTransferFixture()
  const lines = [
    "first_value = first()",
    "second_value = second()",
    "third_value = third()",
    "fourth_value = fourth()"
  ]
  const a = await commit(linked("source"), lines, lines)
  const b = await commit(main, lines, lines.slice(2))
  expect(byCommit(a.sha, "code_adopt")[0].properties?.adoptedLineCount).toBe(2)
  expect(byCommit(b.sha, "code_adopt").map((e) => e.properties?.adoptedLineCount)).toEqual([2, 2])
  expect(byCommit(b.sha, "code_commit_file")[0].properties).toMatchObject({
    agentLineCount: 4,
    agentLineRanges: ["1-4"]
  })
})

it("ignores an identical file in a separate repository and a merge importing A as its second parent", async () => {
  const { main, linked, commit, byCommit } = await createTransferFixture()
  const lines = ["ledger_value = read_ledger()", "return_value = format_ledger(ledger_value)"]
  const a = await commit(linked("source"), lines, lines)
  const unrelated = join(fixture.root, "separate")
  git(["clone", "-q", main, unrelated])
  git(["-C", unrelated, "config", "user.name", "fixture"])
  git(["-C", unrelated, "config", "user.email", "fixture@example.invalid"])
  const copy = await commit(unrelated, lines)
  expect(copy.pending).toBe(false)
  expect(byCommit(copy.sha, "code_adopt")).toHaveLength(0)
  git(["-C", main, "merge", "--no-ff", "-qm", "merge source", a.sha])
  const merge = git(["-C", main, "rev-parse", "HEAD"])
  const snapshots = [
    { absPath: join(main, "sample.py"), stagedContent: Buffer.from(lines.join("\n") + "\n") }
  ]
  expect(await measureForCommit(snapshots, merge, undefined, main)).toBe(true)
  await flushAdoptionEventOutbox()
  expect(byCommit(merge, "code_adopt")).toHaveLength(0)
  expect(byCommit(a.sha, "code_adopt")[0].properties?.adoptedLineCount).toBe(2)
})

it("locates repeated statements by unique adjacent lines but leaves isolated or edited lines at A", async () => {
  const { main, linked, commit, byCommit } = await createTransferFixture()
  const lines = [
    "if read_primary():",
    "    return done",
    "if read_secondary():",
    "    return done",
    "isolated_value = 123"
  ]
  const a = await commit(linked("source"), lines, lines)
  const b = await commit(main, [...lines.slice(0, 4), "edited_value = 999", "isolated_value = 123"])
  expect(byCommit(b.sha, "code_commit_file")[0].properties).toMatchObject({
    agentLineCount: 4,
    agentLineRanges: ["1-4"]
  })
  expect(byCommit(a.sha, "code_commit_file")[0].properties).toMatchObject({
    agentLineCount: 1,
    agentLineRanges: ["5-5"]
  })
})

it("does not transfer a pair of common imports without a distinctive code anchor", async () => {
  const { main, linked, commit, byCommit } = await createTransferFixture()
  const imports = ["import os", "import sys"]
  const a = await commit(linked("source"), imports, imports)
  const b = await commit(main, imports)
  expect(byCommit(b.sha, "code_adopt")).toHaveLength(0)
  expect(byCommit(a.sha, "code_adopt")[0].properties?.adoptedLineCount).toBe(2)
})

it("handles a multi-file transfer with one patch, one ancestry check and no per-file Git blob reads", async () => {
  const { main, linked, byCommit } = await createTransferFixture()
  const source = linked("batch")
  const names = Array.from({ length: 12 }, (_, i) => `batch_${i}.py`)
  const snapshots = await Promise.all(
    names.map(async (name, i) => {
      const content = `batch_${i} = calculate_${i}()\noutput_${i} = format_result(batch_${i})\n`
      const absPath = join(source, name)
      await Promise.all([writeFile(absPath, content), writeFile(join(main, name), content)])
      recordGen({
        tool: "write_file",
        threadId: "batch",
        workspacePath: source,
        filePath: absPath,
        generatedContent: content
      })
      return { absPath, stagedContent: Buffer.from(content) }
    })
  )
  await waitForAdoptionRecordGenIdleForTest()
  for (const [root, subject] of [
    [source, "source"],
    [main, "receiver"]
  ]) {
    git(["-C", root, "add", "."])
    git(["-C", root, "commit", "-qm", subject])
  }
  const a = git(["-C", source, "rev-parse", "HEAD"])
  const b = git(["-C", main, "rev-parse", "HEAD"])
  expect(await measureForCommit(snapshots, a, undefined, source)).toBe(true)
  for (let batch = 0; batch < 3; batch++) await flushAdoptionEventOutbox()
  const trace = join(fixture.root, "transfer-git-processes.jsonl")
  vi.stubEnv("GIT_TRACE2_EVENT", trace)
  expect(
    await measureForCommit(
      names.map((name) => ({ absPath: join(main, name), stagedContent: undefined })),
      b,
      undefined,
      main
    )
  ).toBe(true)
  for (let batch = 0; batch < 3; batch++) await flushAdoptionEventOutbox()
  const starts = (await readFile(trace, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((e) => e.event === "start")
    .map((e) => e.argv as string[])
  expect(starts.filter((args) => args.includes("diff-tree"))).toHaveLength(1)
  expect(starts.filter((args) => args.includes("merge-base"))).toHaveLength(1)
  expect(
    starts.filter((args) => args.includes("show") && args.some((arg) => arg.startsWith(b + ":")))
  ).toEqual([])
  expect(byCommit(b, "code_adopt")).toHaveLength(names.length)
  expect(byCommit(a, "code_adopt").every((e) => e.properties?.adoptedLineCount === 0)).toBe(true)
})
