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
}

export interface PluginCatalogSummary {
  total: number
  truncated: boolean
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
    truncated: page.truncated
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
  return { total: page.total, truncated: page.truncated }
}

async function drainCatalogKind(
  kind: "skills" | "plugins" | "disabled",
  options: LoadOptions
): Promise<{
  skills: SkillMetadata[]
  plugins: PluginMetadata[]
  disabledSkillIds: string[]
  truncated: boolean
}> {
  const skills: SkillMetadata[] = []
  const plugins: PluginMetadata[] = []
  const disabledSkillIds: string[] = []
  let cursor: string | null = null
  let truncated = false
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
    truncated ||= page.truncated
    if (!page.cursor) return { skills, plugins, disabledSkillIds, truncated }
    if (page.cursor === cursor || seenCursors.has(page.cursor)) {
      return { skills, plugins, disabledSkillIds, truncated: true }
    }
    seenCursors.add(page.cursor)
    cursor = page.cursor
  }
  return { skills, plugins, disabledSkillIds, truncated: true }
}

export async function loadSkillCatalogPages(
  revision: string,
  scope = "app-skill-catalog",
  isCurrent?: () => boolean
): Promise<{
  localSkills: SkillMetadata[]
  pluginSkills: SkillMetadata[]
  disabledSkillIds: string[]
}> {
  const [skillResult, disabledResult] = await Promise.all([
    drainCatalogKind("skills", { revision, scope, isCurrent }),
    drainCatalogKind("disabled", { revision, scope, isCurrent })
  ])
  return {
    localSkills: skillResult.skills.filter((skill) => !skill.pluginId),
    pluginSkills: skillResult.skills.filter((skill) => Boolean(skill.pluginId)),
    disabledSkillIds: disabledResult.disabledSkillIds
  }
}

export async function loadPluginCatalogPages(
  revision: string,
  scope = "app-plugin-catalog",
  isCurrent?: () => boolean
): Promise<PluginMetadata[]> {
  return (await drainCatalogKind("plugins", { revision, scope, isCurrent })).plugins
}

export function cancelSkillPluginCatalog(scope: string): void {
  for (const kind of ["skills", "plugins", "disabled"] as const) {
    void window.api.skills.catalog.cancel(`${scope}:${kind}`).catch(() => undefined)
  }
}

export const SKILL_PLUGIN_CATALOG_RENDER_BATCH = 128
