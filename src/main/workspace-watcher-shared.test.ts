import * as path from "path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  WORKSPACE_GITIGNORE_MAX_BYTES,
  WORKSPACE_GITIGNORE_MAX_RULES
} from "../shared/workspace-file-scan"
import { normalizeWorkspacePathKey } from "../shared/workspace-path"

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const watcherMocks = vi.hoisted(() => {
  type WatchCallback = (eventType: string, filename: string | Buffer | null) => void
  type ErrorCallback = (error: Error) => void

  const watchers: Array<{
    workspacePath: string
    callback: WatchCallback
    errorCallback?: ErrorCallback
    close: ReturnType<typeof vi.fn>
  }> = []
  const workerClients: Array<{
    workspacePath: string
    close: ReturnType<typeof vi.fn>
  }> = []
  const watchInstallGates = new Map<string, Promise<void>>()
  const send = vi.fn()
  const windowSends = [send]
  const statSync = vi.fn(() => ({ isDirectory: () => true }))
  const lstat = vi.fn(async (): Promise<{ isDirectory: () => boolean }> => ({
    isDirectory: () => true
  }))
  const stat = vi.fn(async (): Promise<{
    isDirectory: () => boolean
    size: number
    mtime: Date
  }> => ({
    isDirectory: () => false,
    size: 42,
    mtime: new Date("2026-08-21T00:00:00.000Z")
  }))
  const gitignore = { content: "" }
  const gitignoreReadLengths: number[] = []
  const open = vi.fn(async () => ({
    read: vi.fn(async (buffer: Buffer, offset: number, length: number) => {
      gitignoreReadLengths.push(length)
      const source = Buffer.from(gitignore.content, "utf8")
      const bytesRead = Math.min(length, source.byteLength)
      source.copy(buffer, offset, 0, bytesRead)
      return { bytesRead, buffer }
    }),
    close: vi.fn(async () => undefined)
  }))
  const readFileSync = vi.fn(() => "")
  const watch = vi.fn((workspacePath: string, _options: unknown, callback: WatchCallback) => {
    const record = {
      workspacePath,
      callback,
      errorCallback: undefined as ErrorCallback | undefined,
      close: vi.fn()
    }
    watchers.push(record)
    return {
      close: record.close,
      on: vi.fn((event: string, handler: ErrorCallback) => {
        if (event === "error") record.errorCallback = handler
      })
    }
  })

  return {
    watchers,
    workerClients,
    watchInstallGates,
    send,
    windowSends,
    statSync,
    lstat,
    stat,
    gitignore,
    gitignoreReadLengths,
    open,
    readFileSync,
    watch
  }
})

vi.mock("./workspace-watcher-worker/client", () => ({
  isWorkspaceWatcherCancelled: (error: unknown) =>
    error instanceof Error && error.name === "WORKSPACE_WATCHER_CANCELLED",
  WorkspaceWatcherWorkerClient: class {
    private nativeWatcher: { close: () => void; on: (event: string, handler: (error: Error) => void) => void } | null = null
    private closed = false
    readonly close = vi.fn(() => {
      this.closed = true
      this.nativeWatcher?.close()
      this.nativeWatcher = null
    })

    constructor(
      readonly workspacePath: string,
      private readonly onEvent: (event: {
        eventType: "change" | "rename"
        filename: string | null
      }) => void,
      private readonly onError: (error: Error) => void
    ) {
      watcherMocks.workerClients.push({ workspacePath, close: this.close })
    }

    async start(): Promise<void> {
      const gate = watcherMocks.watchInstallGates.get(this.workspacePath)
      if (gate) await gate
      if (this.closed) {
        const error = new Error("cancelled")
        error.name = "WORKSPACE_WATCHER_CANCELLED"
        throw error
      }
      this.nativeWatcher = watcherMocks.watch(
        this.workspacePath,
        { recursive: true },
        (eventType: string, filename: string | Buffer | null) => {
          this.onEvent({
            eventType: eventType === "rename" ? "rename" : "change",
            filename: filename === null ? null : String(filename)
          })
        }
      )
      this.nativeWatcher.on("error", this.onError)
    }
  }
}))

vi.mock("fs", () => ({
  statSync: watcherMocks.statSync,
  promises: { stat: watcherMocks.stat, lstat: watcherMocks.lstat, open: watcherMocks.open },
  readFileSync: watcherMocks.readFileSync,
  watch: watcherMocks.watch
}))

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () =>
      watcherMocks.windowSends.map((send) => ({ webContents: { send } }))
  }
}))

vi.mock("./services/git-hook-service", () => ({
  scheduleGitHookEventSync: vi.fn()
}))

describe("shared workspace watcher", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    watcherMocks.watchers.length = 0
    watcherMocks.workerClients.length = 0
    watcherMocks.watchInstallGates.clear()
    watcherMocks.send.mockClear()
    watcherMocks.windowSends.splice(0, watcherMocks.windowSends.length, watcherMocks.send)
    watcherMocks.statSync.mockClear()
    watcherMocks.lstat.mockClear()
    watcherMocks.stat.mockClear()
    watcherMocks.stat.mockResolvedValue({
      isDirectory: () => false,
      size: 42,
      mtime: new Date("2026-08-21T00:00:00.000Z")
    })
    watcherMocks.gitignore.content = ""
    watcherMocks.gitignoreReadLengths.length = 0
    watcherMocks.open.mockClear()
    watcherMocks.readFileSync.mockClear()
    watcherMocks.watch.mockClear()
  })

  it("uses one physical watcher and sends one batched change per window", async () => {
    const watcher = await import("./services/workspace-watcher")
    const workspacePath = path.resolve("shared-workspace")
    const alternateSpelling = `${workspacePath}${path.sep}`

    await expect(watcher.startWatching("thread-1", workspacePath)).resolves.toBe("started")
    await expect(watcher.startWatching("thread-2", alternateSpelling)).resolves.toBe("existing")
    expect(watcherMocks.watch).toHaveBeenCalledTimes(1)
    expect(watcher.isWatching("thread-1")).toBe(true)
    expect(watcher.isWatching("thread-2")).toBe(true)

    const secondWindowSend = vi.fn()
    watcherMocks.windowSends.push(secondWindowSend)
    watcherMocks.watchers[0].callback("change", "src/file.ts")
    watcherMocks.watchers[0].callback("change", "src/file.ts")
    await vi.advanceTimersByTimeAsync(500)

    expect(watcherMocks.stat).toHaveBeenCalledTimes(1)
    expect(watcherMocks.send).toHaveBeenCalledTimes(1)
    expect(watcherMocks.send).toHaveBeenCalledWith("workspace:files-changed", {
      threadIds: ["thread-1", "thread-2"],
      workspacePath: normalizeWorkspacePathKey(workspacePath),
      changeType: "file",
      update: {
        kind: "patch",
        upserts: [
          {
            path: "/src/file.ts",
            is_dir: false,
            size: 42,
            modified_at: "2026-08-21T00:00:00.000Z"
          }
        ],
        deletes: []
      }
    })
    expect(secondWindowSend).toHaveBeenCalledTimes(1)
    expect(secondWindowSend).toHaveBeenCalledWith("workspace:files-changed", {
      threadIds: ["thread-1", "thread-2"],
      workspacePath: normalizeWorkspacePathKey(workspacePath),
      changeType: "file",
      update: {
        kind: "patch",
        upserts: [
          {
            path: "/src/file.ts",
            is_dir: false,
            size: 42,
            modified_at: "2026-08-21T00:00:00.000Z"
          }
        ],
        deletes: []
      }
    })

    watcher.stopWatching("thread-1")
    expect(watcherMocks.watchers[0].close).not.toHaveBeenCalled()
    expect(watcher.isWatching("thread-2")).toBe(true)

    watcher.stopWatching("thread-2")
    expect(watcherMocks.watchers[0].close).toHaveBeenCalledTimes(1)
    expect(watcher.isWatching("thread-2")).toBe(false)
  })

  it("bounds historical task subscribers while preserving the foreground task", async () => {
    const watcher = await import("./services/workspace-watcher")
    const workspacePath = path.resolve("many-thread-workspace")

    await watcher.startWatching("thread-1", workspacePath)
    watcher.setActiveWatchedThread("thread-1")
    for (let index = 2; index <= 40; index += 1) {
      await watcher.startWatching(`thread-${index}`, workspacePath)
    }

    expect(watcherMocks.watch).toHaveBeenCalledTimes(1)
    expect(watcher.isWatching("thread-1")).toBe(true)
    expect(watcher.isWatching("thread-2")).toBe(false)
    expect(watcher.isWatching("thread-40")).toBe(true)

    watcherMocks.watchers[0].callback("change", "bounded.txt")
    await vi.advanceTimersByTimeAsync(500)

    const payload = watcherMocks.send.mock.calls.at(-1)?.[1] as
      | { threadIds?: string[] }
      | undefined
    expect(payload?.threadIds).toHaveLength(16)
    expect(payload?.threadIds).toContain("thread-1")
    expect(payload?.threadIds).toContain("thread-40")
    expect(payload?.threadIds).not.toContain("thread-2")

    watcher.stopAllWatching()
  })

  it("uses a bounded delete patch and rescans unknown or directory events", async () => {
    const watcher = await import("./services/workspace-watcher")
    const workspacePath = path.resolve("patch-workspace")
    await watcher.startWatching("thread-1", workspacePath)

    const missing = Object.assign(new Error("missing"), { code: "ENOENT" })
    watcherMocks.stat.mockRejectedValueOnce(missing)
    watcherMocks.watchers[0].callback("rename", "removed.txt")
    await vi.advanceTimersByTimeAsync(500)
    expect(watcherMocks.send).toHaveBeenLastCalledWith("workspace:files-changed", {
      threadIds: ["thread-1"],
      workspacePath: normalizeWorkspacePathKey(workspacePath),
      changeType: "file",
      update: { kind: "patch", upserts: [], deletes: ["/removed.txt"] }
    })

    watcherMocks.send.mockClear()
    watcherMocks.stat.mockResolvedValueOnce({
      isDirectory: () => true,
      size: 0,
      mtime: new Date("2026-08-21T00:00:00.000Z")
    })
    watcherMocks.watchers[0].callback("rename", "created-dir")
    await vi.advanceTimersByTimeAsync(500)
    expect(watcherMocks.send).toHaveBeenLastCalledWith("workspace:files-changed", {
      threadIds: ["thread-1"],
      workspacePath: normalizeWorkspacePathKey(workspacePath),
      changeType: "file",
      update: { kind: "rescan" }
    })

    watcherMocks.send.mockClear()
    const statCallsBeforeUnknown = watcherMocks.stat.mock.calls.length
    watcherMocks.watchers[0].callback("rename", null)
    await vi.advanceTimersByTimeAsync(500)
    expect(watcherMocks.stat).toHaveBeenCalledTimes(statCallsBeforeUnknown)
    expect(watcherMocks.send).toHaveBeenLastCalledWith("workspace:files-changed", {
      threadIds: ["thread-1"],
      workspacePath: normalizeWorkspacePathKey(workspacePath),
      changeType: "file",
      update: { kind: "rescan" }
    })

    watcher.stopAllWatching()
  })

  it("moves only the switching thread to a new physical workspace", async () => {
    const watcher = await import("./services/workspace-watcher")
    const firstPath = path.resolve("first-workspace")
    const secondPath = path.resolve("second-workspace")

    await watcher.startWatching("thread-1", firstPath)
    await watcher.startWatching("thread-2", firstPath)
    await watcher.startWatching("thread-1", secondPath)

    expect(watcherMocks.watch).toHaveBeenCalledTimes(2)
    expect(watcherMocks.watchers[0].close).not.toHaveBeenCalled()
    expect(watcher.isWatching("thread-1")).toBe(true)
    expect(watcher.isWatching("thread-2")).toBe(true)

    watcherMocks.watchers[0].callback("change", "old.txt")
    await vi.advanceTimersByTimeAsync(500)
    expect(watcherMocks.send).toHaveBeenCalledTimes(1)
    expect(watcherMocks.send).toHaveBeenLastCalledWith("workspace:files-changed", {
      threadIds: ["thread-2"],
      workspacePath: normalizeWorkspacePathKey(firstPath),
      changeType: "file",
      update: {
        kind: "patch",
        upserts: [
          {
            path: "/old.txt",
            is_dir: false,
            size: 42,
            modified_at: "2026-08-21T00:00:00.000Z"
          }
        ],
        deletes: []
      }
    })

    watcherMocks.send.mockClear()
    watcherMocks.watchers[1].callback("change", "new.txt")
    await vi.advanceTimersByTimeAsync(500)
    expect(watcherMocks.send).toHaveBeenCalledTimes(1)
    expect(watcherMocks.send).toHaveBeenLastCalledWith("workspace:files-changed", {
      threadIds: ["thread-1"],
      workspacePath: normalizeWorkspacePathKey(secondPath),
      changeType: "file",
      update: {
        kind: "patch",
        upserts: [
          {
            path: "/new.txt",
            is_dir: false,
            size: 42,
            modified_at: "2026-08-21T00:00:00.000Z"
          }
        ],
        deletes: []
      }
    })

    watcher.stopAllWatching()
  })

  it("coalesces Git metadata bursts for all threads sharing the workspace", async () => {
    const watcher = await import("./services/workspace-watcher")
    const workspacePath = path.resolve("git-workspace")

    await watcher.startWatching("thread-1", workspacePath)
    await watcher.startWatching("thread-2", workspacePath)
    watcherMocks.watchers[0].callback("change", ".git/index")
    watcherMocks.watchers[0].callback("change", ".git/index")
    watcherMocks.watchers[0].callback("rename", ".git/HEAD")

    expect(watcherMocks.send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(watcherMocks.send).toHaveBeenCalledTimes(1)
    expect(watcherMocks.send).toHaveBeenCalledWith("workspace:files-changed", {
      threadIds: ["thread-1", "thread-2"],
      workspacePath: normalizeWorkspacePathKey(workspacePath),
      changeType: "meta",
      update: { kind: "rescan" }
    })

    watcher.stopAllWatching()
  })

  it("counts physical workspaces for LRU eviction and protects the foreground workspace", async () => {
    const watcher = await import("./services/workspace-watcher")
    const workspacePaths = Array.from({ length: 7 }, (_, index) =>
      path.resolve(`workspace-${index + 1}`)
    )

    await watcher.startWatching("thread-1", workspacePaths[0])
    watcher.setActiveWatchedThread("thread-1")
    for (let index = 1; index < workspacePaths.length; index += 1) {
      await watcher.startWatching(`thread-${index + 1}`, workspacePaths[index])
    }

    expect(watcherMocks.watch).toHaveBeenCalledTimes(7)
    expect(watcher.isWatching("thread-1")).toBe(true)
    expect(watcher.isWatching("thread-2")).toBe(false)
    expect(watcher.isWatching("thread-7")).toBe(true)
    expect(watcherMocks.watchers[0].close).not.toHaveBeenCalled()
    expect(watcherMocks.watchers[1].close).toHaveBeenCalledTimes(1)

    watcher.stopAllWatching()
  })

  it("bounds .gitignore reads and never applies a partial rule past the byte cap", async () => {
    const watcher = await import("./services/workspace-watcher")
    const workspacePath = path.resolve("large-gitignore-workspace")
    watcherMocks.gitignore.content =
      `ignored-first.txt\n${"#".repeat(WORKSPACE_GITIGNORE_MAX_BYTES + 64)}` +
      "\nafter-byte-limit.txt\n"
    await watcher.startWatching("thread-gitignore-bytes", workspacePath)

    watcherMocks.watchers[0].callback("change", "ignored-first.txt")
    watcherMocks.watchers[0].callback("change", "after-byte-limit.txt")
    await vi.advanceTimersByTimeAsync(500)

    expect(watcherMocks.gitignoreReadLengths).toEqual([WORKSPACE_GITIGNORE_MAX_BYTES])
    expect(watcherMocks.stat).toHaveBeenCalledTimes(1)
    expect(watcherMocks.stat).toHaveBeenCalledWith(
      path.join(workspacePath, "after-byte-limit.txt")
    )
    watcher.stopAllWatching()
  })

  it("preserves ordered .gitignore negation semantics for incremental patches", async () => {
    const watcher = await import("./services/workspace-watcher")
    const workspacePath = path.resolve("gitignore-negation-workspace")
    watcherMocks.gitignore.content = "*.log\n!important.log\n"
    await watcher.startWatching("thread-gitignore-negation", workspacePath)

    watcherMocks.watchers[0].callback("change", "debug.log")
    watcherMocks.watchers[0].callback("change", "important.log")
    watcherMocks.watchers[0].callback("change", "source.ts")
    await vi.advanceTimersByTimeAsync(500)

    expect(watcherMocks.stat).toHaveBeenCalledTimes(2)
    expect(watcherMocks.stat).not.toHaveBeenCalledWith(path.join(workspacePath, "debug.log"))
    expect(watcherMocks.stat).toHaveBeenCalledWith(path.join(workspacePath, "important.log"))
    expect(watcherMocks.stat).toHaveBeenCalledWith(path.join(workspacePath, "source.ts"))
    watcher.stopAllWatching()
  })

  it("bounds .gitignore rule matching and still delivers paths after the rule cap", async () => {
    const watcher = await import("./services/workspace-watcher")
    const workspacePath = path.resolve("many-gitignore-rules-workspace")
    const boundedRules = [
      "ignored-first.txt",
      ...Array.from(
        { length: WORKSPACE_GITIGNORE_MAX_RULES - 1 },
        (_, index) => `ignored-${index}.txt`
      )
    ]
    watcherMocks.gitignore.content = `${boundedRules.join("\n")}\nafter-rule-limit.txt\n`
    await watcher.startWatching("thread-gitignore-rules", workspacePath)

    watcherMocks.watchers[0].callback("change", "ignored-first.txt")
    watcherMocks.watchers[0].callback("change", "after-rule-limit.txt")
    await vi.advanceTimersByTimeAsync(500)
    await vi.runAllTimersAsync()

    expect(watcherMocks.stat).toHaveBeenCalledTimes(1)
    expect(watcherMocks.stat).toHaveBeenCalledWith(
      path.join(workspacePath, "after-rule-limit.txt")
    )
    watcher.stopAllWatching()
  })

  it("cancels an in-flight .gitignore load when its watcher is closed", async () => {
    const readGate = deferred<void>()
    watcherMocks.open.mockImplementationOnce(async () => {
      await readGate.promise
      return {
        read: vi.fn(async (buffer: Buffer) => ({ bytesRead: 0, buffer })),
        close: vi.fn(async () => undefined)
      }
    })
    const watcher = await import("./services/workspace-watcher")
    const workspacePath = path.resolve("cancelled-gitignore-workspace")
    await watcher.startWatching("thread-cancel-gitignore", workspacePath)
    watcherMocks.watchers[0].callback("change", "file.txt")
    vi.advanceTimersByTime(500)
    for (let index = 0; index < 5; index += 1) await Promise.resolve()
    expect(watcherMocks.open).toHaveBeenCalledTimes(1)

    watcher.stopWatching("thread-cancel-gitignore")
    readGate.resolve(undefined)
    await vi.runAllTimersAsync()
    await Promise.resolve()

    expect(watcherMocks.stat).not.toHaveBeenCalled()
    expect(watcherMocks.send).not.toHaveBeenCalled()
    expect(watcherMocks.open).toHaveBeenCalledTimes(1)
  })

  it("does not probe UNC paths in main and applies only C from A to B to C", async () => {
    vi.useRealTimers()
    const watcher = await import("./services/workspace-watcher")
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)

    const first = watcher.startWatching("thread-unc", "//server/workspace-a")
    const second = watcher.startWatching("thread-unc", "//server/workspace-b")
    const third = watcher.startWatching("thread-unc", "//server/workspace-c")
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    await expect(third).resolves.toBe("started")
    await expect(second).resolves.toBe("superseded")
    await expect(first).resolves.toBe("superseded")
    clearInterval(ticker)

    expect(ticks).toBeGreaterThan(0)
    expect(watcherMocks.lstat).not.toHaveBeenCalled()
    expect(watcherMocks.watch).toHaveBeenCalledTimes(1)
    expect(watcherMocks.watch).toHaveBeenCalledWith(
      expect.stringContaining("workspace-c"),
      { recursive: true },
      expect.any(Function)
    )
    watcher.stopAllWatching()
  })

  it("keeps a delayed native install off main and closes A and B before subscribing C", async () => {
    vi.useRealTimers()
    const watcher = await import("./services/workspace-watcher")
    const gateA = deferred<void>()
    const gateB = deferred<void>()
    const workspaceA = "//server/install-a"
    const workspaceB = "//server/install-b"
    const workspaceC = "//server/install-c"
    watcherMocks.watchInstallGates.set(workspaceA, gateA.promise)
    watcherMocks.watchInstallGates.set(workspaceB, gateB.promise)
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)

    const first = watcher.startWatching("thread-install", workspaceA)
    await vi.waitFor(() => expect(watcherMocks.workerClients).toHaveLength(1))
    const second = watcher.startWatching("thread-install", workspaceB)
    await vi.waitFor(() => expect(watcherMocks.workerClients).toHaveLength(2))
    const third = watcher.startWatching("thread-install", workspaceC)
    await expect(third).resolves.toBe("started")
    await new Promise<void>((resolve) => setTimeout(resolve, 10))

    expect(ticks).toBeGreaterThan(0)
    expect(watcherMocks.workerClients[0].close).toHaveBeenCalledTimes(1)
    expect(watcherMocks.workerClients[1].close).toHaveBeenCalledTimes(1)
    expect(watcherMocks.watch).toHaveBeenCalledTimes(1)
    expect(watcherMocks.watch).toHaveBeenCalledWith(
      workspaceC,
      { recursive: true },
      expect.any(Function)
    )
    expect(watcher.isWatching("thread-install")).toBe(true)

    gateB.resolve(undefined)
    gateA.resolve(undefined)
    await expect(second).resolves.toBe("superseded")
    await expect(first).resolves.toBe("superseded")
    clearInterval(ticker)
    watcher.stopAllWatching()
    expect(watcherMocks.workerClients[2].close).toHaveBeenCalledTimes(1)
  })

  it("bounds pending native installs before any slow workspace validation completes", async () => {
    vi.useRealTimers()
    const watcher = await import("./services/workspace-watcher")
    const gates = Array.from({ length: 10 }, () => deferred<void>())
    const starts = gates.map((gate, index) => {
      const workspacePath = `//server/pending-${index}`
      watcherMocks.watchInstallGates.set(workspacePath, gate.promise)
      return watcher.startWatching(`thread-pending-${index}`, workspacePath)
    })

    await vi.waitFor(() => expect(watcherMocks.workerClients).toHaveLength(10))
    for (const client of watcherMocks.workerClients.slice(0, 4)) {
      expect(client.close).toHaveBeenCalledTimes(1)
    }
    for (const client of watcherMocks.workerClients.slice(4)) {
      expect(client.close).not.toHaveBeenCalled()
    }

    for (const gate of gates) gate.resolve(undefined)
    const results = await Promise.all(starts)
    expect(results.filter((result) => result === "started")).toHaveLength(6)
    expect(results.filter((result) => result === "superseded")).toHaveLength(4)
    watcher.stopAllWatching()
  })

  it("closes a failed watcher worker and restarts it on the next association", async () => {
    const watcher = await import("./services/workspace-watcher")
    const workspacePath = path.resolve("worker-restart-workspace")
    await expect(watcher.startWatching("thread-restart", workspacePath)).resolves.toBe(
      "started"
    )
    expect(watcherMocks.watchers[0].errorCallback).toBeTypeOf("function")

    watcherMocks.watchers[0].errorCallback?.(new Error("watch worker disconnected"))
    expect(watcherMocks.workerClients[0].close).toHaveBeenCalledTimes(1)
    expect(watcher.isWatching("thread-restart")).toBe(false)

    await expect(watcher.startWatching("thread-restart", workspacePath)).resolves.toBe(
      "started"
    )
    expect(watcherMocks.watch).toHaveBeenCalledTimes(2)
    expect(watcher.isWatching("thread-restart")).toBe(true)
    watcher.stopAllWatching()
    expect(watcherMocks.workerClients[1].close).toHaveBeenCalledTimes(1)
  })
})
