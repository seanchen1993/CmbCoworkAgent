/**
 * Regression tests for slash-command skill merging.
 *
 * Run:
 *   npx tsx tests/slash-skill-merge.spec.ts
 */

import {
  mergeChatSkills,
  selectSkillForSlashName
} from "../src/renderer/src/features/slash-commands/skill-merge.ts"
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
    names(withEnabledLocal).join(",") === "local:same-name,plugin:same-name",
    `enabled local and same-name plugin skill should both remain visible: ${names(withEnabledLocal)}`
  )

  const preferredPluginDoesNotShadowLocal = mergeChatSkills(
    [enabledSameName],
    [pluginSameName],
    new Set(),
    { id: "demo", name: "Demo Plugin" }
  )
  assert(
    names(preferredPluginDoesNotShadowLocal).join(",") === "local:same-name,plugin:same-name",
    `preferred plugin should be shown alongside same-name standalone skill: ${names(preferredPluginDoesNotShadowLocal)}`
  )

  const otherPluginSameName = skill({
    id: "plugin:other/same-name",
    name: "same-name",
    source: "user",
    pluginId: "other"
  })
  const sameNameAcrossPlugins = mergeChatSkills(
    [],
    [pluginSameName, otherPluginSameName],
    new Set()
  )
  assert(
    names(sameNameAcrossPlugins).join(",") === "plugin:same-name,plugin:same-name",
    `same-name plugin skills should both remain visible without a preference: ${names(sameNameAcrossPlugins)}`
  )

  const preferredPluginWinsAmongPlugins = mergeChatSkills(
    [],
    [otherPluginSameName, pluginSameName],
    new Set(),
    { id: "demo", name: "Demo Plugin" }
  )
  assert(
    preferredPluginWinsAmongPlugins.length === 1 &&
      preferredPluginWinsAmongPlugins[0].pluginId === "demo",
    `preferred plugin should only dedupe same-name plugin rows: ${names(preferredPluginWinsAmongPlugins)}`
  )

  const autoSelected = selectSkillForSlashName(
    [enabledSameName, pluginSameName],
    "same-name",
    { id: "demo", name: "Demo Plugin" }
  )
  assert(
    autoSelected?.pluginId === "demo",
    `harness nextAction should prefer bound plugin skill over same-name local skill: ${autoSelected?.id}`
  )

  const manualFallback = selectSkillForSlashName([enabledSameName, pluginSameName], "same-name")
  assert(
    manualFallback === enabledSameName,
    `without a preferred plugin, slash skill selection should keep list order: ${manualFallback?.id}`
  )

  const disabledUnique = skill({ id: "unique-local", name: "unique-local", source: "project" })
  const withUniqueDisabledLocal = mergeChatSkills([disabledUnique], [], new Set(["unique-local"]))
  assert(
    withUniqueDisabledLocal.length === 0,
    `disabled local skill should not enter slash skills: ${names(withUniqueDisabledLocal)}`
  )

  console.log("PASS slash skill merge keeps cross-source duplicate skills visible")
}

run()
