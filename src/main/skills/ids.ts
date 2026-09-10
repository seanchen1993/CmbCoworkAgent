import { basename } from "path"
import {
  MAX_SKILL_DISCOVERY_DEPTH,
  normalizeSkillRelativePath,
  type DiscoveredSkill
} from "./discovery"

export const MAX_CANONICAL_STANDALONE_SKILL_ID_LENGTH = 4_096
export const MAX_DISABLED_STANDALONE_SKILL_IDS = 20_000
const PLUGIN_SKILL_ID_PREFIX = "plugin:"

export interface SkillIdentityLike {
  name: string
  relativePath?: string
  rootDir?: string
}

export function normalizeSkillId(input: string): string {
  return normalizeSkillRelativePath(input.trim()).toLowerCase()
}

function isPluginSkillId(skillId: string): boolean {
  return skillId.startsWith(PLUGIN_SKILL_ID_PREFIX)
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/**
 * Validate the exact standalone identity emitted by the catalog worker.
 *
 * This deliberately performs no discovery and no filesystem reads: a renderer
 * toggle must not synchronously walk every skill directory on Electron main.
 * Legacy display-name aliases are resolved only by the batch/worker paths.
 */
export function normalizeCanonicalStandaloneSkillId(input: string): string | null {
  if (
    input.length === 0 ||
    input.length > MAX_CANONICAL_STANDALONE_SKILL_ID_LENGTH ||
    input !== input.trim() ||
    input.includes("\\") ||
    hasControlCharacter(input)
  ) {
    return null
  }

  const normalized = normalizeSkillId(input)
  if (!normalized || normalized !== input || isPluginSkillId(normalized)) return null

  const segments = normalized.split("/")
  if (
    segments.length > MAX_SKILL_DISCOVERY_DEPTH ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null
  }
  return normalized
}

/**
 * Normalize the persisted standalone snapshot without resolving legacy aliases.
 * Plugin-owned ids never enter this store, even if an older build wrote one.
 */
export function normalizeStandaloneDisabledSkillIds(disabledSkillIds: string[]): string[] {
  const normalized = new Set<string>()
  for (const entry of disabledSkillIds) {
    const skillId = normalizeSkillId(entry)
    if (
      !skillId ||
      isPluginSkillId(skillId) ||
      skillId.length > MAX_CANONICAL_STANDALONE_SKILL_ID_LENGTH
    ) {
      continue
    }
    normalized.add(skillId)
    if (normalized.size >= MAX_DISABLED_STANDALONE_SKILL_IDS) break
  }
  return [...normalized]
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

/**
 * Apply one enablement change to a canonical disabled-skill snapshot.
 *
 * Only an exact canonical id from the standalone builtin/custom catalog may be
 * mutated. Plugin-owned ids intentionally remain outside this store because a
 * plugin skill is controlled by its plugin's enablement state.
 */
export function setDisabledSkillIdState(
  disabledSkillIds: string[],
  skillId: string,
  disabled: boolean
): string[] {
  const current = new Set(normalizeStandaloneDisabledSkillIds(disabledSkillIds))
  const targetId = normalizeCanonicalStandaloneSkillId(skillId)
  if (!targetId) return [...current]

  if (disabled) {
    if (current.size < MAX_DISABLED_STANDALONE_SKILL_IDS || current.has(targetId)) {
      current.add(targetId)
    }
  } else {
    current.delete(targetId)
  }
  return [...current]
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

  // resolveDisabledSkillIds normalizes aliases once at the storage/catalog
  // boundary. Walk this skill's ancestor chain with indexed Set lookups so a
  // large disabled catalog stays O(path depth), not O(skills × disabled ids).
  let candidate = skillId
  while (candidate) {
    if (disabledSkillIds.has(candidate)) return true
    const separator = candidate.lastIndexOf("/")
    if (separator < 0) break
    candidate = candidate.slice(0, separator)
  }
  return false
}
