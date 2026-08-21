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

async function loadModule(loadFromDisk: ReturnType<typeof vi.fn>) {
  const ensureWatching = vi.fn().mockResolvedValue({ success: true, restarted: false })
  vi.stubGlobal("window", {
    api: {
      workspace: {
        loadFromDisk,
        ensureWatching
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
      sharedFiles
    )

    await loader.loadWorkspaceFilesDeduped("thread-2", "/workspace/")
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it("applies one existing-file patch to a 50k cache without a scan or array walk", async () => {
    const files = Array.from({ length: 50_000 }, (_, index) => ({
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
      "/src/file-25000.ts",
      pathListener
    )
    Object.defineProperty(files, Symbol.iterator, {
      configurable: true,
      value: () => {
        throw new Error("incremental metadata patch walked the 50k file array")
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
              path: "/src/file-25000.ts",
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
    expect(files[25_000]).toMatchObject({
      size: 999_999,
      modified_at: "2026-08-21T00:00:00.000Z"
    })
    expect(generationListener).not.toHaveBeenCalled()
    expect(pathListener).toHaveBeenCalledTimes(1)
    expect(loader.getWorkspaceFilePathRevision("/workspace", "/src/file-25000.ts")).toBe(1)
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
      sharedFiles
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

  it("bounds retained workspace trees with an LRU cache", async () => {
    const loadFromDisk = vi.fn(async (_threadId: string, workspacePath: string) => ({
      success: true,
      files: [{ path: `${workspacePath}/file.txt`, is_dir: false }],
      workspacePath
    }))
    const { loader } = await loadModule(loadFromDisk)

    for (let index = 1; index <= 7; index += 1) {
      await loader.loadWorkspaceFilesDeduped(`thread-${index}`, `/workspace-${index}`)
    }

    expect(loader.hasLoadedWorkspaceFiles("thread-1", "/workspace-1")).toBe(false)
    expect(loader.hasLoadedWorkspaceFiles("thread-7", "/workspace-7")).toBe(true)
  })
})
