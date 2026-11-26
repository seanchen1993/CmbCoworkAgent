import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import {
  continueWorkspaceFilesDeduped,
  getWorkspaceFilePathIndex,
  isWorkspaceFileScanSnapshot,
  loadWorkspaceFilesDeduped,
  hydrateInitialWorkspaceFiles,
  markWorkspaceFilesStale,
  mergeWorkspaceStreamFiles,
  reconcileWorkspaceFilePatch,
  subscribeWorkspaceFileResults,
  readWorkspacePathWithFallback,
  refreshWorkspaceFilesFromChangeBatch,
  resumeWorkspaceFilesDeduped,
  retainWorkspaceFilesForPathChange,
  setWorkspaceFileScanTimeoutForTests
} from "./workspace-file-load"

import {
  buildWorkspaceFileTreeProjection,
  getWorkspaceFileTreeProjection,
  type WorkspaceFileTreeNode
} from "./workspace-file-tree-projection"

type WorkspaceApi = Window["api"]["workspace"]

function installWorkspaceApi(overrides: Partial<WorkspaceApi>, platform = "win32"): void {
  vi.stubGlobal("window", {
    electron: { process: { platform } },
    api: {
      workspace: {
        loadFromDisk: vi.fn(),
        ...overrides
      }
    }
  })
}

afterEach(() => {
  setWorkspaceFileScanTimeoutForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("workspace file loading", () => {
  it("clears A files atomically while B is still waiting to hydrate", () => {
    installWorkspaceApi({}, "win32")
    const filesFromA = [{ path: "/same.md", is_dir: false }]

    expect(
      retainWorkspaceFilesForPathChange(filesFromA, "C:/workspace-a", "C:/workspace-b")
    ).toEqual([])
    expect(
      retainWorkspaceFilesForPathChange(filesFromA, "C:\\Workspace-A\\", "c:/workspace-a")
    ).toBe(filesFromA)
  })

  it("hydrates the composer file index without waiting for the Files panel", () => {
    const source = readFileSync(
      new URL("../components/chat/WorkspacePicker.tsx", import.meta.url),
      "utf8"
    ).replace(/\r\n/g, "\n")
    const rightPanelSource = readFileSync(
      new URL("../components/panels/RightPanel.tsx", import.meta.url),
      "utf8"
    ).replace(/\r\n/g, "\n")
    const loaderSource = readFileSync(
      new URL("./workspace-file-load.ts", import.meta.url),
      "utf8"
    ).replace(/\r\n/g, "\n")

    expect(source).toMatch(/const loadedPath = await readWorkspacePath\(\)/)
    expect(source).toMatch(
      /const workspaceHydrationKey = workspacePath[\s\S]*?useEffect\(\(\) => \{[\s\S]*?hydrateInitialWorkspaceFiles\(threadId, requestedWorkspacePath, \{/
    )
    expect(source.indexOf("hydrateInitialWorkspaceFiles(threadId")).toBeLessThan(
      source.indexOf("const loadedPath = await readWorkspacePath()")
    )
    expect(source).toMatch(/isCurrentWorkspace:/)
    expect(source).toMatch(/setWorkspaceFiles/)
    expect(source).toMatch(
      /\}, \[threadId, workspaceHydrationKey, workspaceHydrationReady\]\)/
    )
    expect(source).toMatch(/workspaceHydrationEpochRef\.current === hydrationEpoch/)
    expect(loaderSource).toMatch(/for \(let attempt = 0; attempt < 2; attempt \+= 1\)/)
    expect(source).toMatch(/workspaceChangedWhileReading/)
    expect(rightPanelSource).not.toContain("cancelWorkspaceFileContinuation")
    expect(rightPanelSource).toMatch(
      /resumeWorkspaceFilesDeduped\(threadId, workspacePath, \{\s*onProgress:/
    )
    expect(rightPanelSource).toMatch(/setWorkspaceFiles\?\.\(files\)/)
    expect(rightPanelSource).toMatch(/requestFenceRef\.current\.observe\(threadId, workspacePath\)/)
    expect(rightPanelSource).toMatch(/requestFenceRef\.current\.isCurrent\(requestToken\)/)
    expect(rightPanelSource).toMatch(/\}, \[threadId, workspaceKey, visible\]\)/)
  })

  it("loads the side conversation file index for @ completion or direct @path submission", () => {
    const source = readFileSync(new URL("../components/chat/ChatContainer.tsx", import.meta.url), "utf8")

    const suggestions = source.slice(source.indexOf("const loadMoreWorkspaceMentionFiles"), source.indexOf("const atFileMentions"))
    expect(suggestions).toContain("loadWorkspaceFilesDeduped(threadId, workspacePath, sideComposer ? { signal } : undefined)")
    const pickerIndex = source.slice(source.indexOf("const needsSideFileIndex"), source.indexOf("const slashPopoverKind"))
    expect(pickerIndex).toContain('sideComposer && atFileMentions.mode.kind === "at-file"')
    expect(pickerIndex).toContain("!isWorkspaceFileScanSnapshot(workspacePath, workspaceFiles)")
    expect(pickerIndex).toMatch(/if \(!needsSideFileIndex[\s\S]*hydrateInitialWorkspaceFiles\(threadId, workspacePath/)
    const submission = source.slice(source.indexOf("let filesForSubmission"), source.indexOf("workspaceFiles: filesForSubmission"))
    expect(submission).toContain("!isWorkspaceFileScanSnapshot(workspacePath, workspaceFiles)")
    expect(submission).toMatch(/knownMentions\.length < mentionPaths\.length\) \{\s+const result = await loadBtwWorkspaceFiles\(threadId, workspacePath\)/)
  })

  it("distinguishes an initial scan snapshot from files reported by tools", async () => {
    const workspacePath = "C:/side-workspace"
    const reported = [{ path: "/changed.ts", is_dir: false }]
    const loadFromDisk = vi.fn().mockResolvedValue({
      success: true,
      files: [...reported, { path: "/another.ts", is_dir: false }],
      workspacePath
    })
    installWorkspaceApi({ loadFromDisk })
    try {
      expect(isWorkspaceFileScanSnapshot(workspacePath, reported)).toBe(false)
      const snapshot = await loadWorkspaceFilesDeduped("parent", workspacePath)
      expect(isWorkspaceFileScanSnapshot("c:\\SIDE-WORKSPACE", snapshot.files)).toBe(true)
      expect(isWorkspaceFileScanSnapshot("C:/different-workspace", snapshot.files)).toBe(false)
      expect(isWorkspaceFileScanSnapshot(workspacePath, reported)).toBe(false)
      expect(await loadWorkspaceFilesDeduped("side", workspacePath)).toBe(snapshot)
      expect(loadFromDisk).toHaveBeenCalledOnce()
    } finally {
      markWorkspaceFilesStale("parent", workspacePath)
    }
  })

  it("keeps a streamed file available until the watcher publishes it to all workspace tabs", async () => {
    const workspacePath = "C:/side-workspace-patch"
    const candidates = ["parent", "side"].map(threadId => ({ threadId, workspacePath }))
    const original = { path: "/dir/original.ts", is_dir: false, size: 5 }
    const added = { path: "/added.ts", is_dir: false as const, size: 20 }
    const loadFromDisk = vi.fn().mockResolvedValue({ success: true, files: [original], workspacePath })
    installWorkspaceApi({ loadFromDisk })
    try {
      const snapshot = await loadWorkspaceFilesDeduped("parent", workspacePath)
      const sideFiles = mergeWorkspaceStreamFiles(snapshot.files, [{ ...original, size: 1 }, added])!
      expect(sideFiles).toEqual([original, added])
      expect(isWorkspaceFileScanSnapshot(workspacePath, sideFiles)).toBe(true)
      expect(mergeWorkspaceStreamFiles(sideFiles, [added])).toBe(sideFiles)
      expect(getWorkspaceFilePathIndex(sideFiles)?.get(added.path)).toEqual(added)
      expect(getWorkspaceFilePathIndex(snapshot.files)?.has(added.path)).toBe(false)
      expect(snapshot.files).toEqual([original])
      expect(snapshot.files[0].size).toBe(5)

      const temporary = { ...added, path: "/temporary.ts" }
      let visible = mergeWorkspaceStreamFiles(sideFiles, [temporary])!
      const visibleTree = await buildWorkspaceFileTreeProjection(visible)
      const rightPanel = readFileSync(new URL("../components/panels/RightPanel.tsx", import.meta.url), "utf8")
        .replace(/\r\n/g, "\n")
      const revision = rightPanel.match(/<FileTreeNode\s[\s\S]*?\brevision=\{([^}\n]+)\}/)?.[1]
      const compareRows = rightPanel.match(/const FileTreeNode = memo\([\s\S]*?\n  \(prevProps, nextProps\) => \{([\s\S]*?)\n  \}\n\)/)?.[1]
      expect(revision).toBeDefined()
      expect(compareRows).toBeDefined()
      const readRevision = new Function("node", "expanded", `return ${revision}`) as (
        node: WorkspaceFileTreeNode, expanded: ReadonlySet<string>
      ) => number | boolean
      const rowProps = (node: WorkspaceFileTreeNode, expanded: ReadonlySet<string>) => ({
        node, revision: readRevision(node, expanded), expanded, depth: 0, workspacePath
      })
      const memoEqual = new Function("prevProps", "nextProps", compareRows!) as (
        previous: ReturnType<typeof rowProps>, next: ReturnType<typeof rowProps>
      ) => boolean
      const expanded = new Set(["/dir"])
      const collapsed = new Set<string>()
      const previousFile = rowProps(visibleTree.nodesByPath.get("added.ts")!, expanded)
      const previousOpenDir = rowProps(visibleTree.nodesByPath.get("dir")!, expanded)
      const previousClosedDir = rowProps(previousOpenDir.node, collapsed)
      const previousUnchangedFile = rowProps(visibleTree.nodesByPath.get("dir/original.ts")!, expanded)
      expect(previousFile.node.file?.size).toBe(20)

      const unsubscribe = subscribeWorkspaceFileResults((_key, files, _result, patch) => {
        visible = reconcileWorkspaceFilePatch(visible, files, patch)
      })
      try {
        const watchedFile = { ...added, size: 55, modified_at: "2026-11-25T00:00:00.000Z" }
        const newChild = { ...watchedFile, path: "/dir/new.ts" }
        await refreshWorkspaceFilesFromChangeBatch({
          threadIds: ["parent", "side"], workspacePath, changeType: "file",
          update: { kind: "patch", upserts: [watchedFile, newChild], deletes: [] }
        }, candidates)
        expect(visible).toEqual([original, watchedFile, newChild, temporary])
        expect(getWorkspaceFileTreeProjection(visible)).toBe(visibleTree)
        const file = visibleTree.nodesByPath.get("added.ts")!
        const dir = visibleTree.nodesByPath.get("dir")!
        expect(file).toBe(previousFile.node)
        expect(file.file).toEqual(watchedFile)
        expect(memoEqual(previousFile, rowProps(file, expanded))).toBe(false)
        expect(dir).toBe(previousOpenDir.node)
        expect(dir.children.map(child => child.path)).toContain("/dir/new.ts")
        expect(memoEqual(previousOpenDir, rowProps(dir, expanded))).toBe(false)
        expect(memoEqual(previousClosedDir, rowProps(dir, collapsed))).toBe(true)
        expect(memoEqual(previousUnchangedFile, rowProps(visibleTree.nodesByPath.get("dir/original.ts")!, expanded))).toBe(true)
        expect(getWorkspaceFilePathIndex(snapshot.files)?.has(added.path)).toBe(false)
        const confirmed = (await loadWorkspaceFilesDeduped("parent", workspacePath)).files
        expect(confirmed).toEqual([original, watchedFile, newChild])

        await refreshWorkspaceFilesFromChangeBatch({
          threadIds: ["parent", "side"], workspacePath, changeType: "file",
          update: { kind: "patch", upserts: [], deletes: [temporary.path] }
        }, candidates)
        expect(visible).toBe(confirmed)
        expect(loadFromDisk).toHaveBeenCalledOnce()
      } finally {
        unsubscribe()
      }
    } finally {
      markWorkspaceFilesStale("parent", workspacePath)
    }
  })

  it("keeps implicit directories ordered and prunes them after a streamed file is deleted", async () => {
    const diskFiles = [{ path: "/z-existing.txt", is_dir: false }]
    const pending = { path: "/pending.txt", is_dir: false }
    const nested = { path: "/new-directory/subdirectory/new.txt", is_dir: false }
    const first = mergeWorkspaceStreamFiles(diskFiles, [pending])!
    const projection = await buildWorkspaceFileTreeProjection(first)

    const added = mergeWorkspaceStreamFiles(first, [nested])!
    expect(getWorkspaceFileTreeProjection(added)).toBe(projection)
    expect(projection.tree.map((node) => node.path)).toEqual([
      "/new-directory",
      "/pending.txt",
      "/z-existing.txt"
    ])

    const removed = reconcileWorkspaceFilePatch(added, diskFiles, {
      upserts: [],
      deletes: new Set([nested.path])
    })
    expect(removed).toEqual([...diskFiles, pending])
    expect(getWorkspaceFileTreeProjection(removed)).toBe(projection)
    expect(projection.tree.map((node) => node.path)).toEqual(["/pending.txt", "/z-existing.txt"])
    expect(projection.nodesByPath.has("new-directory/subdirectory")).toBe(false)
  })

  it("uses the current ThreadState path when workspace metadata IPC never settles", async () => {
    vi.useFakeTimers()
    let resolveLateRead!: (path: string | null) => void
    const read = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolveLateRead = resolve
        })
    )
    const controller = new AbortController()
    const pending = readWorkspacePathWithFallback({
      read,
      getFallback: () => "C:/thread-state-workspace",
      signal: controller.signal,
      timeoutMs: 25
    })

    await vi.advanceTimersByTimeAsync(25)
    await expect(pending).resolves.toBe("C:/thread-state-workspace")
    resolveLateRead("C:/stale-late-workspace")
    await Promise.resolve()
    await expect(pending).resolves.toBe("C:/thread-state-workspace")
    expect(read).toHaveBeenCalledTimes(1)
  })

  it("retries one transient workspace metadata failure before using fallback", async () => {
    vi.useFakeTimers()
    const read = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("renderer startup race"))
      .mockResolvedValueOnce("C:/authoritative-workspace")
    const pending = readWorkspacePathWithFallback({
      read,
      getFallback: () => "C:/fallback-workspace",
      signal: new AbortController().signal,
      retryDelayMs: 10
    })

    await vi.advanceTimersByTimeAsync(10)
    await expect(pending).resolves.toBe("C:/authoritative-workspace")
    expect(read).toHaveBeenCalledTimes(2)
  })

  it("shares one renderer scan and cache entry for equivalent Windows paths", async () => {
    let resolveScan!: (result: {
      success: true
      files: Array<{ path: string; is_dir: boolean }>
      workspacePath: string
    }) => void
    const loadFromDisk = vi.fn(
      () =>
        new Promise<{
          success: true
          files: Array<{ path: string; is_dir: boolean }>
          workspacePath: string
        }>((resolve) => {
          resolveScan = resolve
        })
    )
    installWorkspaceApi({ loadFromDisk }, "win32")

    const first = loadWorkspaceFilesDeduped("thread-win-a", "C:\\Repo\\")
    const second = loadWorkspaceFilesDeduped("thread-win-b", "c:/repo")
    expect(second).toBe(first)
    expect(loadFromDisk).toHaveBeenCalledTimes(1)

    resolveScan({
      success: true,
      files: [{ path: "/shared.ts", is_dir: false }],
      workspacePath: "c:/repo"
    })
    const result = await first
    const cached = await loadWorkspaceFilesDeduped("thread-win-c", "C:/REPO/")
    expect(cached).toBe(result)
    expect(loadFromDisk).toHaveBeenCalledTimes(1)
    markWorkspaceFilesStale("thread-win-a", "c:/repo")
  })

  it("publishes an empty directory as a successful loaded snapshot", async () => {
    installWorkspaceApi({
      loadFromDisk: vi.fn().mockResolvedValue({
        success: true,
        files: [],
        workspacePath: "C:/empty"
      })
    })

    const result = await loadWorkspaceFilesDeduped("thread-empty", "C:/empty")

    expect(result).toMatchObject({ success: true, files: [], workspacePath: "C:/empty" })
  })

  it("does not cache a response for a different workspace path", async () => {
    const loadFromDisk = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        files: [{ path: "/old.ts", is_dir: false }],
        workspacePath: "C:/old"
      })
      .mockResolvedValueOnce({
        success: true,
        files: [{ path: "/new.ts", is_dir: false }],
        workspacePath: "C:/new"
      })
    installWorkspaceApi({ loadFromDisk })

    await loadWorkspaceFilesDeduped("thread-stale", "C:/new")
    const fresh = await loadWorkspaceFilesDeduped("thread-stale", "C:/new")

    expect(loadFromDisk).toHaveBeenCalledTimes(2)
    expect(fresh.files).toEqual([{ path: "/new.ts", is_dir: false }])
  })

  it("hydrates @file state without a Files panel and ignores a stale workspace", async () => {
    const loadFromDisk = vi
      .fn()
      .mockResolvedValueOnce({ success: false, files: [], error: "temporary failure" })
      .mockResolvedValue({
        success: true,
        files: [{ path: "/mention.ts", is_dir: false }],
        workspacePath: "C:/mentions"
      })
    installWorkspaceApi({ loadFromDisk })
    const setWorkspaceFiles = vi.fn()
    let current = true

    await expect(
      hydrateInitialWorkspaceFiles("thread-mentions", "C:/mentions", {
        signal: new AbortController().signal,
        isCurrentWorkspace: () => current,
        setWorkspaceFiles,
        retryDelayMs: 0
      })
    ).resolves.toBe(true)
    expect(loadFromDisk).toHaveBeenCalledTimes(2)
    expect(setWorkspaceFiles).toHaveBeenCalledWith([{ path: "/mention.ts", is_dir: false }])

    markWorkspaceFilesStale("thread-mentions", "C:/mentions")
    current = false
    setWorkspaceFiles.mockClear()
    await expect(
      hydrateInitialWorkspaceFiles("thread-mentions", "C:/mentions", {
        signal: new AbortController().signal,
        isCurrentWorkspace: () => current,
        setWorkspaceFiles,
        retryDelayMs: 0
      })
    ).resolves.toBe(false)
    expect(setWorkspaceFiles).not.toHaveBeenCalled()
  })

  it("times out a stuck scan and permits a later retry for the same workspace", async () => {
    vi.useFakeTimers()
    setWorkspaceFileScanTimeoutForTests(25)
    const loadFromDisk = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce({
        success: true,
        files: [{ path: "/recovered.ts", is_dir: false }],
        workspacePath: "C:/stuck"
      })
    installWorkspaceApi({ loadFromDisk })

    const stuck = loadWorkspaceFilesDeduped("thread-timeout", "C:/stuck")
    const timedOut = expect(stuck).rejects.toMatchObject({ name: "TimeoutError" })
    await vi.advanceTimersByTimeAsync(25)
    await timedOut

    const recovered = loadWorkspaceFilesDeduped("thread-timeout", "C:/stuck")
    await vi.advanceTimersByTimeAsync(1)
    await expect(recovered).resolves.toMatchObject({ success: true })
    expect(loadFromDisk).toHaveBeenCalledTimes(2)
    markWorkspaceFilesStale("thread-timeout", "C:/stuck")
  })

  it("cancels a scan whose open response arrives after the request timed out", async () => {
    vi.useFakeTimers()
    setWorkspaceFileScanTimeoutForTests(25)
    let finishOpen!: (value: {
      success: true
      scanId: string
      workspacePath: string
    }) => void
    const fileScanOpen = vi.fn(
      () =>
        new Promise<{ success: true; scanId: string; workspacePath: string }>((resolve) => {
          finishOpen = resolve
        })
    )
    const fileScanCancel = vi.fn().mockResolvedValue({ success: true })
    installWorkspaceApi({
      fileScanOpen,
      fileScanNext: vi.fn(),
      fileScanCancel
    })

    const pending = loadWorkspaceFilesDeduped("thread-late-open", "C:/late-open")
    const timedOut = expect(pending).rejects.toMatchObject({ name: "TimeoutError" })
    await vi.advanceTimersByTimeAsync(25)
    await timedOut

    finishOpen({ success: true, scanId: "late-scan", workspacePath: "C:/late-open" })
    await vi.advanceTimersByTimeAsync(0)
    expect(fileScanCancel).toHaveBeenCalledWith("late-scan")
  })

  it("does not let a stuck cancellation IPC block timeout recovery", async () => {
    vi.useFakeTimers()
    setWorkspaceFileScanTimeoutForTests(25)
    installWorkspaceApi({
      fileScanOpen: vi.fn().mockResolvedValue({
        success: true,
        scanId: "stuck-cancel-scan",
        workspacePath: "C:/stuck-cancel"
      }),
      fileScanNext: vi.fn(() => new Promise<never>(() => undefined)),
      fileScanCancel: vi.fn(() => new Promise<never>(() => undefined))
    })

    const pending = loadWorkspaceFilesDeduped("thread-stuck-cancel", "C:/stuck-cancel")
    const timedOut = expect(pending).rejects.toMatchObject({ name: "TimeoutError" })
    await vi.advanceTimersByTimeAsync(25)
    await timedOut
  })

  it("times out a stuck continuation and allows the workspace to be scanned again", async () => {
    vi.useFakeTimers()
    setWorkspaceFileScanTimeoutForTests(25)
    const fileScanOpen = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        scanId: "continuation-stuck",
        workspacePath: "C:/continuation-timeout"
      })
      .mockResolvedValueOnce({
        success: true,
        scanId: "continuation-retry",
        workspacePath: "C:/continuation-timeout"
      })
    const fileScanNext = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        files: [{ path: "/first.ts", is_dir: false }],
        done: false,
        truncated: true,
        continuation: "next-segment",
        workspacePath: "C:/continuation-timeout"
      })
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce({
        success: true,
        files: [{ path: "/recovered.ts", is_dir: false }],
        done: true,
        truncated: false,
        workspacePath: "C:/continuation-timeout"
      })
    const fileScanCancel = vi.fn().mockResolvedValue({ success: true })
    installWorkspaceApi({ fileScanOpen, fileScanNext, fileScanCancel })

    await expect(
      loadWorkspaceFilesDeduped("thread-continuation-timeout", "C:/continuation-timeout")
    ).resolves.toMatchObject({ continuationAvailable: true })

    const stuck = continueWorkspaceFilesDeduped(
      "thread-continuation-timeout",
      "C:/continuation-timeout"
    )
    const timedOut = expect(stuck).rejects.toMatchObject({ name: "TimeoutError" })
    await vi.advanceTimersByTimeAsync(25)
    await timedOut
    expect(fileScanCancel).toHaveBeenCalledWith("continuation-stuck")

    await expect(
      loadWorkspaceFilesDeduped("thread-continuation-timeout", "C:/continuation-timeout")
    ).resolves.toMatchObject({
      files: [{ path: "/recovered.ts", is_dir: false }],
      continuationAvailable: false
    })
    expect(fileScanOpen).toHaveBeenCalledTimes(2)
    markWorkspaceFilesStale("thread-continuation-timeout", "C:/continuation-timeout")
  })

  it("replays a lost 10k cursor and advances beyond the visible segment", async () => {
    const fileScanOpen = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        scanId: "scan-evicted",
        workspacePath: "C:/large-workspace"
      })
      .mockResolvedValueOnce({
        success: true,
        scanId: "scan-recovered",
        workspacePath: "C:/large-workspace"
      })
    const firstSegmentSize = 10_000
    let evictedOffset = 0
    let recoveredOffset = 0
    const fileScanNext = vi.fn(
      async (scanId: string, _threadId: string, continuation?: string) => {
        if (scanId === "scan-evicted" && continuation) {
          return {
            success: false as const,
            files: [],
            done: true,
            error: "Workspace file scan is not available"
          }
        }
        if (scanId === "scan-recovered" && continuation) {
          return {
            success: true as const,
            files: [{ path: "/after-10000.ts", is_dir: false }],
            done: true,
            truncated: false,
            workspacePath: "C:/large-workspace"
          }
        }
        const offset = scanId === "scan-evicted" ? evictedOffset : recoveredOffset
        const pageSize = Math.min(128, firstSegmentSize - offset)
        const files = Array.from({ length: pageSize }, (_, pageIndex) => ({
          path: `/file-${String(offset + pageIndex).padStart(5, "0")}.ts`,
          is_dir: false
        }))
        const nextOffset = offset + pageSize
        if (scanId === "scan-evicted") evictedOffset = nextOffset
        else recoveredOffset = nextOffset
        const truncated = nextOffset === firstSegmentSize
        return {
          success: true as const,
          files,
          done: false,
          truncated,
          ...(truncated
            ? {
                continuation:
                  scanId === "scan-evicted" ? "evicted-token" : "recovered-token"
              }
            : {}),
          workspacePath: "C:/large-workspace"
        }
      }
    )
    const fileScanCancel = vi.fn().mockResolvedValue({ success: true })
    installWorkspaceApi({ fileScanOpen, fileScanNext, fileScanCancel })

    await expect(
      loadWorkspaceFilesDeduped("thread-large", "C:/large-workspace")
    ).resolves.toMatchObject({
      files: expect.arrayContaining([{ path: "/file-09999.ts", is_dir: false }]),
      continuationAvailable: true
    })

    const recovery = resumeWorkspaceFilesDeduped("thread-large", "C:/large-workspace")
    const sharedRecovery = resumeWorkspaceFilesDeduped("thread-large", "C:/large-workspace")
    expect(sharedRecovery).toBe(recovery)
    const recovered = await recovery
    expect(recovered.files).toHaveLength(firstSegmentSize + 1)
    expect(recovered.files.at(-1)?.path).toBe("/after-10000.ts")
    expect(recovered.continuationAvailable).toBe(false)
    expect(fileScanOpen).toHaveBeenCalledTimes(2)
    expect(fileScanNext).toHaveBeenCalledTimes(Math.ceil(firstSegmentSize / 128) * 2 + 2)
    expect(fileScanCancel).toHaveBeenCalledWith("scan-evicted")
    markWorkspaceFilesStale("thread-large", "C:/large-workspace")
  })
})
