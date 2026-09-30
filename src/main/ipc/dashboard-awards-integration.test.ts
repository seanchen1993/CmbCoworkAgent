import { readFileSync } from "node:fs"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"
import * as helpers from "./dashboard-awards-skill"
import { buildSkillUsageMatchFilter } from "./dashboard-skill-usage"
import { normalizeSkillQueryName } from "../utils/skill-identifiers"
import { isMissingOrgValue } from "./dashboard-org-fields"

type Row = Record<string, unknown>
function record(value: unknown): Row {
  return value && typeof value === "object" ? (value as Row) : {}
}
interface AwardRow {
  skillKey?: string
  children?: AwardRow[]
}
interface AwardFetchers {
  fetchSkillUsageSummary: (range: unknown, granularity: string, names: string[]) => Promise<unknown>
  fetchSkillUserStats: (range: unknown, granularity: string, name: string) => Promise<unknown>
  fetchAwardSkillContributions: (range: unknown, names: string[]) => Promise<AwardRow[]>
  fetchAwardUserApplications: (range: unknown) => Promise<AwardRow[]>
  fetchAwardTeamBenchmark: (range: unknown) => Promise<AwardRow[]>
  fetchAwardTeamSkillCoverage: (
    range: unknown,
    groups: Array<{ shi: string; skillNames: string[] }>
  ) => Promise<Record<string, number>>
}
const range = { from: "2026-09-01", to: "2026-09-30" }
const source = readFileSync(new URL("./dashboard.ts", import.meta.url), "utf8")
const start = source.indexOf("async function fetchAwardComposite(")
const end = source.indexOf("/** `_source` fields needed to render a Commit", start)
function sourceBetween(start: string, end: string): string {
  const offset = source.indexOf(start)
  const stop = source.indexOf(end, offset)
  if (offset < 0 || stop < 0) throw new Error(`Missing fetcher source: ${start}`)
  return source.slice(offset, stop)
}
// Execute the actual fetchers with fixture ES responses, without loading Electron or starting the app.
const usageSource = [
  sourceBetween("function buildSkillUsageWildcardFilter(", "const SKILL_EVAL_STATS_PAGE_SIZE"),
  sourceBetween("async function fetchSkillUsageSummary(", "async function fetchSkillEvalSummary("),
  sourceBetween("async function fetchSkillUserStats(", "async function fetchUserProfilesBySapIds(")
].join("\n")
const compiled = ts.transpileModule(usageSource + source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText
function fetchers(esQuery: (index: string, body: Row) => Promise<unknown>): AwardFetchers {
  const deps = {
    ...helpers,
    buildSkillUsageMatchFilter,
    esQuery,
    getEsIndex: (index: string) => index,
    requireDashboardAwardsAccess: () => {},
    requireDashboardAccess: () => {},
    buildNonEmptyYstIdFilter: () => ({ exists: { field: "ystId" } }),
    buildEmptyYstIdFilter: () => ({ term: { ystId: "" } }),
    timeRangeFilter: (field: string, value: unknown) => ({ range: { [field]: value } }),
    buildNonEmptyOrgLevelFilter: (field: string) => ({ exists: { field } }),
    buildProjectModeCodeAggs: () => ({
      codeGenFilters: [{ term: { eventName: "code_gen" } }],
      codeAdoptFilters: [{ term: { eventName: "code_adoption" } }],
      perBucketAggs: { code_gen: { filter: { term: { eventName: "code_gen" } } } }
    }),
    asRecord: (value: unknown) => (value && typeof value === "object" ? value : {}),
    asString: (value: unknown) => (typeof value === "string" ? value : ""),
    asNumber: (value: unknown, fallback = 0) => (typeof value === "number" ? value : fallback),
    readOrgText: (value: unknown) => String(value || ""),
    normalizeCodeStatsFromContainer: (value: Row) => value.codeStats,
    normalizeSkillQueryName,
    isMissingOrgValue
  }
  return new Function(
    ...Object.keys(deps),
    `${compiled}\nreturn { fetchSkillUsageSummary, fetchSkillUserStats, fetchAwardSkillContributions, fetchAwardUserApplications, fetchAwardTeamBenchmark, fetchAwardTeamSkillCoverage }`
  )(...Object.values(deps)) as AwardFetchers
}

function pagedQuery(
  fixtures: Record<string, Row[]>,
  totals?: Row
): (index: string, body: Row) => Promise<Row> {
  return async (index, body) => {
    expect(body.size).toBe(0)
    expect(JSON.stringify(body.query)).toContain(index === "trace" ? "startedAt" : "eventName")
    const [name, agg] = Object.entries(record(body.aggs))[0] as [string, Row]
    if (!agg.composite) return { aggregations: totals }
    const composite = record(agg.composite)
    const fields = (composite.sources as Row[]).map((item: Row) => Object.keys(item)[0]).join(",")
    const rows = fixtures[`${index}:${fields}`] ?? []
    const cursor = composite.after
      ? rows.findIndex((row) => JSON.stringify(row.key) === JSON.stringify(composite.after)) + 1
      : 0
    const page = rows.slice(cursor, cursor + Number(composite.size))
    return {
      aggregations: {
        [name]: {
          buckets: page,
          ...(cursor + page.length < rows.length ? { after_key: page.at(-1)?.key } : {})
        }
      }
    }
  }
}

describe("award fetcher integration", () => {
  it("agrees with marketplace counts for nonstandard versions and overlapping aliases", async () => {
    const traces = Array.from({ length: 117 }, (_, i) => ({
      ystId: `user${i % 20}`,
      usedSkills:
        i === 0
          ? ["requirement"]
          : i === 1
            ? ["requirement-v1", "Requirement-v2"]
            : i < 104
              ? ["requirement-v1.0.0"]
              : ["requirement-v1.0.0_202609"]
    }))
    const bodies: Row[] = []
    const query = async (index: string, body: Row): Promise<Row> => {
      bodies.push(body)
      const filters = record(record(record(record(body.aggs).by_skill).filters).filters)
      expect(Object.keys(filters)).toEqual(["requirement"])
      const buckets = Object.fromEntries(
        Object.entries(filters).map(([key, filter]) => {
          const clauses = record(record(filter).bool).should as Row[]
          const matches = traces.filter(
            (trace) =>
              index === "trace" &&
              clauses.some((clause) => {
                if (clause.term)
                  return trace.usedSkills.includes(String(Object.values(record(clause.term))[0]))
                const prefix = String(Object.values(record(clause.prefix))[0])
                return trace.usedSkills.some((name) => name.startsWith(prefix))
              })
          )
          const users = new Set(matches.map((trace) => trace.ystId)).size
          return [
            key,
            {
              doc_count: matches.length,
              unique_users: { count: { value: users } },
              real_users: { users: { value: users } }
            }
          ]
        })
      )
      return { aggregations: { by_skill: { buckets } } }
    }
    const api = fetchers(query)
    const names = ["Requirement-v1.0.0", "requirement-v2.0.0"]
    const market = record(await api.fetchSkillUsageSummary(range, "month", names))
    const marketBuckets = record(record(record(market.aggregations).by_skill).buckets)
    expect(marketBuckets.requirement).toMatchObject({
      doc_count: 117,
      unique_users: { count: { value: 20 } }
    })
    const awards = await api.fetchAwardSkillContributions(range, names)
    expect(awards).toHaveLength(1)
    expect(awards[0]).toMatchObject({ skillKey: "requirement", callCount: 117, userCount: 20 })
    const marketBody = bodies[0]
    const awardTraceBody = bodies[1]
    expect(awardTraceBody.query).toEqual(marketBody.query)
    expect(record(record(awardTraceBody.aggs).by_skill).filters).toEqual(
      record(record(marketBody.aggs).by_skill).filters
    )
  })

  it("uses the marketplace rule for user details, including bare names", async () => {
    let request: Row = {}
    const query = async (_index: string, body: Row): Promise<Row> => {
      request = body
      return {}
    }
    await fetchers(query).fetchSkillUserStats(range, "month", "Requirement-v1.0.0")
    const clauses = record(record(request.query).bool).must as Row[]
    const [candidate] = helpers.groupAwardSkillCandidates(["Requirement-v1.0.0"])
    const expected = helpers.buildAwardSkillMatchFilter(candidate, [
      "usedSkills",
      "usedSkills.keyword"
    ])
    expect(clauses.at(-1)).toEqual(expected)
    expect(JSON.stringify(request.aggs)).toContain(JSON.stringify(expected))
  })

  it("normalizes skill identifiers once when a base name also ends in a number", async () => {
    let request: Row = {}
    const query = async (_index: string, body: Row): Promise<Row> => {
      request = body
      return {}
    }
    await fetchers(query).fetchSkillUsageSummary(range, "month", ["schema-3.0-v1.0+build.7"])
    const filters = record(record(record(record(request.aggs).by_skill).filters).filters)
    expect(Object.keys(filters)).toEqual(["schema-3.0"])
    expect(filters["schema-3.0"]).toEqual(
      helpers.buildAwardSkillMatchFilter(
        helpers.groupAwardSkillCandidates(["schema-3.0-v1.0+build.7"])[0],
        ["usedSkills", "usedSkills.keyword"]
      )
    )
  })

  it("returns skills after position 300 and aggregates all versions in one filter bucket", async () => {
    const names = [
      ...Array.from({ length: 350 }, (_, i) => `skill-item${i}`),
      "code-review-v1",
      "code-review-v2.0"
    ]
    let requests = 0
    const query = vi.fn(async (index: string, body: Row) => {
      requests += 1
      const filters = record(record(record(record(body.aggs).by_skill).filters).filters)
      expect(Object.keys(filters).length).toBeLessThanOrEqual(100)
      return {
        aggregations: {
          by_skill: {
            buckets: Object.fromEntries(
              Object.keys(filters).map((key) => [
                key,
                index === "trace"
                  ? {
                      doc_count: key === "code-review" ? 12 : 1,
                      real_org: { cross_org: { value: 3 } },
                      real_users: { users: { value: 5 } }
                    }
                  : { doc_count: 1, codeStats: { generatedLines: 800 } }
              ])
            )
          }
        }
      }
    })
    const rows = await fetchers(query).fetchAwardSkillContributions(range, names)
    expect(rows).toHaveLength(351)
    expect(rows.find((row: AwardRow) => row.skillKey === "skill-item349")).toMatchObject({
      callCount: 1
    })
    expect(rows.filter((row: AwardRow) => row.skillKey === "code-review")).toEqual([
      {
        skillKey: "code-review",
        callCount: 12,
        crossOrgCount: 3,
        userCount: 5,
        codeStats: { generatedLines: 800 }
      }
    ])
    expect(requests).toBe(8)
  })

  it("includes users past 100 and code events past 2000, while combining skill versions", async () => {
    const user = (i: number): string => `user${String(i).padStart(5, "0")}`
    const fixtures = {
      "trace:user": Array.from({ length: 2101 }, (_, i) => ({
        key: { user: user(i) },
        doc_count: i === 2100 ? 1 : 4,
        latest_user_info: { hits: { hits: [{ _source: { userName: user(i) } }] } }
      })),
      "event:user": Array.from({ length: 2101 }, (_, i) => ({
        key: { user: user(i) },
        codeStats: { generatedLines: i + 1 }
      })),
      "trace:user,skill": [
        { key: { user: user(2100), skill: "review-v1" } },
        { key: { user: user(2100), skill: "review-v2" } },
        { key: { user: user(2100), skill: "writer-v1.2" } }
      ]
    }
    const rows = await fetchers(pagedQuery(fixtures)).fetchAwardUserApplications(range)
    expect(rows).toHaveLength(2101)
    expect(rows.at(-1)).toMatchObject({
      ystId: user(2100),
      callCount: 1,
      skillCount: 2,
      codeStats: { generatedLines: 2101 }
    })
  })

  it("keeps rooms, groups and users beyond old limits and joins both levels correctly", async () => {
    const room = (i: number): string => `room${String(i).padStart(4, "0")}`
    const group = (i: number): string => `group${String(i).padStart(4, "0")}`
    const fixtures = {
      "trace:shi": Array.from({ length: 201 }, (_, i) => ({
        key: { shi: room(i) },
        usage_count: { value: i === 200 ? 5005 : 1 }
      })),
      "trace:shi,group": Array.from({ length: 501 }, (_, i) => ({
        key: { shi: room(200), group: group(i) },
        usage_count: { value: 6 }
      })),
      "trace:shi,user": Array.from({ length: 5001 }, (_, i) => ({
        key: { shi: room(200), user: `user${String(i).padStart(5, "0")}` },
        doc_count: i === 5000 ? 5 : 1
      })),
      "trace:shi,group,user": [
        { key: { shi: room(200), group: group(500), user: "u1" }, doc_count: 5 },
        { key: { shi: room(200), group: group(500), user: "u2" }, doc_count: 1 }
      ],
      "trace:shi,skill": [
        { key: { shi: room(200), skill: "review-v1" } },
        { key: { shi: room(200), skill: "review-v2" } }
      ],
      "trace:shi,group,skill": [
        { key: { shi: room(200), group: group(500), skill: "review-v1" } },
        { key: { shi: room(200), group: group(500), skill: "review-v2" } }
      ],
      "event:shi": [{ key: { shi: room(200) }, codeStats: { generatedLines: 800 } }],
      "event:shi,group": [
        { key: { shi: room(200), group: group(500) }, codeStats: { generatedLines: 80 } }
      ]
    }
    const rows = await fetchers(
      pagedQuery(fixtures, {
        total_usage: { value: 5205 },
        real_users: { total_users: { value: 5001 } }
      })
    ).fetchAwardTeamBenchmark(range)
    expect(rows).toHaveLength(201)
    const last = rows.at(-1)!
    expect(last).toMatchObject({
      shi: room(200),
      userCount: 5001,
      aboveAvgUserCount: 1,
      distinctSkillsUsed: 1,
      codeStats: { generatedLines: 800 }
    })
    expect(last.children!).toHaveLength(501)
    expect(last.children!.at(-1)).toMatchObject({
      group: group(500),
      userCount: 2,
      aboveAvgUserCount: 1,
      distinctSkillsUsed: 1,
      codeStats: { generatedLines: 80 }
    })
  })

  it("counts a covered room once across versions and excludes skills with a similar prefix", async () => {
    const query = pagedQuery({
      "trace:shi,skill": [
        { key: { shi: "r1", skill: "review-v1" } },
        { key: { shi: "r1", skill: "review-v2" } },
        { key: { shi: "r2", skill: "review-2.0.0" } },
        { key: { shi: "r3", skill: "review-helper-v1" } }
      ]
    })
    const result = await fetchers(query).fetchAwardTeamSkillCoverage(range, [
      { shi: "author", skillNames: ["review-v2"] },
      { shi: "author/group", skillNames: ["review"] },
      { shi: "unused", skillNames: ["other"] }
    ])
    expect(result).toEqual({ author: 2, "author/group": 2, unused: 0 })
  })

  it("rejects incomplete contribution responses", async () => {
    const query = async () => ({ timed_out: true, aggregations: { by_skill: { buckets: {} } } })
    await expect(fetchers(query).fetchAwardSkillContributions(range, ["review"])).rejects.toThrow(
      "未完整"
    )
  })
})
