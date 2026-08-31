import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MarketItem } from "@/api/market"
import type { PluginMetadata, SkillMetadata } from "@/types"
import {
  configureAppCatalogLoaders,
  ensureDisabledSkillsChangedInvalidationSource,
  ensureSkillsChangedInvalidationSource,
  ensureWorkspaceHooksChangedInvalidationSource,
  getGlobalHookCatalogRevision,
  getPluginCatalogRevision,
  getSkillCatalogRevision,
  getWorkspaceHookCatalogRevision,
  invalidateSkillCatalog,
  projectChatSkillCatalog,
  readPluginCatalogCache,
  readSkillCatalogCache,
  resetAppCatalogCacheForTests,
  revalidateGlobalHookCatalog,
  revalidateMarketSkillCatalog,
  revalidatePluginCatalog,
  revalidateSkillCatalog,
  subscribeGlobalHookCatalogInvalidation,
  subscribePluginCatalogInvalidation,
  subscribeSkillCatalogInvalidation,
  subscribeWorkspaceHookCatalogInvalidation
} from "./app-catalog-cache"

function skill(
  name: string,
  options: Partial<SkillMetadata> = {}
): SkillMetadata {
  return {
    id: options.id ?? name,
    name,
    description: options.description ?? name,
    path: options.path ?? `C:/skills/${name}/SKILL.md`,
    source: options.source ?? "user",
    version: options.version ?? "1.0.0",
    ...options
  }
}

function plugin(id: string): PluginMetadata {
  return {
    id,
    name: id,
    version: "1.0.0",
    description: id,
    author: "test",
    path: `C:/plugins/${id}`,
    enabled: true,
    skillCount: 1,
    mcpServerCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  }
}

function marketSkill(name: string): MarketItem {
  return {
    name,
    chinese_name: `中文-${name}`,
    description: name,
    filename: `${name}.zip`,
    created_at: "2026-01-01T00:00:00.000Z"
  }
}

function expectCatalogRevision(
  value: string,
  version: string | number,
  revision: number
): void {
  expect(value).toMatch(new RegExp(`^${String(version)}:[^:]+:${revision}$`))
}

describe("application catalog cache", () => {
  beforeEach(() => resetAppCatalogCacheForTests())

  it("dedupes rapid remount reads and keeps the same-version snapshot stable", async () => {
    const loader = vi.fn(async () => ({
      localSkills: [skill("local")],
      pluginSkills: [skill("plugin", { pluginId: "plugin-a", pluginName: "A" })],
      disabledSkillIds: []
    }))

    const [first, second] = await Promise.all([
      revalidateSkillCatalog(7, loader),
      revalidateSkillCatalog(7, loader)
    ])
    const remount = await revalidateSkillCatalog(7, loader)

    expect(loader).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
    expect(remount).toBe(first)
    expect(readSkillCatalogCache()).toBe(first)
  })

  it("keeps a same-name plugin skill in the enabled right-panel summary", async () => {
    const snapshot = await revalidateSkillCatalog("same-name", async () => ({
      localSkills: [skill("review")],
      pluginSkills: [
        skill("review", {
          id: "plugin:plugin-a/review",
          path: "C:/plugins/plugin-a/skills/review/SKILL.md",
          pluginId: "plugin-a",
          pluginName: "Plugin A"
        })
      ],
      disabledSkillIds: ["review"],
      total: 2,
      enabledSkillCount: 1,
      truncated: false,
      truncatedReasons: []
    }))

    expect(snapshot.rightPanelSkills).toHaveLength(2)
    expect(snapshot.total).toBe(snapshot.rightPanelSkills.length)
    expect(snapshot.rightPanelEnabledSkillCount).toBe(1)
    expect(snapshot.disabledSkillIds).toEqual(new Set(["review"]))
  })

  it("routes App and Chat callers through one configured page loader", async () => {
    const configuredLoader = vi.fn(async () => ({
      localSkills: [skill("shared")],
      pluginSkills: [],
      disabledSkillIds: []
    }))
    const legacyLoader = vi.fn(async () => ({
      localSkills: [skill("legacy")],
      pluginSkills: [],
      disabledSkillIds: []
    }))
    configureAppCatalogLoaders({
      skills: configuredLoader,
      plugins: async () => []
    })

    const [appSnapshot, chatSnapshot] = await Promise.all([
      revalidateSkillCatalog("shared", legacyLoader),
      revalidateSkillCatalog("shared", legacyLoader)
    ])

    expect(configuredLoader).toHaveBeenCalledTimes(1)
    expect(legacyLoader).not.toHaveBeenCalled()
    expect(chatSnapshot).toBe(appSnapshot)
  })

  it("marks an invalidated configured pagination load stale before it can supersede refresh", async () => {
    let releaseStaleLoad = (): void => undefined
    const generationChecks: Array<() => boolean> = []
    const staleGate = new Promise<void>((resolve) => {
      releaseStaleLoad = resolve
    })
    const configuredLoader = vi.fn(
      async (_key: string, isCurrent: () => boolean) => {
        if (configuredLoader.mock.calls.length === 1) {
          generationChecks.push(isCurrent)
          await staleGate
          if (!isCurrent()) throw new Error("Catalog request superseded")
          return { localSkills: [skill("stale")], pluginSkills: [], disabledSkillIds: [] }
        }
        return { localSkills: [skill("fresh")], pluginSkills: [], disabledSkillIds: [] }
      }
    )
    configureAppCatalogLoaders({ skills: configuredLoader, plugins: async () => [] })

    const stale = revalidateSkillCatalog("race").catch((error) => error)
    await vi.waitFor(() => expect(generationChecks).toHaveLength(1))
    invalidateSkillCatalog()
    expect(generationChecks[0]()).toBe(false)
    const fresh = revalidateSkillCatalog("race")
    releaseStaleLoad()

    await expect(stale).resolves.toEqual(expect.objectContaining({
      message: "Catalog request superseded"
    }))
    await expect(fresh).resolves.toMatchObject({
      rightPanelSkills: [expect.objectContaining({ name: "fresh" })]
    })
    expect(readSkillCatalogCache()?.rightPanelSkills[0]?.name).toBe("fresh")
  })

  it("installs one skills:changed source and shares the invalidated refresh", async () => {
    let emitChanged = (): void => {
      throw new Error("skills source was not installed")
    }
    let emitHooksChanged = (payload: { reason?: string }): void => {
      throw new Error(`hooks source was not installed: ${payload.reason ?? "unknown"}`)
    }
    const sourceSubscribe = vi.fn((listener: () => void) => {
      emitChanged = listener
      return vi.fn()
    })
    const observed = vi.fn()
    const hooksObserved = vi.fn()
    const hooksSourceSubscribe = vi.fn((listener: (payload: { reason?: string }) => void) => {
      emitHooksChanged = listener
      return vi.fn()
    })
    const unsubscribe = subscribeSkillCatalogInvalidation(observed)
    const unsubscribeHooks = subscribeGlobalHookCatalogInvalidation(hooksObserved)
    ensureSkillsChangedInvalidationSource(sourceSubscribe)
    ensureSkillsChangedInvalidationSource(sourceSubscribe)
    ensureDisabledSkillsChangedInvalidationSource(hooksSourceSubscribe)
    ensureDisabledSkillsChangedInvalidationSource(hooksSourceSubscribe)

    const loader = vi.fn(async () => ({
      localSkills: [skill(`local-${loader.mock.calls.length}`)],
      pluginSkills: [],
      disabledSkillIds: []
    }))
    const initial = await revalidateSkillCatalog(1, loader)
    const hookLoader = vi.fn(async () => ({
      globalHooks: [],
      pluginHooks: [],
      skillHooks: []
    }))
    const hooksInitial = await revalidateGlobalHookCatalog(1, hookLoader)
    expect(await revalidateGlobalHookCatalog(1, hookLoader)).toBe(hooksInitial)
    expectCatalogRevision(getSkillCatalogRevision(1), 1, 0)
    expect(getGlobalHookCatalogRevision()).toBe(0)
    emitChanged()
    const [left, right] = await Promise.all([
      revalidateSkillCatalog(1, loader),
      revalidateSkillCatalog(1, loader)
    ])

    expect(sourceSubscribe).toHaveBeenCalledTimes(1)
    expect(hooksSourceSubscribe).toHaveBeenCalledTimes(1)
    expect(observed).toHaveBeenCalledTimes(1)
    expect(loader).toHaveBeenCalledTimes(2)
    expect(left).toBe(right)
    expect(left).not.toBe(initial)
    expectCatalogRevision(getSkillCatalogRevision(1), 1, 1)

    emitHooksChanged({ reason: "ordinary-hook-edit" })
    expect(observed).toHaveBeenCalledTimes(1)
    expect(hooksObserved).toHaveBeenCalledTimes(1)
    expect(getGlobalHookCatalogRevision()).toBe(1)
    await Promise.all([
      revalidateGlobalHookCatalog(1, hookLoader),
      revalidateGlobalHookCatalog(1, hookLoader)
    ])
    expect(hookLoader).toHaveBeenCalledTimes(2)
    emitHooksChanged({ reason: "skills-disabled-changed" })
    expect(observed).toHaveBeenCalledTimes(2)
    expect(hooksObserved).toHaveBeenCalledTimes(2)
    expect(getGlobalHookCatalogRevision()).toBe(2)
    unsubscribe()
    unsubscribeHooks()
  })

  it("advances skill and plugin revisions for external and cross-window catalog changes", async () => {
    let emitHooksChanged = (payload: { reason?: string }): void => {
      throw new Error(`hooks source was not installed: ${payload.reason ?? "unknown"}`)
    }
    ensureDisabledSkillsChangedInvalidationSource((listener) => {
      emitHooksChanged = listener
      return vi.fn()
    })
    const skillsObserved = vi.fn()
    const pluginsObserved = vi.fn()
    const unsubscribeSkills = subscribeSkillCatalogInvalidation(skillsObserved)
    const unsubscribePlugins = subscribePluginCatalogInvalidation(pluginsObserved)

    expectCatalogRevision(getSkillCatalogRevision(4), 4, 0)
    expectCatalogRevision(getPluginCatalogRevision(4), 4, 0)

    emitHooksChanged({ reason: "skill-hook-file-changed" })
    expectCatalogRevision(getSkillCatalogRevision(4), 4, 1)
    expectCatalogRevision(getPluginCatalogRevision(4), 4, 0)

    emitHooksChanged({ reason: "plugin-hook-file-changed" })
    expectCatalogRevision(getSkillCatalogRevision(4), 4, 2)
    expectCatalogRevision(getPluginCatalogRevision(4), 4, 1)

    emitHooksChanged({ reason: "config-file-changed" })
    expectCatalogRevision(getSkillCatalogRevision(4), 4, 3)
    expectCatalogRevision(getPluginCatalogRevision(4), 4, 2)
    expect(skillsObserved).toHaveBeenCalledTimes(3)
    expect(pluginsObserved).toHaveBeenCalledTimes(2)

    unsubscribeSkills()
    unsubscribePlugins()
  })

  it("keeps one workspace-hook source and revisions equivalent workspace paths", () => {
    let emitChanged = (payload: { threadId: string; workspacePath: string }): void => {
      throw new Error(`workspace hooks source was not installed: ${payload.threadId}`)
    }
    const sourceCleanup = vi.fn()
    const sourceSubscribe = vi.fn(
      (listener: (payload: { threadId: string; workspacePath: string }) => void) => {
        emitChanged = listener
        return sourceCleanup
      }
    )
    const observed = vi.fn()
    const unsubscribe = subscribeWorkspaceHookCatalogInvalidation(observed)

    ensureWorkspaceHooksChangedInvalidationSource(sourceSubscribe)
    ensureWorkspaceHooksChangedInvalidationSource(sourceSubscribe)
    expect(getWorkspaceHookCatalogRevision("C:/repo")).toBe(0)

    const payload = { threadId: "thread-b", workspacePath: "C:\\repo\\" }
    emitChanged(payload)

    expect(sourceSubscribe).toHaveBeenCalledTimes(1)
    expect(getWorkspaceHookCatalogRevision("C:/repo")).toBe(1)
    expect(getWorkspaceHookCatalogRevision("C:/other")).toBe(0)
    expect(observed).toHaveBeenCalledOnce()
    expect(observed).toHaveBeenCalledWith(payload)
    unsubscribe()
  })

  it("keeps stale data visible while a new plugin version revalidates once", async () => {
    const old = await revalidateSkillCatalog(1, async () => ({
      localSkills: [skill("old")],
      pluginSkills: [],
      disabledSkillIds: []
    }))
    let resolveNext = (value: {
      localSkills: SkillMetadata[]
      pluginSkills: SkillMetadata[]
      disabledSkillIds: string[]
    }): void => {
      throw new Error(`next loader was not started: ${value.localSkills.length}`)
    }
    const nextLoader = vi.fn(
      () =>
        new Promise<{
          localSkills: SkillMetadata[]
          pluginSkills: SkillMetadata[]
          disabledSkillIds: string[]
        }>((resolve) => {
          resolveNext = resolve
        })
    )

    const first = revalidateSkillCatalog(2, nextLoader)
    const second = revalidateSkillCatalog(2, nextLoader)
    expect(readSkillCatalogCache()).toBe(old)
    resolveNext({ localSkills: [skill("new")], pluginSkills: [], disabledSkillIds: [] })
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(nextLoader).toHaveBeenCalledTimes(1)
    expect(firstResult).toBe(secondResult)
    expect(readSkillCatalogCache()?.localSkills[0]?.name).toBe("new")
  })

  it("preserves the last snapshot after a Worker failure and allows a clean retry", async () => {
    const stale = await revalidateSkillCatalog("old", async () => ({
      localSkills: [skill("scheduler-assistant", { source: "project" })],
      pluginSkills: [],
      disabledSkillIds: []
    }))
    const failedLoader = vi.fn(async () => {
      throw new Error("skill catalog worker unavailable")
    })

    await expect(revalidateSkillCatalog("new", failedLoader)).rejects.toThrow(
      "skill catalog worker unavailable"
    )
    expect(readSkillCatalogCache()).toBe(stale)

    const retryLoader = vi.fn(async () => ({
      localSkills: [skill("skill-creator", { source: "project" })],
      pluginSkills: [],
      disabledSkillIds: []
    }))
    const fresh = await revalidateSkillCatalog("new", retryLoader)

    expect(failedLoader).toHaveBeenCalledTimes(1)
    expect(retryLoader).toHaveBeenCalledTimes(1)
    expect(fresh.localSkills[0]?.name).toBe("skill-creator")
    expect(readSkillCatalogCache()).toBe(fresh)
  })

  it("invalidates exactly on revision/version and memoizes harness projections", async () => {
    const localSkills = Array.from({ length: 10_000 }, (_, index) => skill(`local-${index}`))
    const pluginSkills = Array.from({ length: 10_000 }, (_, index) =>
      skill(`plugin-${index}`, {
        id: `plugin-${index}`,
        pluginId: index % 2 === 0 ? "bound" : "other",
        pluginName: index % 2 === 0 ? "Bound" : "Other"
      })
    )
    const snapshot = await revalidateSkillCatalog("version-a", async () => ({
      localSkills,
      pluginSkills,
      disabledSkillIds: []
    }))

    const first = projectChatSkillCatalog(snapshot, {
      harnessScoped: true,
      preferredPlugin: { id: "bound" }
    })
    const remount = projectChatSkillCatalog(snapshot, {
      harnessScoped: true,
      preferredPlugin: { id: "bound" }
    })
    const unresolved = projectChatSkillCatalog(snapshot, { harnessScoped: true })

    expect(remount).toBe(first)
    expect(first.skills).toHaveLength(15_000)
    expect(first.skills.some((item) => item.pluginId === "other")).toBe(false)
    expect(unresolved.skills).toHaveLength(10_000)
    expect(unresolved.skills.some((item) => item.pluginId)).toBe(false)

    invalidateSkillCatalog()
    const next = await revalidateSkillCatalog("version-a", async () => ({
      localSkills: [skill("changed")],
      pluginSkills: [],
      disabledSkillIds: []
    }))
    expect(next).not.toBe(snapshot)
  })

  it("dedupes plugin and market catalogs for same-version panel remounts", async () => {
    const pluginLoader = vi.fn(async () => [plugin("one")])
    const marketLoader = vi.fn(async () => [marketSkill("one")])

    const [pluginsA, pluginsB, marketA, marketB] = await Promise.all([
      revalidatePluginCatalog(3, pluginLoader),
      revalidatePluginCatalog(3, pluginLoader),
      revalidateMarketSkillCatalog(marketLoader),
      revalidateMarketSkillCatalog(marketLoader)
    ])
    await revalidatePluginCatalog(3, pluginLoader)
    await revalidateMarketSkillCatalog(marketLoader)

    expect(pluginLoader).toHaveBeenCalledTimes(1)
    expect(marketLoader).toHaveBeenCalledTimes(1)
    expect(pluginsB).toBe(pluginsA)
    expect(marketB).toBe(marketA)
    expect(readPluginCatalogCache()).toBe(pluginsA)
    expect(marketA.skillMap.one?.chinese_name).toBe("中文-one")
  })

  it("keeps catalog totals and truncation metadata across detail loads and remounts", async () => {
    const skills = await revalidateSkillCatalog("limited", async () => ({
      localSkills: [skill("one")],
      pluginSkills: [],
      disabledSkillIds: [],
      total: 12,
      enabledSkillCount: 8,
      truncated: true,
      truncatedReasons: ["skill-count"]
    }))
    const remountedSkills = await revalidateSkillCatalog("limited", async () => {
      throw new Error("cached skill catalog should be reused")
    })
    expect(remountedSkills).toBe(skills)
    expect(remountedSkills).toMatchObject({
      total: 12,
      rightPanelEnabledSkillCount: 8,
      truncated: true,
      truncatedReasons: ["skill-count"]
    })

    const plugins = await revalidatePluginCatalog("limited", async () => ({
      plugins: [plugin("one")],
      total: 9,
      truncated: true,
      truncatedReasons: ["plugin-count"]
    }))
    const remountedPlugins = await revalidatePluginCatalog("limited", async () => {
      throw new Error("cached plugin catalog should be reused")
    })
    expect(remountedPlugins).toBe(plugins)
    expect(remountedPlugins).toMatchObject({
      total: 9,
      truncated: true,
      truncatedReasons: ["plugin-count"]
    })
  })
})
