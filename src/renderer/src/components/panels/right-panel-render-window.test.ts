import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import {
  RIGHT_PANEL_INITIAL_RENDER_ITEMS,
  selectRightPanelPrioritizedWindow,
  selectRightPanelWindow
} from "./right-panel-render-window"

describe("right panel render windows", () => {
  it("never exposes an unbounded catalog on the first render", () => {
    const items = Array.from({ length: 20_000 }, (_, index) => ({
      index,
      enabled: index % 3 !== 0
    }))

    const window = selectRightPanelPrioritizedWindow(
      items,
      RIGHT_PANEL_INITIAL_RENDER_ITEMS,
      (item) => item.enabled
    )

    expect(window.enabled.length + window.disabled.length).toBe(RIGHT_PANEL_INITIAL_RENDER_ITEMS)
    expect(window.enabled.every((item) => item.enabled)).toBe(true)
    expect(window.disabled.every((item) => !item.enabled)).toBe(true)
    expect(window.enabledCount + window.disabledCount).toBe(20_000)
    expect(window.remainingCount).toBe(20_000 - RIGHT_PANEL_INITIAL_RENDER_ITEMS)
  })

  it("bounds each skill-tree level independently", () => {
    const nodes = Array.from({ length: 10_000 }, (_, index) => index)
    expect(selectRightPanelWindow(nodes, RIGHT_PANEL_INITIAL_RENDER_ITEMS)).toHaveLength(
      RIGHT_PANEL_INITIAL_RENDER_ITEMS
    )
  })

  it("loads bounded header summaries without hydrating collapsed detail sections", () => {
    const source = readFileSync(new URL("./RightPanel.tsx", import.meta.url), "utf8").replace(
      /\r\n/g,
      "\n"
    )
    expect(source).toContain("if (!skillsOpen) return undefined")
    expect(source).toContain("if (!pluginsOpen) return undefined")
    expect(source).toContain("refreshGlobalCatalogSummary")
    expect(source).toContain("refreshWorkspaceHookSummary")
    expect(source).toContain("const promise = refreshGlobalCatalogSummary()")
    expect(source).toContain("void refreshWorkspaceHookSummary()")
    expect(source).toContain("await globalSummaryPromiseRef.current")
    expect(source).toContain("RIGHT_PANEL_GLOBAL_SUMMARY_SCOPE")
    expect(source).not.toContain("refreshSkillSummary")
    expect(source).not.toContain("refreshPluginSummary")
    expect(source).toContain("page.relatedSummary.skillEntries")
    expect(source).toContain("page.relatedSummary.pluginEntries")
    expect(source).not.toContain("loadSkillCatalogSummary")
    expect(source).not.toContain("loadPluginCatalogSummary")
    expect(source).not.toContain("catalogSummaryWarmupRef")
    expect(source).toContain("limit: 1")
    expect(source).toContain("badge !== undefined && badge !== null")
    expect(source).toContain("getSkillCatalogRevision(pluginVersion)")
    expect(source).toContain("getPluginCatalogRevision(pluginVersion)")
    expect(source).toContain("getGlobalHookCatalogRevision()")
    expect(source).toContain("getWorkspaceHookCatalogRevision(workspacePath)")
    expect(source).toContain("total: snapshot.total")
    expect(source).toContain("truncated: snapshot.truncated")
    expect(source).not.toContain("total: snapshot.plugins.length, truncated: false")
    expect(source).toContain(
      "normalizeWorkspaceFileKey(data.workspacePath) === workspaceKey"
    )
    expect(source).toContain("RIGHT_PANEL_HOOK_REFRESH_DEBOUNCE_MS")
    expect(source).not.toContain("window.api.lsp.getStatus(")
    expect(source).not.toContain(
      "workspaceFileSummaryReady || workspaceFiles.length > 0"
    )
    expect(source).not.toContain("window.api.skills.list()")
    expect(source).not.toContain("window.api.skills.listPlugins()")
    expect(source).not.toContain("window.api.plugins.list()")
    expect(source).not.toContain("badge={hooks.filter((h) => h.enabled).length}")
    expect(source).not.toContain("<HooksContent onChange=")

    const appSource = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8")
    expect(appSource).toContain(
      'loadSkillCatalogPages(key, "app-skill-catalog", isCurrent)'
    )
    expect(appSource).toContain(
      'loadPluginCatalogPages(key, "app-plugin-catalog", isCurrent)'
    )
  })
})
