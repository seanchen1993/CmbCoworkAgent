import { beforeEach, describe, expect, it, vi } from "vitest"

type WorkspaceLoadResult = {
  success: boolean
  files: Array<{
    path: string
    is_dir: boolean
    size?: number
    modified_at?: string
  }>
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

async function loadModule(
  loadFromDisk: ReturnType<typeof vi.fn>,
  pagedApi: Record<string, unknown> = {}
) {
  const ensureWatching = vi.fn().mockResolvedValue({ success: true, restarted: false })
  vi.stubGlobal("window", {
    api: {
      workspace: {
        loadFromDisk,
        ensureWatching,
        ...pagedApi
      }
    }
  })
  return {
    loader: await import("../renderer/src/lib/workspace-file-load"),
    ensureWatching
  }
}

describe("workspace file load deduplication", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it("shares one scan for ordinary concurrent callers", async () => {
    const scan = deferred<WorkspaceLoadResult>()
    const loadFromDisk = vi.fn(() => scan.promise)
    const { loader } = await loadModule(loadFromDisk)

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

  it("shares a scan and cached file array across threads using the same workspace", async () => {
    const scan = deferred<WorkspaceLoadResult>()
    const loadFromDisk = vi.fn(() => scan.promise)
    const { loader, ensureWatching } = await loadModule(loadFromDisk)

    const first = loader.loadWorkspaceFilesDeduped("thread-1", "/workspace/")
    const second = loader.loadWorkspaceFilesDeduped("thread-2", "/workspace")

    expect(loadFromDisk).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
    expect(ensureWatching).toHaveBeenCalledWith("thread-2")

    const sharedFiles = [{ path: "/shared.txt", is_dir: false }]
    const result = { success: true, files: sharedFiles, workspacePath: "/workspace" }
    scan.resolve(result)
    await expect(first).resolves.toBe(result)

    const cached = await loader.loadWorkspaceFilesDeduped("thread-3", "/workspace/")
    expect(loadFromDisk).toHaveBeenCalledTimes(1)
    expect(cached).toBe(result)
    expect(cached.files).toBe(sharedFiles)
    expect(ensureWatching).toHaveBeenCalledWith("thread-3")
    expect(loader.hasLoadedWorkspaceFiles("thread-3", "/workspace")).toBe(true)
  })

  it("publishes one shared file generation to initialized thread-state consumers", async () => {
    const sharedFiles = [{ path: "/shared.txt", is_dir: false }]
    const loadFromDisk = vi.fn().mockResolvedValue({
      success: true,
      files: sharedFiles,
      workspacePath: "/workspace"
    })
    const { loader } = await loadModule(loadFromDisk)
    const listener = vi.fn()
    const unsubscribe = loader.subscribeWorkspaceFileResults(listener)

    await loader.loadWorkspaceFilesDeduped("thread-1", "/workspace")
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(
      loader.normalizeWorkspaceFileKey("/workspace"),
      sharedFiles,
      expect.objectContaining({ success: true, files: sharedFiles })
    )

    await loader.loadWorkspaceFilesDeduped("thread-2", "/workspace/")
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it("applies one existing-file patch to a retained segment without an array walk", async () => {
    const files = Array.from({ length: 10_000 }, (_, index) => ({
      path: `/src/file-${index}.ts`,
      is_dir: false,
      size: index,
      modified_at: "2026-08-20T00:00:00.000Z"
    }))
    const loadFromDisk = vi.fn().mockResolvedValue({
      success: true,
      files,
      workspacePath: "/workspace"
    })
    const { loader } = await loadModule(loadFromDisk)
    await loader.loadWorkspaceFilesDeduped("thread-1", "/workspace")

    const generationListener = vi.fn()
    const pathListener = vi.fn()
    const unsubscribeGeneration = loader.subscribeWorkspaceFileResults(generationListener)
    const unsubscribePath = loader.subscribeWorkspaceFilePathChanges(
      "/workspace",
      "/src/file-5000.ts",
      pathListener
    )
    Object.defineProperty(files, Symbol.iterator, {
      configurable: true,
      value: () => {
        throw new Error("incremental metadata patch walked the retained file array")
      }
    })

    await loader.refreshWorkspaceFilesFromChangeBatch(
      {
        threadIds: ["thread-1", "thread-2"],
        workspacePath: "/workspace",
        changeType: "file",
        update: {
          kind: "patch",
          upserts: [
            {
              path: "/src/file-5000.ts",
              is_dir: false,
              size: 999_999,
              modified_at: "2026-08-21T00:00:00.000Z"
            }
          ],
          deletes: []
        }
      },
      [
        { threadId: "thread-1", workspacePath: "/workspace" },
        { threadId: "thread-2", workspacePath: "/workspace/" }
      ]
    )

    const cached = await loader.loadWorkspaceFilesDeduped("thread-2", "/workspace/")
    expect(loadFromDisk).toHaveBeenCalledTimes(1)
    expect(cached.files).toBe(files)
    expect(files[5_000]).toMatchObject({
      size: 999_999,
      modified_at: "2026-08-21T00:00:00.000Z"
    })
    expect(generationListener).not.toHaveBeenCalled()
    expect(pathListener).toHaveBeenCalledTimes(1)
    expect(loader.getWorkspaceFilePathRevision("/workspace", "/src/file-5000.ts")).toBe(1)
    unsubscribePath()
    unsubscribeGeneration()
  })

  it("orders a patch after an in-flight initial scan without a trailing full scan", async () => {
    const scan = deferred<WorkspaceLoadResult>()
    const loadFromDisk = vi.fn(() => scan.promise)
    const { loader } = await loadModule(loadFromDisk)

    const initial = loader.loadWorkspaceFilesDeduped("thread-1", "/workspace")
    const patch = loader.refreshWorkspaceFilesFromChangeBatch(
      {
        threadIds: ["thread-1"],
        workspacePath: "/workspace",
        changeType: "file",
        update: {
          kind: "patch",
          upserts: [
            {
              path: "/active.ts",
              is_dir: false,
              size: 200,
              modified_at: "2026-08-21T00:00:00.000Z"
            }
          ],
          deletes: []
        }
      },
      [{ threadId: "thread-1", workspacePath: "/workspace" }]
    )
    scan.resolve({
      success: true,
      files: [{ path: "/active.ts", is_dir: false, size: 100 }],
      workspacePath: "/workspace"
    })

    await initial
    await patch
    const cached = await loader.loadWorkspaceFilesDeduped("thread-1", "/workspace")
    expect(loadFromDisk).toHaveBeenCalledTimes(1)
    expect(cached.files[0]).toMatchObject({ size: 200 })
  })

  it("publishes at most one shared array for a create/delete batch", async () => {
    const loadFromDisk = vi.fn().mockResolvedValue({
      success: true,
      files: [
        { path: "/keep.ts", is_dir: false, size: 1 },
        { path: "/remove.ts", is_dir: false, size: 2 }
      ],
      workspacePath: "/workspace"
    })
    const { loader } = await loadModule(loadFromDisk)
    await loader.loadWorkspaceFilesDeduped("thread-1", "/workspace")
    const listener = vi.fn()
    const unsubscribe = loader.subscribeWorkspaceFileResults(listener)

    await loader.refreshWorkspaceFilesFromChangeBatch(
      {
        threadIds: ["thread-1", "thread-2"],
        workspacePath: "/workspace",
        changeType: "file",
        update: {
          kind: "patch",
          upserts: [
            {
              path: "/created.ts",
              is_dir: false,
              size: 3,
              modified_at: "2026-08-21T00:00:00.000Z"
            },
            {
              path: "/keep.ts",
              is_dir: false,
              size: 4,
              modified_at: "2026-08-21T00:00:00.000Z"
            }
          ],
          deletes: ["/remove.ts"]
        }
      },
      [{ threadId: "thread-1", workspacePath: "/workspace" }]
    )

    expect(loadFromDisk).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(1)
    const published = listener.mock.calls[0][1]
    expect(published).toHaveLength(2)
    expect(published.map((file: { path: string }) => file.path).sort()).toEqual([
      "/created.ts",
      "/keep.ts"
    ])
    const shared = await loader.loadWorkspaceFilesDeduped("thread-2", "/workspace/")
    expect(shared.files).toBe(published)
    unsubscribe()
  })

  it("turns one multi-thread change batch into one shared scan and publication", async () => {
    const sharedFiles = [{ path: "/changed.txt", is_dir: false }]
    const loadFromDisk = vi.fn().mockResolvedValue({
      success: true,
      files: sharedFiles,
      workspacePath: "C:/workspace"
    })
    const { loader } = await loadModule(loadFromDisk)
    const listener = vi.fn()
    const unsubscribe = loader.subscribeWorkspaceFileResults(listener)

    await loader.refreshWorkspaceFilesFromChangeBatch(
      {
        threadIds: ["thread-1", "thread-2"],
        workspacePath: loader.normalizeWorkspaceFileKey("C:/workspace/"),
        changeType: "file"
      },
      [
        { threadId: "thread-1", workspacePath: "C:/workspace" },
        { threadId: "thread-2", workspacePath: "C:/workspace/" }
      ]
    )

    expect(loadFromDisk).toHaveBeenCalledTimes(1)
    expect(loadFromDisk).toHaveBeenCalledWith("thread-1", "C:/workspace")
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(
      loader.normalizeWorkspaceFileKey("C:/workspace"),
      sharedFiles,
      expect.objectContaining({ success: true, files: sharedFiles })
    )
    unsubscribe()
  })

  it("does not scan the file tree for a metadata-only batch", async () => {
    const loadFromDisk = vi.fn()
    const { loader } = await loadModule(loadFromDisk)

    await loader.refreshWorkspaceFilesFromChangeBatch(
      {
        threadIds: ["thread-1", "thread-2"],
        workspacePath: loader.normalizeWorkspaceFileKey("C:/workspace"),
        changeType: "meta"
      },
      [{ threadId: "thread-1", workspacePath: "C:/workspace" }]
    )

    expect(loadFromDisk).not.toHaveBeenCalled()
  })

  it("runs one trailing scan only when a file-change caller requests it", async () => {
    const firstScan = deferred<WorkspaceLoadResult>()
    const trailingScan = deferred<WorkspaceLoadResult>()
    const loadFromDisk = vi
      .fn()
      .mockImplementationOnce(() => firstScan.promise)
      .mockImplementationOnce(() => trailingScan.promise)
    const { loader } = await loadModule(loadFromDisk)

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

  it("refreshes an in-flight scan when the global watcher marks its path stale", async () => {
    const firstScan = deferred<WorkspaceLoadResult>()
    const trailingScan = deferred<WorkspaceLoadResult>()
    const loadFromDisk = vi
      .fn()
      .mockImplementationOnce(() => firstScan.promise)
      .mockImplementationOnce(() => trailingScan.promise)
    const { loader } = await loadModule(loadFromDisk)

    const pending = loader.loadWorkspaceFilesDeduped("thread-1", "/workspace")
    loader.markWorkspaceFilesStale("thread-2", "/workspace/")
    firstScan.resolve({
      success: true,
      files: [{ path: "/old.txt", is_dir: false }],
      workspacePath: "/workspace"
    })
    await vi.waitFor(() => expect(loadFromDisk).toHaveBeenCalledTimes(2))

    const freshResult = {
      success: true,
      files: [{ path: "/new.txt", is_dir: false }],
      workspacePath: "/workspace"
    }
    trailingScan.resolve(freshResult)

    await expect(pending).resolves.toBe(freshResult)
    expect(loader.hasLoadedWorkspaceFiles("thread-2", "/workspace")).toBe(true)
  })

  it("publishes truncated boundary metadata after a watcher rescan", async () => {
    let openCount = 0
    const fileScanOpen = vi.fn(async () => {
      openCount += 1
      return {
        success: true,
        scanId: `scan-watcher-${openCount}`,
        workspacePath: "/workspace-watcher-boundary"
      }
    })
    const fileScanNext = vi.fn(async (scanId: string) =>
      scanId === "scan-watcher-1"
        ? {
            success: true,
            files: [{ path: "/initial.txt", is_dir: false }],
            done: true,
            truncated: false,
            workspacePath: "/workspace-watcher-boundary"
          }
        : {
            success: true,
            files: [{ path: "/rescanned.txt", is_dir: false }],
            done: false,
            truncated: true,
            continuation: "continue-watcher",
            workspacePath: "/workspace-watcher-boundary"
          }
    )
    const { loader } = await loadModule(vi.fn(), {
      fileScanOpen,
      fileScanNext,
      fileScanCancel: vi.fn().mockResolvedValue({ success: true })
    })
    await loader.loadWorkspaceFilesDeduped(
      "thread-watcher-boundary",
      "/workspace-watcher-boundary"
    )
    const listener = vi.fn()
    const unsubscribe = loader.subscribeWorkspaceFileResults(listener)

    await loader.refreshWorkspaceFilesFromChangeBatch(
      {
        threadIds: ["thread-watcher-boundary"],
        workspacePath: "/workspace-watcher-boundary",
        changeType: "file"
      },
      [
        {
          threadId: "thread-watcher-boundary",
          workspacePath: "/workspace-watcher-boundary"
        }
      ]
    )

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][1]).toEqual([
      { path: "/rescanned.txt", is_dir: false }
    ])
    expect(listener.mock.calls[0][2]).toMatchObject({
      truncated: true,
      continuationAvailable: true
    })
    unsubscribe()
  })

  it("never publishes an invalidated truncated generation before its trailing scan", async () => {
    const oldPage = deferred<{
      success: boolean
      files: Array<{ path: string; is_dir: boolean }>
      done: boolean
      truncated: boolean
      continuation: string
      workspacePath: string
    }>()
    let openCount = 0
    const fileScanOpen = vi.fn(async () => {
      openCount += 1
      return {
        success: true,
        scanId: `scan-generation-${openCount}`,
        workspacePath: "/workspace-generation"
      }
    })
    const fileScanNext = vi.fn(async (scanId: string) => {
      if (scanId === "scan-generation-1") return oldPage.promise
      return {
        success: true,
        files: [{ path: "/fresh.txt", is_dir: false }],
        done: false,
        truncated: true,
        continuation: "continue-fresh",
        workspacePath: "/workspace-generation"
      }
    })
    const fileScanCancel = vi.fn().mockResolvedValue({ success: true })
    const { loader } = await loadModule(vi.fn(), {
      fileScanOpen,
      fileScanNext,
      fileScanCancel
    })
    const listener = vi.fn()
    const unsubscribe = loader.subscribeWorkspaceFileResults(listener)
    const pending = loader.loadWorkspaceFilesDeduped(
      "thread-generation",
      "/workspace-generation"
    )
    await vi.waitFor(() => expect(fileScanNext).toHaveBeenCalledTimes(1))
    loader.markWorkspaceFilesStale("thread-generation", "/workspace-generation")
    oldPage.resolve({
      success: true,
      files: [{ path: "/stale.txt", is_dir: false }],
      done: false,
      truncated: true,
      continuation: "continue-stale",
      workspacePath: "/workspace-generation"
    })

    await expect(pending).resolves.toMatchObject({
      files: [{ path: "/fresh.txt", is_dir: false }],
      truncated: true,
      continuationAvailable: true
    })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][1]).toEqual([{ path: "/fresh.txt", is_dir: false }])
    expect(listener.mock.calls[0][2]).toMatchObject({
      truncated: true,
      continuationAvailable: true
    })
    expect(fileScanCancel).toHaveBeenCalledWith("scan-generation-1")
    loader.cancelWorkspaceFileContinuation("thread-generation", "/workspace-generation")
    unsubscribe()
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
    const { loader } = await loadModule(loadFromDisk)

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
    const { loader } = await loadModule(loadFromDisk)

    await expect(loader.loadWorkspaceFilesDeduped("thread-1", "C:/workspace")).rejects.toThrow(
      "renderer disconnected"
    )
    await expect(loader.loadWorkspaceFilesDeduped("thread-1", "C:/workspace")).resolves.toEqual(
      recoveredResult
    )
    expect(loadFromDisk).toHaveBeenCalledTimes(2)
  })

  it("can mark a successfully loaded empty workspace as stale", async () => {
    const loadFromDisk = vi.fn().mockResolvedValue({
      success: true,
      files: [],
      workspacePath: "C:/empty"
    })
    const { loader } = await loadModule(loadFromDisk)

    await loader.loadWorkspaceFilesDeduped("thread-1", "C:/empty")
    expect(loader.hasLoadedWorkspaceFiles("thread-1", "C:/empty")).toBe(true)

    loader.markWorkspaceFilesStale("thread-1", "C:/empty")
    expect(loader.hasLoadedWorkspaceFiles("thread-1", "C:/empty")).toBe(false)
  })

  it("invalidates the shared cached tree when any associated thread marks it stale", async () => {
    const firstResult = {
      success: true,
      files: [{ path: "/old.txt", is_dir: false }],
      workspacePath: "/workspace"
    }
    const freshResult = {
      success: true,
      files: [{ path: "/new.txt", is_dir: false }],
      workspacePath: "/workspace"
    }
    const loadFromDisk = vi
      .fn()
      .mockResolvedValueOnce(firstResult)
      .mockResolvedValueOnce(freshResult)
    const { loader } = await loadModule(loadFromDisk)

    await loader.loadWorkspaceFilesDeduped("thread-1", "/workspace")
    await loader.loadWorkspaceFilesDeduped("thread-2", "/workspace/")
    expect(loadFromDisk).toHaveBeenCalledTimes(1)

    loader.markWorkspaceFilesStale("thread-2", "/workspace/")
    await expect(
      loader.loadWorkspaceFilesDeduped("thread-1", "/workspace", {
        requestTrailingRescan: true
      })
    ).resolves.toBe(freshResult)
    expect(loadFromDisk).toHaveBeenCalledTimes(2)
  })

  it("bounds retained workspace trees by aggregate bytes instead of workspace count", async () => {
    const loadFromDisk = vi.fn(async (_threadId: string, workspacePath: string) => ({
      success: true,
      files: [{ path: `${workspacePath}/file.txt`, is_dir: false }],
      workspacePath
    }))
    const { loader } = await loadModule(loadFromDisk)

    for (let index = 1; index <= 7; index += 1) {
      await loader.loadWorkspaceFilesDeduped(`thread-${index}`, `/workspace-${index}`)
    }

    // More than the old six-workspace count is retained while the aggregate
    // payload stays under the byte budget.
    expect(loader.hasLoadedWorkspaceFiles("thread-1", "/workspace-1")).toBe(true)
    loader.setWorkspaceFileCacheByteLimitForTests(320)
    expect(loader.hasLoadedWorkspaceFiles("thread-1", "/workspace-1")).toBe(false)
    expect(loader.hasLoadedWorkspaceFiles("thread-7", "/workspace-7")).toBe(true)
  })

  it("hard-bounds a legacy full-array response by retained bytes", async () => {
    const sourceFiles = Array.from({ length: 100 }, (_, index) => ({
      path: `/${String(index).padStart(3, "0")}-${"x".repeat(100_000)}.txt`,
      is_dir: false
    }))
    const loadFromDisk = vi.fn().mockResolvedValue({
      success: true,
      files: sourceFiles,
      workspacePath: "/workspace-byte-budget"
    })
    const { loader } = await loadModule(loadFromDisk)

    const result = await loader.loadWorkspaceFilesDeduped(
      "thread-byte-budget",
      "/workspace-byte-budget"
    )
    const diagnostics = loader.getWorkspaceFileCacheDiagnosticsForTests()

    expect(result.files.length).toBeLessThan(sourceFiles.length)
    expect(result).toMatchObject({
      success: true,
      truncated: true,
      continuationAvailable: false
    })
    expect(diagnostics.byteSize).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(loader.getWorkspaceFilePathIndex(result.files)?.size).toBe(result.files.length)
  })

  it("waits for an explicit action before continuing a truncated segment", async () => {
    const fileScanOpen = vi.fn(async () => ({
      success: true,
      scanId: "scan-segmented",
      workspacePath: "/workspace-segmented"
    }))
    const fileScanNext = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        files: [{ path: "/first.txt", is_dir: false }],
        done: false,
        truncated: true,
        continuation: "continue-1",
        workspacePath: "/workspace-segmented"
      })
      .mockResolvedValueOnce({
        success: true,
        files: [{ path: "/second.txt", is_dir: false }],
        done: false,
        truncated: true,
        continuation: "continue-2",
        workspacePath: "/workspace-segmented"
      })
      .mockResolvedValueOnce({
        success: true,
        files: [{ path: "/third.txt", is_dir: false }],
        done: true,
        truncated: false,
        workspacePath: "/workspace-segmented"
      })
    const { loader } = await loadModule(vi.fn(), {
      fileScanOpen,
      fileScanNext,
      fileScanCancel: vi.fn().mockResolvedValue({ success: true })
    })

    const initial = await loader.loadWorkspaceFilesDeduped(
      "thread-segmented",
      "/workspace-segmented"
    )
    expect(initial).toMatchObject({
      success: true,
      files: [{ path: "/first.txt", is_dir: false }],
      truncated: true,
      continuationAvailable: true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(fileScanNext).toHaveBeenCalledTimes(1)
    expect(fileScanNext).toHaveBeenNthCalledWith(
      1,
      "scan-segmented",
      "thread-segmented",
      undefined
    )

    await expect(
      loader.continueWorkspaceFilesDeduped(
        "thread-segmented",
        "/workspace-segmented"
      )
    ).resolves.toMatchObject({
      success: true,
      files: [
        { path: "/first.txt", is_dir: false },
        { path: "/second.txt", is_dir: false }
      ],
      truncated: true,
      continuationAvailable: true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(fileScanNext).toHaveBeenCalledTimes(2)
    expect(fileScanNext).toHaveBeenNthCalledWith(
      2,
      "scan-segmented",
      "thread-segmented",
      "continue-1"
    )

    await expect(
      loader.continueWorkspaceFilesDeduped(
        "thread-segmented",
        "/workspace-segmented"
      )
    ).resolves.toMatchObject({
      success: true,
      files: [
        { path: "/first.txt", is_dir: false },
        { path: "/second.txt", is_dir: false },
        { path: "/third.txt", is_dir: false }
      ],
      truncated: false,
      continuationAvailable: false
    })
    expect(fileScanNext).toHaveBeenNthCalledWith(
      3,
      "scan-segmented",
      "thread-segmented",
      "continue-2"
    )
  })

  it("drops a cancelled partial cache so reopening starts a resumable scan", async () => {
    let openCount = 0
    const fileScanOpen = vi.fn(async () => {
      openCount += 1
      return {
        success: true,
        scanId: `scan-reopen-${openCount}`,
        workspacePath: "/workspace-reopen"
      }
    })
    const fileScanNext = vi.fn(async (scanId: string) =>
      scanId === "scan-reopen-1"
        ? {
            success: true,
            files: [{ path: "/partial.txt", is_dir: false }],
            done: false,
            truncated: true,
            continuation: "continue-reopen",
            workspacePath: "/workspace-reopen"
          }
        : {
            success: true,
            files: [{ path: "/fresh.txt", is_dir: false }],
            done: true,
            truncated: false,
            workspacePath: "/workspace-reopen"
          }
    )
    const fileScanCancel = vi.fn().mockResolvedValue({ success: true })
    const { loader } = await loadModule(vi.fn(), {
      fileScanOpen,
      fileScanNext,
      fileScanCancel
    })

    const partial = await loader.loadWorkspaceFilesDeduped(
      "thread-reopen",
      "/workspace-reopen"
    )
    expect(partial.continuationAvailable).toBe(true)
    expect(loader.getWorkspaceFileCacheDiagnosticsForTests().byteSize).toBeGreaterThan(0)

    loader.cancelWorkspaceFileContinuation("thread-reopen", "/workspace-reopen")
    expect(partial.continuationAvailable).toBe(false)
    expect(loader.hasLoadedWorkspaceFiles("thread-reopen", "/workspace-reopen")).toBe(false)
    expect(loader.getWorkspaceFileCacheDiagnosticsForTests()).toEqual({
      workspaceCount: 0,
      byteSize: 0,
      continuationCount: 0
    })
    await vi.waitFor(() => expect(fileScanCancel).toHaveBeenCalledWith("scan-reopen-1"))

    await expect(
      loader.loadWorkspaceFilesDeduped("thread-reopen", "/workspace-reopen")
    ).resolves.toMatchObject({
      files: [{ path: "/fresh.txt", is_dir: false }],
      continuationAvailable: false
    })
    expect(fileScanOpen).toHaveBeenCalledTimes(2)
  })

  it("cancels A immediately before a B workspace scan completes", async () => {
    const pageA = deferred<WorkspaceLoadResult>()
    const cancelledScanIds: string[] = []
    const fileScanOpen = vi.fn(async (_threadId: string, workspacePath: string) => ({
      success: true,
      scanId: workspacePath === "/workspace-a" ? "scan-a" : "scan-b",
      workspacePath
    }))
    const fileScanNext = vi.fn(async (scanId: string) => {
      if (scanId === "scan-a") {
        await pageA.promise
        return { success: false, files: [], done: true, error: "cancelled" }
      }
      return {
        success: true,
        files: [{ path: "/b.txt", is_dir: false }],
        done: true,
        workspacePath: "/workspace-b"
      }
    })
    const fileScanCancel = vi.fn(async (scanId: string) => {
      cancelledScanIds.push(scanId)
      return { success: true }
    })
    const { loader } = await loadModule(vi.fn(), {
      fileScanOpen,
      fileScanNext,
      fileScanCancel
    })
    const controller = new AbortController()
    const first = loader.loadWorkspaceFilesDeduped("thread-a", "/workspace-a", {
      signal: controller.signal
    })
    await vi.waitFor(() =>
      expect(fileScanNext).toHaveBeenCalledWith("scan-a", "thread-a", undefined)
    )
    controller.abort()
    await expect(first).rejects.toMatchObject({ name: "AbortError" })
    await vi.waitFor(() => expect(cancelledScanIds).toContain("scan-a"))

    const second = loader.loadWorkspaceFilesDeduped("thread-b", "/workspace-b")
    await expect(second).resolves.toMatchObject({
      success: true,
      files: [{ path: "/b.txt", is_dir: false }]
    })
    pageA.resolve({ success: false, files: [] })
  })

  it("cancels the final tree projection when its panel consumer closes", async () => {
    const files = Array.from({ length: 256 }, (_, index) => ({
      path: `/file-${String(255 - index).padStart(3, "0")}.txt`,
      is_dir: false
    }))
    let offset = 0
    const fileScanNext = vi.fn(async () => {
      const page = files.slice(offset, offset + 128)
      offset += page.length
      return {
        success: true,
        files: page,
        done: offset >= files.length,
        truncated: false,
        workspacePath: "/workspace-projection-cancel"
      }
    })
    const fileScanCancel = vi.fn().mockResolvedValue({ success: true })
    const { loader } = await loadModule(vi.fn(), {
      fileScanOpen: vi.fn().mockResolvedValue({
        success: true,
        scanId: "scan-projection-cancel",
        workspacePath: "/workspace-projection-cancel"
      }),
      fileScanNext,
      fileScanCancel
    })
    const controller = new AbortController()
    const request = loader.loadWorkspaceFilesDeduped(
      "thread-projection-cancel",
      "/workspace-projection-cancel",
      {
        signal: controller.signal,
        onProgress: (loadedCount) => {
          if (loadedCount === files.length) controller.abort()
        }
      }
    )

    await expect(request).rejects.toMatchObject({ name: "AbortError" })
    await vi.waitFor(() => expect(fileScanCancel).toHaveBeenCalled())
    expect(
      loader.hasLoadedWorkspaceFiles(
        "thread-projection-cancel",
        "/workspace-projection-cancel"
      )
    ).toBe(false)
  })

  it("retains one bounded segment from a 500k workspace without auto-continuing", async () => {
    const totalWorkspaceEntries = 500_000
    const firstSegmentEntries = 10_000
    let offset = 0
    const fileScanOpen = vi.fn(async () => ({
      success: true,
      scanId: "scan-50k",
      workspacePath: "/workspace-50k"
    }))
    const fileScanNext = vi.fn(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve))
      const count = Math.min(128, firstSegmentEntries - offset)
      const files = Array.from({ length: count }, (_, pageIndex) => {
        const index = offset + pageIndex
        return {
          path: `/file-${String(index).padStart(6, "0")}.ts`,
          is_dir: false,
          size: index
        }
      })
      offset += count
      const truncated = offset >= firstSegmentEntries
      return {
        success: true,
        files,
        done: offset >= totalWorkspaceEntries,
        truncated,
        ...(truncated ? { continuation: "continue-10k" } : {}),
        workspacePath: "/workspace-50k"
      }
    })
    const { loader } = await loadModule(vi.fn(), {
      fileScanOpen,
      fileScanNext,
      fileScanCancel: vi.fn().mockResolvedValue({ success: true })
    })
    let ticks = 0
    let maxTickGapMs = 0
    let lastTickAt = performance.now()
    const ticker = setInterval(() => {
      ticks += 1
      const now = performance.now()
      maxTickGapMs = Math.max(maxTickGapMs, now - lastTickAt)
      lastTickAt = now
    }, 1)
    const progress = vi.fn()
    const result = await loader.loadWorkspaceFilesDeduped("thread-50k", "/workspace-50k", {
      onProgress: progress
    })
    clearInterval(ticker)

    const callsAtInitialCompletion = fileScanNext.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(result.files).toHaveLength(firstSegmentEntries)
    expect(result).toMatchObject({
      truncated: true,
      continuationAvailable: true
    })
    expect(callsAtInitialCompletion).toBe(Math.ceil(firstSegmentEntries / 128))
    expect(fileScanNext).toHaveBeenCalledTimes(callsAtInitialCompletion)
    expect(callsAtInitialCompletion).toBeLessThan(Math.ceil(totalWorkspaceEntries / 128))
    expect(ticks).toBeGreaterThan(10)
    expect(maxTickGapMs).toBeLessThan(50)
    expect(progress).toHaveBeenLastCalledWith(firstSegmentEntries)
    expect(progress.mock.calls.length).toBeLessThan(20)
    const cached = await loader.loadWorkspaceFilesDeduped("thread-other", "/workspace-50k/")
    expect(cached.files).toBe(result.files)
    expect(fileScanOpen).toHaveBeenCalledTimes(1)
    const projectionModule = await import(
      "../renderer/src/lib/workspace-file-tree-projection"
    )
    const projection = projectionModule.getWorkspaceFileTreeProjection(result.files)
    expect(projection?.tree).toHaveLength(firstSegmentEntries)
    expect(projection?.nodesByPath.size).toBe(firstSegmentEntries)
    expect(loader.getWorkspaceFilePathIndex(result.files)?.size).toBe(firstSegmentEntries)
    expect(loader.getWorkspaceFileCacheDiagnosticsForTests()).toMatchObject({
      workspaceCount: 1,
      continuationCount: 1
    })
  })
})
