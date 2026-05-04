export const DEFAULT_SKILL_VERSION = "v1.0.0"

const SKILL_VERSION_SUFFIX_RE = /^(.*?)-(v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/

export function normalizeSkillVersion(version: string | undefined | null): string {
  const trimmed = typeof version === "string" ? version.trim() : ""
  if (!trimmed) return DEFAULT_SKILL_VERSION
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`
}

export function parseSkillIdentifier(skill: string): { name: string; version?: string } {
  const trimmed = typeof skill === "string" ? skill.trim() : ""
  if (!trimmed) return { name: "" }

  const match = trimmed.match(SKILL_VERSION_SUFFIX_RE)
  if (!match) return { name: trimmed }

  const name = match[1].trim()
  if (!name) return { name: trimmed }

  return {
    name,
    version: normalizeSkillVersion(match[2])
  }
}

export function ensureVersionedSkillIdentifier(
  skill: string,
  version?: string | null
): string {
  const parsed = parseSkillIdentifier(skill)
  if (!parsed.name) return ""
  return `${parsed.name}-${parsed.version ?? normalizeSkillVersion(version)}`
}

export function getSkillIdentifierLookupTerms(skill: string): string[] {
  const parsed = parseSkillIdentifier(skill)
  if (!parsed.name) return []

  const terms = new Set<string>()
  if (parsed.version) {
    terms.add(`${parsed.name}-${parsed.version}`)
    terms.add(parsed.name)
  } else {
    terms.add(parsed.name)
    terms.add(ensureVersionedSkillIdentifier(parsed.name))
  }

  return Array.from(terms)
}
