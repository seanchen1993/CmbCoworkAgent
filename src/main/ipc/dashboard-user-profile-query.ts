/** Keep legacy substring matching, with two terms sets instead of two clauses per ID. */
export function buildUserProfileIdFilter(sapIds: string[]): Record<string, unknown> {
  if (!sapIds.length) return { match_none: {} }
  const wildcards = sapIds.flatMap((id) => {
    const pattern = `*${id.replace(/[\\*?]/g, "\\$&")}*`
    return [{ wildcard: { sapId: pattern } }, { wildcard: { "sapId.keyword": pattern } }]
  })
  return {
    bool: {
      should: [{ terms: { sapId: sapIds } }, { terms: { "sapId.keyword": sapIds } }, ...wildcards],
      minimum_should_match: 1
    }
  }
}
