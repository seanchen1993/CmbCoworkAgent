import { describe, expect, it } from "vitest"
import {
  appendWorkspaceFileTreeProjectionPage,
  createWorkspaceFileTreeProjectionBuilder,
  finalizeWorkspaceFileTreeProjection,
  getWorkspaceFileTreeProjection,
  patchWorkspaceFileTreeProjection
} from "./workspace-file-tree-projection"

describe("workspace file tree projection", () => {
  it("projects all 50k root files in bounded batches while the event loop keeps ticking", async () => {
    const files = Array.from({ length: 50_000 }, (_, index) => ({
      path: `/file-${String(index).padStart(5, "0")}.ts`,
      is_dir: false,
      size: index
    }))
    const projection = createWorkspaceFileTreeProjectionBuilder(true)
    let ticks = 0
    let maxTickGapMs = 0
    let lastTickAt = performance.now()
    const ticker = setInterval(() => {
      ticks += 1
      const now = performance.now()
      maxTickGapMs = Math.max(maxTickGapMs, now - lastTickAt)
      lastTickAt = now
    }, 1)
    for (let offset = 0; offset < files.length; offset += 128) {
      appendWorkspaceFileTreeProjectionPage(projection, files.slice(offset, offset + 128))
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await finalizeWorkspaceFileTreeProjection(files, projection)
    clearInterval(ticker)

    expect(projection.tree).toHaveLength(50_000)
    expect(projection.tree[0]?.path).toBe("/file-00000.ts")
    expect(projection.tree.at(-1)?.path).toBe("/file-49999.ts")
    expect(getWorkspaceFileTreeProjection(files)).toBe(projection)
    expect(ticks).toBeGreaterThan(10)
    expect(maxTickGapMs).toBeLessThan(30)
  })

  it("sorts 50k root directories without scheduling one event-loop turn per directory", async () => {
    const files = Array.from({ length: 50_000 }, (_, index) => ({
      path: `/directory-${String(49_999 - index).padStart(5, "0")}`,
      is_dir: true
    }))
    const projection = createWorkspaceFileTreeProjectionBuilder(false)
    for (let offset = 0; offset < files.length; offset += 128) {
      appendWorkspaceFileTreeProjectionPage(projection, files.slice(offset, offset + 128))
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    let ticks = 0
    let maxTickGapMs = 0
    let lastTickAt = performance.now()
    const ticker = setInterval(() => {
      ticks += 1
      const now = performance.now()
      maxTickGapMs = Math.max(maxTickGapMs, now - lastTickAt)
      lastTickAt = now
    }, 1)
    const startedAt = performance.now()
    await finalizeWorkspaceFileTreeProjection(files, projection)
    const durationMs = performance.now() - startedAt
    clearInterval(ticker)

    expect(projection.tree).toHaveLength(50_000)
    expect(projection.tree[0]?.path).toBe("/directory-00000")
    expect(ticks).toBeGreaterThan(10)
    expect(maxTickGapMs).toBeLessThan(30)
    expect(durationMs).toBeLessThan(3_000)
  })

  it("keeps directory ordering and patches one structural generation without rebuilding", async () => {
    const files = [
      { path: "/src", is_dir: true },
      { path: "/src/a.ts", is_dir: false, size: 1 },
      { path: "/z.txt", is_dir: false, size: 2 }
    ]
    const projection = createWorkspaceFileTreeProjectionBuilder(true)
    appendWorkspaceFileTreeProjectionPage(projection, files)
    await finalizeWorkspaceFileTreeProjection(files, projection)
    const nextFiles = [files[0], files[1], { path: "/b.txt", is_dir: false, size: 3 }]
    patchWorkspaceFileTreeProjection(
      files,
      nextFiles,
      [{ path: "/b.txt", is_dir: false, size: 3 }],
      ["/z.txt"]
    )

    expect(getWorkspaceFileTreeProjection(nextFiles)).toBe(projection)
    expect(projection.tree.map((node) => node.path)).toEqual(["/src", "/b.txt"])
    expect(projection.tree[0]?.children.map((node) => node.path)).toEqual(["/src/a.ts"])
  })
})
