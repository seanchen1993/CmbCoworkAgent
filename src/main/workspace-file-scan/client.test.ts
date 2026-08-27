import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Worker, type Worker as WorkerType } from "node:worker_threads"
import { build } from "esbuild"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  WORKSPACE_FILE_SCAN_PAGE_MAX_BYTES,
  WORKSPACE_FILE_SCAN_PAGE_MAX_ENTRIES,
  WORKSPACE_FILE_SCAN_SEGMENT_MAX_ENTRIES,
  WORKSPACE_GITIGNORE_MAX_BYTES,
  type WorkspaceFileScanEntry
} from "../../shared/workspace-file-scan"
import {
  WORKSPACE_FILE_SCAN_MAX_CONTINUATION_LENGTH,
  WORKSPACE_FILE_SCAN_MAX_PATH_LENGTH,
  WORKSPACE_FILE_SCAN_WORKER_RESOURCE_LIMITS,
  WorkspaceFileScanSession
} from "./client"

let buildDirectory = ""
let workerPath = ""
const temporaryDirectories: string[] = []

beforeAll(async () => {
  buildDirectory = mkdtempSync(join(tmpdir(), "cmb-workspace-scan-build-"))
  workerPath = join(buildDirectory, "workspace-file-scan-worker.cjs")
  await build({
    entryPoints: [fileURLToPath(new URL("./workspace-file-scan-worker.ts", import.meta.url))],
    outfile: workerPath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22"
  })
})

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true })
  rmSync(buildDirectory, { recursive: true, force: true })
})

describe("WorkspaceFileScanSession", () => {
  it("bounds its heap, rejects clean early exit, and permits only one request per session", async () => {
    expect(WORKSPACE_FILE_SCAN_WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb).toBe(128)
    const worker = new FakeScanWorker()
    const session = new WorkspaceFileScanSession(
      "lifecycle",
      "C:\\workspace",
      async () => worker as unknown as WorkerType
    )
    const open = session.open()
    await Promise.resolve()
    await expect(session.next(1, 1024)).rejects.toThrow("already in progress")
    worker.emit("exit", 0)
    await expect(open).rejects.toThrow("exited with code 0")
    await session.close()
  })

  it("rejects oversized paths and page requests before dispatch", async () => {
    const worker = new FakeScanWorker()
    const oversizedPath = new WorkspaceFileScanSession(
      "oversized-path",
      "x".repeat(WORKSPACE_FILE_SCAN_MAX_PATH_LENGTH + 1),
      async () => worker as unknown as WorkerType
    )
    await expect(oversizedPath.open()).rejects.toThrow(/string limit/)
    expect(worker.postCount).toBe(0)

    const oversizedPage = new WorkspaceFileScanSession(
      "oversized-page",
      "C:\\workspace",
      async () => worker as unknown as WorkerType
    )
    await expect(
      oversizedPage.next(
        WORKSPACE_FILE_SCAN_PAGE_MAX_ENTRIES,
        WORKSPACE_FILE_SCAN_PAGE_MAX_BYTES,
        "x".repeat(WORKSPACE_FILE_SCAN_MAX_CONTINUATION_LENGTH + 1)
      )
    ).rejects.toThrow(/hard request budget/)
    expect(worker.postCount).toBe(0)
  })

  it("returns a complete tree through hard-bounded pages", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "cmb-workspace-scan-"))
    temporaryDirectories.push(workspacePath)
    mkdirSync(join(workspacePath, "src"))
    mkdirSync(join(workspacePath, "ignored"))
    mkdirSync(join(workspacePath, "after-byte-cap"))
    writeFileSync(
      join(workspacePath, ".gitignore"),
      `ignored/\n${"#".repeat(WORKSPACE_GITIGNORE_MAX_BYTES + 64)}` +
        "\nafter-byte-cap/\n"
    )
    for (let index = 0; index < 350; index += 1) {
      writeFileSync(join(workspacePath, `file-${String(index).padStart(3, "0")}.txt`), "x")
    }
    writeFileSync(join(workspacePath, "src", "inside.ts"), "source")
    writeFileSync(join(workspacePath, "ignored", "hidden.txt"), "hidden")
    writeFileSync(join(workspacePath, "after-byte-cap", "visible.txt"), "visible")

    const session = new WorkspaceFileScanSession(
      "scan-test",
      workspacePath,
      async () => new Worker(workerPath, { name: "workspace-file-scan-test" })
    )
    await session.open()
    const files: WorkspaceFileScanEntry[] = []
    let pageCount = 0
    try {
      while (true) {
        const page = await session.next(
          WORKSPACE_FILE_SCAN_PAGE_MAX_ENTRIES,
          WORKSPACE_FILE_SCAN_PAGE_MAX_BYTES
        )
        pageCount += 1
        expect(page.files.length).toBeLessThanOrEqual(WORKSPACE_FILE_SCAN_PAGE_MAX_ENTRIES)
        expect(Buffer.byteLength(JSON.stringify(page.files))).toBeLessThanOrEqual(
          WORKSPACE_FILE_SCAN_PAGE_MAX_BYTES
        )
        files.push(...page.files)
        if (page.done) break
      }
    } finally {
      await session.close()
    }

    expect(pageCount).toBeGreaterThan(2)
    expect(files).toHaveLength(354)
    expect(files).toContainEqual({ path: "/src", is_dir: true })
    expect(files.map((file) => file.path)).toContain("/src/inside.ts")
    expect(files.some((file) => file.path.startsWith("/ignored"))).toBe(false)
    expect(files.map((file) => file.path)).toContain("/after-byte-cap/visible.txt")
  }, 30_000)

  it("can cancel a worker and start a fresh scan without retaining old traversal state", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "cmb-workspace-scan-restart-"))
    temporaryDirectories.push(workspacePath)
    writeFileSync(join(workspacePath, "one.txt"), "1")
    writeFileSync(join(workspacePath, "two.txt"), "2")

    const cancelled = new WorkspaceFileScanSession(
      "scan-cancelled",
      workspacePath,
      async () => new Worker(workerPath, { name: "workspace-file-scan-cancelled-test" })
    )
    await cancelled.open()
    await cancelled.close()

    const restarted = new WorkspaceFileScanSession(
      "scan-restarted",
      workspacePath,
      async () => new Worker(workerPath, { name: "workspace-file-scan-restarted-test" })
    )
    await restarted.open()
    const files: WorkspaceFileScanEntry[] = []
    try {
      let continuation: string | undefined
      while (true) {
        const page = await restarted.next(
          WORKSPACE_FILE_SCAN_PAGE_MAX_ENTRIES,
          WORKSPACE_FILE_SCAN_PAGE_MAX_BYTES,
          continuation
        )
        files.push(...page.files)
        continuation = page.truncated ? page.continuation : undefined
        if (page.done) break
      }
    } finally {
      await restarted.close()
    }

    expect(files.map((file) => file.path).sort()).toEqual(["/one.txt", "/two.txt"])
  }, 30_000)

  it("continues past the whole-segment entry limit without silently losing files", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "cmb-workspace-scan-limit-"))
    temporaryDirectories.push(workspacePath)
    const total = WORKSPACE_FILE_SCAN_SEGMENT_MAX_ENTRIES + 50
    for (let index = 0; index < total; index += 1) {
      writeFileSync(join(workspacePath, `entry-${String(index).padStart(5, "0")}.txt`), "")
    }
    const session = new WorkspaceFileScanSession(
      "scan-continuation",
      workspacePath,
      async () => new Worker(workerPath, { name: "workspace-file-scan-continuation-test" })
    )
    await session.open()
    let continuation: string | undefined
    let truncatedPages = 0
    let loaded = 0
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    try {
      while (true) {
        const page = await session.next(
          WORKSPACE_FILE_SCAN_PAGE_MAX_ENTRIES,
          WORKSPACE_FILE_SCAN_PAGE_MAX_BYTES,
          continuation
        )
        loaded += page.files.length
        if (page.truncated) {
          truncatedPages += 1
          expect(page.continuation).toBeTruthy()
          continuation = page.continuation
        } else {
          continuation = undefined
        }
        if (page.done) break
      }
    } finally {
      clearInterval(ticker)
      await session.close()
    }

    expect(loaded).toBe(total)
    expect(truncatedPages).toBeGreaterThan(0)
    expect(ticks).toBeGreaterThan(10)
  }, 60_000)
})

class FakeScanWorker extends EventEmitter {
  postCount = 0

  postMessage(): void {
    this.postCount += 1
    return undefined
  }

  unref(): this {
    return this
  }

  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
}
import { EventEmitter } from "node:events"
