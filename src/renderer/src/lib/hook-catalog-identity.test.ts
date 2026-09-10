import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { getHookCatalogIdentity } from "./hook-catalog-identity"

describe("hook catalog UI identity", () => {
  it("isolates a standalone skill hook from a same-name plugin skill hook", () => {
    const standalone = {
      source: "skill" as const,
      id: "skill:review/shared",
      skillName: "review",
      skillPath: "C:/skills/review",
      hookPath: "C:/skills/review/hooks.json"
    }
    const pluginOwned = {
      source: "skill" as const,
      id: "skill:review/shared",
      skillName: "review",
      skillPath: "C:/plugins/plugin-a/skills/review",
      hookPath: "C:/plugins/plugin-a/skills/review/hooks.json",
      pluginId: "plugin-a"
    }

    expect(getHookCatalogIdentity(standalone)).not.toBe(getHookCatalogIdentity(pluginOwned))
    expect(getHookCatalogIdentity(pluginOwned)).toBe(getHookCatalogIdentity({ ...pluginOwned }))
    expect(standalone.id).toBe(pluginOwned.id)
  })

  it("uses the catalog identity for list keys and selection without rewriting runtime ids", () => {
    const hooksPanel = readFileSync(
      new URL("../components/customize/HooksPanel.tsx", import.meta.url),
      "utf8"
    )
    const rightPanel = readFileSync(
      new URL("../components/panels/RightPanel.tsx", import.meta.url),
      "utf8"
    )

    expect(hooksPanel).toContain("getHookCatalogIdentity")
    expect(hooksPanel).not.toContain('key={`${hook.source}:${hook.id}`}')
    expect(rightPanel).toContain("getHookCatalogIdentity(hook)")
  })
})
