import type { SkillMetadata } from "../../types"
import { isSkillDisabled, normalizeSkillId } from "../../lib/skill-ids"

function normalizeSkillName(value: string): string {
  return normalizeSkillId(value)
}

function normalizePluginName(value: string | undefined | null): string {
  return normalizeSkillId(value)
}

function normalizePluginId(value: string | undefined | null): string {
  return normalizeSkillId(value)
}

type PreferredPlugin = string | { id?: string | null; name?: string | null }

function isPreferredPluginSkill(skill: SkillMetadata, preferredPlugin?: PreferredPlugin | null): boolean {
  if (!preferredPlugin) return false
  if (typeof preferredPlugin === "string") {
    return normalizePluginName(skill.pluginName) === normalizePluginName(preferredPlugin)
  }
  const preferredId = normalizePluginId(preferredPlugin.id)
  const preferredName = normalizePluginName(preferredPlugin.name)
  return Boolean(
    (preferredId && normalizePluginId(skill.pluginId) === preferredId) ||
      (preferredName && normalizePluginName(skill.pluginName) === preferredName)
  )
}

/**
 * Merge built-in/custom skills with plugin skills for chat surfaces.
 *
 * In ordinary chat, enabled first-party skills keep precedence over same-name
 * plugin skills, but disabled first-party skills must not shadow plugin skills.
 *
 * When `preferredPlugin` is set, duplicate-named skills are deduplicated in
 * favour of the preferred plugin. This is used in harness mode to prioritise
 * skills from the project's bound plugin.
 */
export function mergeChatSkills(
  localSkills: SkillMetadata[],
  pluginSkills: SkillMetadata[],
  disabledSkillIds: ReadonlySet<string>,
  preferredPlugin?: PreferredPlugin | null
): SkillMetadata[] {
  const hasPreferredPlugin = Boolean(
    typeof preferredPlugin === "string"
      ? normalizePluginName(preferredPlugin)
      : normalizePluginId(preferredPlugin?.id) || normalizePluginName(preferredPlugin?.name)
  )
  const preferredPluginNames = new Set(
    pluginSkills
      .filter((skill) => isPreferredPluginSkill(skill, preferredPlugin))
      .map((skill) => normalizeSkillName(skill.name))
      .filter(Boolean)
  )
  const visibleLocalSkills = hasPreferredPlugin
    ? localSkills.filter((skill) => !preferredPluginNames.has(normalizeSkillName(skill.name)))
    : localSkills
  const enabledVisibleLocalSkills = visibleLocalSkills.filter(
    (skill) => !isSkillDisabled(skill, disabledSkillIds)
  )
  const enabledLocalNames = new Set(
    enabledVisibleLocalSkills
      .map((skill) => normalizeSkillName(skill.name))
      .filter(Boolean)
  )

  // Without a preferred plugin (conversation mode), only filter out plugin
  // skills whose names are already covered by enabled local skills. Plugins
  // may have duplicate-named skills and both should appear in the popover.
  if (!hasPreferredPlugin) {
    return [
      ...enabledVisibleLocalSkills,
      ...pluginSkills.filter(
        (pluginSkill) => !enabledLocalNames.has(normalizeSkillName(pluginSkill.name))
      )
    ]
  }

  // Harness mode: inter-plugin deduplication. The preferred plugin's skill
  // wins over same-named skills from other plugins.
  const seenNames = new Set(enabledLocalNames)
  const dedupedPlugins: SkillMetadata[] = []

  for (const skill of pluginSkills) {
    const name = normalizeSkillName(skill.name)
    const isPreferredPlugin = isPreferredPluginSkill(skill, preferredPlugin)
    if (!name || seenNames.has(name)) {
      if (isPreferredPlugin) {
        const idx = dedupedPlugins.findIndex(
          (s) =>
            normalizeSkillName(s.name) === name &&
            !isPreferredPluginSkill(s, preferredPlugin)
        )
        if (idx >= 0) {
          dedupedPlugins[idx] = skill
        }
      }
      continue
    }
    seenNames.add(name)
    dedupedPlugins.push(skill)
  }

  return [...enabledVisibleLocalSkills, ...dedupedPlugins]
}
