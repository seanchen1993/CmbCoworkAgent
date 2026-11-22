import { mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const storage = vi.hoisted(() => ({ path: "", configurationAvailable: true }))
vi.mock("../storage", () => ({ getOpenworkDir: () => storage.path }))
vi.mock("../harness-board/config-v2", () => ({
  assertHarnessConfigAvailable() {
    if (!storage.configurationAvailable) throw new Error("project configuration unavailable")
  }
}))

const project = {
  projectId: "project-a",
  name: "Project A",
  "harness-adapter": { id: "fixture", name: "Fixture", type: "plugin" }
}

async function replaceRegistry(value: unknown): Promise<void> {
  const path = join(storage.path, "harness-board-projects.json")
  await writeFile(path + ".tmp", JSON.stringify(value))
  await rename(path + ".tmp", path)
}

beforeEach(async () => {
  vi.resetModules()
  storage.configurationAvailable = true
  storage.path = await mkdtemp(join(tmpdir(), "project-search-catalog-"))
})

afterEach(async () => {
  await rm(storage.path, { force: true, recursive: true })
})

describe("project search authority", () => {
  it("revokes an intact loaded registry when the Board configuration is unavailable", async () => {
    await replaceRegistry({ projects: [project] })
    const { readProjectSearchCatalog, isCurrentProjectSearchCatalog } = await import("./project-catalog")
    const first = await readProjectSearchCatalog()
    expect(first?.projects.has(project.projectId)).toBe(true)
    storage.configurationAvailable = false
    expect(await isCurrentProjectSearchCatalog(first!.generation)).toBe(false)
    expect(await readProjectSearchCatalog()).toBeNull()
    storage.configurationAvailable = true
    expect((await readProjectSearchCatalog())?.generation).not.toBe(first!.generation)
  })

  it("distinguishes an empty directory from missing, corrupt and ambiguous data", async () => {
    const { readProjectSearchCatalog } = await import("./project-catalog")
    expect(await readProjectSearchCatalog()).toBeNull()
    await replaceRegistry({ projects: [] })
    expect((await readProjectSearchCatalog())?.projects.size).toBe(0)
    await replaceRegistry({ projects: [project, project] })
    expect(await readProjectSearchCatalog()).toBeNull()
    await writeFile(join(storage.path, "harness-board-projects.json"), '{"projects":[')
    expect(await readProjectSearchCatalog()).toBeNull()
  })

  it("uses projects beyond catalog UI pages and tracks only current full Feature observations", async () => {
    await replaceRegistry({
      projects: [
        ...Array.from({ length: 70 }, (_, index) => ({
          ...project,
          projectId: "unrelated-" + index
        })),
        project
      ]
    })
    const { readProjectSearchCatalog, isCurrentProjectSearchCatalog } =
      await import("./project-catalog")
    const { beginHarnessFeatureCatalogRead } =
      await import("../harness-board/feature-catalog-lifecycle")
    const unknown = await readProjectSearchCatalog()
    expect(unknown?.projects.get(project.projectId)?.features).toBeUndefined()
    const slow = beginHarnessFeatureCatalogRead([project.projectId])
    const fresh = beginHarnessFeatureCatalogRead([project.projectId])
    fresh.observed(project.projectId, [{ slug: "available" }])
    fresh.finish()
    slow.observed(project.projectId, [{ slug: "old" }])
    slow.finish()
    const observed = await readProjectSearchCatalog()
    expect(observed?.projects.get(project.projectId)?.features).toEqual(new Set(["available"]))
    expect(await isCurrentProjectSearchCatalog(unknown!.generation)).toBe(false)
  })

  it("keeps an issued route eligible after harmless observations but rejects removed Features", async () => {
    await replaceRegistry({ projects: [project] })
    const { readProjectSearchCatalog, isProjectSearchRouteCurrent } = await import("./project-catalog")
    const { beginHarnessFeatureCatalogRead } = await import("../harness-board/feature-catalog-lifecycle")
    const route = { kind: "projectSession", projectId: project.projectId } as const
    const feature = { ...route, kind: "featureSession", slug: "current" } as const
    const initial = (await readProjectSearchCatalog())!.generation
    const first = beginHarnessFeatureCatalogRead([project.projectId])
    first.observed(project.projectId, [{ slug: feature.slug }])
    first.finish()
    const known = (await readProjectSearchCatalog())!.generation
    expect(isProjectSearchRouteCurrent(initial, route)).toBe(true)
    expect(isProjectSearchRouteCurrent(known, feature)).toBe(true)
    const next = beginHarnessFeatureCatalogRead([project.projectId])
    next.observed(project.projectId, [])
    next.finish()
    expect(isProjectSearchRouteCurrent(known, feature)).toBe(false)
    const rebuilt = beginHarnessFeatureCatalogRead([project.projectId])
    rebuilt.observed(project.projectId, [{ slug: feature.slug }])
    rebuilt.finish()
    const recreated = (await readProjectSearchCatalog())!.generation
    expect(isProjectSearchRouteCurrent(known, feature)).toBe(false)
    expect(isProjectSearchRouteCurrent(recreated, feature)).toBe(true)
    expect(isProjectSearchRouteCurrent(known, route)).toBe(true)
    await replaceRegistry({ projects: [] })
    expect(isProjectSearchRouteCurrent(known, route)).toBe(false)
  })

  it("rejects observations started before a project registry replacement", async () => {
    await replaceRegistry({ projects: [project] })
    const { readProjectSearchCatalog, isCurrentProjectSearchCatalog } =
      await import("./project-catalog")
    const { beginHarnessFeatureCatalogRead } =
      await import("../harness-board/feature-catalog-lifecycle")
    const original = await readProjectSearchCatalog()
    const removed = beginHarnessFeatureCatalogRead([project.projectId])
    await replaceRegistry({ projects: [{ ...project, name: "Recreated" }] })
    removed.observed(project.projectId, [{ slug: "old" }])
    removed.finish()
    expect(await isCurrentProjectSearchCatalog(original!.generation)).toBe(false)
    expect((await readProjectSearchCatalog())?.projects.get(project.projectId)).toEqual({
      label: "Recreated"
    })
  })
})
