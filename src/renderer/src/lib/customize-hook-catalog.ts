import type { HookConfig } from "@/types"

export const CUSTOMIZE_HOOK_CATALOG_SCOPE = "customize-hooks"
export const CUSTOMIZE_HOOK_CATALOG_PAGE_LIMIT = 256

type HookCatalogPage = Awaited<ReturnType<typeof window.api.hooks.catalog.read>>

export type CatalogPluginHook = HookCatalogPage["pluginHooks"][number]
export type CatalogSkillHook = HookCatalogPage["skillHooks"][number]

export type CustomizeDisplayHook =
  | (HookConfig & { source: "global" })
  | (CatalogPluginHook & { source: "plugin" })
  | (CatalogSkillHook & { source: "skill" })

export interface CustomizeHookCatalogProjection {
  hooks: CustomizeDisplayHook[]
  truncated: boolean
  truncatedReasons: string[]
}

export async function readCustomizeHookCatalog(
  readPage: typeof window.api.hooks.catalog.read,
  isCurrent: () => boolean
): Promise<CustomizeHookCatalogProjection | null> {
  const globalHooks: CustomizeDisplayHook[] = []
  const skillHooks: CustomizeDisplayHook[] = []
  const pluginHooks: CustomizeDisplayHook[] = []
  const truncatedReasons = new Set<string>()
  let cursor: string | undefined
  let truncated = false

  do {
    const previousCursor = cursor
    const page = await readPage({
      requestScope: CUSTOMIZE_HOOK_CATALOG_SCOPE,
      ...(cursor ? { cursor } : {}),
      limit: CUSTOMIZE_HOOK_CATALOG_PAGE_LIMIT
    })
    if (!isCurrent()) return null

    globalHooks.push(
      ...page.globalHooks.map((hook): CustomizeDisplayHook => ({ ...hook, source: "global" }))
    )
    skillHooks.push(
      ...page.skillHooks.map((hook): CustomizeDisplayHook => ({ ...hook, source: "skill" }))
    )
    pluginHooks.push(
      ...page.pluginHooks.map((hook): CustomizeDisplayHook => ({ ...hook, source: "plugin" }))
    )
    truncated ||= page.truncated
    for (const reason of page.truncatedReasons) truncatedReasons.add(reason)
    cursor = page.nextCursor
    if (cursor && cursor === previousCursor) {
      truncated = true
      truncatedReasons.add("cursor-no-progress")
      break
    }
  } while (cursor)

  return {
    hooks: [...globalHooks, ...skillHooks, ...pluginHooks],
    truncated,
    truncatedReasons: [...truncatedReasons]
  }
}
