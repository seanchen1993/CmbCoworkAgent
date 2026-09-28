import type { SkillMetadata } from "../../types"
import { isSkillDisabled, normalizeSkillId } from "../../lib/skill-ids"
import {
  isSkillOwnedByBoundPlugin,
  isSkillVisibleForProjectMode,
  type ProjectModeSkillScope
} from "../../../../shared/skill-visibility"

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

function toProjectModeSkillScope(
  preferredPlugin: PreferredPlugin | null | undefined,
  projectMode: boolean
): ProjectModeSkillScope {
  if (typeof preferredPlugin === "string") {
    return { projectMode, boundPluginName: preferredPlugin }
  }
  return {
    projectMode,
    boundPluginId: preferredPlugin?.id,
    boundPluginName: preferredPlugin?.name
  }
}

export function isPreferredPluginSkill(
  skill: SkillMetadata,
  preferredPlugin?: PreferredPlugin | null
): boolean {
  if (!preferredPlugin) return false
  return isSkillOwnedByBoundPlugin(skill, toProjectModeSkillScope(preferredPlugin, true))
}

export function selectSkillForSlashName(
  skills: SkillMetadata[],
  slashSkill: string,
  preferredPlugin?: PreferredPlugin | null,
  projectMode = hasPreferredPlugin(preferredPlugin)
): SkillMetadata | null {
  const normalizedSlashSkill = normalizeSkillName(slashSkill)
  if (!normalizedSlashSkill) return null
  const visibilityScope = toProjectModeSkillScope(preferredPlugin, projectMode)
  const matches = skills.filter((skill) => {
    if (normalizeSkillName(skill.name) !== normalizedSlashSkill) return false
    return isSkillVisibleForProjectMode(skill, visibilityScope)
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
 * When `projectMode` is enabled, only project-mode plugin skills owned by the
 * bound plugin are exposed; non-project plugin skills remain available.
 */
export function mergeChatSkills(
  localSkills: SkillMetadata[],
  pluginSkills: SkillMetadata[],
  disabledSkillIds: ReadonlySet<string>,
  preferredPlugin?: PreferredPlugin | null,
  projectMode = hasPreferredPlugin(preferredPlugin)
): SkillMetadata[] {
  const visibilityScope = toProjectModeSkillScope(preferredPlugin, projectMode)
  const visibleLocalSkills = localSkills
  const enabledVisibleLocalSkills = visibleLocalSkills.filter(
    (skill) => !isSkillDisabled(skill, disabledSkillIds)
  )

  const visiblePluginSkills = pluginSkills.filter((skill) =>
    isSkillVisibleForProjectMode(skill, visibilityScope)
  )
  return [...enabledVisibleLocalSkills, ...visiblePluginSkills]
}
