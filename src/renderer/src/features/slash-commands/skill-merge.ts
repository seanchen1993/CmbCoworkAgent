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

  // Deduplicate plugin skills by name: when `preferredPluginId` is given,
  // the preferred plugin's skill wins over same-named skills from other
  // plugins. Without a preference, the first encountered skill wins.
  const seenPluginNames = new Set(enabledLocalNames)
  const dedupedPlugins: SkillMetadata[] = []

  for (const skill of pluginSkills) {
    const name = normalizeSkillName(skill.name)
    if (!name || seenPluginNames.has(name)) {
      // Already covered by a local skill or a previously added plugin skill.
      // Replace the existing entry when this one comes from the preferred plugin.
      if (preferredPluginId && skill.pluginId === preferredPluginId && seenPluginNames.has(name)) {
        const idx = dedupedPlugins.findIndex(
          (s) => normalizeSkillName(s.name) === name && s.pluginId !== preferredPluginId
        )
        if (idx >= 0) {
          dedupedPlugins[idx] = skill
        }
      }
      continue
    }
    seenPluginNames.add(name)
    dedupedPlugins.push(skill)
  }

  return [...localSkills, ...dedupedPlugins]
}
