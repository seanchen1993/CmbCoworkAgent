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
  const matches = skills.filter((skill) => normalizeSkillName(skill.name) === normalizedSlashSkill)
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
 * When `preferredPlugin` is set, duplicate plugin skills are deduplicated in
 * favour of the preferred plugin. Standalone skills are still shown alongside
 * plugin skills with the same name.
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
  const visibleLocalSkills = localSkills
  const enabledVisibleLocalSkills = visibleLocalSkills.filter(
    (skill) => !isSkillDisabled(skill, disabledSkillIds)
  )

  // Conversation mode: list every enabled standalone skill and every enabled
  // plugin skill. Same-name rows are disambiguated by source labels in the UI.
  if (!hasPreferredPlugin) {
    return [...enabledVisibleLocalSkills, ...pluginSkills]
  }

  // Harness mode: keep the bound plugin's row when multiple plugins provide
  // the same skill name, but do not collapse standalone-vs-plugin collisions.
  const seenNames = new Set<string>()
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
