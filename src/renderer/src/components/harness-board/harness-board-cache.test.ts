import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  HarnessAdapterRegistryItem,
  HarnessProjectDetailViewModel,
  HarnessProjectListItem
} from "@/types"
import {
  HARNESS_PROJECT_DETAIL_BATCH_SIZE,
  MAX_HARNESS_PROJECT_DETAIL_CACHE_ENTRIES,
  cacheHarnessBoardCatalog,
  cacheHarnessProjectDetails,
  loadHarnessProjectDetailsCached,
  mergeBoundedHarnessRecord,
  readHarnessBoardCatalogCache,
  readHarnessProjectDetailCache,
  resetHarnessBoardCacheForTests,
  revalidateHarnessBoardCatalog,
  takeHarnessProjectDetailBatch
} from "./harness-board-cache"

function project(projectId: string): HarnessProjectListItem {
  return { projectId } as HarnessProjectListItem
}

function registry(id: string): HarnessAdapterRegistryItem {
  return { id } as HarnessAdapterRegistryItem
}

function detail(projectId: string): HarnessProjectDetailViewModel {
  return { project: { projectId } } as HarnessProjectDetailViewModel
}

describe("harness board cache", () => {
  beforeEach(() => resetHarnessBoardCacheForTests())

  it("serves a stale catalog while one shared revalidation is in flight", async () => {
    cacheHarnessBoardCatalog([project("stale")], [registry("stale")], 1)
    let resolveLoad!: (value: {
      projects: HarnessProjectListItem[]
      registry: HarnessAdapterRegistryItem[]
    }) => void
    const loader = vi.fn(
      () =>
        new Promise<{
          projects: HarnessProjectListItem[]
          registry: HarnessAdapterRegistryItem[]
        }>((resolve) => {
          resolveLoad = resolve
        })
    )

    const first = revalidateHarnessBoardCatalog("plugin-1", loader)
    const second = revalidateHarnessBoardCatalog("plugin-1", loader)

    expect(readHarnessBoardCatalogCache()?.projects[0]?.projectId).toBe("stale")
    expect(loader).toHaveBeenCalledTimes(1)
    resolveLoad({ projects: [project("fresh")], registry: [registry("fresh")] })
    await expect(first).resolves.toMatchObject({ projects: [{ projectId: "fresh" }] })
    await expect(second).resolves.toMatchObject({ registry: [{ id: "fresh" }] })
  })

  it("keeps project details bounded by LRU recency for large catalogs", () => {
    const details: Record<string, HarnessProjectDetailViewModel> = {}
    for (let index = 0; index < 500; index += 1) {
      details[`project-${index}`] = detail(`project-${index}`)
    }
    cacheHarnessProjectDetails(details)

    const cached = readHarnessProjectDetailCache()
    expect(Object.keys(cached)).toHaveLength(MAX_HARNESS_PROJECT_DETAIL_CACHE_ENTRIES)
    expect(cached["project-0"]).toBeUndefined()
    expect(cached["project-499"]).toBeDefined()
  })

  it("bounds component projection state while touching recent entries", () => {
    let state: Record<string, { revision: number }> = {}
    for (let index = 0; index < 200; index += 1) {
      state = mergeBoundedHarnessRecord(
        state,
        [[`project-${index}`, { revision: index }]],
        MAX_HARNESS_PROJECT_DETAIL_CACHE_ENTRIES
      )
    }

    expect(Object.keys(state)).toHaveLength(MAX_HARNESS_PROJECT_DETAIL_CACHE_ENTRIES)
    expect(state["project-0"]).toBeUndefined()
    expect(state["project-199"]).toEqual({ revision: 199 })
  })

  it("deduplicates overlapping detail loads across rapid remounts", async () => {
    let resolveLoad!: (value: Record<string, HarnessProjectDetailViewModel>) => void
    const loader = vi.fn(
      () =>
        new Promise<Record<string, HarnessProjectDetailViewModel>>((resolve) => {
          resolveLoad = resolve
        })
    )

    const first = loadHarnessProjectDetailsCached(["a", "b"], loader)
    const second = loadHarnessProjectDetailsCached(["b"], loader)
    expect(loader).toHaveBeenCalledTimes(1)
    resolveLoad({ a: detail("a"), b: detail("b") })

    await expect(first).resolves.toMatchObject({ a: { project: { projectId: "a" } } })
    await expect(second).resolves.toMatchObject({ b: { project: { projectId: "b" } } })
  })

  it("drains visible projects first and never exceeds the production batch size", () => {
    const priority = new Set(["visible-1", "visible-2"])
    const background = new Set(
      Array.from({ length: 500 }, (_, index) => `project-${index}`)
    )
    const seen = new Set<string>()
    const batches: string[][] = []

    while (priority.size > 0 || background.size > 0) {
      const batch = takeHarnessProjectDetailBatch(
        priority,
        background,
        seen,
        HARNESS_PROJECT_DETAIL_BATCH_SIZE
      )
      if (batch.length === 0) break
      batches.push(batch)
      for (const projectId of batch) seen.add(projectId)
    }

    expect(batches[0]?.slice(0, 2)).toEqual(["visible-1", "visible-2"])
    expect(Math.max(...batches.map((batch) => batch.length))).toBe(
      HARNESS_PROJECT_DETAIL_BATCH_SIZE
    )
    expect(seen).toHaveLength(502)
  })

  it("uses a bounded catalog page and does not enqueue the complete project list", () => {
    const source = readFileSync(new URL("./HarnessBoardView.tsx", import.meta.url), "utf8")
    expect(source).toContain("window.api.harnessBoard.catalogPage({")
    expect(source).toContain("const PROJECT_CATALOG_PAGE_SIZE = 24")
    expect(source).not.toContain("queueProjectDetails(items.map")
    expect(source).not.toContain("queueProjectDetails(Object.keys(cachedDetails)")
    expect(source).not.toContain("function areHarnessValuesEqual")
    expect(HARNESS_PROJECT_DETAIL_BATCH_SIZE).toBeLessThanOrEqual(8)
  })
})
