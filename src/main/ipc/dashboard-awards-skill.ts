import { normalizeSkillIdentifierText, normalizeSkillQueryName } from "../utils/skill-identifiers"

export interface AwardSkillCandidate {
  /** One row per base skill, regardless of marketplace versions or name casing. */
  key: string
  bases: string[]
  identifiers: string[]
}

export function groupAwardSkillCandidates(names: string[]): AwardSkillCandidate[] {
  const groups = new Map<string, { bases: Set<string>; identifiers: Set<string> }>()
  for (const raw of Array.isArray(names) ? names : []) {
    const identifier = normalizeSkillIdentifierText(String(raw || ""))
    const base = normalizeSkillQueryName(identifier)
    if (!base) continue
    const key = base.toLowerCase()
    const group = groups.get(key) ?? { bases: new Set<string>(), identifiers: new Set<string>() }
    group.bases.add(base)
    group.bases.add(key)
    group.identifiers.add(identifier)
    groups.set(key, group)
  }
  return Array.from(groups, ([key, group]) => ({
    key,
    bases: Array.from(group.bases),
    identifiers: Array.from(group.identifiers)
  }))
}

/** Match bare names and versions without including other skills sharing a prefix. */
export function buildAwardSkillMatchFilter(
  candidate: AwardSkillCandidate,
  fields: readonly string[]
): Record<string, unknown> {
  const should: Record<string, unknown>[] = []
  for (const field of fields) {
    for (const base of candidate.bases) {
      const escaped = base.replace(/[\\.?+*|{}[\]()"#@&<>~]/g, "\\$&")
      should.push(
        { term: { [field]: base } },
        // Lucene treats a trailing '-' as the start of a range, unlike JavaScript.
        // Keep the literal hyphen first in the suffix character class.
        { regexp: { [field]: `${escaped}-[vV]?[0-9]+(\\.[0-9]+){0,3}([-+][-0-9A-Za-z.]+)?` } }
      )
    }
    for (const identifier of candidate.identifiers) {
      if (!candidate.bases.includes(identifier)) should.push({ term: { [field]: identifier } })
    }
  }
  return { bool: { should, minimum_should_match: 1 } }
}

/** At most two batches run at once. A failure rejects the entire result. */
export async function mapAwardBatches<T, R>(
  items: T[],
  size: number,
  execute: (batch: T[]) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(size) || size < 1) throw new Error("Invalid award batch size")
  const results: R[] = []
  for (let index = 0; index < items.length; index += size * 2) {
    const batches = [
      items.slice(index, index + size),
      items.slice(index + size, index + size * 2)
    ].filter((batch) => batch.length > 0)
    results.push(...(await Promise.all(batches.map(execute))))
  }
  return results
}

type JsonRecord = Record<string, unknown>
function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {}
}

export function readCompleteAwardAggregation(rawValue: unknown, name: string): JsonRecord {
  const raw = record(rawValue)
  if (raw.timed_out || Number(record(raw._shards).failed) > 0) {
    throw new Error("评奖查询未完整返回，请重试")
  }
  const aggs = record(raw.aggregations)
  if (!aggs[name]) throw new Error("评奖查询缺少统计结果")
  return record(aggs[name])
}

/** Composite cursors enumerate all candidates instead of selecting top terms. */
export async function fetchAllAwardCompositeBuckets(
  body: JsonRecord,
  aggregation: string,
  execute: (body: JsonRecord) => Promise<unknown>
): Promise<JsonRecord[]> {
  const aggs = record(body.aggs)
  const agg = record(aggs[aggregation])
  const buckets: JsonRecord[] = []
  const cursors = new Set<string>()
  let after: JsonRecord | undefined
  for (;;) {
    const raw = record(
      await execute({
        ...body,
        aggs: {
          ...aggs,
          [aggregation]: {
            ...agg,
            composite: { ...record(agg.composite), ...(after ? { after } : {}) }
          }
        }
      })
    )
    const page = readCompleteAwardAggregation(raw, aggregation)
    if (!Array.isArray(page.buckets)) throw new Error("评奖查询缺少统计结果")
    buckets.push(...page.buckets.map(record))
    const next = record(page.after_key)
    if (page.buckets.length === 0 || Object.keys(next).length === 0) break
    const cursor = JSON.stringify(next)
    if (cursors.has(cursor)) throw new Error("评奖查询分页未前进，请重试")
    cursors.add(cursor)
    after = next
  }
  return buckets
}

/** Count base names once even when a user/team used several versions. */
export function countAwardDistinctSkills(
  buckets: JsonRecord[],
  owner: (key: JsonRecord) => string
): Map<string, number> {
  const skills = new Map<string, Set<string>>()
  for (const bucket of buckets) {
    const key = record(bucket.key)
    const skill = normalizeSkillQueryName(String(key.skill || "")).toLowerCase()
    if (!skill) continue
    const id = owner(key)
    const names = skills.get(id) ?? new Set<string>()
    names.add(skill)
    skills.set(id, names)
  }
  return new Map(Array.from(skills, ([key, values]) => [key, values.size]))
}
