import type { SkillMetadata } from "@/types"

export function normalizeSkillId(value: string | undefined | null): string {
  return (value ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase()
}

export function getSkillMetadataId(skill: SkillMetadata): string {
  return normalizeSkillId(skill.id || skill.relativePath || skill.name)
}

export function isSkillDisabled(skill: SkillMetadata, disabledSkillIds: ReadonlySet<string>): boolean {
  const id = getSkillMetadataId(skill)
  const name = normalizeSkillId(skill.name)
  return (!!id && disabledSkillIds.has(id)) || (!!name && disabledSkillIds.has(name))
}
