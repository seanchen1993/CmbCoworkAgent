import { basename } from "path"
import { normalizeSkillRelativePath, type DiscoveredSkill } from "./discovery"

export interface SkillIdentityLike {
  name: string
  relativePath?: string
  rootDir?: string
}

export function normalizeSkillId(input: string): string {
  return normalizeSkillRelativePath(input.trim()).toLowerCase()
}

export function getDiscoveredSkillId(skill: SkillIdentityLike): string {
  const relativeId = normalizeSkillId(skill.relativePath ?? "")
  if (relativeId) return relativeId
  return normalizeSkillId(skill.name)
}

export function getDiscoveredSkillAliases(skill: SkillIdentityLike): string[] {
  const aliases = new Set<string>()
  const id = getDiscoveredSkillId(skill)
  if (id) aliases.add(id)

  const name = normalizeSkillId(skill.name)
  if (name) aliases.add(name)

  const relativePath = normalizeSkillRelativePath(skill.relativePath ?? "")
  if (relativePath) {
    const segments = relativePath.split("/").filter(Boolean)
    const leaf = segments.length > 0 ? segments[segments.length - 1] : undefined
    if (leaf) aliases.add(normalizeSkillId(leaf))
  } else if (skill.rootDir) {
    aliases.add(normalizeSkillId(basename(skill.rootDir)))
  }

  return [...aliases].filter(Boolean)
}

export function resolveDisabledSkillIds(
  disabledEntries: string[],
  skills: DiscoveredSkill[]
): string[] {
  const byId = new Map<string, DiscoveredSkill>()
  const byAlias = new Map<string, Set<string>>()

  for (const skill of skills) {
    const id = getDiscoveredSkillId(skill)
    if (!id) continue
    byId.set(id, skill)
    for (const alias of getDiscoveredSkillAliases(skill)) {
      let ids = byAlias.get(alias)
      if (!ids) {
        ids = new Set<string>()
        byAlias.set(alias, ids)
      }
      ids.add(id)
    }
  }

  const resolved = new Set<string>()
  for (const entry of disabledEntries) {
    const normalized = normalizeSkillId(entry)
    if (!normalized) continue

    if (byId.has(normalized)) {
      resolved.add(normalized)
      continue
    }

    const aliasMatches = byAlias.get(normalized)
    if (aliasMatches && aliasMatches.size > 0) {
      for (const id of aliasMatches) {
        resolved.add(id)
      }
      continue
    }

    resolved.add(normalized)
  }

  return [...resolved]
}

function matchesSkillIdOrDescendant(entry: string, skillId: string): boolean {
  return entry === skillId || entry.startsWith(`${skillId}/`)
}

export function removeDisabledSkillEntriesForSkills(
  disabledEntries: string[],
  skillsToRemove: SkillIdentityLike[],
  remainingSkills: SkillIdentityLike[]
): string[] {
  const removedIds = new Set(
    skillsToRemove.map((skill) => getDiscoveredSkillId(skill)).filter(Boolean)
  )
  const removedAliases = new Set(skillsToRemove.flatMap(getDiscoveredSkillAliases))
  const remainingIds = new Set(
    remainingSkills.map((skill) => getDiscoveredSkillId(skill)).filter(Boolean)
  )
  const remainingAliases = new Set(remainingSkills.flatMap(getDiscoveredSkillAliases))
  const kept: string[] = []
  const seen = new Set<string>()

  for (const entry of disabledEntries) {
    const normalized = normalizeSkillId(entry)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)

    const targetsRemovedId = [...removedIds].some((id) =>
      matchesSkillIdOrDescendant(normalized, id)
    )
    if (targetsRemovedId) continue

    const targetsRemovedAlias =
      removedAliases.has(normalized) &&
      !remainingAliases.has(normalized) &&
      !remainingIds.has(normalized)
    if (targetsRemovedAlias) continue

    kept.push(entry)
  }

  return kept
}

export function isDiscoveredSkillDisabled(
  skill: SkillIdentityLike,
  disabledSkillIds: ReadonlySet<string>
): boolean {
  const skillId = getDiscoveredSkillId(skill)
  if (!skillId) return false
  for (const disabledId of disabledSkillIds) {
    if (matchesSkillIdOrDescendant(skillId, normalizeSkillId(disabledId))) {
      return true
    }
  }
  return false
}
