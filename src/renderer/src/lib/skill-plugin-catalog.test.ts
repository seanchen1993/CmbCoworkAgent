import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { SkillMetadata, SkillPluginCatalogPage } from "../../../main/types"
import {
  loadSkillCatalogPages,
  SKILL_PLUGIN_CATALOG_RENDER_BATCH
} from "./skill-plugin-catalog"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("renderer skill/plugin catalog pagination", () => {
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
          skills: input.kind === "skills" ? selected : [],
          plugins: [],
          disabledSkillIds: [],
          cursor: nextOffset < items.length ? `page:${nextOffset}` : null,
          total: items.length,
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
    expect(skillsSource).toContain("filteredBuiltin.slice(0, visibleSkillLimit)")
    expect(skillsSource).toContain("加载更多（剩余")
    expect(pluginsSource).toContain(
      "useState(\n    SKILL_PLUGIN_CATALOG_RENDER_BATCH\n  )"
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
