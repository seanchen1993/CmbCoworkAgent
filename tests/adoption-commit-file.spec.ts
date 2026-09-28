/**
 * `code_commit_file` end to end: agent generation → real git commit →
 * measureForCommit → outbox → reporter.
 *
 * Run:
 *   npx tsx tests/adoption-commit-file.spec.ts
 */

import { execFile } from "child_process"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { promisify } from "util"
import type {
  CoworkEvent,
  EventReportResult,
  IEventReporter
} from "../src/main/services/event-reporter.ts"

type AdoptionTrackerModule = typeof import("../src/main/services/adoption-tracker.ts")
type EventReporterModule = typeof import("../src/main/services/event-reporter.ts")

let testDataRoot = ""
let captureStagedSnapshotsForCommit!: AdoptionTrackerModule["captureStagedSnapshotsForCommit"]
let flushAdoptionEventOutbox!: AdoptionTrackerModule["flushAdoptionEventOutbox"]
let initializeAdoptionTracker!: AdoptionTrackerModule["initializeAdoptionTracker"]
let measureForCommit!: AdoptionTrackerModule["measureForCommit"]
let recordGen!: AdoptionTrackerModule["recordGen"]
let shutdownAdoptionTracker!: AdoptionTrackerModule["shutdownAdoptionTracker"]
let waitForAdoptionRecordGenIdleForTest!: AdoptionTrackerModule["waitForAdoptionRecordGenIdleForTest"]
let NoopEventReporter!: EventReporterModule["NoopEventReporter"]
let setEventReporter!: EventReporterModule["setEventReporter"]

const execFileAsync = promisify(execFile)

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${message}: expected ${e}, got ${a}`)
}

class CapturingReporter implements IEventReporter {
  readonly events: CoworkEvent[] = []

  async report(event: CoworkEvent): Promise<EventReportResult> {
    this.events.push(JSON.parse(JSON.stringify(event)) as CoworkEvent)
    return { ok: true, status: 200 }
  }

  named(eventName: string, commitSha: string): Record<string, unknown>[] {
    return this.events
      .filter((event) => event.eventName === eventName)
      .map((event) => event.properties ?? {})
      .filter((properties) => properties.commitSha === commitSha)
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf-8" })
  return stdout.trim()
}

async function withRepo<T>(
  name: string,
  withBaseCommit: boolean,
  fn: (repo: string) => Promise<T>
): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), `${name}-`))
  const repo = await realpath(tempDir)
  try {
    await git(repo, ["init", "-q", "-b", "main"])
    await git(repo, ["config", "user.email", "test@example.com"])
    await git(repo, ["config", "user.name", "Test"])
    await mkdir(join(repo, "src"), { recursive: true })
    if (withBaseCommit) {
      await writeFile(join(repo, "README.md"), "init\n")
      await git(repo, ["add", "."])
      await git(repo, ["commit", "-q", "-m", "init"])
    }
    return await fn(repo)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

async function withTracker<T>(fn: (reporter: CapturingReporter) => Promise<T>): Promise<T> {
  shutdownAdoptionTracker()
  const reporter = new CapturingReporter()
  setEventReporter(reporter)
  assert(await initializeAdoptionTracker(), "tracker should initialize")
  try {
    return await fn(reporter)
  } finally {
    await waitForAdoptionRecordGenIdleForTest()
    shutdownAdoptionTracker()
    setEventReporter(new NoopEventReporter())
    await rm(join(testDataRoot, "adoption"), { recursive: true, force: true })
    await rm(join(testDataRoot, "adoption-index.sqlite"), { force: true })
  }
}

/** Stage everything, commit it, and run the commit-time measurement like the git panel does. */
async function commitAndMeasure(
  repo: string,
  message: string,
  stage: string[] = ["-A"]
): Promise<string> {
  await waitForAdoptionRecordGenIdleForTest()
  await git(repo, ["add", ...stage])
  const captureTimeMs = Date.now()
  const snapshots = await captureStagedSnapshotsForCommit(repo)
  await git(repo, ["commit", "-q", "-m", message])
  const commitSha = await git(repo, ["rev-parse", "HEAD"])
  assert(
    await measureForCommit(snapshots, commitSha, captureTimeMs, repo),
    "commit measurement should complete durably"
  )
  await flushAdoptionEventOutbox()
  return commitSha
}

function sum(rows: Record<string, unknown>[], field: string): number {
  return rows.reduce((total, row) => total + (typeof row[field] === "number" ? row[field] : 0), 0)
}

/** The per-file rollups of a commit must add up to its code_adopt events. */
function assertRollupMatchesAdoptEvents(reporter: CapturingReporter, commitSha: string): void {
  const files = reporter.named("code_commit_file", commitSha)
  const adopts = reporter
    .named("code_adopt", commitSha)
    .filter((row) => typeof row.adoptedLineCount === "number")
  assert(files.length > 0, "commit should have code_commit_file events")
  assertEqual(
    sum(files, "agentLineCount"),
    sum(adopts, "adoptedLineCount"),
    "agentLineCount should sum to the commit's adoptedLineCount"
  )
  assertEqual(
    sum(files, "effectiveGeneratedLineCount"),
    sum(adopts, "effectiveGeneratedLineCount"),
    "effectiveGeneratedLineCount should sum to the commit's code_adopt events"
  )
  assertEqual(
    sum(files, "generatedLineCount"),
    sum(adopts, "generatedLineCount"),
    "generatedLineCount should sum to the commit's code_adopt events"
  )
  const rolledUp = files.flatMap((row) => row.genEventIds as string[]).sort()
  assertEqual(
    rolledUp,
    adopts.map((row) => row.genEventId as string).sort(),
    "genEventIds should list exactly the commit's code_adopt generations"
  )
  for (const row of files) {
    const ranges = row.agentLineRanges as string[]
    const covered = ranges.reduce((total, range) => {
      const [start, end] = range.split("-").map(Number)
      return total + end - start + 1
    }, 0)
    assertEqual(
      covered,
      row.agentLineCount,
      `ranges of ${String(row.filePath)} should cover every agent line`
    )
  }
}

async function testEditAndNewFileInOneCommit(): Promise<void> {
  await withTracker(async (reporter) => {
    await withRepo("commit-file-edit", true, async (repo) => {
      const orderPath = join(repo, "src", "Order.java")
      await writeFile(
        orderPath,
        ["class Order {", "  void a() {", "    doA();", "  }", "}", ""].join("\n")
      )
      await git(repo, ["add", "."])
      await git(repo, ["commit", "-q", "-m", "base"])

      // The agent inserts b(); its `}` duplicates three other lines in the file.
      recordGen({
        threadId: "commit-file-spec",
        workspacePath: repo,
        filePath: orderPath,
        tool: "edit_file",
        oldString: "    doA();\n  }\n",
        generatedContent: "    doA();\n  }\n\n  void b() {\n    doB();\n  }\n",
        occurrences: 1
      })
      // The human adds c() in the same commit.
      await writeFile(
        orderPath,
        [
          "class Order {", //  1
          "  void a() {", //   2
          "    doA();", //     3
          "  }", //            4
          "", //               5
          "  void b() {", //   6  agent
          "    doB();", //     7  agent
          "  }", //            8  agent
          "", //               9
          "  void c() {", //   10 human
          "    doC();", //     11 human
          "  }", //            12 human
          "}", //              13
          ""
        ].join("\n")
      )

      // The agent creates util.ts; the human rewrites its last line before committing.
      const utilPath = join(repo, "src", "util.ts")
      const generated = [
        "export function add(a: number, b: number) {",
        "  return a + b",
        "}",
        "export const ZERO = 0",
        ""
      ].join("\n")
      recordGen({
        threadId: "commit-file-spec",
        workspacePath: repo,
        filePath: utilPath,
        tool: "write_file",
        generatedContent: generated,
        deletedLineCount: 0
      })
      await writeFile(utilPath, generated.replace("= 0", "= 0 // tuned by hand"))

      const commitSha = await commitAndMeasure(repo, "agent work")
      const files = reporter.named("code_commit_file", commitSha)
      assertEqual(
        files.map((row) => row.filePath).sort(),
        ["src/Order.java", "src/util.ts"],
        "one event per file"
      )

      const order = files.find((row) => row.filePath === "src/Order.java") ?? {}
      assertEqual(order.agentLineCount, 3, "Order.java agent line count")
      assertEqual(
        order.agentLineRanges,
        ["6-8"],
        "Order.java `}` should land next to b(), not in a() or c()"
      )
      assertEqual(order.lineMapping, "diff", "Order.java line mapping")
      assertEqual(order.agentLineCountOutsideDiff, 0, "Order.java lines outside the diff")
      assertEqual(order.addedLineCount, 8, "Order.java added lines")
      assertEqual(order.addedNonBlankLineCount, 6, "Order.java added non-blank lines")
      assertEqual(order.deletedLineCount, 0, "Order.java deleted lines")
      assertEqual(order.fileDeleted, false, "Order.java is not deleted")
      assertEqual(order.language, "java", "Order.java language")
      assertEqual(order.agentLineRangesTruncated, false, "Order.java ranges are complete")

      const util = files.find((row) => row.filePath === "src/util.ts") ?? {}
      assertEqual(util.agentLineCount, 3, "util.ts keeps the three untouched agent lines")
      assertEqual(util.agentLineRanges, ["1-3"], "util.ts agent lines")
      assertEqual(util.generatedLineCount, 4, "util.ts generated lines")
      assertEqual(util.effectiveGeneratedLineCount, 4, "util.ts effective lines")
      assertEqual(util.addedLineCount, 4, "util.ts is a new file")

      assertRollupMatchesAdoptEvents(reporter, commitSha)
    })
  })
  console.log("PASS edits and new files report agent lines where the commit added them")
}

async function testDeletedFile(): Promise<void> {
  await withTracker(async (reporter) => {
    await withRepo("commit-file-delete", true, async (repo) => {
      const legacyPath = join(repo, "src", "legacy.ts")
      await writeFile(legacyPath, "export const a = 1\n")
      await git(repo, ["add", "."])
      await git(repo, ["commit", "-q", "-m", "base"])

      recordGen({
        threadId: "commit-file-spec",
        workspacePath: repo,
        filePath: legacyPath,
        tool: "edit_file",
        oldString: "export const a = 1\n",
        generatedContent: "export const a = 1\nexport const b = 2\n",
        occurrences: 1
      })
      await writeFile(legacyPath, "export const a = 1\nexport const b = 2\n")
      await waitForAdoptionRecordGenIdleForTest()
      await rm(legacyPath)

      const commitSha = await commitAndMeasure(repo, "drop legacy")
      const [row] = reporter.named("code_commit_file", commitSha)
      assert(row, "deleted file should still get a rollup")
      assertEqual(row.fileDeleted, true, "file is deleted")
      assertEqual(row.agentLineCount, 0, "no agent lines survive a deletion")
      assertEqual(row.agentLineRanges, [], "no line numbers for a deleted file")
      assertEqual(
        row.effectiveGeneratedLineCount,
        1,
        "the generated line still counts as effective"
      )
      assertEqual(row.addedLineCount, 0, "deletion adds nothing")
      assertEqual(row.deletedLineCount, 1, "deletion removes the committed line")
      assertEqual(row.lineMapping, "diff", "deleted file still has diff information")
      assertRollupMatchesAdoptEvents(reporter, commitSha)
    })
  })
  console.log("PASS deleted files report zero agent lines and keep the rollup consistent")
}

async function testRootCommit(): Promise<void> {
  await withTracker(async (reporter) => {
    await withRepo("commit-file-root", false, async (repo) => {
      const firstPath = join(repo, "src", "first.ts")
      const content = "export const first = 1\n\nexport const second = 2\n"
      recordGen({
        threadId: "commit-file-spec",
        workspacePath: repo,
        filePath: firstPath,
        tool: "write_file",
        generatedContent: content,
        deletedLineCount: 0
      })
      await writeFile(firstPath, content)

      const commitSha = await commitAndMeasure(repo, "root")
      const [row] = reporter.named("code_commit_file", commitSha)
      assert(row, "root commit should get a rollup")
      assertEqual(row.lineMapping, "diff", "root commit is diffed as a creation")
      assertEqual(row.agentLineRanges, ["1-1", "3-3"], "blank line 2 splits the ranges")
      assertEqual(row.agentLineCountOutsideDiff, 0, "every agent line was added by the root commit")
      assertEqual(row.addedLineCount, 3, "root commit adds every line")
      assertEqual(row.addedNonBlankLineCount, 2, "root commit adds two non-blank lines")
      assertRollupMatchesAdoptEvents(reporter, commitSha)
    })
  })
  console.log("PASS root commits are diffed as creations")
}

async function main(): Promise<void> {
  await testEditAndNewFileInOneCommit()
  await testDeletedFile()
  await testRootCommit()
}

async function run(): Promise<void> {
  testDataRoot = await mkdtemp(join(tmpdir(), "adoption-commit-file-data-"))
  process.env.CMB_COWORK_AGENT_HOME = testDataRoot
  try {
    const adoptionTracker = await import("../src/main/services/adoption-tracker.ts")
    const eventReporter = await import("../src/main/services/event-reporter.ts")
    ;({
      captureStagedSnapshotsForCommit,
      flushAdoptionEventOutbox,
      initializeAdoptionTracker,
      measureForCommit,
      recordGen,
      shutdownAdoptionTracker,
      waitForAdoptionRecordGenIdleForTest
    } = adoptionTracker)
    ;({ NoopEventReporter, setEventReporter } = eventReporter)
    await main()
  } finally {
    await waitForAdoptionRecordGenIdleForTest?.()
    shutdownAdoptionTracker?.()
    await rm(testDataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

run().catch((error) => {
  console.error("FAIL adoption commit-file tests", error)
  process.exitCode = 1
})
