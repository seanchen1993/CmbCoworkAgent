/**
 * Regression tests for slash-command skill merging.
 *
 * Run:
 *   npx tsx tests/slash-skill-merge.spec.ts
 */

import { mergeChatSkills } from "../src/renderer/src/features/slash-commands/skill-merge.ts"
import type { SkillMetadata } from "../src/renderer/src/types.ts"

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function skill(partial: Partial<SkillMetadata> & Pick<SkillMetadata, "name" | "source">): SkillMetadata {
  return {
    id: partial.name,
    description: "",
    path: `C:/skills/${partial.name}/SKILL.md`,
    version: "v1.0.0",
    ...partial
  }
}

function names(skills: SkillMetadata[]): string[] {
  return skills.map((item) => `${item.pluginId ? "plugin" : "local"}:${item.name}`)
}

function run(): void {
  const disabledSameName = skill({ id: "same-name", name: "same-name", source: "user" })
  const enabledSameName = skill({ id: "same-name", name: "same-name", source: "user" })
  const pluginSameName = skill({
    id: "plugin:demo/same-name",
    name: "same-name",
    source: "user",
    pluginId: "demo"
  })

  const withDisabledLocal = mergeChatSkills(
    [disabledSameName],
    [pluginSameName],
    new Set(["same-name"])
  )
  assert(
    names(withDisabledLocal).join(",") === "plugin:same-name",
    `disabled local skill should be hidden while same-name plugin remains: ${names(withDisabledLocal)}`
  )

  const withEnabledLocal = mergeChatSkills([enabledSameName], [pluginSameName], new Set())
  assert(
    names(withEnabledLocal).join(",") === "local:same-name",
    `enabled local skill should keep precedence over same-name plugin skill: ${names(withEnabledLocal)}`
  )

  const disabledUnique = skill({ id: "unique-local", name: "unique-local", source: "project" })
  const withUniqueDisabledLocal = mergeChatSkills([disabledUnique], [], new Set(["unique-local"]))
  assert(
    withUniqueDisabledLocal.length === 0,
    `disabled local skill should not enter slash skills: ${names(withUniqueDisabledLocal)}`
  )

  console.log("PASS slash skill merge hides disabled local skills without shadowing plugin skills")
}

run()
