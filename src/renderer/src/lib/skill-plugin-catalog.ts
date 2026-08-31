import type { PluginMetadata, SkillMetadata } from "@/types"

const CATALOG_PAGE_SIZE = 128
// The worker's 64 MiB total-read budget can still yield more than 256 pages
// when many near-response-limit metadata rows coexist with thousands of small
// rows. Keep the renderer drain finite without truncating a catalog that is
// otherwise within the worker's hard source budgets.
const MAX_CATALOG_PAGES = 1_024

interface LoadOptions {
  revision: string
  scope: string
  isCurrent?: () => boolean
}

export interface SkillCatalogSummary {
  total: number
  enabled: number
  truncated: boolean
  truncatedReasons: string[]
}

export interface PluginCatalogSummary {
  total: number
  truncated: boolean
  truncatedReasons: string[]
}

export interface PluginCatalogLoadResult {
  plugins: PluginMetadata[]
  total: number
  truncated: boolean
  truncatedReasons: string[]
}

export async function loadSkillCatalogSummary(
  revision: string,
  scope = "right-panel-summary",
  isCurrent?: () => boolean
): Promise<SkillCatalogSummary> {
  if (isCurrent && !isCurrent()) throw new Error("Catalog request superseded")
  const page = await window.api.skills.catalog.read(
    { kind: "skills", limit: 1, revision },
    `${scope}:skills`
  )
  if (isCurrent && !isCurrent()) throw new Error("Catalog request superseded")
  return {
    total: page.total,
    enabled: page.enabledSkillCount,
    truncated: page.truncated,
    truncatedReasons: page.truncatedReasons
  }
}

export async function loadPluginCatalogSummary(
  revision: string,
  scope = "right-panel-summary",
  isCurrent?: () => boolean
): Promise<PluginCatalogSummary> {
  if (isCurrent && !isCurrent()) throw new Error("Catalog request superseded")
  const page = await window.api.skills.catalog.read(
    { kind: "plugins", limit: 1, revision },
    `${scope}:plugins`
  )
  if (isCurrent && !isCurrent()) throw new Error("Catalog request superseded")
  return {
    total: page.total,
    truncated: page.truncated,
    truncatedReasons: page.truncatedReasons
  }
}

async function drainCatalogKind(
  kind: "skills" | "plugins" | "disabled",
  options: LoadOptions
): Promise<{
  skills: SkillMetadata[]
  plugins: PluginMetadata[]
  disabledSkillIds: string[]
  total: number
  enabledSkillCount: number
  truncated: boolean
  truncatedReasons: string[]
}> {
  const skills: SkillMetadata[] = []
  const plugins: PluginMetadata[] = []
  const disabledSkillIds: string[] = []
  let cursor: string | null = null
  let total = 0
  let enabledSkillCount = 0
  let truncated = false
  const truncatedReasons = new Set<string>()
  const seenCursors = new Set<string>()
  for (let pageIndex = 0; pageIndex < MAX_CATALOG_PAGES; pageIndex += 1) {
    if (options.isCurrent && !options.isCurrent()) throw new Error("Catalog request superseded")
    const page = await window.api.skills.catalog.read(
      { kind, cursor, limit: CATALOG_PAGE_SIZE, revision: options.revision },
      `${options.scope}:${kind}`
    )
    if (options.isCurrent && !options.isCurrent()) throw new Error("Catalog request superseded")
    skills.push(...page.skills)
    plugins.push(...page.plugins)
    disabledSkillIds.push(...page.disabledSkillIds)
    total = page.total
    enabledSkillCount = page.enabledSkillCount
    truncated ||= page.truncated
    for (const reason of page.truncatedReasons) truncatedReasons.add(reason)
    if (!page.cursor) {
      return {
        skills,
        plugins,
        disabledSkillIds,
        total,
        enabledSkillCount,
        truncated,
        truncatedReasons: [...truncatedReasons]
      }
    }
    if (page.cursor === cursor || seenCursors.has(page.cursor)) {
      truncatedReasons.add("cursor-no-progress")
      return {
        skills,
        plugins,
        disabledSkillIds,
        total,
        enabledSkillCount,
        truncated: true,
        truncatedReasons: [...truncatedReasons]
      }
    }
    seenCursors.add(page.cursor)
    cursor = page.cursor
  }
  truncatedReasons.add("renderer-page-limit")
  return {
    skills,
    plugins,
    disabledSkillIds,
    total,
    enabledSkillCount,
    truncated: true,
    truncatedReasons: [...truncatedReasons]
  }
}

export async function loadSkillCatalogPages(
  revision: string,
  scope = "app-skill-catalog",
  isCurrent?: () => boolean
): Promise<{
  localSkills: SkillMetadata[]
  pluginSkills: SkillMetadata[]
  disabledSkillIds: string[]
  total: number
  enabledSkillCount: number
  truncated: boolean
  truncatedReasons: string[]
}> {
  const [skillResult, disabledResult] = await Promise.all([
    drainCatalogKind("skills", { revision, scope, isCurrent }),
    drainCatalogKind("disabled", { revision, scope, isCurrent })
  ])
  return {
    localSkills: skillResult.skills.filter((skill) => !skill.pluginId),
    pluginSkills: skillResult.skills.filter((skill) => Boolean(skill.pluginId)),
    disabledSkillIds: disabledResult.disabledSkillIds,
    total: skillResult.total,
    enabledSkillCount: skillResult.enabledSkillCount,
    truncated: skillResult.truncated || disabledResult.truncated,
    truncatedReasons: [
      ...new Set([...skillResult.truncatedReasons, ...disabledResult.truncatedReasons])
    ]
  }
}

export async function loadPluginCatalogPages(
  revision: string,
  scope = "app-plugin-catalog",
  isCurrent?: () => boolean
): Promise<PluginCatalogLoadResult> {
  const result = await drainCatalogKind("plugins", { revision, scope, isCurrent })
  return {
    plugins: result.plugins,
    total: result.total,
    truncated: result.truncated,
    truncatedReasons: result.truncatedReasons
  }
}

export function cancelSkillPluginCatalog(scope: string): void {
  for (const kind of ["skills", "plugins", "disabled"] as const) {
    void window.api.skills.catalog.cancel(`${scope}:${kind}`).catch(() => undefined)
  }
}

export const SKILL_PLUGIN_CATALOG_RENDER_BATCH = 128
