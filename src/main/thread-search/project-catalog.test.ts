import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
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
    await fresh.observed(project.projectId, [{ slug: "available" }])
    fresh.finish()
    await slow.observed(project.projectId, [{ slug: "old" }])
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
    expect(isProjectSearchRouteCurrent(initial, feature)).toBe(true)
    const first = beginHarnessFeatureCatalogRead([project.projectId])
    await first.observed(project.projectId, [{ slug: feature.slug }])
    first.finish()
    const known = (await readProjectSearchCatalog())!.generation
    expect(isProjectSearchRouteCurrent(initial, route)).toBe(true)
    expect(isProjectSearchRouteCurrent(known, feature)).toBe(true)
    const next = beginHarnessFeatureCatalogRead([project.projectId])
    await next.observed(project.projectId, [])
    next.finish()
    expect(isProjectSearchRouteCurrent(known, feature)).toBe(false)
    expect(isProjectSearchRouteCurrent(initial, feature)).toBe(false)
    const rebuilt = beginHarnessFeatureCatalogRead([project.projectId])
    await rebuilt.observed(project.projectId, [{ slug: feature.slug }])
    rebuilt.finish()
    const recreated = (await readProjectSearchCatalog())!.generation
    expect(isProjectSearchRouteCurrent(known, feature)).toBe(false)
    expect(isProjectSearchRouteCurrent(recreated, feature)).toBe(true)
    expect(isProjectSearchRouteCurrent(known, route)).toBe(true)
    await replaceRegistry({ projects: [] })
    expect(isProjectSearchRouteCurrent(known, route)).toBe(false)
  })

  it("authorizes only read-only history without Feature evidence and after directory loss", async () => {
    const path = join(storage.path, "workspace-project")
    await mkdir(path)
    await replaceRegistry({
      projects: [{
        ...project, workspace: { path: storage.path }, projectCode: "workspace-project"
      }]
    })
    const { readProjectSearchCatalog, readProjectSearchNavigationAccess } = await import("./project-catalog")
    const { beginHarnessFeatureCatalogRead } = await import("../harness-board/feature-catalog-lifecycle")
    const route = { kind: "projectSession", projectId: project.projectId } as const
    const feature = { ...route, kind: "featureSession", slug: "unseen" } as const
    const unknown = (await readProjectSearchCatalog())!.generation
    await expect(readProjectSearchNavigationAccess(unknown, route)).resolves.toBe("live")
    await expect(readProjectSearchNavigationAccess(unknown, feature)).resolves.toBe("history")
    const observed = beginHarnessFeatureCatalogRead([project.projectId])
    await observed.observed(project.projectId, [{ slug: feature.slug }])
    observed.finish()
    const known = (await readProjectSearchCatalog())!.generation
    await expect(readProjectSearchNavigationAccess(known, feature)).resolves.toBe("live")
    await rename(path, path + "-moved")
    await writeFile(path, "not a directory")
    await expect(readProjectSearchNavigationAccess(known, route)).resolves.toBe("history")
    await expect(readProjectSearchNavigationAccess(known, feature)).resolves.toBe("history")
    const removed = beginHarnessFeatureCatalogRead([project.projectId])
    await removed.observed(project.projectId, [])
    removed.finish()
    const withoutFeature = (await readProjectSearchCatalog())!.generation
    await expect(readProjectSearchNavigationAccess(withoutFeature, feature)).resolves.toBeNull()
    await replaceRegistry({ projects: [] })
    await expect(readProjectSearchNavigationAccess(withoutFeature, route)).resolves.toBeNull()
  })

  it("preserves unobserved history across other projects and rejects lost local evidence", async () => {
    const otherProject = { ...project, projectId: "other-project" }
    await replaceRegistry({ projects: [project, otherProject] })
    const { readProjectSearchCatalog, readProjectSearchNavigationAccess } = await import("./project-catalog")
    const { beginHarnessFeatureCatalogRead } = await import("../harness-board/feature-catalog-lifecycle")
    const feature = { kind: "featureSession", projectId: project.projectId, slug: "old" } as const
    const unknown = (await readProjectSearchCatalog())!.generation
    const other = beginHarnessFeatureCatalogRead([otherProject.projectId])
    await other.observed(otherProject.projectId, [{ slug: "unrelated" }])
    other.finish()
    await expect(readProjectSearchNavigationAccess(unknown, feature)).resolves.toBe("history")

    const local = beginHarnessFeatureCatalogRead([project.projectId])
    await local.observed(project.projectId, [{ slug: "x".repeat(4097) }])
    local.finish()
    const refused = (await readProjectSearchCatalog())!
    expect(refused.projects.get(project.projectId)?.features).toBeNull()
    await expect(readProjectSearchNavigationAccess(unknown, feature)).resolves.toBeNull()
    await expect(readProjectSearchNavigationAccess(refused.generation, feature)).resolves.toBeNull()
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
    await removed.observed(project.projectId, [{ slug: "old" }])
    removed.finish()
    expect(await isCurrentProjectSearchCatalog(original!.generation)).toBe(false)
    expect((await readProjectSearchCatalog())?.projects.get(project.projectId)).toEqual({
      label: "Recreated"
    })
  })

  it("retains exclusions across compatible registry edits and restart without granting live access", async () => {
    const original = {
      ...project, workspacePath: storage.path, projectDir: "present",
      lifecycle: { status: "active" }
    }
    const other = { ...original, projectId: "other" }
    await mkdir(join(storage.path, original.projectDir))
    await replaceRegistry({ projects: [original, other] })
    const catalog = await import("./project-catalog")
    const { beginHarnessFeatureCatalogRead } = await import("../harness-board/feature-catalog-lifecycle")
    const read = beginHarnessFeatureCatalogRead([project.projectId])
    await read.observed(project.projectId, [{ slug: "wanted" }])
    read.finish()
    const before = (await catalog.readProjectSearchCatalog())!
    const wanted = { kind: "featureSession", projectId: project.projectId, slug: "wanted" } as const
    const excluded = { ...wanted, slug: "excluded" }
    await expect(catalog.readProjectSearchNavigationAccess(before.generation, wanted)).resolves.toBe("live")

    const normalized = { ...original, lifecycle: { status: "active", createAt: "new stamp" } }
    await replaceRegistry({ projects: [normalized, { ...other, name: "Renamed" }] })
    const after = (await catalog.readProjectSearchCatalog())!
    expect(after.projects.get(project.projectId)?.features).toEqual(new Set(["wanted"]))
    await expect(catalog.readProjectSearchNavigationAccess(before.generation, wanted)).resolves.toBeNull()
    await expect(catalog.readProjectSearchNavigationAccess(after.generation, excluded)).resolves.toBeNull()

    vi.resetModules()
    const restarted = await import("./project-catalog")
    const recovered = (await restarted.readProjectSearchCatalog())!
    await expect(restarted.readProjectSearchNavigationAccess(recovered.generation, wanted))
      .resolves.toBe("history")
    await expect(restarted.readProjectSearchNavigationAccess(recovered.generation, excluded))
      .resolves.toBeNull()

    await replaceRegistry({ projects: [{
      ...normalized, projectId: "new-registration"
    }] })
    const replacement = (await restarted.readProjectSearchCatalog())!
    expect(replacement.projects.has(project.projectId)).toBe(false)
    expect(replacement.projects.get("new-registration")?.features).toBeUndefined()
    await expect(restarted.readProjectSearchNavigationAccess(recovered.generation, wanted))
      .resolves.toBeNull()
  })

  it("fails closed for unreadable evidence and recovers a restored file after the cooldown", async () => {
    await replaceRegistry({ projects: [project] })
    const evidencePath = join(storage.path, "thread-search-feature-evidence.json")
    await writeFile(evidencePath, "")
    const {
      readProjectSearchCatalog, readProjectSearchNavigationAccess, onProjectSearchCatalogChange
    } = await import("./project-catalog")
    let now = Date.now()
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
    const catalog = (await readProjectSearchCatalog())!
    expect(catalog.projects.get(project.projectId)?.features).toBeNull()
    const route = { projectId: project.projectId } as const
    await expect(readProjectSearchNavigationAccess(catalog.generation, {
      ...route, kind: "featureSession", slug: "unknown"
    })).resolves.toBeNull()
    await expect(readProjectSearchNavigationAccess(catalog.generation, {
      ...route, kind: "projectSession"
    })).resolves.toBe("history")
    const invalidated = vi.fn()
    const stop = onProjectSearchCatalogChange(invalidated)
    try {
      const id = createHash("sha256").update(project.projectId).digest("hex")
      await rm(evidencePath)
      now += 2_001
      expect((await readProjectSearchCatalog())!.projects.get(project.projectId)?.features).toBeNull()
      expect(invalidated).not.toHaveBeenCalled()
      await writeFile(evidencePath, JSON.stringify([[id, ["known"]]]))
      const waiting = (await readProjectSearchCatalog())!
      expect(waiting.generation).toBe(catalog.generation)
      expect(waiting.projects.get(project.projectId)?.features).toBeNull()
      now += 2_001
      const recovered = (await readProjectSearchCatalog())!
      expect(recovered.generation).not.toBe(catalog.generation)
      expect(invalidated).toHaveBeenCalledTimes(1)
      await expect(readProjectSearchNavigationAccess(recovered.generation, {
        ...route, kind: "featureSession", slug: "known"
      })).resolves.toBe("history")
      await expect(readProjectSearchNavigationAccess(recovered.generation, {
        ...route, kind: "featureSession", slug: "excluded"
      })).resolves.toBeNull()
    } finally {
      stop()
      clock.mockRestore()
    }
  })

  it("retains observations received during an evidence outage ahead of the restored snapshot", async () => {
    await replaceRegistry({ projects: [project] })
    const evidencePath = join(storage.path, "thread-search-feature-evidence.json")
    await writeFile(evidencePath, "invalid JSON")
    const { readProjectSearchCatalog } = await import("./project-catalog")
    const { beginHarnessFeatureCatalogRead } = await import("../harness-board/feature-catalog-lifecycle")
    let now = Date.now()
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      const read = beginHarnessFeatureCatalogRead([project.projectId])
      await read.observed(project.projectId, [])
      read.finish()
      const id = createHash("sha256").update(project.projectId).digest("hex")
      await writeFile(evidencePath, JSON.stringify([[id, ["obsolete"]]]))
      now += 2_001
      expect((await readProjectSearchCatalog())?.projects.get(project.projectId)?.features)
        .toEqual(new Set())
      await vi.waitFor(async () => {
        expect(JSON.parse(await readFile(evidencePath, "utf8"))).toEqual([[id, []]])
      })
    } finally {
      clock.mockRestore()
    }
  })
})
