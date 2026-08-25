import type { MarketItem } from "@/api/market"
import { mergeChatSkills, type PreferredPlugin } from "@/features/slash-commands/skill-merge"
import { isSkillDisabled, normalizeSkillId } from "@/lib/skill-ids"
import type { PluginMetadata, SkillMetadata } from "@/types"

export interface SkillCatalogLoadResult {
  localSkills: SkillMetadata[]
  pluginSkills: SkillMetadata[]
  disabledSkillIds: string[]
}

export interface SkillCatalogSnapshot {
  key: string
  localSkills: SkillMetadata[]
  pluginSkills: SkillMetadata[]
  disabledSkillIds: Set<string>
  rightPanelSkills: SkillMetadata[]
  rightPanelEnabledSkillCount: number
  updatedAt: number
}

export interface ChatSkillCatalogProjection {
  skills: SkillMetadata[]
  disabledSkillIds: Set<string>
}

export interface PluginCatalogSnapshot {
  key: string
  plugins: PluginMetadata[]
  updatedAt: number
}

export type CatalogMarketSkillInfo = Pick<MarketItem, "name" | "chinese_name">

export interface MarketSkillCatalogSnapshot {
  items: MarketItem[]
  skillMap: Record<string, CatalogMarketSkillInfo>
  updatedAt: number
}

type GlobalHookMetadata = Awaited<ReturnType<typeof window.api.hooks.list>>[number]
type PluginHookMetadata = Awaited<ReturnType<typeof window.api.plugins.listHooks>>[number]
type SkillHookMetadata = Awaited<ReturnType<typeof window.api.hooks.skills.list>>[number]

export interface GlobalHookCatalogSnapshot {
  key: string
  globalHooks: GlobalHookMetadata[]
  pluginHooks: PluginHookMetadata[]
  skillHooks: SkillHookMetadata[]
  updatedAt: number
}

type CatalogRequest<T> = {
  key: string
  generation: number
  promise: Promise<T>
}

let skillSnapshot: SkillCatalogSnapshot | null = null
let skillRequest: CatalogRequest<SkillCatalogSnapshot> | null = null
let skillGeneration = 0
let skillInvalidationRevision = 0
let skillsChangedSourceInstalled = false
let skillsChangedSourceCleanup: (() => void) | null = null
let disabledSkillsChangedSourceInstalled = false
let disabledSkillsChangedSourceCleanup: (() => void) | null = null
const skillInvalidationListeners = new Set<() => void>()
const chatProjectionCache = new WeakMap<
  SkillCatalogSnapshot,
  Map<string, ChatSkillCatalogProjection>
>()

let pluginSnapshot: PluginCatalogSnapshot | null = null
let pluginRequest: CatalogRequest<PluginCatalogSnapshot> | null = null
let pluginGeneration = 0

let marketSkillSnapshot: MarketSkillCatalogSnapshot | null = null
let marketSkillRequest: Promise<MarketSkillCatalogSnapshot> | null = null
let marketSkillGeneration = 0

let globalHookSnapshot: GlobalHookCatalogSnapshot | null = null
let globalHookRequest: CatalogRequest<GlobalHookCatalogSnapshot> | null = null
let globalHookGeneration = 0
let globalHookInvalidationRevision = 0
const globalHookInvalidationListeners = new Set<() => void>()

let configuredSkillLoader: ((key: string) => Promise<SkillCatalogLoadResult>) | null = null
let configuredPluginLoader: ((key: string) => Promise<PluginMetadata[]>) | null = null

export function configureAppCatalogLoaders(loaders: {
  skills: (key: string) => Promise<SkillCatalogLoadResult>
  plugins: (key: string) => Promise<PluginMetadata[]>
}): void {
  configuredSkillLoader = loaders.skills
  configuredPluginLoader = loaders.plugins
}

function skillCatalogKey(pluginVersion: string | number): string {
  return `${String(pluginVersion)}:${skillInvalidationRevision}`
}

function createSkillCatalogSnapshot(
  key: string,
  result: SkillCatalogLoadResult
): SkillCatalogSnapshot {
  const disabledSkillIds = new Set(result.disabledSkillIds.map(normalizeSkillId))
  const byId = new Map<string, SkillMetadata>()

  // Preserve the right-panel precedence used before this cache: local/project
  // metadata replaces a plugin row on a genuine id collision.
  for (const skill of result.pluginSkills) {
    byId.set(normalizeSkillId(skill.id || skill.name), skill)
  }
  for (const skill of result.localSkills) {
    byId.set(normalizeSkillId(skill.id || skill.name), skill)
  }

  const rightPanelSkills = Array.from(byId.values())
  let rightPanelEnabledSkillCount = 0
  for (const skill of rightPanelSkills) {
    if (!isSkillDisabled(skill, disabledSkillIds)) rightPanelEnabledSkillCount += 1
  }

  return {
    key,
    localSkills: result.localSkills,
    pluginSkills: result.pluginSkills,
    disabledSkillIds,
    rightPanelSkills,
    rightPanelEnabledSkillCount,
    updatedAt: Date.now()
  }
}

export function readSkillCatalogCache(): SkillCatalogSnapshot | null {
  return skillSnapshot
}

export function isSkillCatalogFresh(
  snapshot: SkillCatalogSnapshot | null,
  pluginVersion: string | number
): snapshot is SkillCatalogSnapshot {
  return snapshot?.key === skillCatalogKey(pluginVersion)
}

/**
 * Application-lifetime stale-while-revalidate cache for the filesystem-backed
 * skill catalogs. A remount at the same version gets the exact same snapshot;
 * plugin-version and skills:changed invalidations each create one new key.
 */
export function revalidateSkillCatalog(
  pluginVersion: string | number,
  loader?: () => Promise<SkillCatalogLoadResult>
): Promise<SkillCatalogSnapshot> {
  const key = skillCatalogKey(pluginVersion)
  if (skillSnapshot?.key === key) return Promise.resolve(skillSnapshot)
  if (skillRequest?.key === key) return skillRequest.promise

  const generation = ++skillGeneration
  const load = configuredSkillLoader
    ? () => configuredSkillLoader!(key)
    : loader
  if (!load) return Promise.reject(new Error("Skill catalog loader is not configured"))
  const promise = load()
    .then((result) => {
      const next = createSkillCatalogSnapshot(key, result)
      if (generation === skillGeneration && key === skillCatalogKey(pluginVersion)) {
        skillSnapshot = next
      }
      return generation === skillGeneration ? next : (skillSnapshot ?? next)
    })
    .finally(() => {
      if (skillRequest?.generation === generation) skillRequest = null
    })

  skillRequest = { key, generation, promise }
  return promise
}

export function invalidateSkillCatalog(): void {
  skillInvalidationRevision += 1
  skillGeneration += 1
  for (const listener of skillInvalidationListeners) listener()
}

export function subscribeSkillCatalogInvalidation(listener: () => void): () => void {
  skillInvalidationListeners.add(listener)
  return () => skillInvalidationListeners.delete(listener)
}

/** Install the renderer's skills:changed bridge once for the whole application. */
export function ensureSkillsChangedInvalidationSource(
  subscribe: (listener: () => void) => () => void
): void {
  if (skillsChangedSourceInstalled) return
  skillsChangedSourceInstalled = true
  try {
    skillsChangedSourceCleanup = subscribe(invalidateSkillCatalog)
  } catch (error) {
    skillsChangedSourceInstalled = false
    throw error
  }
}

/**
 * Disabled-skill writes currently travel on hooks:changed because they also
 * affect skill hook activation. Filter that shared channel precisely instead
 * of invalidating the catalog for unrelated hook edits.
 */
export function ensureDisabledSkillsChangedInvalidationSource(
  subscribe: (listener: (payload: { reason?: string }) => void) => () => void
): void {
  if (disabledSkillsChangedSourceInstalled) return
  disabledSkillsChangedSourceInstalled = true
  try {
    disabledSkillsChangedSourceCleanup = subscribe((payload) => {
      if (payload.reason === "skills-disabled-changed") invalidateSkillCatalog()
      globalHookInvalidationRevision += 1
      globalHookGeneration += 1
      for (const listener of globalHookInvalidationListeners) listener()
    })
  } catch (error) {
    disabledSkillsChangedSourceInstalled = false
    throw error
  }
}

export function readGlobalHookCatalogCache(): GlobalHookCatalogSnapshot | null {
  return globalHookSnapshot
}

export function revalidateGlobalHookCatalog(
  pluginVersion: string | number,
  loader: () => Promise<{
    globalHooks: GlobalHookMetadata[]
    pluginHooks: PluginHookMetadata[]
    skillHooks: SkillHookMetadata[]
  }>
): Promise<GlobalHookCatalogSnapshot> {
  const key = `${String(pluginVersion)}:${globalHookInvalidationRevision}`
  if (globalHookSnapshot?.key === key) return Promise.resolve(globalHookSnapshot)
  if (globalHookRequest?.key === key) return globalHookRequest.promise

  const generation = ++globalHookGeneration
  const promise = loader()
    .then((result) => {
      const next = { key, ...result, updatedAt: Date.now() }
      if (generation === globalHookGeneration) globalHookSnapshot = next
      return generation === globalHookGeneration ? next : (globalHookSnapshot ?? next)
    })
    .finally(() => {
      if (globalHookRequest?.generation === generation) globalHookRequest = null
    })
  globalHookRequest = { key, generation, promise }
  return promise
}

export function subscribeGlobalHookCatalogInvalidation(listener: () => void): () => void {
  globalHookInvalidationListeners.add(listener)
  return () => globalHookInvalidationListeners.delete(listener)
}

function preferredPluginProjectionKey(preferredPlugin?: PreferredPlugin | null): string {
  if (!preferredPlugin) return ""
  if (typeof preferredPlugin === "string") return `name:${normalizeSkillId(preferredPlugin)}`
  return [
    `id:${normalizeSkillId(preferredPlugin.id ?? "")}`,
    `name:${normalizeSkillId(preferredPlugin.name ?? "")}`
  ].join("|")
}

/**
 * Memoizes the sort/filter projection too, so a 20k-row directory is not
 * rebuilt by ChatContainer remounts after the base snapshot was cached.
 */
export function projectChatSkillCatalog(
  snapshot: SkillCatalogSnapshot,
  options: {
    harnessScoped?: boolean
    preferredPlugin?: PreferredPlugin | null
  } = {}
): ChatSkillCatalogProjection {
  const harnessScoped = options.harnessScoped === true
  const preferredPlugin = options.preferredPlugin ?? null
  const key = harnessScoped
    ? `harness:${preferredPluginProjectionKey(preferredPlugin) || "unresolved"}`
    : "conversation"
  let projections = chatProjectionCache.get(snapshot)
  if (!projections) {
    projections = new Map()
    chatProjectionCache.set(snapshot, projections)
  }
  const cached = projections.get(key)
  if (cached) return cached

  const availableLocalSkills = snapshot.localSkills.filter(
    (skill) => skill.source === "project" || skill.source === "user"
  )
  // Until a bound project is resolved, expose no plugin-owned skill. Showing
  // every plugin would violate the harness binding while its catalog is loading.
  const visiblePluginSkills = harnessScoped && !preferredPlugin ? [] : snapshot.pluginSkills
  const skills = mergeChatSkills(
    availableLocalSkills,
    visiblePluginSkills,
    snapshot.disabledSkillIds,
    preferredPlugin
  ).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
  const projection = { skills, disabledSkillIds: snapshot.disabledSkillIds }
  projections.set(key, projection)
  return projection
}

export function readPluginCatalogCache(): PluginCatalogSnapshot | null {
  return pluginSnapshot
}

export function revalidatePluginCatalog(
  pluginVersion: string | number,
  loader?: () => Promise<PluginMetadata[]>
): Promise<PluginCatalogSnapshot> {
  const key = String(pluginVersion)
  if (pluginSnapshot?.key === key) return Promise.resolve(pluginSnapshot)
  if (pluginRequest?.key === key) return pluginRequest.promise

  const generation = ++pluginGeneration
  const load = configuredPluginLoader
    ? () => configuredPluginLoader!(key)
    : loader
  if (!load) return Promise.reject(new Error("Plugin catalog loader is not configured"))
  const promise = load()
    .then((plugins) => {
      const next = { key, plugins, updatedAt: Date.now() }
      if (generation === pluginGeneration) pluginSnapshot = next
      return generation === pluginGeneration ? next : (pluginSnapshot ?? next)
    })
    .finally(() => {
      if (pluginRequest?.generation === generation) pluginRequest = null
    })

  pluginRequest = { key, generation, promise }
  return promise
}

export function readMarketSkillCatalogCache(): MarketSkillCatalogSnapshot | null {
  return marketSkillSnapshot
}

function normalizeMarketSkillName(value: string): string {
  return value.trim().toLowerCase()
}

export function revalidateMarketSkillCatalog(
  loader: () => Promise<MarketItem[]>
): Promise<MarketSkillCatalogSnapshot> {
  if (marketSkillSnapshot) return Promise.resolve(marketSkillSnapshot)
  if (marketSkillRequest) return marketSkillRequest

  const generation = ++marketSkillGeneration
  const promise = loader()
    .then((items) => {
      const skillMap: Record<string, CatalogMarketSkillInfo> = {}
      for (const item of items) {
        const normalized = normalizeMarketSkillName(item.name)
        if (!normalized) continue
        skillMap[normalized] = { name: item.name, chinese_name: item.chinese_name }
      }
      const next = { items, skillMap, updatedAt: Date.now() }
      if (generation === marketSkillGeneration) marketSkillSnapshot = next
      return generation === marketSkillGeneration ? next : (marketSkillSnapshot ?? next)
    })
    .finally(() => {
      if (generation === marketSkillGeneration) marketSkillRequest = null
    })

  marketSkillRequest = promise
  return promise
}

export function invalidateMarketSkillCatalog(): void {
  marketSkillGeneration += 1
  marketSkillSnapshot = null
  marketSkillRequest = null
}

export function resetAppCatalogCacheForTests(): void {
  skillsChangedSourceCleanup?.()
  disabledSkillsChangedSourceCleanup?.()
  skillSnapshot = null
  skillRequest = null
  skillGeneration = 0
  skillInvalidationRevision = 0
  skillsChangedSourceInstalled = false
  skillsChangedSourceCleanup = null
  disabledSkillsChangedSourceInstalled = false
  disabledSkillsChangedSourceCleanup = null
  skillInvalidationListeners.clear()
  pluginSnapshot = null
  pluginRequest = null
  pluginGeneration = 0
  marketSkillSnapshot = null
  marketSkillRequest = null
  marketSkillGeneration = 0
  globalHookSnapshot = null
  globalHookRequest = null
  globalHookGeneration = 0
  globalHookInvalidationRevision = 0
  globalHookInvalidationListeners.clear()
  configuredSkillLoader = null
  configuredPluginLoader = null
}
