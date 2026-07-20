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

export type PreferredPlugin = string | { id?: string | null; name?: string | null }

function hasPreferredPlugin(preferredPlugin?: PreferredPlugin | null): boolean {
  return Boolean(
    typeof preferredPlugin === "string"
      ? normalizePluginName(preferredPlugin)
      : normalizePluginId(preferredPlugin?.id) || normalizePluginName(preferredPlugin?.name)
  )
}

function isPluginSkill(skill: SkillMetadata): boolean {
  return Boolean(skill.pluginId?.trim() || skill.pluginName?.trim())
}

export function isPreferredPluginSkill(skill: SkillMetadata, preferredPlugin?: PreferredPlugin | null): boolean {
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

export function selectSkillForSlashName(
  skills: SkillMetadata[],
  slashSkill: string,
  preferredPlugin?: PreferredPlugin | null
): SkillMetadata | null {
  const normalizedSlashSkill = normalizeSkillName(slashSkill)
  if (!normalizedSlashSkill) return null
  const matches = skills.filter((skill) => {
    if (normalizeSkillName(skill.name) !== normalizedSlashSkill) return false
    if (!hasPreferredPlugin(preferredPlugin)) return true
    return !isPluginSkill(skill) || isPreferredPluginSkill(skill, preferredPlugin)
  })
  if (matches.length === 0) return null
  return matches.find((skill) => isPreferredPluginSkill(skill, preferredPlugin)) ?? matches[0]
}

/**
 * Merge built-in/custom skills with plugin skills for chat surfaces.
 *
 * Slash/chat surfaces must keep same-name skills from different sources visible
 * so users can explicitly choose the standalone skill or the plugin-owned skill.
 * The selected skill is later serialized with its absolute SKILL.md path, so
 * runtime routing does not have to guess by name.
 *
 * When `preferredPlugin` is set, project-mode chat surfaces only expose
 * standalone skills and skills owned by the bound plugin.
 */
export function mergeChatSkills(
  localSkills: SkillMetadata[],
  pluginSkills: SkillMetadata[],
  disabledSkillIds: ReadonlySet<string>,
  preferredPlugin?: PreferredPlugin | null
): SkillMetadata[] {
  const hasProjectPlugin = hasPreferredPlugin(preferredPlugin)
  const visibleLocalSkills = localSkills
  const enabledVisibleLocalSkills = visibleLocalSkills.filter(
    (skill) => !isSkillDisabled(skill, disabledSkillIds)
  )

  // Conversation mode: list every enabled standalone skill and every enabled
  // plugin skill. Same-name rows are disambiguated by source labels in the UI.
  if (!hasProjectPlugin) {
    return [...enabledVisibleLocalSkills, ...pluginSkills]
  }

  const boundPluginSkills = pluginSkills.filter((skill) =>
    isPreferredPluginSkill(skill, preferredPlugin)
  )
  return [...enabledVisibleLocalSkills, ...boundPluginSkills]
}
