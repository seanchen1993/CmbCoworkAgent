import { afterEach, expect, it, vi } from "vitest"
import { getEventListeners } from "node:events"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotOwnedShellProcess } from "./owned-shell-process"
import { inspectOwnedShellReceipts } from "./owned-shell-receipts"

const { launchPort } = vi.hoisted(() => ({ launchPort: vi.fn() }))
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process")
  return { ...actual, spawn: launchPort }
})

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  launchPort.mockReset()
  for (const close of cleanup.splice(0).reverse()) await close()
})

it.skipIf(process.platform === "win32")(
  "detaches startup timers and cancellation observers when the launch port throws before spawning; no platform-kernel claim",
  async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "cmb-owned-pre-spawn-")))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const controlRoot = join(directory, "shell-resources")
    await mkdir(controlRoot, { mode: 0o700 })
    const helperEntry = join(directory, "helper.cjs")
    const workerEntry = join(directory, "worker.cjs")
    const helperSource = "module.exports = {}\n"
    const workerSource = "module.exports = {}\n"
    await writeFile(helperEntry, helperSource)
    await writeFile(workerEntry, workerSource)
    const helperSha256 = createHash("sha256").update(helperSource).digest("hex")
    const workerSha256 = createHash("sha256").update(workerSource).digest("hex")
    const releasePrepared = vi.fn(async () => {})
    const controller = new AbortController()
    const failure = new Error("synchronous launch-port failure before child creation")
    // Only the synchronous Node launch port fails. Actual validation, private
    // receipt, endpoint/listen and finally cleanup use the production source.
    // No process launches and no test output claims Linux/Windows containment.
    const spawn = launchPort.mockImplementation(() => {
      throw failure
    })
    vi.useFakeTimers()
    const runner = new BotOwnedShellProcess({
      helper: { entry: helperEntry, sha256: helperSha256 },
      launch: {
        entry: workerEntry,
        entrySha256: workerSha256,
        cwd: directory,
        executable: process.execPath,
        execArgv: [],
        environment: {}
      },
      controlRoot,
      origin: {
        hostId: "startup-disposal-test",
        dataEpoch: "epoch",
        policySha256: "a".repeat(64)
      },
      assertCurrent: async (signal) => signal.throwIfAborted(),
      releasePrepared
    })
    const operation = runner.start(
      {
        command: "never-run",
        cwd: directory,
        runId: "startup-disposal-test",
        timeoutMs: 7_200_000,
        background: true,
        execution: { windowsSandbox: "none", resourceDirectory: directory }
      },
      controller.signal
    )
    const dispositions = await Promise.allSettled([operation.admitted, operation.completion])
    expect(dispositions).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure }
    ])
    expect(spawn).toHaveBeenCalledOnce()
    expect(releasePrepared).toHaveBeenCalledExactlyOnceWith(true)
    expect(await inspectOwnedShellReceipts(controlRoot)).toEqual([])
    expect.soft(vi.getTimerCount()).toBe(0)
    expect.soft(getEventListeners(controller.signal, "abort")).toHaveLength(0)
  }
)
