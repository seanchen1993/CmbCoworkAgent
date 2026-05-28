// NOTE: relative imports (not "@/...") so this module stays importable from
// the bare `tsx` test runner, which doesn't resolve TS path aliases.
import type { SkillMetadata } from "../../types"
import { normalizeSkillId } from "../../lib/skill-ids"

/**
 * Compact label for the right-aligned source badge in the slash popover.
 * Prefers a recognisable plugin identity when present, otherwise falls back
 * to the broad project / user partition.
 */
export function getSourceLabel(skill: SkillMetadata): string {
  if (skill.pluginName) return skill.pluginName
  if (skill.pluginId) return skill.pluginId
  return skill.source === "project" ? "系统" : "个人"
}

function getPluginIdentityLabel(skill: SkillMetadata): string | null {
  if (skill.pluginName && skill.pluginId && skill.pluginName !== skill.pluginId) {
    return `${skill.pluginName} (${skill.pluginId})`
  }
  if (skill.pluginName) return skill.pluginName
  if (skill.pluginId) return skill.pluginId
  return null
}

function getPathTailLabel(skill: SkillMetadata): string | null {
  const pathish = skill.relativePath || skill.path
  if (!pathish) return null
  const parts = pathish.replace(/\\/g, "/").split("/").filter(Boolean)
  // Drop trailing "SKILL.md" so we surface the meaningful parent directories.
  if (parts.length && /^skill\.md$/i.test(parts[parts.length - 1])) parts.pop()
  if (parts.length === 0) return null
  return parts.slice(-2).join("/")
}

/**
 * Short hint rendered on a second line when the popover contains another
 * skill with the same name. We combine plugin identity with a path-tail hint
 * when both exist so two skills from the same plugin (or two ambient skills
 * with no plugin) still get a discriminating tail. Returns null only when no
 * useful signal is available at all — callers skip the subline in that case.
 */
export function getDisambiguationLabel(skill: SkillMetadata): string | null {
  const plugin = getPluginIdentityLabel(skill)
  const tail = getPathTailLabel(skill)
  if (plugin && tail) return `${plugin} · ${tail}`
  return plugin || tail
}

/**
 * Names that appear more than once in the given list, keyed by the normalised
 * skill id. Matching uses `normalizeSkillId` so "Review" / "review" / "review/"
 * all collapse to the same bucket — they look the same to the user and need a
 * subline regardless of casing. Callers re-derive list membership with the
 * same normaliser so the displayed `s.name` casing is irrelevant.
 */
export function computeDuplicateSkillNames(
  skills: ReadonlyArray<SkillMetadata>
): ReadonlySet<string> {
  const counts = new Map<string, number>()
  for (const s of skills) {
    const key = normalizeSkillId(s.name)
    if (!key) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const dups = new Set<string>()
  for (const [key, count] of counts) if (count > 1) dups.add(key)
  return dups
}
