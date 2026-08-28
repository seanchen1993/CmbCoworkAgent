import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { SkillMetadata, SkillPluginCatalogPage } from "../../../main/types"
import {
  loadPluginCatalogPages,
  loadPluginCatalogSummary,
  loadSkillCatalogPages,
  loadSkillCatalogSummary,
  SKILL_PLUGIN_CATALOG_RENDER_BATCH
} from "./skill-plugin-catalog"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("renderer skill/plugin catalog pagination", () => {
  it("reads only one Worker row for collapsed header summaries", async () => {
    const read = vi.fn(
      async (
        input: {
          kind: "skills" | "plugins" | "disabled"
          limit?: number
          revision?: string
        },
        requestScope: string
      ): Promise<SkillPluginCatalogPage> => {
        void requestScope
        return {
          kind: input.kind,
          sourceKey: "summary-source",
          catalogGlobalRevision: 0,
          disabledSkillsRevision: 0,
          skills: [],
          plugins: [],
          disabledSkillIds: [],
          cursor: "snapshot:1",
          total: input.kind === "skills" ? 7 : 3,
          enabledSkillCount: input.kind === "skills" ? 5 : 0,
          truncated: false,
          truncatedReasons: [],
          stats: {
            scannedDirectories: 0,
            scannedFiles: 0,
            discoveredSkills: 0,
            readBytes: 0
          }
        }
      }
    )
    vi.stubGlobal("window", {
      api: { skills: { catalog: { read, cancel: vi.fn(async () => undefined) } } }
    })

    await expect(loadSkillCatalogSummary("revision", "summary")).resolves.toEqual({
      total: 7,
      enabled: 5,
      truncated: false,
      truncatedReasons: []
    })
    await expect(loadPluginCatalogSummary("revision", "summary")).resolves.toEqual({
      total: 3,
      truncated: false,
      truncatedReasons: []
    })
    expect(read.mock.calls.map(([input, scope]) => [input.kind, input.limit, scope])).toEqual([
      ["skills", 1, "summary:skills"],
      ["plugins", 1, "summary:plugins"]
    ])
  })

  it("accumulates 20k entries through bounded context-bridge pages", async () => {
    const catalog = Array.from({ length: 20_000 }, (_, index): SkillMetadata => ({
      id: `skill-${index}`,
      name: `skill-${index}`,
      description: `description-${index}`,
      path: `C:/skills/skill-${index}/SKILL.md`,
      source: "user",
      version: "1.0.0"
    }))
    const responseBytes: number[] = []
    const read = vi.fn(
      async (
        input: { kind: "skills" | "plugins" | "disabled"; cursor?: string | null; limit?: number }
      ): Promise<SkillPluginCatalogPage> => {
        const offset = input.cursor ? Number(input.cursor.split(":").at(-1)) : 0
        const items = input.kind === "skills" ? catalog : []
        const selected = items.slice(offset, offset + Math.min(input.limit ?? 128, 128))
        const nextOffset = offset + selected.length
        const page: SkillPluginCatalogPage = {
          kind: input.kind,
          sourceKey: `${input.kind}-large-source`,
          catalogGlobalRevision: 0,
          disabledSkillsRevision: 0,
          skills: input.kind === "skills" ? selected : [],
          plugins: [],
          disabledSkillIds: [],
          cursor: nextOffset < items.length ? `page:${nextOffset}` : null,
          total: items.length,
          enabledSkillCount: items.length,
          truncated: false,
          truncatedReasons: [],
          stats: {
            scannedDirectories: 20_000,
            scannedFiles: 20_000,
            discoveredSkills: 20_000,
            readBytes: 2 * 1024 * 1024
          }
        }
        responseBytes.push(Buffer.byteLength(JSON.stringify(page), "utf-8"))
        return page
      }
    )
    vi.stubGlobal("window", {
      api: {
        skills: {
          catalog: { read, cancel: vi.fn(async () => undefined) }
        }
      }
    })

    const snapshot = await loadSkillCatalogPages("revision-1", "test-catalog")

    expect(snapshot.localSkills).toHaveLength(20_000)
    expect(snapshot.pluginSkills).toHaveLength(0)
    expect(read.mock.calls.every(([input]) => input.limit === 128)).toBe(true)
    expect(Math.max(...responseBytes)).toBeLessThanOrEqual(512 * 1024)
    expect(responseBytes).toHaveLength(Math.ceil(20_000 / 128) + 1)
  })

  it("preserves protocol totals and truncation metadata after draining detail pages", async () => {
    const read = vi.fn(
      async (
        input: { kind: "skills" | "plugins" | "disabled" }
      ): Promise<SkillPluginCatalogPage> => ({
        kind: input.kind,
        sourceKey: `${input.kind}-detail-source`,
        catalogGlobalRevision: 0,
        disabledSkillsRevision: 0,
        skills:
          input.kind === "skills"
            ? [
                {
                  id: "skill-one",
                  name: "skill-one",
                  description: "skill-one",
                  path: "C:/skills/skill-one/SKILL.md",
                  source: "user",
                  version: "1.0.0"
                }
              ]
            : [],
        plugins:
          input.kind === "plugins"
            ? [
                {
                  id: "plugin-one",
                  name: "plugin-one",
                  version: "1.0.0",
                  description: "plugin-one",
                  author: "test",
                  path: "C:/plugins/plugin-one",
                  enabled: true,
                  skillCount: 0,
                  mcpServerCount: 0,
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z"
                }
              ]
            : [],
        disabledSkillIds: input.kind === "disabled" ? ["skill-one"] : [],
        cursor: null,
        total: input.kind === "skills" ? 9 : input.kind === "plugins" ? 7 : 1,
        enabledSkillCount: input.kind === "skills" ? 6 : 0,
        truncated: true,
        truncatedReasons: [`${input.kind}-limit`],
        stats: {
          scannedDirectories: 1,
          scannedFiles: 1,
          discoveredSkills: 1,
          readBytes: 1
        }
      })
    )
    vi.stubGlobal("window", {
      api: { skills: { catalog: { read, cancel: vi.fn(async () => undefined) } } }
    })

    await expect(loadSkillCatalogPages("revision", "detail")).resolves.toMatchObject({
      total: 9,
      enabledSkillCount: 6,
      truncated: true,
      truncatedReasons: ["skills-limit", "disabled-limit"]
    })
    await expect(loadPluginCatalogPages("revision", "detail")).resolves.toMatchObject({
      total: 7,
      truncated: true,
      truncatedReasons: ["plugins-limit"]
    })
  })

  it("surfaces Worker failures without falling back to main-process directory scans", async () => {
    const list = vi.fn(async () => [])
    const listPlugins = vi.fn(async () => [])
    const getDisabled = vi.fn(async () => [])
    vi.stubGlobal("window", {
      api: {
        skills: {
          catalog: {
            read: vi.fn(async () => {
              throw new Error("skill catalog worker unavailable")
            }),
            cancel: vi.fn(async () => undefined)
          },
          list,
          listPlugins,
          getDisabled
        }
      }
    })

    await expect(loadSkillCatalogPages("failed", "test-catalog")).rejects.toThrow(
      "skill catalog worker unavailable"
    )
    expect(list).not.toHaveBeenCalled()
    expect(listPlugins).not.toHaveBeenCalled()
    expect(getDisabled).not.toHaveBeenCalled()
  })

  it("keeps Customize Skills and Plugins initial DOM at 128 with explicit expansion", () => {
    const skillsSource = readFileSync(
      new URL("../components/customize/SkillsPanel.tsx", import.meta.url),
      "utf8"
    )
    const pluginsSource = readFileSync(
      new URL("../components/customize/PluginsPanel.tsx", import.meta.url),
      "utf8"
    )

    expect(SKILL_PLUGIN_CATALOG_RENDER_BATCH).toBe(128)
    expect(skillsSource).toContain(
      "useState(SKILL_PLUGIN_CATALOG_RENDER_BATCH)"
    )
    expect(skillsSource).toContain("useState(() => readSkillCatalogCache())")
    expect(skillsSource).toContain('skillCatalogLoadState === "loading"')
    expect(skillsSource).toContain('skillCatalogLoadState === "error"')
    expect(skillsSource).toContain(
      'skillCatalogLoadState === "ready" && builtinSkills.length === 0'
    )
    expect(skillsSource).toContain("snapshot === cachedBeforeRefresh")
    expect(skillsSource).toContain("recoveredEmptySkillCatalogKeys.has(snapshot.key)")
    expect(skillsSource).toContain("builtinSkills.length > 0 &&")
    expect(skillsSource).toContain("filteredBuiltin.slice(0, visibleSkillLimit)")
    expect(skillsSource).toContain("加载更多（剩余")
    expect(skillsSource).not.toContain("window.api.skills.list()")
    const toggleBlock = skillsSource.slice(
      skillsSource.indexOf("const toggleSkillEnabled"),
      skillsSource.indexOf("const handleDeleteSkill")
    )
    expect(toggleBlock).not.toContain("window.api.skills.getDisabled()")
    expect(toggleBlock).toContain("void refreshSkills(true)")
    expect(pluginsSource).toMatch(
      /useState\(\s*SKILL_PLUGIN_CATALOG_RENDER_BATCH\s*\)/
    )
    expect(pluginsSource).toContain(
      "filteredPlugins.slice(0, visiblePluginLimit)"
    )
    expect(pluginsSource).toContain("加载更多（剩余")
  })

  it("wires Chat and App update checks to the same configured snapshot", () => {
    const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8")
    const chatSource = readFileSync(
      new URL("../components/chat/ChatContainer.tsx", import.meta.url),
      "utf8"
    )
    const welcomeSource = readFileSync(
      new URL("../components/chat/WelcomeSkills.tsx", import.meta.url),
      "utf8"
    )
    const marketSource = readFileSync(new URL("../api/market.ts", import.meta.url), "utf8")
    const marketSkillsSource = marketSource.slice(
      marketSource.indexOf("async getSkills("),
      marketSource.indexOf("async getMcps(")
    )

    expect(appSource).toContain("configureAppCatalogLoaders({")
    const disabledMigration = appSource.slice(
      appSource.indexOf("async function migrateDisabledSkillsFromLocalStorage"),
      appSource.indexOf("const LEFT_MIN")
    )
    expect(disabledMigration).toContain("window.api.skills.setDisabled")
    expect(disabledMigration).not.toContain("window.api.skills.getDisabled")
    expect(appSource).toContain(
      "const installedSkills = (await revalidateSkillCatalog(pluginVersion)).localSkills"
    )
    expect(chatSource).toContain(
      "const skillCatalogPromise = revalidateSkillCatalog(pluginVersion)"
    )
    expect(appSource).not.toContain("window.api.skills.list()")
    expect(chatSource).not.toContain("window.api.skills.list()")
    expect(chatSource).not.toContain("window.api.skills.listPlugins()")
    expect(welcomeSource).not.toContain("window.api.skills.list()")
    expect(welcomeSource).toContain(
      "installFeaturedSkills(goodSkills, skillsMetadata, controller.signal)"
    )
    expect(welcomeSource).toContain("FEATURED_AUTO_INSTALL_LIMIT")
    expect(welcomeSource).toContain("FEATURED_AUTO_INSTALL_MAX_BYTES")
    expect(welcomeSource).toContain("installFeaturedSkillsOnce(goodSkillsData, localSkills, controller.signal)")
    expect(welcomeSource).toContain("controller.abort()")
    expect(marketSource).toContain("MARKET_SKILL_LIST_MAX_RESPONSE_BYTES")
    expect(marketSkillsSource).not.toContain("response.json()")
  })
})
