import type { SkillMetadata } from "@/types"

export function normalizeSkillId(value: string | undefined | null): string {
  return (value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase()
}

export function getSkillMetadataId(skill: SkillMetadata): string {
  return normalizeSkillId(skill.id || skill.relativePath || skill.name)
}

function isPluginOwnedSkill(skill: SkillMetadata): boolean {
  return Boolean(skill.pluginId?.trim())
}

export function isSkillDisabled(
  skill: SkillMetadata,
  disabledSkillIds: ReadonlySet<string>
): boolean {
  // Plugin-owned skills are controlled by plugin enablement. In particular,
  // a legacy standalone name in disabled-skills.json must not disable a
  // same-name skill exposed by an enabled plugin.
  if (isPluginOwnedSkill(skill)) return false

  const id = getSkillMetadataId(skill)
  const name = normalizeSkillId(skill.name)
  if (id) {
    // The catalog normalizes disabled ids before constructing this Set. Walk
    // only this skill's ancestors instead of scanning the entire disabled Set
    // for every skill (O(path depth), rather than O(skills × disabled ids)).
    let candidate = id
    while (candidate) {
      if (disabledSkillIds.has(candidate)) return true
      const separator = candidate.lastIndexOf("/")
      if (separator < 0) break
      candidate = candidate.slice(0, separator)
    }
  }
  return !!name && disabledSkillIds.has(name)
}
