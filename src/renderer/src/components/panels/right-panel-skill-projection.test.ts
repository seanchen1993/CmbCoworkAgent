import { beforeEach, describe, expect, it } from "vitest"
import type { SkillMetadata } from "@/types"
import {
  getRightPanelSkillProjection,
  getRightPanelSkillProjectionAsync,
  getRightPanelSkillProjectionDiagnostics,
  resetRightPanelSkillProjectionDiagnosticsForTests
} from "./right-panel-skill-projection"

function skill(index: number): SkillMetadata {
  const group = Math.floor(index / 100)
  return {
    id: `skill-${index}`,
    name: index % 17 === 0 ? "typescript-advanced-types" : `skill-${index}`,
    description: `skill ${index}`,
    path: `C:/skills/group-${group}/skill-${index}/SKILL.md`,
    relativePath: `group-${group}/skill-${index}/SKILL.md`,
    source: "user",
    version: "1.0.0"
  }
}

describe("right-panel skill projection", () => {
  beforeEach(() => resetRightPanelSkillProjectionDiagnosticsForTests())

  it("cooperatively builds a 20k directory projection once without blocking timers", async () => {
    const skills = Array.from({ length: 20_000 }, (_, index) => skill(index))
    const disabled = new Set(["skill-1", "skill-10001"])
    let timerTicks = 0
    const timer = setInterval(() => {
      timerTicks += 1
    }, 1)

    const firstBuild = getRightPanelSkillProjectionAsync(skills, disabled)
    const sharedBuild = getRightPanelSkillProjectionAsync(skills, disabled)
    expect(sharedBuild).toBe(firstBuild)
    const first = await firstBuild
    clearInterval(timer)
    for (let index = 0; index < 100; index += 1) {
      expect(getRightPanelSkillProjection(skills, disabled)).toBe(first)
    }

    expect(timerTicks).toBeGreaterThan(10)
    expect(getRightPanelSkillProjectionDiagnostics().buildCount).toBe(1)
    expect(first.enabled.length + first.disabled.length).toBe(20_000)
    expect(first.disabled).toHaveLength(2)
    expect(
      first.enabledGeneral.tree.reduce((sum, node) => sum + node.skillCount, 0) +
        first.enabledProgramming.tree.reduce((sum, node) => sum + node.skillCount, 0)
    ).toBe(first.enabled.length)
  }, 15_000)

  it("rebuilds only when the catalog or disabled-set identity changes", () => {
    const skills = [skill(1), skill(2)]
    const firstDisabled = new Set<string>()
    const secondDisabled = new Set(["skill-2"])

    const first = getRightPanelSkillProjection(skills, firstDisabled)
    const second = getRightPanelSkillProjection(skills, secondDisabled)

    expect(second).not.toBe(first)
    expect(second.disabled.map((item) => item.id)).toEqual(["skill-2"])
    expect(getRightPanelSkillProjectionDiagnostics().buildCount).toBe(2)
  })

  it("does not classify a same-name plugin skill as disabled", () => {
    const standalone = skill(1)
    const skillId = standalone.id ?? standalone.name
    const plugin = {
      ...standalone,
      id: `plugin:plugin-a/${skillId}`,
      path: `C:/plugins/plugin-a/skills/${skillId}/SKILL.md`,
      pluginId: "plugin-a",
      pluginName: "Plugin A"
    }

    const projection = getRightPanelSkillProjection([standalone, plugin], new Set([skillId]))

    expect(projection.disabled).toEqual([standalone])
    expect(projection.enabled).toEqual([plugin])
  })
})
