import * as path from "path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { normalizeWorkspacePathKey } from "../shared/workspace-path"

const watcherMocks = vi.hoisted(() => {
  type WatchCallback = (eventType: string, filename: string | Buffer | null) => void
  type ErrorCallback = (error: Error) => void

  const watchers: Array<{
    workspacePath: string
    callback: WatchCallback
    errorCallback?: ErrorCallback
    close: ReturnType<typeof vi.fn>
  }> = []
  const send = vi.fn()
  const windowSends = [send]
  const statSync = vi.fn(() => ({ isDirectory: () => true }))
  const stat = vi.fn(async (): Promise<{
    isDirectory: () => boolean
    size: number
    mtime: Date
  }> => ({
    isDirectory: () => false,
    size: 42,
    mtime: new Date("2026-08-21T00:00:00.000Z")
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

  return { watchers, send, windowSends, statSync, stat, readFileSync, watch }
})

vi.mock("fs", () => ({
  statSync: watcherMocks.statSync,
  promises: { stat: watcherMocks.stat },
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
    watcherMocks.send.mockClear()
    watcherMocks.windowSends.splice(0, watcherMocks.windowSends.length, watcherMocks.send)
    watcherMocks.statSync.mockClear()
    watcherMocks.stat.mockClear()
    watcherMocks.stat.mockResolvedValue({
      isDirectory: () => false,
      size: 42,
      mtime: new Date("2026-08-21T00:00:00.000Z")
    })
    watcherMocks.readFileSync.mockClear()
    watcherMocks.watch.mockClear()
  })

  it("uses one physical watcher and sends one batched change per window", async () => {
    const watcher = await import("./services/workspace-watcher")
    const workspacePath = path.resolve("shared-workspace")
    const alternateSpelling = `${workspacePath}${path.sep}`

    expect(watcher.startWatching("thread-1", workspacePath)).toBe("started")
    expect(watcher.startWatching("thread-2", alternateSpelling)).toBe("existing")
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

  it("uses a bounded delete patch and rescans unknown or directory events", async () => {
    const watcher = await import("./services/workspace-watcher")
    const workspacePath = path.resolve("patch-workspace")
    watcher.startWatching("thread-1", workspacePath)

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

    watcher.startWatching("thread-1", firstPath)
    watcher.startWatching("thread-2", firstPath)
    watcher.startWatching("thread-1", secondPath)

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

    watcher.startWatching("thread-1", workspacePath)
    watcher.startWatching("thread-2", workspacePath)
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

    watcher.startWatching("thread-1", workspacePaths[0])
    watcher.setActiveWatchedThread("thread-1")
    for (let index = 1; index < workspacePaths.length; index += 1) {
      watcher.startWatching(`thread-${index + 1}`, workspacePaths[index])
    }

    expect(watcherMocks.watch).toHaveBeenCalledTimes(7)
    expect(watcher.isWatching("thread-1")).toBe(true)
    expect(watcher.isWatching("thread-2")).toBe(false)
    expect(watcher.isWatching("thread-7")).toBe(true)
    expect(watcherMocks.watchers[0].close).not.toHaveBeenCalled()
    expect(watcherMocks.watchers[1].close).toHaveBeenCalledTimes(1)

    watcher.stopAllWatching()
  })
})
