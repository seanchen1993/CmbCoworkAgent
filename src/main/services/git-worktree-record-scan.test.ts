import { createHash } from "crypto"
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { describe, expect, test } from "vitest"
import {
  getWorkflowWorktreeRecordScanLimitsForTest,
  listWorkflowWorktreeRecords,
  listWorkflowWorktreeRecordsForPrune
} from "./git-worktree"

function canonicalKey(value: string): string {
  const normalized = resolve(value).replace(/\\/g, "/").replace(/\/+$/, "")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function recordsRoot(appDataRoot: string, commonDir: string): string {
  const repoKey = createHash("sha256").update(canonicalKey(commonDir)).digest("hex").slice(0, 12)
  return join(appDataRoot, "worktrees", repoKey, ".records")
}

async function writeFilesBounded(
  directory: string,
  count: number,
  content: string
): Promise<void> {
  for (let start = 0; start < count; start += 64) {
    await Promise.all(
      Array.from({ length: Math.min(64, count - start) }, (_, offset) =>
        writeFile(join(directory, `pressure-${start + offset}.json`), content)
      )
    )
  }
}

describe("workflow worktree record scan bounds", () => {
  test("fails closed before an unbounded manifest directory can be materialized", async () => {
    const appDataRoot = await mkdtemp(join(tmpdir(), "cmb-wt-record-count-"))
    const commonDir = join(appDataRoot, "repo", ".git")
    const root = recordsRoot(appDataRoot, commonDir)
    const { maxFiles } = getWorkflowWorktreeRecordScanLimitsForTest()
    await mkdir(root, { recursive: true })
    await writeFilesBounded(root, maxFiles + 1, "")
    let turns = 0
    const timer = setInterval(() => {
      turns += 1
    }, 0)

    try {
      await expect(listWorkflowWorktreeRecords(commonDir, appDataRoot)).rejects.toThrow(
        /safe limit/i
      )
      await expect(
        listWorkflowWorktreeRecordsForPrune(commonDir, appDataRoot)
      ).resolves.toMatchObject({ reliable: false })
      expect(turns).toBeGreaterThan(0)
    } finally {
      clearInterval(timer)
      await rm(appDataRoot, { recursive: true, force: true })
    }
  }, 30_000)

  test("caps aggregate manifest bytes and yields while reading pressure data", async () => {
    const appDataRoot = await mkdtemp(join(tmpdir(), "cmb-wt-record-bytes-"))
    const commonDir = join(appDataRoot, "repo", ".git")
    const root = recordsRoot(appDataRoot, commonDir)
    const { maxRecordBytes, maxTotalBytes } = getWorkflowWorktreeRecordScanLimitsForTest()
    const content = JSON.stringify("x".repeat(maxRecordBytes - 4))
    const count = Math.floor(maxTotalBytes / Buffer.byteLength(content)) + 1
    await mkdir(root, { recursive: true })
    await writeFilesBounded(root, count, content)
    let turns = 0
    const timer = setInterval(() => {
      turns += 1
    }, 0)

    try {
      await expect(listWorkflowWorktreeRecords(commonDir, appDataRoot)).rejects.toThrow(
        /total-byte limit/i
      )
      await expect(
        listWorkflowWorktreeRecordsForPrune(commonDir, appDataRoot)
      ).resolves.toMatchObject({ reliable: false })
      expect(turns).toBeGreaterThan(0)
    } finally {
      clearInterval(timer)
      await rm(appDataRoot, { recursive: true, force: true })
    }
  }, 30_000)
})
