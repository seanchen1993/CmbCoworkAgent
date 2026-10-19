import { pbkdf2 } from "node:crypto"
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { closeWorkspaceProbeWorker, WorkspaceProbeClient } from "./workspace-probe-client"
import { validateWorkspaceDirectory } from "./workspace-validation"
import {
  createWorkspaceProbeTestWorker,
  removeWorkspaceProbeTestWorker
} from "./workspace-probe.test-helper"

vi.mock("./workspace-probe-worker?nodeWorker", async () => ({
  default: (await import("./workspace-probe.test-helper")).createWorkspaceProbeTestWorker
}))
const root = mkdtempSync(join(tmpdir(), "cmb-workspace-real-probe-"))
afterAll(async () => {
  await closeWorkspaceProbeWorker()
  removeWorkspaceProbeTestWorker()
  if (
    dirname(root) !== resolve(tmpdir()) ||
    !basename(root).startsWith("cmb-workspace-real-probe-")
  )
    throw Error("Unexpected workspace probe fixture directory")
  rmSync(root, { recursive: true, force: true })
})

describe("real workspace worker checks", () => {
  it("returns a fresh physical directory, rejects files/missing paths, and sees deletion", async () => {
    const directory = join(root, "real directory")
    mkdirSync(directory)
    await expect(validateWorkspaceDirectory(directory)).resolves.toBe(realpathSync(directory))
    const file = join(root, "file")
    writeFileSync(file, "not a directory")
    await expect(validateWorkspaceDirectory(file)).rejects.toThrow("不是目录")
    await expect(validateWorkspaceDirectory(join(root, "missing"))).rejects.toThrow(
      "不存在或不可访问"
    )
    rmdirSync(directory)
    await expect(validateWorkspaceDirectory(directory)).rejects.toThrow("不存在或不可访问")
  })

  it("does not reuse a prior successful symlink target", async () => {
    const first = join(root, "first"),
      second = join(root, "second"),
      alias = join(root, "alias")
    mkdirSync(first)
    mkdirSync(second)
    symlinkSync(first, alias, process.platform === "win32" ? "junction" : "dir")
    await expect(validateWorkspaceDirectory(alias)).resolves.toBe(realpathSync(first))
    unlinkSync(alias)
    symlinkSync(second, alias, process.platform === "win32" ? "junction" : "dir")
    await expect(validateWorkspaceDirectory(alias)).resolves.toBe(realpathSync(second))
  })

  it("uses an on-time real probe result after a 3200ms blocked main loop, with the original 3000ms budget", async () => {
    // Warm only Vite's factory module. The measured call still creates a new thread and reads FS.
    await validateWorkspaceDirectory(root)
    const start = performance.now()
    const pending = validateWorkspaceDirectory(root)
    const until = performance.now() + 3_200
    while (performance.now() < until) {
      /* Actual synchronous host-loop contention. */
    }
    await expect(pending).resolves.toBe(realpathSync(root))
    console.log(
      JSON.stringify({
        control: "worker-real-FS-main-block",
        blockedMs: 3_200,
        originalBudgetMs: 3_000,
        callerElapsedMs: performance.now() - start
      })
    )
  })

  it("probes a real directory while the original libuv pool still owns concurrent crypto work", async () => {
    let completed = 0
    const jobs = Array.from(
      { length: 4 },
      () =>
        new Promise<void>((resolve, reject) => {
          pbkdf2("private test", "test salt", 600_000, 32, "sha256", (error) => {
            completed++
            if (error) reject(error)
            else resolve()
          })
        })
    )
    try {
      await expect(validateWorkspaceDirectory(root)).resolves.toBe(realpathSync(root))
      expect(completed).toBeLessThan(4)
    } finally {
      await Promise.all(jobs)
    }
  })

  it("times out real stalled worker startup at the original deadline and observes physical exit", async () => {
    const client = new WorkspaceProbeClient((options) =>
      createWorkspaceProbeTestWorker(options, 4_500)
    )
    const started = performance.now()
    try {
      await expect(client.probe(root)).rejects.toMatchObject({ reason: "timeout" })
      expect(performance.now() - started).toBeLessThan(4_000)
      await vi.waitFor(() => expect(client.status().active).toBe(0), { timeout: 1_000 })
    } finally {
      await client.close()
    }
  })

  it("aborts a real starting thread and waits for exact exit without starting filesystem work", async () => {
    const client = new WorkspaceProbeClient((options) =>
      createWorkspaceProbeTestWorker(options, 4_500)
    )
    const controller = new AbortController()
    const pending = client.probe(root, controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
    controller.abort()
    try {
      await rejected
      await vi.waitFor(() => expect(client.status().active).toBe(0), { timeout: 1_000 })
    } finally {
      await client.close()
    }
  })
})
