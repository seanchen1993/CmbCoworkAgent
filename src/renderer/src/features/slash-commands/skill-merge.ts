import type { SkillMetadata } from "../../types"
import { isSkillDisabled, normalizeSkillId } from "../../lib/skill-ids"

function normalizeSkillName(value: string): string {
  return normalizeSkillId(value)
}

/**
 * Merge built-in/custom skills with plugin skills for chat surfaces.
 *
 * Enabled first-party skills keep precedence over same-name plugin skills, but
 * disabled first-party skills must not shadow plugin skills. Otherwise a user
 * can disable/uninstall the standalone copy and still lose the plugin-provided
 * command from the slash popover.
 */
export function mergeChatSkills(
  localSkills: SkillMetadata[],
  pluginSkills: SkillMetadata[],
  disabledSkillIds: ReadonlySet<string>
): SkillMetadata[] {
  const enabledLocalSkills = localSkills.filter(
    (skill) => !isSkillDisabled(skill, disabledSkillIds)
  )
  const enabledLocalNames = new Set(
    enabledLocalSkills
      .map((skill) => normalizeSkillName(skill.name))
      .filter(Boolean)
  )

  return [
    ...enabledLocalSkills,
    ...pluginSkills.filter(
      (pluginSkill) => !enabledLocalNames.has(normalizeSkillName(pluginSkill.name))
    )
  ]
}
