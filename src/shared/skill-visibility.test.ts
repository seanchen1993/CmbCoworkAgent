import { describe, expect, it } from "vitest"
import { getEnabledPluginSkillMiddlewareSources } from "../main/storage"
import { isSkillVisibleForProjectMode } from "./skill-visibility"

describe("skill visibility", () => {
  it("restricts only project-mode plugin skills", () => {
    const scope = { projectMode: true, boundPluginId: "bound" }
    expect(
      isSkillVisibleForProjectMode({ pluginId: "other", isProjectModePlugin: true }, scope)
    ).toBe(false)
    expect(
      isSkillVisibleForProjectMode({ pluginId: "other", isProjectModePlugin: false }, scope)
    ).toBe(true)
    expect(isSkillVisibleForProjectMode({}, scope)).toBe(true)
  })

  it("hides project-mode skills while the project binding is unresolved", () => {
    expect(isSkillVisibleForProjectMode({ isProjectModePlugin: true }, { projectMode: true })).toBe(
      false
    )
  })

  it("prefers the bound plugin ID over a matching name", () => {
    const skill = { pluginId: "foreign", pluginName: "Same Name", isProjectModePlugin: true }
    expect(
      isSkillVisibleForProjectMode(skill, {
        projectMode: true,
        boundPluginId: "bound",
        boundPluginName: "Same Name"
      })
    ).toBe(false)
    expect(
      isSkillVisibleForProjectMode(skill, { projectMode: true, boundPluginName: "Same Name" })
    ).toBe(true)
  })

  it("assembles middleware sources from only visible plugins", async () => {
    const sources = [
      {
        sourceDir: "/bound",
        pluginRoot: "/bound",
        pluginId: "bound",
        pluginName: "Bound",
        isProjectModePlugin: true,
        maxDepth: 0
      },
      {
        sourceDir: "/foreign",
        pluginRoot: "/foreign",
        pluginId: "foreign",
        pluginName: "Foreign",
        isProjectModePlugin: true,
        maxDepth: 0
      },
      {
        sourceDir: "/shared",
        pluginRoot: "/shared",
        pluginId: "foreign",
        pluginName: "Foreign",
        isProjectModePlugin: false,
        maxDepth: 0
      }
    ]
    const visible = sources.filter((source) =>
      isSkillVisibleForProjectMode(source, { projectMode: true, boundPluginId: "bound" })
    )
    expect(await getEnabledPluginSkillMiddlewareSources(visible)).toEqual([
      "/bound",
      "/shared"
    ])
  })
})
