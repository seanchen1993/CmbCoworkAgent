import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, isAbsolute } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const fixture = vi.hoisted(() => ({ root: "", roots: [] as string[], holdCandidates: false,
  candidateEntered: undefined as (() => void) | undefined,
  candidatesReleased: undefined as Promise<void> | undefined,
  removals: [] as string[] }))

// Only directory discovery is controlled. The production deletion, disposal,
// sweep chains and fs.rm run unchanged against explicitly owned directories.
vi.mock("../context-history-path", async importOriginal => {
  const actual = await importOriginal<typeof import("../context-history-path")>()
  return { ...actual,
    getProjectThreadDataDirectoryReadCandidatesSync: () => fixture.roots,
    getProjectThreadDataDirectoryReadCandidates: async () => {
      if (fixture.holdCandidates) { fixture.candidateEntered?.(); await fixture.candidatesReleased }
      return fixture.roots
    } }
})
vi.mock("fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, rm: async (path: string, options: Parameters<typeof actual.rm>[1]) => {
    const suffix = relative(fixture.root, path)
    if (suffix.startsWith("..") || isAbsolute(suffix)) throw Error("Fixture attempted external deletion")
    fixture.removals.push(path)
    return actual.rm(path, options)
  } }
})

import { deleteWorkflowRunsForThread, getLegacyWorkflowRunsDir, isWorkflowRunDirDisposed,
  reviveWorkflowThread, setBeforeWorkflowRunDirSweepForTest } from "./run-store"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
let priorHome: string | undefined
let database: DatabaseSync
let workspace: string
let threadId: string
let directories: string[]
let tasks: Promise<unknown>[]
let releases: Array<() => void>
const guard = () => {
  if (database.prepare("SELECT 1 FROM threads WHERE thread_id=?").get(threadId))
    throw Error("DELETED_THREAD_SOURCE_RETIRED")
}
const recreate = () => {
  database.prepare("INSERT INTO threads VALUES(?,?)").run(threadId, '{"cmb_thread_incarnation":"NEW"}')
  reviveWorkflowThread(threadId)
  for (const directory of directories) writeFileSync(join(directory, "owner.txt"), "NEW")
}

beforeEach(() => {
  fixture.root = mkdtempSync(join(tmpdir(), "mods-retirement-workflow-"))
  fixture.roots = [join(fixture.root, "managed", "thread"), join(fixture.root, "pre-custom", "thread")]
  fixture.holdCandidates = false
  fixture.candidateEntered = undefined
  fixture.candidatesReleased = undefined
  fixture.removals = []
  workspace = join(fixture.root, "workspace")
  mkdirSync(workspace, { recursive: true })
  priorHome = process.env.CMB_COWORK_AGENT_HOME
  process.env.CMB_COWORK_AGENT_HOME = join(fixture.root, "app-data")
  threadId = "thread-" + fixture.root.split(/[/\\]/).at(-1)
  directories = [...fixture.roots.map(path => join(path, "workflows")),
    getLegacyWorkflowRunsDir(workspace, threadId)]
  for (const directory of directories) {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "owner.txt"), "OLD")
  }
  database = new DatabaseSync(":memory:")
  database.exec("CREATE TABLE threads(thread_id TEXT PRIMARY KEY,metadata TEXT)")
  tasks = []; releases = []
})
afterEach(async () => {
  for (const release of releases) release()
  await Promise.allSettled(tasks)
  setBeforeWorkflowRunDirSweepForTest()
  reviveWorkflowThread(threadId)
  database.close()
  if (priorHome === undefined) delete process.env.CMB_COWORK_AGENT_HOME
  else process.env.CMB_COWORK_AGENT_HOME = priorHome
  rmSync(fixture.root, { recursive: true, force: true })
})

it("does not mark or remove a replacement after held actual candidate discovery", async () => {
  const entered = deferred(), released = deferred()
  fixture.holdCandidates = true
  fixture.candidateEntered = entered.resolve
  fixture.candidatesReleased = released.promise
  releases.push(released.resolve)
  const deleting = deleteWorkflowRunsForThread(workspace, threadId, guard)
    .then(() => undefined, error => error)
  tasks.push(deleting)
  await entered.promise
  recreate()
  released.resolve()
  expect(await deleting).toMatchObject({ message: "DELETED_THREAD_SOURCE_RETIRED" })
  expect(isWorkflowRunDirDisposed(workspace, threadId)).toBe(false)
  expect(fixture.removals).toEqual([])
  for (const directory of directories) expect(readFileSync(join(directory, "owner.txt"), "utf8")).toBe("NEW")
})

it("rechecks source after the real pre-sweep await before dispatching any rm", async () => {
  const entered = deferred(), released = deferred()
  releases.push(released.resolve)
  setBeforeWorkflowRunDirSweepForTest(async () => { entered.resolve(); await released.promise })
  const deleting = deleteWorkflowRunsForThread(workspace, threadId, guard)
    .then(() => undefined, error => error)
  tasks.push(deleting)
  await entered.promise
  recreate()
  released.resolve()
  expect(await deleting).toMatchObject({ message: "DELETED_THREAD_SOURCE_RETIRED" })
  await new Promise<void>(done => setImmediate(done))
  expect(isWorkflowRunDirDisposed(workspace, threadId)).toBe(false)
  expect(fixture.removals).toEqual([])
  for (const directory of directories) expect(readFileSync(join(directory, "owner.txt"), "utf8")).toBe("NEW")
})

it("still tombstones and physically removes all owned candidates for the current deleted source", async () => {
  const deleting = deleteWorkflowRunsForThread(workspace, threadId, guard)
  tasks.push(deleting)
  await deleting
  expect(fixture.removals).toHaveLength(directories.length)
  expect(isWorkflowRunDirDisposed(workspace, threadId)).toBe(true)
  for (const directory of directories) expect(existsSync(directory)).toBe(false)
})
