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
 *
 * When `preferredPluginId` is set, duplicate-named skills across plugins are
 * deduplicated in favour of the preferred plugin. This is used in harness mode
 * to prioritise skills from the project's bound plugin.
 */
export function mergeChatSkills(
  localSkills: SkillMetadata[],
  pluginSkills: SkillMetadata[],
  disabledSkillIds: ReadonlySet<string>,
  preferredPluginId?: string | null
): SkillMetadata[] {
  const enabledLocalNames = new Set(
    localSkills
      .filter((skill) => !isSkillDisabled(skill, disabledSkillIds))
      .map((skill) => normalizeSkillName(skill.name))
      .filter(Boolean)
  )

  // Without a preferred plugin (conversation mode), only filter out plugin
  // skills whose names are already covered by enabled local skills. Plugins
  // may have duplicate-named skills and both should appear in the popover.
  if (!preferredPluginId) {
    return [
      ...localSkills,
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
    if (!name || seenNames.has(name)) {
      if (skill.pluginId === preferredPluginId) {
        const idx = dedupedPlugins.findIndex(
          (s) => normalizeSkillName(s.name) === name && s.pluginId !== preferredPluginId
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

  return [...localSkills, ...dedupedPlugins]
}
