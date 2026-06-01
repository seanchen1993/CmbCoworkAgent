export const DEFAULT_SKILL_VERSION = "v1.0.0"

const SKILL_VERSION_SUFFIX_RE = /^(.*?)-(v?\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?)$/
const SKILL_VERSION_QUERY_SUFFIX_RE = /-v?\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?$/i
const SKILL_PACKAGE_EXTENSION_RE = /\.(zip|tar\.gz|tgz|md)$/i

export function normalizeSkillVersion(version: string | undefined | null): string {
  const trimmed = typeof version === "string" ? version.trim() : ""
  if (!trimmed) return DEFAULT_SKILL_VERSION
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`
}

export function normalizeSkillIdentifierText(raw: string): string {
  return String(raw || "")
    .trim()
    .replace(/^\$/, "")
    .replace(SKILL_PACKAGE_EXTENSION_RE, "")
}

export function normalizeSkillQueryName(raw: string): string {
  return normalizeSkillIdentifierText(raw)
    .replace(SKILL_VERSION_QUERY_SUFFIX_RE, "")
    .trim()
}

export function parseSkillIdentifier(skill: string): { name: string; version?: string } {
  const trimmed = normalizeSkillIdentifierText(skill)
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

export function parseSkillNameVersionIdentifier(
  skill: string,
  fallbackName = "unknown"
): { skillName: string; skillVersion?: string } {
  const parsed = parseSkillIdentifier(skill)
  return {
    skillName: parsed.name || fallbackName,
    ...(parsed.version ? { skillVersion: parsed.version } : {})
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

/**
 * Strip enclosing single- or double-quotes from a YAML scalar value.
 * Handles values like `"hello"` → `hello` or `'world'` → `world`.
 */
export function stripYamlQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "")
}

/**
 * Minimal YAML frontmatter parser (only key: value pairs).
 * Does not handle nested structures or YAML syntax beyond simple scalars.
 */
export function parseYamlFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}

  const result: Record<string, string> = {}
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":")
    if (colonIdx <= 0) continue
    const key = line.slice(0, colonIdx).trim()
    const value = stripYamlQuotes(line.slice(colonIdx + 1).trim())
    if (key) result[key] = value
  }
  return result
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
