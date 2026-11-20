type JsonRecord = Record<string, unknown>
const record = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {}

export const USER_PROFILE_EXACT_BATCH_SIZE = 100
export const USER_PROFILE_LEGACY_BATCH_SIZE = 20
export const USER_PROFILE_PAGE_SIZE = 100

/** Exact lookup is the common path; substring lookup is only for unresolved legacy IDs. */
export function buildUserProfileIdFilter(sapIds: string[], embedded = false): JsonRecord {
  if (!sapIds.length) return { match_none: {} }
  const wildcards = embedded
    ? sapIds.flatMap((id) => {
        const pattern = `*${id.replace(/[\\*?]/g, "\\$&")}*`
        return [{ wildcard: { sapId: pattern } }, { wildcard: { "sapId.keyword": pattern } }]
      })
    : []
  return {
    bool: {
      should: [{ terms: { sapId: sapIds } }, { terms: { "sapId.keyword": sapIds } }, ...wildcards],
      minimum_should_match: 1
    }
  }
}

/** Metadata-only composite pages, at most two batches in flight, no trace payloads. */
export async function fetchUserProfileDirectory(
  sapIds: string[],
  execute: (body: JsonRecord) => Promise<unknown>
): Promise<{ items: JsonRecord[] }> {
  // Marketplace IDs can already contain "工号/姓名/部门"; only the ID is queried.
  const ids = Array.from(new Set(sapIds.map((id) => id.split(/[／/]/)[0].trim()).filter(Boolean)))
  const profiles = new Map<string, JsonRecord>()

  async function lookup(batch: string[], embedded: boolean): Promise<void> {
    const cursors = new Set<string>()
    let after: JsonRecord | undefined
    for (;;) {
      const result = record(
        await execute({
          size: 0,
          track_total_hits: false,
          query: { bool: { filter: [buildUserProfileIdFilter(batch, embedded)] } },
          aggs: {
            by_sap: {
              composite: {
                size: USER_PROFILE_PAGE_SIZE,
                sources: [{ sapId: { terms: { field: "sapId" } } }],
                ...(after ? { after } : {})
              },
              aggs: {
                latest_user_info: {
                  top_hits: {
                    size: 1,
                    sort: [{ startedAt: { order: "desc" } }],
                    _source: { includes: ["userName", "orgName", "upperOrgLv0", "upperOrgLv1"] }
                  }
                },
                user_name: { terms: { field: "userName", size: 1 } },
                org_name: { terms: { field: "orgName", size: 1 } }
              }
            }
          }
        })
      )
      if (!Array.isArray(result.items)) throw new Error("用户资料查询缺少统计结果，请重试")
      for (const value of result.items) {
        const profile = record(value)
        if (typeof profile.sapId !== "string" || !profile.sapId.trim())
          throw new Error("用户资料查询返回无效工号，请重试")
        profiles.set(profile.sapId, profile)
      }
      if (result.afterKey == null || result.items.length === 0) break
      const next = record(result.afterKey)
      if (Object.keys(next).length !== 1 || typeof next.sapId !== "string")
        throw new Error("用户资料查询分页游标无效，请重试")
      const cursor = JSON.stringify(next)
      if (cursors.has(cursor)) throw new Error("用户资料查询分页未前进，请重试")
      cursors.add(cursor)
      after = next
    }
  }

  async function batches(values: string[], size: number, embedded: boolean): Promise<void> {
    for (let offset = 0; offset < values.length; offset += size * 2) {
      const group = [
        values.slice(offset, offset + size),
        values.slice(offset + size, offset + size * 2)
      ]
      await Promise.all(
        group.filter((batch) => batch.length).map((batch) => lookup(batch, embedded))
      )
    }
  }

  await batches(ids, USER_PROFILE_EXACT_BATCH_SIZE, false)
  // Both 6-digit and 8-digit candidates can identify the same profile. A known
  // exact result also satisfies its shorter alias, avoiding redundant wildcards.
  const unresolved = ids.filter(
    (id) => !Array.from(profiles.keys()).some((key) => key.includes(id))
  )
  await batches(unresolved, USER_PROFILE_LEGACY_BATCH_SIZE, true)
  return {
    items: Array.from(profiles.values()).sort((a, b) =>
      String(a.sapId).localeCompare(String(b.sapId))
    )
  }
}
