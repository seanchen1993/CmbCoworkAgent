/**
 * Integration tests for Git hook based code collection paths.
 *
 * Run:
 *   npx tsx tests/git-hook-collection-path.spec.ts
 */

import { execFile } from "child_process"
import { createHash } from "crypto"
import { existsSync } from "fs"
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "fs/promises"
import { homedir, tmpdir } from "os"
import { join } from "path"
import { promisify } from "util"
import { captureStagedSnapshotsForCommit } from "../src/main/services/adoption-tracker.ts"
import {
  CMBDEVCLAW_INTERNAL_GIT_ENV,
  installGitHooks,
  syncGitHookEvents,
  uninstallGitHooks
} from "../src/main/services/git-hook-service.ts"

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

function repoEventsDir(repo: string): string {
  return join(homedir(), ".cmbcoworkagent", "git-hooks", "events", repoKey(repo))
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

async function testExternalCommandCommitIsCollectedByHook(): Promise<void> {
  await withTempRepo("git-hook-external", async (repo) => {
    const status = await installGitHooks(repo)
    assert(status.state === "installed", `expected installed hook, got ${status.state}`)

    await writeFile(join(repo, "external.ts"), "export const externalValue = 1\n")
    await git(repo, ["add", "external.ts"])
    await git(repo, ["commit", "-q", "-m", "external command commit"])

    const head = await git(repo, ["rev-parse", "HEAD"])
    const snapshot = await readReadySnapshot(repo)
    assert(snapshot.meta.gitRoot === repo, `snapshot gitRoot should be repo, got ${snapshot.meta.gitRoot}`)
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
    assert(remainingReady.length === 0, "sync should consume ready external command snapshots")
    assert(processed.length === 1, "sync should move external command snapshot to processed")
  })
}

async function testGitPanelPathSkipsHookAndUsesDirectStagedCapture(): Promise<void> {
  await withTempRepo("git-hook-panel", async (repo) => {
    const status = await installGitHooks(repo)
    assert(status.state === "installed", `expected installed hook, got ${status.state}`)

    await writeFile(join(repo, "panel.ts"), "export const panelValue = 1\n")
    await git(repo, ["add", "panel.ts"])

    const snapshots = captureStagedSnapshotsForCommit(repo)
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

async function run(): Promise<void> {
  await testExternalCommandCommitIsCollectedByHook()
  console.log("PASS external command commit collection through Git hook")
  await testGitPanelPathSkipsHookAndUsesDirectStagedCapture()
  console.log("PASS Git Panel collection path skips hook and uses direct staged capture")
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
