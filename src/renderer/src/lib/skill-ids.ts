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

function matchesSkillIdOrDescendant(skillId: string, disabledId: string): boolean {
  return skillId === disabledId || skillId.startsWith(`${disabledId}/`)
}

export function isSkillDisabled(
  skill: SkillMetadata,
  disabledSkillIds: ReadonlySet<string>
): boolean {
  const id = getSkillMetadataId(skill)
  const name = normalizeSkillId(skill.name)
  if (id) {
    for (const disabledId of disabledSkillIds) {
      if (matchesSkillIdOrDescendant(id, normalizeSkillId(disabledId))) return true
    }
  }
  return !!name && disabledSkillIds.has(name)
}
