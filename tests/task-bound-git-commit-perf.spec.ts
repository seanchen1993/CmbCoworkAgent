/** Run independently with Node 22 and `npx tsx tests/task-bound-git-commit-perf.spec.ts`. */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"
import {
  captureEligibleTaskCommitPreview,
  executeTaskBoundGitCommit
} from "../src/main/services/task-bound-git-commit"
import { withoutGitRepositoryOverrides } from "../src/main/services/git-environment"

const fileCount = 1_024
const rounds = 3
const selectedCounts = [1, 32, 256]
const names = Array.from({ length: fileCount }, (_, index) => `file-${index}.txt`)

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["--literal-pathspecs", ...args], {
    cwd,
    env: withoutGitRepositoryOverrides(process.env, "workspace"),
    encoding: "utf8",
    windowsHide: true
  }).trimEnd()
}

function createRepository(cwd: string): void {
  mkdirSync(cwd)
  git(cwd, ["init", "-q", "-b", "main"])
  for (const [key, value] of Object.entries({
    "user.name": "Benchmark",
    "user.email": "benchmark@example.invalid",
    "commit.gpgsign": "false",
    "core.autocrlf": "false",
    "core.fsmonitor": "false",
    "core.hooksPath": ".git/empty-benchmark-hooks"
  })) {
    git(cwd, ["config", "--local", key, value])
  }
  for (const file of names) writeFileSync(path.join(cwd, file), "initial\n")
  git(cwd, ["add", "."])
  git(cwd, ["commit", "-qm", "initial"])
}

function assertCommit(cwd: string, parent: string, selected: string[]): void {
  assert.equal(git(cwd, ["rev-parse", "HEAD^"]), parent)
  const diff = git(cwd, [
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "--no-renames",
    "-z",
    "-r",
    "HEAD"
  ])
  assert.deepEqual(diff.split("\0").filter(Boolean).sort(), [...selected].sort())
  assert.equal(git(cwd, ["status", "--porcelain"]), "")
}

function nativeCommit(cwd: string, files: string[], message: string): number {
  const parent = git(cwd, ["rev-parse", "HEAD"])
  const start = performance.now()
  git(cwd, ["add", "--", ...files])
  git(cwd, ["commit", "--only", "-qm", message, "--", ...files])
  const elapsed = Math.round(performance.now() - start)
  assertCommit(cwd, parent, files)
  return elapsed
}

async function boundCommit(cwd: string, files: string[], message: string) {
  const parent = git(cwd, ["rev-parse", "HEAD"])
  const start = performance.now()
  const preview = await captureEligibleTaskCommitPreview(cwd, files, parent)
  const previewFinished = performance.now()
  const result = await executeTaskBoundGitCommit({
    worktreePath: cwd,
    filePaths: files,
    message,
    revalidate: async () => true,
    canPublish: () => true,
    onPrepared: async (candidate) => {
      assert.equal(candidate.parent, parent)
      assert.equal(candidate.tree, preview.tree)
      assert.ok(candidate.indexRecovery?.preparedDigest)
    }
  })
  const committed = performance.now()
  if (result.status !== "committed") throw new Error(result.reason)
  assert.deepEqual([...preview.files].sort(), [...files].sort())
  assert.equal(result.sha, git(cwd, ["rev-parse", "HEAD"]))
  assertCommit(cwd, parent, files)
  return {
    previewMs: Math.round(previewFinished - start),
    commitMs: Math.round(committed - previewFinished),
    previewAndCommitMs: Math.round(committed - start)
  }
}

function median(samples: number[]): number {
  return [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]
}

async function run(): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), "task-bound-git-perf-"))
  try {
    const bound = path.join(directory, "bound")
    const native = path.join(directory, "native")
    createRepository(bound)
    createRepository(native)
    console.log(
      JSON.stringify({
        node: process.version,
        git: git(bound, ["--version"]),
        platform: process.platform,
        arch: process.arch,
        trackedFiles: fileCount,
        rounds
      })
    )
    for (const count of selectedCounts) {
      const files = names.slice(0, count)
      const samples = []
      for (let round = 0; round < rounds; round++) {
        const content = `updated ${count} ${round}\n`
        const message = `CARD-1 #comment test:benchmark ${count}-${round} #CMBDevClaw`
        for (const file of files) {
          writeFileSync(path.join(bound, file), content)
          writeFileSync(path.join(native, file), content)
        }
        // Alternate order while keeping the two measurements strictly sequential.
        let nativeMs = round % 2 === 0 ? nativeCommit(native, files, message) : 0
        const boundTimes = await boundCommit(bound, files, message)
        if (round % 2 === 1) nativeMs = nativeCommit(native, files, message)
        samples.push({ nativeMs, ...boundTimes })
      }
      console.log(
        JSON.stringify({
          selectedFiles: count,
          samples,
          medianMs: {
            native: median(samples.map((s) => s.nativeMs)),
            preview: median(samples.map((s) => s.previewMs)),
            commit: median(samples.map((s) => s.commitMs)),
            previewAndCommit: median(samples.map((s) => s.previewAndCommitMs))
          }
        })
      )
    }
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
  }
}

void run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
