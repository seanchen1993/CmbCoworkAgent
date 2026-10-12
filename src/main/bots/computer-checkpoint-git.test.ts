import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { createWorkflowWorktree, persistWorkflowWorktreeRecord } from "../services/git-worktree"
import { captureComputerGit, restoreComputerGit } from "./computer-checkpoint-git"
import { ComputerBudget } from "./computer-checkpoint-ports"
import { BotHostLock } from "./host-lock"
import type { WorkflowWorktreeRecord } from "../agent/workflow/types"
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true })
})
const exec = promisify(execFile)
const git = async (cwd: string, ...args: string[]) =>
  (
    await exec("git", [
      "-c",
      "user.name=Checkpoint Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-C",
      cwd,
      ...args
    ])
  ).stdout.trimEnd()
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-computer-git-")))
  roots.push(root)
  const project = join(root, "project"),
    appDataRoot = join(root, "workspaces"),
    ownerRoot = join(root, "owner")
  await mkdir(project)
  await mkdir(ownerRoot)
  await git(project, "init", "-b", "main")
  await writeFile(join(project, "app.txt"), "base\n")
  await git(project, "add", "app.txt")
  await git(project, "commit", "-m", "base")
  const info = await createWorkflowWorktree({
    workspacePath: project,
    appDataRoot,
    runId: "run",
    threadId: "thread",
    persistOwnership: true
  })
  const record: WorkflowWorktreeRecord = {
    ...info,
    id: info.name,
    runId: "run",
    threadId: "thread",
    status: "ready",
    dirty: true,
    updatedAt: new Date().toISOString()
  }
  await persistWorkflowWorktreeRecord(record, appDataRoot)
  const lock = BotHostLock.acquire(ownerRoot)!
  const owner = {
    assertCurrent: () => lock.assertCurrent(),
    checkCurrent: () => lock.checkCurrent(),
    identity: () => lock.recoveryOwnershipIdentity()
  }
  return { root, project, appDataRoot, record, lock, owner }
}
it("seals an actual managed linked checkout into an independent repository with full staged and unstaged state", async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.record.directory, "app.txt"), "staged\n")
    await git(f.record.directory, "add", "app.txt")
    await writeFile(join(f.record.directory, "app.txt"), "unstaged work\n")
    await writeFile(join(f.record.directory, "untracked.txt"), "ordinary evidence")
    const sourceHead = await git(f.project, "rev-parse", "HEAD"),
      managedHead = await git(f.record.directory, "rev-parse", "HEAD"),
      sourceCached = await git(
        f.record.directory,
        "diff",
        "--cached",
        "--binary",
        "--full-index",
        "HEAD"
      ),
      sourceDirty = await git(f.record.directory, "diff", "--binary", "--full-index")
    const archive = join(f.root, "archive"),
      restored = join(f.root, "restored")
    const manifest = await captureComputerGit({
      record: f.record,
      appDataRoot: f.appDataRoot,
      destination: archive,
      scratch: join(f.root, "scratch"),
      budget: new ComputerBudget(),
      owner: f.owner,
      signal: new AbortController().signal
    })
    expect(manifest.objects.count).toBeGreaterThan(0)
    await restoreComputerGit({
      source: archive,
      destination: restored,
      owner: f.owner,
      signal: new AbortController().signal,
      maxExpandedBytes: 20 * 1024 ** 3
    })
    expect(await readFile(join(restored, "app.txt"), "utf8")).toBe("unstaged work\n")
    expect(await readFile(join(restored, "untracked.txt"), "utf8")).toBe("ordinary evidence")
    expect(await git(restored, "diff", "--cached", "--binary", "--full-index", "HEAD")).toBe(
      sourceCached
    )
    expect(await git(restored, "diff", "--binary", "--full-index")).toBe(sourceDirty)
    expect(await git(restored, "rev-parse", "HEAD")).toBe(managedHead)
    expect(await git(f.project, "rev-parse", "HEAD")).toBe(sourceHead)
    expect(
      await git(f.record.directory, "diff", "--cached", "--binary", "--full-index", "HEAD")
    ).toBe(sourceCached)
    expect(await git(f.record.directory, "diff", "--binary", "--full-index")).toBe(sourceDirty)
    // Its .git is an independent directory, never the linked checkout's
    // external commonDir reference. It needs neither source refs nor network.
    expect(await git(restored, "rev-parse", "--git-common-dir")).toBe(".git")
  } finally {
    f.lock.release()
  }
}, 20_000)
it("refuses special index flags instead of publishing a falsely complete Git snapshot", async () => {
  const f = await fixture()
  try {
    await git(f.record.directory, "update-index", "--skip-worktree", "app.txt")
    await expect(
      captureComputerGit({
        record: f.record,
        appDataRoot: f.appDataRoot,
        destination: join(f.root, "archive"),
        scratch: join(f.root, "scratch"),
        budget: new ComputerBudget(),
        owner: f.owner,
        signal: new AbortController().signal
      })
    ).rejects.toThrow("索引标志")
    await expect(readFile(join(f.root, "archive", "manifest.json"))).rejects.toMatchObject({
      code: "ENOENT"
    })
  } finally {
    f.lock.release()
  }
}, 20_000)
