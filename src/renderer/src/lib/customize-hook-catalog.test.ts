import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import {
  CUSTOMIZE_HOOK_CATALOG_PAGE_LIMIT,
  CUSTOMIZE_HOOK_CATALOG_SCOPE,
  readCustomizeHookCatalog
} from "./customize-hook-catalog"

type HookCatalogPage = Awaited<ReturnType<typeof window.api.hooks.catalog.read>>

function page(overrides: Partial<HookCatalogPage> = {}): HookCatalogPage {
  return {
    globalHooks: [],
    workspaceHooks: [],
    pluginHooks: [],
    skillHooks: [],
    totalEntries: 0,
    enabledEntries: 0,
    truncated: false,
    truncatedReasons: [],
    stats: {
      durationMs: 0,
      responseBytes: 0,
      scannedDirectories: 0,
      scannedFiles: 0,
      discoveredSkills: 0,
      readBytes: 0
    },
    ...overrides
  }
}

describe("Customize hook catalog projection", () => {
  it("keeps the panel wired to the isolated catalog and cancels it on unmount", () => {
    const source = readFileSync(
      new URL("../components/customize/HooksPanel.tsx", import.meta.url),
      "utf8"
    )
    const loadStart = source.indexOf("const loadHooks = useCallback")
    const loadEnd = source.indexOf("const filteredHooks = useMemo", loadStart)
    const loadSurface = source.slice(loadStart, loadEnd)

    expect(loadSurface).toContain("readCustomizeHookCatalog")
    expect(loadSurface).toContain("window.api.hooks.catalog.cancel")
    expect(loadSurface).not.toContain("window.api.plugins.getDetail")
    expect(loadSurface).not.toContain("window.api.plugins.list()")
    expect(loadSurface).not.toContain("window.api.hooks.skills.list()")
  })

  it("drains bounded pages through its own request scope without plugin detail fanout", async () => {
    const readPage = vi
      .fn()
      .mockResolvedValueOnce(
        page({
          globalHooks: [
            {
              id: "global",
              event: "Stop",
              type: "command",
              command: "echo global",
              enabled: true,
              createdAt: "2026-01-01",
              updatedAt: "2026-01-01"
            }
          ],
          nextCursor: "snapshot:1",
          totalEntries: 3
        })
      )
      .mockResolvedValueOnce(
        page({
          pluginHooks: [
            {
              id: "plugin",
              event: "Stop",
              type: "command",
              command: "echo plugin",
              enabled: true,
              createdAt: "2026-01-01",
              updatedAt: "2026-01-01",
              pluginId: "plugin-id",
              pluginName: "Plugin",
              pluginRoot: "C:\\plugin",
              pluginEnabled: true,
              hookPath: "C:\\plugin\\hooks.json"
            }
          ],
          skillHooks: [
            {
              id: "skill",
              event: "Stop",
              type: "command",
              command: "echo skill",
              enabled: true,
              createdAt: "2026-01-01",
              updatedAt: "2026-01-01",
              skillName: "Skill",
              skillPath: "C:\\skill",
              skillRoot: "C:\\skill",
              hookPath: "C:\\skill\\hooks.json"
            }
          ],
          totalEntries: 3,
          truncated: true,
          truncatedReasons: ["entry-limit"]
        })
      )

    const result = await readCustomizeHookCatalog(readPage, () => true)

    expect(readPage).toHaveBeenNthCalledWith(1, {
      requestScope: CUSTOMIZE_HOOK_CATALOG_SCOPE,
      limit: CUSTOMIZE_HOOK_CATALOG_PAGE_LIMIT
    })
    expect(readPage).toHaveBeenNthCalledWith(2, {
      requestScope: CUSTOMIZE_HOOK_CATALOG_SCOPE,
      cursor: "snapshot:1",
      limit: CUSTOMIZE_HOOK_CATALOG_PAGE_LIMIT
    })
    expect(result?.hooks.map((hook) => `${hook.source}:${hook.id}`)).toEqual([
      "global:global",
      "skill:skill",
      "plugin:plugin"
    ])
    expect(result).toMatchObject({ truncated: true, truncatedReasons: ["entry-limit"] })
  })

  it("drops a stale continuation result after cancellation or tab unmount", async () => {
    let current = true
    const readPage = vi.fn(async () => {
      current = false
      return page({ nextCursor: "snapshot:1" })
    })

    await expect(readCustomizeHookCatalog(readPage, () => current)).resolves.toBeNull()
    expect(readPage).toHaveBeenCalledTimes(1)
  })

  it("stops a non-progressing cursor instead of spinning forever", async () => {
    const readPage = vi
      .fn()
      .mockResolvedValueOnce(page({ nextCursor: "snapshot:0" }))
      .mockResolvedValueOnce(page({ nextCursor: "snapshot:0" }))

    const result = await readCustomizeHookCatalog(readPage, () => true)

    expect(readPage).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      truncated: true,
      truncatedReasons: ["cursor-no-progress"]
    })
  })
})
