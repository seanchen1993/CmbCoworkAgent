import { beforeEach, describe, expect, it, vi } from "vitest"

type WorkspaceLoadResult = {
  success: boolean
  files: Array<{ path: string; is_dir: boolean }>
  workspacePath?: string
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function loadModule(loadFromDisk: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("window", {
    api: {
      workspace: {
        loadFromDisk
      }
    }
  })
  return import("../renderer/src/lib/workspace-file-load")
}

describe("workspace file load deduplication", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it("shares one scan for ordinary concurrent callers", async () => {
    const scan = deferred<WorkspaceLoadResult>()
    const loadFromDisk = vi.fn(() => scan.promise)
    const loader = await loadModule(loadFromDisk)

    const first = loader.loadWorkspaceFilesDeduped("thread-1", "C:/workspace")
    const second = loader.loadWorkspaceFilesDeduped("thread-1", "C:/workspace")

    expect(loadFromDisk).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)

    const result = {
      success: true,
      files: [],
      workspacePath: "C:/workspace"
    }
    scan.resolve(result)

    await expect(first).resolves.toEqual(result)
    expect(loader.hasLoadedWorkspaceFiles("thread-1", "C:/workspace")).toBe(true)
  })

  it("runs one trailing scan only when a file-change caller requests it", async () => {
    const firstScan = deferred<WorkspaceLoadResult>()
    const trailingScan = deferred<WorkspaceLoadResult>()
    const loadFromDisk = vi
      .fn()
      .mockImplementationOnce(() => firstScan.promise)
      .mockImplementationOnce(() => trailingScan.promise)
    const loader = await loadModule(loadFromDisk)

    const first = loader.loadWorkspaceFilesDeduped("thread-1", "C:/workspace")
    const changed = loader.loadWorkspaceFilesDeduped("thread-1", "C:/workspace", {
      requestTrailingRescan: true
    })

    firstScan.resolve({
      success: true,
      files: [{ path: "/old.txt", is_dir: false }],
      workspacePath: "C:/workspace"
    })
    await vi.waitFor(() => expect(loadFromDisk).toHaveBeenCalledTimes(2))

    const freshResult = {
      success: true,
      files: [{ path: "/new.txt", is_dir: false }],
      workspacePath: "C:/workspace"
    }
    trailingScan.resolve(freshResult)

    await expect(first).resolves.toEqual(freshResult)
    await expect(changed).resolves.toEqual(freshResult)
  })

  it("queues one follow-up cycle when changes continue during the trailing scan", async () => {
    const firstScan = deferred<WorkspaceLoadResult>()
    const trailingScan = deferred<WorkspaceLoadResult>()
    const followUpResult = {
      success: true,
      files: [{ path: "/newest.txt", is_dir: false }],
      workspacePath: "C:/workspace"
    }
    const loadFromDisk = vi
      .fn()
      .mockImplementationOnce(() => firstScan.promise)
      .mockImplementationOnce(() => trailingScan.promise)
      .mockResolvedValueOnce(followUpResult)
    const loader = await loadModule(loadFromDisk)

    const first = loader.loadWorkspaceFilesDeduped("thread-1", "C:/workspace")
    loader.loadWorkspaceFilesDeduped("thread-1", "C:/workspace", {
      requestTrailingRescan: true
    })

    firstScan.resolve({
      success: true,
      files: [{ path: "/old.txt", is_dir: false }],
      workspacePath: "C:/workspace"
    })
    await vi.waitFor(() => expect(loadFromDisk).toHaveBeenCalledTimes(2))

    const duringTrailing = loader.loadWorkspaceFilesDeduped("thread-1", "C:/workspace", {
      requestTrailingRescan: true
    })
    const sameBurst = loader.loadWorkspaceFilesDeduped("thread-1", "C:/workspace", {
      requestTrailingRescan: true
    })
    expect(duringTrailing).not.toBe(first)
    expect(sameBurst).toBe(duringTrailing)

    const freshResult = {
      success: true,
      files: [{ path: "/new.txt", is_dir: false }],
      workspacePath: "C:/workspace"
    }
    trailingScan.resolve(freshResult)

    await expect(first).resolves.toEqual(freshResult)
    await expect(duringTrailing).resolves.toEqual(followUpResult)
    expect(loadFromDisk).toHaveBeenCalledTimes(3)
  })

  it("clears a rejected in-flight request so a later call can retry", async () => {
    const recoveredResult = {
      success: true,
      files: [],
      workspacePath: "C:/workspace"
    }
    const loadFromDisk = vi
      .fn()
      .mockRejectedValueOnce(new Error("renderer disconnected"))
      .mockResolvedValueOnce(recoveredResult)
    const loader = await loadModule(loadFromDisk)

    await expect(
      loader.loadWorkspaceFilesDeduped("thread-1", "C:/workspace")
    ).rejects.toThrow("renderer disconnected")
    await expect(
      loader.loadWorkspaceFilesDeduped("thread-1", "C:/workspace")
    ).resolves.toEqual(recoveredResult)
    expect(loadFromDisk).toHaveBeenCalledTimes(2)
  })

  it("can mark a successfully loaded empty workspace as stale", async () => {
    const loadFromDisk = vi.fn().mockResolvedValue({
      success: true,
      files: [],
      workspacePath: "C:/empty"
    })
    const loader = await loadModule(loadFromDisk)

    await loader.loadWorkspaceFilesDeduped("thread-1", "C:/empty")
    expect(loader.hasLoadedWorkspaceFiles("thread-1", "C:/empty")).toBe(true)

    loader.markWorkspaceFilesStale("thread-1", "C:/empty")
    expect(loader.hasLoadedWorkspaceFiles("thread-1", "C:/empty")).toBe(false)
  })
})
