/**
 * Pure cloud-evolution candidate matching/dedup logic.
 *
 * Self-contained on purpose: no browser globals, no `import.meta`, no path
 * aliases — so it is unit-testable directly (tsx) and reusable from the
 * localStorage-backed wrappers in evolution.ts. Types are imported type-only
 * (erased at runtime), so this module never pulls in evolution.ts at runtime.
 */
import type { EvolutionAdoptionRecord, EvolutionCandidate, InstalledSkillLike } from "./evolution"

function normalizeVersion(version?: string | null): string | null {
  const raw = String(version ?? "").trim()
  if (!raw) return null
  return raw.startsWith("v") ? raw.slice(1) : raw
}

export function compareEvolutionVersions(left?: string | null, right?: string | null): number {
  const lv = normalizeVersion(left)
  const rv = normalizeVersion(right)
  // If either side is missing, no reliable comparison — suppress the update.
  if (lv === null || rv === null) return 0
  const l = lv.split(".").map((part) => Number(part) || 0)
  const r = rv.split(".").map((part) => Number(part) || 0)
  for (let i = 0; i < 3; i++) {
    const diff = (l[i] || 0) - (r[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Identity key that keeps plugin skills distinct from same-named standalone
 * skills. Plugin candidates/skills are namespaced by their plugin so a plugin
 * "pdf" never matches or dedupes against a custom "pdf".
 */
export function evolutionSkillKey(skillName: string, pluginName?: string | null): string {
  return pluginName ? `plugin:${pluginName}/${skillName}` : skillName
}

function candidateSkillKey(candidate: EvolutionCandidate): string {
  return evolutionSkillKey(candidate.skill_name, candidate.plugin_name)
}

export function withAdoptionRecord(
  candidate: EvolutionCandidate,
  record: EvolutionAdoptionRecord
): EvolutionCandidate {
  return {
    ...candidate,
    local_adoption_status: "adopted",
    local_adopted_at: record.adopted_at,
    local_backup_id: record.backup_id,
    local_backup_path: record.backup_path
  }
}

export function candidateFromAdoptionRecord(record: EvolutionAdoptionRecord): EvolutionCandidate {
  const candidate = record.candidate
  if (candidate) return withAdoptionRecord(candidate, record)
  return withAdoptionRecord(
    {
      candidate_id: record.candidate_id,
      run_id: "",
      status: "published",
      recommendation: null,
      base_skill_id: record.skill_name,
      full_bundle_path: "",
      files_changed: [],
      source_trace_ids: [],
      source_thread_ids: [],
      skill_name: record.skill_name,
      evolution_status: "published",
      source_version: record.source_version || null,
      target_version: record.target_version || null,
      source_bundle_hash: null,
      auto_optimized: true,
      evaluation_score: null,
      published_at: null,
      published_s3_path: null,
      notes: "本地已采纳记录"
    },
    record
  )
}

/**
 * Pick the latest available update per skill (plugin-aware), given the set of
 * locally-installed skills plus the ignored/adopted bookkeeping. Pure: callers
 * supply ignored/adopted from their own storage.
 */
export function selectAvailableUpdates(
  candidates: EvolutionCandidate[],
  installedSkills: InstalledSkillLike[],
  bookkeeping: { ignoredIds: Set<string>; adopted: Map<string, EvolutionAdoptionRecord> }
): EvolutionCandidate[] {
  const { ignoredIds, adopted } = bookkeeping
  const available = candidates
    .filter((candidate) => !ignoredIds.has(candidate.candidate_id))
    .filter((candidate) => candidate.auto_optimized !== false)
    .filter((candidate) => {
      const key = candidateSkillKey(candidate)
      const installed = installedSkills.find(
        (skill) => evolutionSkillKey(skill.name, skill.pluginName) === key
      )
      if (!installed) return false
      return compareEvolutionVersions(candidate.target_version, installed.version) > 0
    })
    .map((candidate) => {
      const record = adopted.get(candidate.candidate_id)
      return record ? withAdoptionRecord(candidate, record) : candidate
    })

  const latestBySkill = new Map<string, EvolutionCandidate>()
  for (const candidate of available) {
    const key = candidateSkillKey(candidate)
    const current = latestBySkill.get(key)
    if (!current || compareEvolutionVersions(candidate.target_version, current.target_version) > 0) {
      latestBySkill.set(key, candidate)
    }
  }

  for (const record of adopted.values()) {
    if (ignoredIds.has(record.candidate_id)) continue
    const recordCandidate = candidateFromAdoptionRecord(record)
    const key = candidateSkillKey(recordCandidate)
    const current = latestBySkill.get(key)
    if (!current) {
      latestBySkill.set(key, recordCandidate)
      continue
    }
    if (
      current.candidate_id === record.candidate_id &&
      compareEvolutionVersions(record.target_version, current.target_version) >= 0
    ) {
      latestBySkill.set(key, recordCandidate)
    }
  }

  return [...latestBySkill.values()].sort((a, b) => {
    const statusDelta =
      Number(Boolean(a.local_adoption_status)) - Number(Boolean(b.local_adoption_status))
    if (statusDelta !== 0) return statusDelta
    return a.skill_name.localeCompare(b.skill_name)
  })
}
