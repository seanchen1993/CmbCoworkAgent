/**
 * Integration tests for Git hook based code collection paths.
 *
 * Run:
 *   npx tsx tests/git-hook-collection-path.spec.ts
 */

import { execFile } from "child_process"
import { createHash } from "crypto"
import { existsSync } from "fs"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { promisify } from "util"

type AdoptionTrackerModule = typeof import("../src/main/services/adoption-tracker.ts")
type AdoptionIndexModule = typeof import("../src/main/services/adoption-index.ts")
type GitHookServiceModule = typeof import("../src/main/services/git-hook-service.ts")

let testDataRoot = ""
let captureStagedSnapshotsForCommit!: AdoptionTrackerModule["captureStagedSnapshotsForCommit"]
let initializeAdoptionTracker!: AdoptionTrackerModule["initializeAdoptionTracker"]
let recordGen!: AdoptionTrackerModule["recordGen"]
let shutdownAdoptionTracker!: AdoptionTrackerModule["shutdownAdoptionTracker"]
let waitForAdoptionRecordGenIdleForTest!: AdoptionTrackerModule["waitForAdoptionRecordGenIdleForTest"]
let findPendingGensForFile!: AdoptionIndexModule["findPendingGensForFile"]
let CMBDEVCLAW_INTERNAL_GIT_ENV!: GitHookServiceModule["CMBDEVCLAW_INTERNAL_GIT_ENV"]
let installGitHooks!: GitHookServiceModule["installGitHooks"]
let syncGitHookEvents!: GitHookServiceModule["syncGitHookEvents"]
let uninstallGitHooks!: GitHookServiceModule["uninstallGitHooks"]

const execFileAsync = promisify(execFile)

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function removeTempDir(dir: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (error) {
      lastError = error
      await sleep(125)
    }
  }
  throw lastError
}

async function withTempRepo<T>(name: string, fn: (repo: string) => Promise<T>): Promise<T> {
  const tempPath = await mkdtemp(join(tmpdir(), `${name}-`))
  const repo = await realpath(tempPath)
  try {
    await initRepo(repo)
    await cleanupRepoEvents(repo)
    return await fn(repo)
  } finally {
    await uninstallGitHooks(repo).catch(() => undefined)
    await cleanupRepoEvents(repo).catch(() => undefined)
    await removeTempDir(tempPath)
  }
}

async function git(
  cwd: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv }
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, ...(options?.env ?? {}) }
  })
  return stdout.trim()
}

async function initRepo(repo: string): Promise<void> {
  await git(repo, ["init", "-q", "-b", "main"])
  await git(repo, ["config", "user.email", "test@example.com"])
  await git(repo, ["config", "user.name", "Test"])
  await writeFile(join(repo, "README.md"), "init\n")
  await git(repo, ["add", "."])
  await git(repo, ["commit", "-q", "-m", "init"])
}

function repoKey(repo: string): string {
  return createHash("sha1").update(repo.trim().replace(/\\/g, "/").toLowerCase()).digest("hex")
}

function normalizePathForAssert(value: string): string {
  return value.trim().replace(/\\/g, "/").toLowerCase()
}

function repoEventsDir(repo: string): string {
  return join(testDataRoot, "git-hooks", "events", repoKey(repo))
}

function adoptionStorePath(name: string): string {
  return join(testDataRoot, name)
}

async function withIsolatedAdoptionStore<T>(fn: () => Promise<T>): Promise<T> {
  shutdownAdoptionTracker()
  const adoptionDir = adoptionStorePath("adoption")
  const adoptionIndex = adoptionStorePath("adoption-index.sqlite")
  await rm(adoptionDir, { recursive: true, force: true })
  await rm(adoptionIndex, { force: true })

  try {
    return await fn()
  } finally {
    await waitForAdoptionRecordGenIdleForTest()
    shutdownAdoptionTracker()
    await rm(adoptionDir, { recursive: true, force: true })
    await rm(adoptionIndex, { force: true })
  }
}

async function cleanupRepoEvents(repo: string): Promise<void> {
  await rm(repoEventsDir(repo), { recursive: true, force: true })
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

async function readReadySnapshot(repo: string): Promise<{
  name: string
  meta: {
    commitSha?: string
    gitRoot?: string
    files?: Array<{ absPath: string; relPath?: string; blobFile?: string; deleted?: boolean }>
  }
}> {
  const readyDir = join(repoEventsDir(repo), "ready")
  const names = await listDirs(readyDir)
  assert(names.length === 1, `expected exactly one ready snapshot, got ${names.length}`)
  const name = names[0]
  const raw = await readFile(join(readyDir, name, "meta.json"), "utf-8")
  return { name, meta: JSON.parse(raw) }
}

async function testExternalCommandCommitWithoutCodeGenIsSkipped(): Promise<void> {
  await withTempRepo("git-hook-external", async (repo) => {
    const status = await installGitHooks(repo)
    assert(status.state === "installed", `expected installed hook, got ${status.state}`)

    await writeFile(join(repo, "external.ts"), "export const externalValue = 1\n")
    await git(repo, ["add", "external.ts"])
    await git(repo, ["commit", "-q", "-m", "external command commit"])

    const head = await git(repo, ["rev-parse", "HEAD"])
    const snapshot = await readReadySnapshot(repo)
    assert(
      normalizePathForAssert(snapshot.meta.gitRoot || "") === normalizePathForAssert(repo),
      `snapshot gitRoot should be repo, got ${snapshot.meta.gitRoot}`
    )
    assert(snapshot.meta.commitSha === head, `snapshot commitSha should be HEAD, got ${snapshot.meta.commitSha}`)
    assert(snapshot.meta.files?.length === 1, `expected one collected file, got ${snapshot.meta.files?.length}`)
    assert(snapshot.meta.files?.[0]?.relPath === "external.ts", "external.ts should be collected")

    const blobFile = snapshot.meta.files?.[0]?.blobFile
    assert(blobFile, "collected file should reference a staged blob")
    const blob = await readFile(join(repoEventsDir(repo), "ready", snapshot.name, blobFile as string), "utf-8")
    assert(blob.includes("externalValue"), "staged blob should contain external command content")

    await syncGitHookEvents(repo)
    const remainingReady = await listDirs(join(repoEventsDir(repo), "ready"))
    const processed = await listDirs(join(repoEventsDir(repo), "processed"))
    const skipped = await listDirs(join(repoEventsDir(repo), "skipped"))
    assert(remainingReady.length === 0, "sync should consume ready external command snapshots")
    assert(processed.length === 0, "external command snapshot without code_gen should not be processed")
    assert(skipped.length === 1, "external command snapshot without code_gen should be skipped")
  })
}

async function testExternalCommandCommitWithCodeGenIsCollectedByHook(): Promise<void> {
  await withIsolatedAdoptionStore(async () => {
    await initializeAdoptionTracker()
    await withTempRepo("git-hook-external-codegen", async (repo) => {
      const status = await installGitHooks(repo)
      assert(status.state === "installed", `expected installed hook, got ${status.state}`)

      const filePath = join(repo, "external.ts")
      const generatedContent = "export const externalValue = 2\n"
      recordGen({
        threadId: "hook-test-thread",
        workspacePath: repo,
        filePath,
        tool: "write_file",
        generatedContent
      })
      await sleep(250)

      await writeFile(filePath, generatedContent)
      await git(repo, ["add", "external.ts"])
      await git(repo, ["commit", "-q", "-m", "external command commit with codegen"])

      await syncGitHookEvents(repo)
      await sleep(250)
      const remainingReady = await listDirs(join(repoEventsDir(repo), "ready"))
      const processed = await listDirs(join(repoEventsDir(repo), "processed"))
      const skipped = await listDirs(join(repoEventsDir(repo), "skipped"))
      assert(remainingReady.length === 0, "sync should consume ready code_gen snapshots")
      assert(processed.length === 1, "external command snapshot with code_gen should be processed")
      assert(skipped.length === 0, "external command snapshot with code_gen should not be skipped")
    })
  })
}

async function testGitPanelPathSkipsHookAndUsesDirectStagedCapture(): Promise<void> {
  await withTempRepo("git-hook-panel", async (repo) => {
    const status = await installGitHooks(repo)
    assert(status.state === "installed", `expected installed hook, got ${status.state}`)

    await writeFile(join(repo, "panel.ts"), "export const panelValue = 1\n")
    await git(repo, ["add", "panel.ts"])

    const snapshots = await captureStagedSnapshotsForCommit(repo)
    assert(snapshots.length === 1, `Git Panel path should directly capture one staged file, got ${snapshots.length}`)
    assert(snapshots[0]?.absPath.endsWith("panel.ts"), `expected panel.ts snapshot, got ${snapshots[0]?.absPath}`)
    assert(
      snapshots[0]?.stagedContent?.toString("utf-8").includes("panelValue"),
      "Git Panel direct staged snapshot should contain panel content"
    )

    await git(repo, ["commit", "-q", "-m", "git panel simulated commit"], {
      env: { [CMBDEVCLAW_INTERNAL_GIT_ENV]: "1" }
    })

    const readyDir = join(repoEventsDir(repo), "ready")
    const pendingDir = join(repoEventsDir(repo), "pending")
    assert(!existsSync(readyDir) || (await listDirs(readyDir)).length === 0, "Git Panel env should skip hook ready snapshots")
    assert(!existsSync(pendingDir) || (await listDirs(pendingDir)).length === 0, "Git Panel env should skip hook pending snapshots")
  })
}

async function testCoreHooksPathInWorkspaceIsNotModified(): Promise<void> {
  await withTempRepo("git-hook-husky-skip", async (repo) => {
    await git(repo, ["config", "core.hooksPath", ".husky"])
    const huskyDir = join(repo, ".husky")
    const preCommit = join(huskyDir, "pre-commit")
    const originalHook = `#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

npm test
`
    await mkdir(huskyDir, { recursive: true })
    await writeFile(preCommit, originalHook)

    const status = await installGitHooks(repo)
    assert(
      status.state === "external_hooks_path",
      `workspace core.hooksPath should be skipped, got ${status.state}`
    )
    assert(status.canInstall === false, "workspace core.hooksPath should not be installable")
    assert(
      (await readFile(preCommit, "utf-8")) === originalHook,
      ".husky/pre-commit must not be modified"
    )
    assert(
      !existsSync(`${preCommit}.cmbdevclaw-user`),
      "should not create a .cmbdevclaw-user backup in .husky"
    )
    assert(
      !existsSync(join(repo, ".git", "hooks", "pre-commit")),
      "should not install an inert .git/hooks hook"
    )
  })
}

async function testExternalCommitReconciledWithoutHook(): Promise<void> {
  await withIsolatedAdoptionStore(async () => {
    await initializeAdoptionTracker()
    await withTempRepo("git-hook-reconcile", async (repo) => {
      // Simulate IntelliJ IDEA 2026: the agent generated code, but the external
      // commit bypasses our pre-commit/post-commit hooks entirely — so NO hooks
      // are installed here. The hook-independent reconciler must still detect the
      // commit and measure adoption from the commit object itself.
      const filePath = join(repo, "reconciled.ts")
      const generatedContent = "export const reconciledValue = 42\n"
      recordGen({
        threadId: "reconcile-test-thread",
        workspacePath: repo,
        filePath,
        tool: "write_file",
        generatedContent
      })
      await sleep(250)
      assert(
        findPendingGensForFile(filePath, 0).length === 1,
        "expected exactly one pending gen before the commit"
      )

      // First sync establishes the reconciler baseline cursor at the current HEAD
      // (the repo's initial commit) WITHOUT backfilling history — it must not
      // consume the pending gen yet.
      await syncGitHookEvents(repo)
      assert(
        findPendingGensForFile(filePath, 0).length === 1,
        "baseline sync must not measure the pending gen"
      )

      // External commit with no hook firing.
      await writeFile(filePath, generatedContent)
      await git(repo, ["add", "reconciled.ts"])
      await git(repo, ["commit", "-q", "-m", "external IDE commit without hook"])
      const head = await git(repo, ["rev-parse", "HEAD"])

      // Second sync: the reconciler sees HEAD moved and measures adoption.
      await syncGitHookEvents(repo)
      await sleep(250)

      const processedRaw = await readFile(
        join(repoEventsDir(repo), "processed-commits.json"),
        "utf-8"
      ).catch(() => "[]")
      const processed = JSON.parse(processedRaw) as string[]
      assert(
        Array.isArray(processed) && processed.includes(head),
        `reconciler should record commit ${head} in processed-commits.json`
      )
      assert(
        findPendingGensForFile(filePath, 0).length === 0,
        "reconciler should have measured (consumed) the pending gen for the hookless commit"
      )

      // The reconciler path must not have created any hook ready/pending snapshots.
      const ready = await listDirs(join(repoEventsDir(repo), "ready"))
      const pending = await listDirs(join(repoEventsDir(repo), "pending"))
      assert(
        ready.length === 0 && pending.length === 0,
        "reconciler must not produce hook ready/pending snapshots"
      )
    })
  })
}

async function run(): Promise<void> {
  testDataRoot = await mkdtemp(join(tmpdir(), "git-hook-collection-data-"))
  process.env.CMB_COWORK_AGENT_HOME = testDataRoot
  try {
    const adoptionTracker = await import("../src/main/services/adoption-tracker.ts")
    const adoptionIndex = await import("../src/main/services/adoption-index.ts")
    const gitHookService = await import("../src/main/services/git-hook-service.ts")
    ;({
      captureStagedSnapshotsForCommit,
      initializeAdoptionTracker,
      recordGen,
      shutdownAdoptionTracker,
      waitForAdoptionRecordGenIdleForTest
    } = adoptionTracker)
    ;({ findPendingGensForFile } = adoptionIndex)
    ;({
      CMBDEVCLAW_INTERNAL_GIT_ENV,
      installGitHooks,
      syncGitHookEvents,
      uninstallGitHooks
    } = gitHookService)

    await testExternalCommandCommitWithoutCodeGenIsSkipped()
    console.log("PASS external command commit without code_gen is skipped")
    await testExternalCommandCommitWithCodeGenIsCollectedByHook()
    console.log("PASS external command commit with code_gen is collected through Git hook")
    await testGitPanelPathSkipsHookAndUsesDirectStagedCapture()
    console.log("PASS Git Panel collection path skips hook and uses direct staged capture")
    await testCoreHooksPathInWorkspaceIsNotModified()
    console.log("PASS workspace core.hooksPath is skipped without modifying .husky")
    await testExternalCommitReconciledWithoutHook()
    console.log("PASS external commit without hook is reconciled and measured")
  } finally {
    await waitForAdoptionRecordGenIdleForTest?.()
    shutdownAdoptionTracker?.()
    await rm(testDataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
