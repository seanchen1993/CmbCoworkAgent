import { describe, expect, it } from "vitest"
import { buildUserProfileIdFilter } from "./dashboard-user-profile-query"

describe("bounded user profile queries", () => {
  it("keeps a 500-user request below the ES 7.x default 1024-clause limit", () => {
    const ids = Array.from({ length: 500 }, (_, i) => String(80300000 + i))
    const filter = buildUserProfileIdFilter(ids) as { bool: { should: unknown[] } }
    expect(filter.bool.should).toHaveLength(1002)
    expect(filter.bool.should[0]).toEqual({ terms: { sapId: ids } })
    expect(filter.bool.should[1]).toEqual({ terms: { "sapId.keyword": ids } })
    expect(filter.bool.should.at(-1)).toEqual({ wildcard: { "sapId.keyword": "*80300499*" } })
  })

  it("preserves exact IDs, historic embedded IDs and literal wildcard characters", () => {
    expect(buildUserProfileIdFilter(["80300001", "a*?\\b"])).toEqual({
      bool: {
        should: [
          { terms: { sapId: ["80300001", "a*?\\b"] } },
          { terms: { "sapId.keyword": ["80300001", "a*?\\b"] } },
          { wildcard: { sapId: "*80300001*" } },
          { wildcard: { "sapId.keyword": "*80300001*" } },
          { wildcard: { sapId: "*a\\*\\?\\\\b*" } },
          { wildcard: { "sapId.keyword": "*a\\*\\?\\\\b*" } }
        ],
        minimum_should_match: 1
      }
    })
    expect(buildUserProfileIdFilter([])).toEqual({ match_none: {} })
  })
})
