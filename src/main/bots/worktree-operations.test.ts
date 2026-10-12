import { afterEach, expect, it } from "vitest"
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { executeBotWorktreeOperation } from "./worktree-operations"
import {
  botWorktreeAcquired,
  botWorktreeDetail,
  botWorktreeRecord,
  botWorktreeSource
} from "./worktree-contract"
import { BotHostLock } from "./host-lock"
import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"

const exec = promisify(execFile)
const clean: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const fn of clean.splice(0).reverse()) await fn()
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "bot-worktree-git-"))
  clean.push(() => rm(directory, { recursive: true, force: true }))
  const workspacePath = join(directory, "project"),
    appDataRoot = join(directory, "managed")
  await mkdir(workspacePath)
  const git = (cwd: string, ...args: string[]) =>
    exec("git", [
      "-c",
      "user.name=Workflow Test",
      "-c",
      "user.email=workflow@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-C",
      cwd,
      ...args
    ])
  await git(workspacePath, "init", "-b", "main")
  await writeFile(join(workspacePath, "app.txt"), "original\n")
  await git(workspacePath, "add", "app.txt")
  await git(workspacePath, "commit", "-m", "initial")
  const common = { workspacePath, appDataRoot },
    signal = new AbortController().signal
  const source = botWorktreeSource.parse(
    await executeBotWorktreeOperation({ ...common, op: "prepare" }, signal)
  )
  const acquire = async (childId = "child-a") =>
    botWorktreeAcquired.parse(
      await executeBotWorktreeOperation(
        { ...common, source, op: "acquire", runId: "wf_abcdef123456", childId },
        signal
      )
    )
  return { ...common, directory, common, signal, source, git, acquire }
}

it("creates isolated sibling checkouts from one frozen HEAD and recovers the same checkout with its changes", async () => {
  const f = await fixture()
  await writeFile(join(f.workspacePath, "app.txt"), "source uncommitted\n")
  const [a, b] = await Promise.all([f.acquire(), f.acquire("child-b")])
  expect(a.boundary.workspaceRoot).not.toBe(b.boundary.workspaceRoot)
  expect(await readFile(join(a.boundary.workspaceRoot, "app.txt"), "utf8")).toBe("original\n")
  await writeFile(join(a.boundary.workspaceRoot, "app.txt"), "isolated change\n")
  const recovered = await f.acquire()
  expect(recovered.record.id).toBe(a.record.id)
  expect(await readFile(join(recovered.boundary.workspaceRoot, "app.txt"), "utf8")).toBe(
    "isolated change\n"
  )
  expect(await readFile(join(b.boundary.workspaceRoot, "app.txt"), "utf8")).toBe("original\n")
  expect(await readFile(join(f.workspacePath, "app.txt"), "utf8")).toBe("source uncommitted\n")
  const ready = botWorktreeRecord.parse(
    await executeBotWorktreeOperation(
      { ...f.common, op: "settle", record: a.record, succeeded: true },
      f.signal
    )
  )
  expect(ready).toMatchObject({ status: "ready", dirty: true })
  const detail = botWorktreeDetail.parse(
    await executeBotWorktreeOperation({ ...f.common, op: "diff", record: ready }, f.signal)
  )
  expect(detail.summary).toContain("app.txt")
}, 20_000)

it("reuses Cmb integration and preserves the original source until the reviewed worktree is merged", async () => {
  const f = await fixture(),
    a = await f.acquire()
  await writeFile(join(a.boundary.workspaceRoot, "app.txt"), "reviewed change\n")
  await f.git(a.boundary.workspaceRoot, "add", "app.txt")
  await f.git(a.boundary.workspaceRoot, "commit", "-m", "reviewed change")
  const ready = botWorktreeRecord.parse(
    await executeBotWorktreeOperation(
      { ...f.common, op: "settle", record: a.record, succeeded: true },
      f.signal
    )
  )
  expect(await readFile(join(f.workspacePath, "app.txt"), "utf8")).toBe("original\n")
  await expect(
    executeBotWorktreeOperation(
      { ...f.common, op: "merge", record: ready, expectedHeadCommit: ready.baseCommit },
      f.signal
    )
  ).rejects.toThrow("reviewed deliverable changed")
  expect(await readFile(join(f.workspacePath, "app.txt"), "utf8")).toBe("original\n")
  const merged = botWorktreeRecord.parse(
    await executeBotWorktreeOperation(
      { ...f.common, op: "merge", record: ready, expectedHeadCommit: ready.headCommit! },
      f.signal
    )
  )
  expect(merged.status).toBe("merged")
  expect(await readFile(join(f.workspacePath, "app.txt"), "utf8")).toBe("reviewed change\n")
  await expect(f.acquire()).rejects.toThrow("已交付")
}, 20_000)

it("previews committed, staged, unstaged and new files without staging or invoking external diff", async () => {
  const f = await fixture(),
    a = await f.acquire()
  const checkout = a.record.directory
  await writeFile(join(checkout, "app.txt"), "committed\n")
  await f.git(checkout, "add", "app.txt")
  await f.git(checkout, "commit", "-m", "first change")
  await writeFile(join(checkout, "app.txt"), "in progress\n")
  await writeFile(join(checkout, "staged.txt"), "staged contents\n")
  await f.git(checkout, "add", "staged.txt")
  await writeFile(join(checkout, "新增.txt"), "new contents\n")
  await f.git(checkout, "config", "diff.external", "must-not-execute-diff")
  const before = (await f.git(checkout, "status", "--porcelain", "-z")).stdout
  const detail = botWorktreeDetail.parse(
    await executeBotWorktreeOperation({ ...f.common, op: "diff", record: a.record }, f.signal)
  )
  expect(detail.patch).toContain("-original")
  expect(detail.patch).toContain("+in progress")
  expect(detail.patch).toContain("+staged contents")
  expect(detail.patch).toContain("b/新增.txt")
  expect(detail.patch).toContain("+new contents")
  expect(detail.patchTruncated).toBe(false)
  expect((await f.git(checkout, "status", "--porcelain", "-z")).stdout).toBe(before)
  expect(await readFile(join(f.workspacePath, "app.txt"), "utf8")).toBe("original\n")
}, 20_000)

it("bounds previews and never follows an untracked link to private content", async () => {
  const f = await fixture(),
    a = await f.acquire()
  const checkout = a.record.directory
  await writeFile(join(f.directory, "private.txt"), "PRIVATE_CONTENT_MUST_NOT_BE_READ")
  // Windows file symlink creation requires developer mode/admin. The bounded
  // binary/large-file checks remain platform-independent.
  if (process.platform !== "win32")
    await symlink(join(f.directory, "private.txt"), join(checkout, "link.txt"))
  await writeFile(join(checkout, "binary.bin"), Buffer.from([0, 1, 2, 3]))
  await writeFile(join(checkout, "large.txt"), "oversized\n".repeat(40_000))
  const detail = botWorktreeDetail.parse(
    await executeBotWorktreeOperation({ ...f.common, op: "diff", record: a.record }, f.signal)
  )
  if (process.platform !== "win32") expect(detail.patch).toContain("new file mode 120000")
  expect(detail.patch).not.toContain("PRIVATE_CONTENT_MUST_NOT_BE_READ")
  expect(detail.summary).toContain("binary.bin")
  expect(detail.summary).toContain("large.txt")
  expect(detail.patchTruncated).toBe(true)
  expect(detail.patch!.length).toBeLessThanOrEqual(256_000)
  await writeFile(join(checkout, "app.txt"), "tracked oversized\n".repeat(100_000))
  const oversized = botWorktreeDetail.parse(
    await executeBotWorktreeOperation({ ...f.common, op: "diff", record: a.record }, f.signal)
  )
  expect(oversized.patchTruncated).toBe(true)
  expect(oversized.patch).toContain("+tracked oversized")
  expect(oversized.patch!.length).toBeLessThanOrEqual(256_000)
}, 20_000)

it("rejects changed ownership and missing checkouts instead of replacing them", async () => {
  const f = await fixture(),
    a = await f.acquire()
  await rm(a.record.directory, { recursive: true })
  await expect(f.acquire()).rejects.toThrow()
  await expect(
    executeBotWorktreeOperation(
      { ...f.common, op: "settle", record: { ...a.record, threadId: "other" }, succeeded: true },
      f.signal
    )
  ).rejects.toThrow("ownership")
  await expect(
    executeBotWorktreeOperation(
      { ...f.common, op: "status", record: { ...a.record, directory: f.workspacePath } },
      f.signal
    )
  ).rejects.toThrow("ownership")
}, 15_000)

it("pins discarded commits, removes only the owned checkout and keeps the source unchanged", async () => {
  const f = await fixture(),
    a = await f.acquire()
  await writeFile(join(a.record.directory, "app.txt"), "to discard\n")
  await f.git(a.record.directory, "add", "app.txt")
  await f.git(a.record.directory, "commit", "-m", "private change")
  const ready = botWorktreeRecord.parse(
    await executeBotWorktreeOperation(
      { ...f.common, op: "settle", record: a.record, succeeded: true },
      f.signal
    )
  )
  await expect(
    executeBotWorktreeOperation(
      { ...f.common, op: "discard", record: ready, expectedHeadCommit: ready.baseCommit },
      f.signal
    )
  ).rejects.toThrow("reviewed deliverable changed")
  await writeFile(join(a.record.directory, "untracked.txt"), "also explicitly discarded")
  const discarded = botWorktreeRecord.parse(
    await executeBotWorktreeOperation(
      { ...f.common, op: "discard", record: ready, expectedHeadCommit: ready.headCommit! },
      f.signal
    )
  )
  expect(discarded).toMatchObject({ status: "discarded", cleanupPending: false })
  await expect(readFile(join(a.record.directory, "app.txt"))).rejects.toThrow()
  expect(await readFile(join(f.workspacePath, "app.txt"), "utf8")).toBe("original\n")
  expect(
    (await f.git(f.workspacePath, "worktree", "list", "--porcelain")).stdout.match(/^worktree /gm)
  ).toHaveLength(1)
  const cleaned = botWorktreeRecord.parse(
    await executeBotWorktreeOperation(
      { ...f.common, op: "cleanup", record: discarded, expectedHeadCommit: discarded.headCommit! },
      f.signal
    )
  )
  expect(cleaned).toMatchObject({ status: "discarded", cleanupPending: false })
}, 20_000)

it("cancels while the prior worker owns the repository without dispatching another Git mutation", async () => {
  const f = await fixture()
  const lockDirectory = join(
    f.appDataRoot,
    ".locks",
    createHash("sha256").update(f.source.commonDir).digest("hex")
  )
  await mkdir(lockDirectory, { recursive: true })
  const lock = BotHostLock.acquire(lockDirectory)!
  const controller = new AbortController()
  const task = executeBotWorktreeOperation(
    { ...f.common, source: f.source, op: "acquire", runId: "wf_abcdef123456", childId: "waiting" },
    controller.signal
  )
  const rejected = expect(task).rejects.toThrow()
  controller.abort()
  try {
    await rejected
  } finally {
    lock.release()
  }
  expect(
    (await f.git(f.workspacePath, "worktree", "list", "--porcelain")).stdout.match(/^worktree /gm)
  ).toHaveLength(1)
}, 15_000)
