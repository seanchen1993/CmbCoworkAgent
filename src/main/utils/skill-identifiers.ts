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
  return normalizeSkillIdentifierText(raw).replace(SKILL_VERSION_QUERY_SUFFIX_RE, "").trim()
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

export function ensureVersionedSkillIdentifier(skill: string, version?: string | null): string {
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
 * Strip a YAML inline comment from a scalar: an unquoted `#` preceded by start
 * or whitespace begins a comment (`read_only # note` → `read_only`). Respects
 * quotes so `"a # b"` keeps the `#`. Without this, `workload: read_only # x` was
 * read as the literal `read_only # x` (≠ the `read_only` enum), silently widening
 * a restricted agent to full — a real privilege bug, so strip it here.
 */
export function stripYamlInlineComment(value: string): string {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (c === "'" && !inDouble) inSingle = !inSingle
    else if (c === '"' && !inSingle) inDouble = !inDouble
    else if (c === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i)
    }
  }
  return value
}

/**
 * Minimal YAML frontmatter parser for `key: value` scalars plus single-level
 * block sequences. A key whose inline value is empty and is followed by
 * `  - item` lines is collected into a comma-joined string, so consumers that
 * comma-split (e.g. agent `tools`/`disallowedTools`) treat these equivalently:
 *   tools: Read, Bash        →  "Read, Bash"
 *   tools: [Read, Bash]      →  "[Read, Bash]"  (caller strips brackets)
 *   tools:\n  - Read\n  - Bash → "Read, Bash"
 * Single-line scalar fields take the inline branch and are unaffected.
 */
export function parseYamlFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}

  const result: Record<string, string> = {}
  const lines = match[1].split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const colonIdx = line.indexOf(":")
    if (colonIdx <= 0) continue
    const key = line.slice(0, colonIdx).trim()
    if (!key) continue
    const inlineValue = stripYamlInlineComment(line.slice(colonIdx + 1)).trim()
    if (inlineValue) {
      result[key] = stripYamlQuotes(inlineValue)
      continue
    }
    // Empty inline value: look ahead for a block sequence (`- item` lines). Skip
    // interspersed comment/blank lines (a `# comment` between the key and its
    // items previously aborted the scan → empty value → silent full-tools widening).
    const items: string[] = []
    let j = i + 1
    for (; j < lines.length; j++) {
      if (/^\s*#/.test(lines[j]) || /^\s*$/.test(lines[j])) continue
      const itemMatch = lines[j].match(/^\s*-\s+(.+)$/)
      if (!itemMatch) break
      const item = stripYamlQuotes(stripYamlInlineComment(itemMatch[1]).trim())
      if (item) items.push(item)
    }
    if (items.length > 0) {
      result[key] = items.join(", ")
      i = j - 1 // consume the item lines we just folded in
    } else {
      result[key] = ""
    }
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
