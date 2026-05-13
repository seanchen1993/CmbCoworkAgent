/**
 * Regression tests for the welcome-page skill grouping used by ChatContainer.
 *
 * Run:
 *   npx tsx tests/welcome-skill-grouping.spec.ts
 */

import { groupWelcomeSkills } from "../src/renderer/src/components/chat/skill-grouping.ts"
import type { SkillMetadata } from "../src/renderer/src/types.ts"

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function names(skills: SkillMetadata[]): string[] {
  return skills.map((skill) => skill.name)
}

function skill(partial: Partial<SkillMetadata> & Pick<SkillMetadata, "name" | "source">): SkillMetadata {
  return {
    description: "",
    path: `C:/skills/${partial.name}/SKILL.md`,
    version: "v1.0.0",
    ...partial
  }
}

function run(): void {
  const disabled = new Set(["builtin-general", "custom-disabled", "custom-parent"])
  const buckets = groupWelcomeSkills(
    [
      skill({ id: "builtin-general", name: "builtin-general", source: "project" }),
      skill({ id: "builtin-programming", name: "builtin-programming", source: "project" }),
      skill({ id: "custom-enabled", name: "custom-enabled", source: "user" }),
      skill({ id: "custom-disabled", name: "custom-disabled", source: "user" }),
      skill({ id: "custom-parent/child", name: "custom-child", source: "user" }),
      skill({ id: "featured-user", name: "featured-user", source: "user" }),
      skill({ id: "encrypt-password", name: "encrypt-password", source: "user" }),
      skill({
        id: "plugin:demo/plugin-skill",
        name: "plugin-skill",
        source: "user",
        pluginId: "demo"
      })
    ],
    [{ name: "featured-user" }],
    (item) => {
      if (item.pluginId) return false
      const id = item.id || item.name
      return [...disabled].some((disabledId) => id === disabledId || id.startsWith(`${disabledId}/`))
    },
    (item) => item.id === "builtin-programming"
  )

  assert(
    names(buckets.generalSkills).length === 0,
    `disabled built-in skills should not appear in generalSkills: ${names(buckets.generalSkills)}`
  )
  assert(
    names(buckets.programmingSkills).join(",") === "builtin-programming",
    `enabled programming built-in skill should be grouped separately: ${names(buckets.programmingSkills)}`
  )
  assert(
    names(buckets.enabledCustomSkills).join(",") === "custom-enabled,plugin-skill",
    `enabled custom grouping mismatch: ${names(buckets.enabledCustomSkills)}`
  )
  assert(
    names(buckets.disabledLocalSkills).join(",") === "custom-disabled,custom-child",
    `disabled list should include only disabled pure custom skills: ${names(buckets.disabledLocalSkills)}`
  )
  assert(
    !names(buckets.disabledLocalSkills).includes("builtin-general"),
    "disabled built-in skills must not be rendered under custom disabled skills"
  )
  assert(
    !names(buckets.disabledLocalSkills).includes("featured-user"),
    "disabled/filtered marketplace good skills must stay out of custom disabled skills"
  )
  assert(
    !names(buckets.disabledLocalSkills).includes("encrypt-password"),
    "hard-filtered encrypt-password skill must stay out of custom disabled skills"
  )
  assert(
    !names(buckets.disabledLocalSkills).includes("plugin-skill"),
    "plugin-owned skills must not be treated as locally disabled skills"
  )

  console.log("PASS welcome skill grouping excludes built-in, featured, hard-filtered and plugin skills")
}

run()
