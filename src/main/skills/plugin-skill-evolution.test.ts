import { describe, expect, it } from "vitest"
import { join, resolve } from "path"

import { isPluginSkillWriteAllowed } from "./plugin-skill-evolution"

const PLUGIN_A = resolve("/home/u/.cmbcoworkagent/plugins/plugin-a/skills")
const PLUGIN_B = resolve("/home/u/.cmbcoworkagent/plugins/plugin-b/skills")
const CUSTOM = resolve("/home/u/.cmbcoworkagent/skills")

describe("isPluginSkillWriteAllowed", () => {
  const enabled = [PLUGIN_A, PLUGIN_B]

  it("allows a skill dir nested under an enabled plugin source dir", () => {
    expect(isPluginSkillWriteAllowed(join(PLUGIN_A, "pdf"), enabled)).toBe(true)
    expect(isPluginSkillWriteAllowed(join(PLUGIN_B, "office", "docx"), enabled)).toBe(true)
  })

  it("allows the source dir itself (containment is inclusive)", () => {
    expect(isPluginSkillWriteAllowed(PLUGIN_A, enabled)).toBe(true)
  })

  it("denies a skill dir outside every enabled plugin source dir", () => {
    expect(isPluginSkillWriteAllowed(join(CUSTOM, "pdf"), enabled)).toBe(false)
    expect(isPluginSkillWriteAllowed(resolve("/etc/passwd"), enabled)).toBe(false)
  })

  it("denies path traversal that escapes a plugin source dir", () => {
    expect(isPluginSkillWriteAllowed(join(PLUGIN_A, "..", "..", "evil"), enabled)).toBe(false)
  })

  it("denies a sibling dir that shares a prefix but is not nested", () => {
    // ".../plugins/plugin-a/skills" vs sibling ".../plugins/plugin-a/skills-evil"
    expect(isPluginSkillWriteAllowed(`${PLUGIN_A}-evil`, enabled)).toBe(false)
  })

  it("denies when no plugins are enabled (empty source list)", () => {
    expect(isPluginSkillWriteAllowed(join(PLUGIN_A, "pdf"), [])).toBe(false)
  })

  it("denies an empty skill dir", () => {
    expect(isPluginSkillWriteAllowed("", enabled)).toBe(false)
  })
})
