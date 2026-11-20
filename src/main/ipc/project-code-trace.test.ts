import { describe, expect, it, vi } from "vitest"
import { fetchProjectCodeTracePage } from "./project-code-trace"
import { stageBucketCodeFilterClause } from "./dashboard-stage-buckets"
import type {
  ProjectCodeTraceCursor,
  ProjectCodeTraceRequest
} from "../../shared/project-code-trace"
import { projectCodeClassificationReason } from "../../shared/project-code-trace"

type Row = Record<string, unknown>
interface Document extends Row {
  eventId: string
  properties: Row
}
type SortValue = string | number
interface QueryBody {
  size: number
  query: { bool: { filter: Row[] } }
  post_filter?: Row
  aggs?: Record<string, { filter: Row }>
  sort?: Array<Record<string, { order: string }>>
  collapse?: { field: string }
  search_after?: SortValue[]
}
const object = (value: unknown): Row => (value && typeof value === "object" ? (value as Row) : {})
const field = (row: Row, path: string): unknown =>
  path.split(".").reduce<unknown>((v, key) => object(v)[key], row)
function matches(row: Row, clause: Row): boolean {
  if (clause.term) return Object.entries(object(clause.term)).every(([k, v]) => field(row, k) === v)
  if (clause.terms)
    return Object.entries(object(clause.terms)).every(([k, v]) =>
      (v as unknown[]).includes(field(row, k))
    )
  if (clause.exists) {
    const v = field(row, String(object(clause.exists).field))
    return Array.isArray(v) ? v.some((value) => value !== null) : v !== undefined && v !== null
  }
  if (clause.range)
    return Object.entries(object(clause.range)).every(([k, bounds]) => {
      const v = field(row, k)
      const b = bounds as Row
      return (
        v !== undefined &&
        (b.gt === undefined || Number(v) > Number(b.gt)) &&
        (b.lte === undefined || String(v) <= String(b.lte))
      )
    })
  const b = object(clause.bool)
  return (
    ((b.filter ?? []) as Row[]).every((f) => matches(row, f)) &&
    !((b.must_not ?? []) as Row[]).some((f) => matches(row, f)) &&
    (!b.minimum_should_match || ((b.should ?? []) as Row[]).some((f) => matches(row, f)))
  )
}
const request: ProjectCodeTraceRequest = { projectId: "p", bucket: "vibecoding", pageSize: 20 }
const access = [{ term: { upperOrgLv1: "mine" } }]
function event(id: string, kind: string, props: Row = {}): Document {
  return {
    eventId: id,
    eventName: kind,
    eventTime: "2025-01-01T00:00:00.000Z",
    upperOrgLv1: "mine",
    userName: "User",
    properties: { eventId: id, harnessProjectId: "p", ...props }
  }
}
function adopt(id: string, props: Row = {}): Document {
  return event(id, "code_adopt", {
    genEventId: `g-${id}`,
    generatedLineCount: 15,
    effectiveGeneratedLineCount: 12,
    adoptedLineCount: 10,
    harnessNodeStatus: "进行中",
    usedSkills: [],
    ...props
  })
}
function fakeEs(rows: Document[]) {
  let active = 0
  let peak = 0
  const query = vi.fn(async (rawBody: Row) => {
    const body = rawBody as unknown as QueryBody
    active++
    peak = Math.max(peak, active)
    await Promise.resolve()
    try {
      const scoped = rows.filter((row) => matches(row, body.query))
      const aggregation = body.aggs
        ? Object.fromEntries(
            Object.entries(body.aggs).map(([name, raw]) => {
              const def = raw
              return [
                name,
                {
                  adopted_lines: {
                    value: scoped
                      .filter((row) => matches(row, def.filter))
                      .reduce((sum, row) => sum + Number(row.properties.adoptedLineCount), 0)
                  }
                }
              ]
            })
          )
        : undefined
      let result = body.post_filter
        ? scoped.filter((row) => matches(row, body.post_filter!))
        : [...scoped]
      const sorts = body.sort ?? []
      const tuple = (row: Row) => sorts.map((sort) => field(row, Object.keys(sort)[0]) as SortValue)
      const compare = (a: SortValue[], b: SortValue[]): number => {
        for (let i = 0; i < sorts.length; i++) {
          if (a[i] === b[i]) continue
          const order = (Object.values(sorts[i])[0] as Row).order
          return (a[i] > b[i] ? 1 : -1) * (order === "desc" ? -1 : 1)
        }
        return 0
      }
      result.sort((a, b) => compare(tuple(a), tuple(b)))
      if (body.collapse)
        result = result.filter(
          (row, i, all) =>
            all.findIndex(
              (r) => field(r, body.collapse!.field) === field(row, body.collapse!.field)
            ) === i
        )
      const total = result.length
      if (body.search_after)
        result = result.filter((row) => compare(tuple(row), body.search_after!) > 0)
      return {
        hits: {
          total: { value: total, relation: "eq" },
          hits: result
            .slice(0, body.size)
            .map((row) => ({ _id: row.eventId, _source: row, sort: tuple(row) }))
        },
        ...(aggregation ? { aggregations: aggregation } : {})
      }
    } finally {
      active--
    }
  })
  return { query, peak: () => peak }
}

describe("project code provenance", () => {
  it("uses lifetime, permission-scoped code attribution; child Skills and completed stages reconcile with list totals", async () => {
    const rows = [
      adopt("v-empty", { adoptedLineCount: 30 }),
      adopt("v-done", {
        adoptedLineCount: 20,
        harnessNodeStatus: "已完成",
        usedSkills: ["parent-skill"],
        subagentKind: "workflow_agent",
        threadId: "child",
        rootThreadId: "parent"
      }),
      adopt("h", { adoptedLineCount: 50, usedSkills: ["parent-skill"] }),
      adopt("unknown", { adoptedLineCount: 1000, harnessNodeStatus: null }),
      adopt("zero", { adoptedLineCount: 0 }),
      { ...adopt("forbidden", { adoptedLineCount: 9999 }), upperOrgLv1: "other" },
      adopt("other-project", { harnessProjectId: "other", adoptedLineCount: 9999 }),
      event("g-v-done", "code_gen", {
        relativeHint: "a.ts",
        usedSkills: ["parent-skill"],
        harnessNodeStatus: "已完成",
        subagentKind: "workflow_agent"
      })
    ]
    const { query, peak } = fakeEs(rows)
    const page = await fetchProjectCodeTracePage(request, access, query)
    expect(page.total).toBe(2)
    expect(page.summary).toEqual({ harnessLines: 50, vibeLines: 50, unattributedLines: 1000 })
    expect(page.items.map((r) => r.eventId)).toEqual(["v-empty", "v-done"])
    expect(page.items[0].generationAvailable).toBe(false)
    expect(page.items[1]).toMatchObject({
      file: "a.ts",
      nodeStatus: "已完成",
      usedSkills: ["parent-skill"],
      agentKind: "workflow_agent",
      threadId: "child",
      rootThreadId: "parent"
    })
    expect(projectCodeClassificationReason(page.items[1].nodeStatus, true)).toContain("阶段已完成")
    expect(query).toHaveBeenCalledTimes(2)
    expect(peak()).toBeLessThanOrEqual(2)
    expect(query.mock.calls[0][0].post_filter).toEqual(stageBucketCodeFilterClause("vibecoding"))
  })

  it("pages through 1,001 tied records without truncation/duplication, fetching at most one page of metadata", async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => adopt(`a-${String(i).padStart(4, "0")}`))
    const { query, peak } = fakeEs(rows)
    let cursor: ProjectCodeTraceCursor | null = null
    const ids: string[] = []
    let pages = 0
    do {
      const page = await fetchProjectCodeTracePage({ ...request, cursor }, access, query)
      ids.push(...page.items.map((r) => r.eventId))
      cursor = page.nextCursor
      pages++
      if (pages === 1) expect(page.summary?.vibeLines).toBe(10010)
      else expect(page.summary).toBeUndefined()
    } while (cursor && pages < 100)
    expect(ids).toHaveLength(1001)
    expect(new Set(ids).size).toBe(1001)
    expect(pages).toBe(51)
    expect(query).toHaveBeenCalledTimes(102)
    expect(peak()).toBeLessThanOrEqual(2)
    for (const [rawBody] of query.mock.calls) {
      const body = rawBody as unknown as QueryBody & Row
      expect(body.size).toBeLessThanOrEqual(21)
      expect(body.from).toBeUndefined()
      expect(JSON.stringify(body)).not.toContain("_raw")
      expect(body.query.bool.filter).toContainEqual(access[0])
      expect(body.query.bool.filter).toContainEqual({
        term: { "properties.harnessProjectId": "p" }
      })
    }
  })

  it("keeps historical attribution and flags disagreements instead of silently changing buckets", async () => {
    const { query } = fakeEs([
      adopt("a"),
      event("g-a", "code_gen", { usedSkills: ["skill"], harnessNodeStatus: "进行中" })
    ])
    const page = await fetchProjectCodeTracePage(request, access, query)
    expect(page.items[0]).toMatchObject({
      usedSkills: [],
      attributionMismatch: true,
      generationAttribution: { usedSkills: ["skill"], nodeStatus: "进行中" }
    })
    expect(page.summary?.vibeLines).toBe(10)
    expect(page.summary?.harnessLines).toBe(0)
  })

  it("batches commit links, preserves missing generations and never reads code or contexts", async () => {
    const { query, peak } = fakeEs([
      adopt("a", { commitSha: "sha" }),
      event("commit", "git.commit.created", {
        harnessProjectId: undefined,
        commitSha: "sha",
        commitUrl: "https://git.example/sha",
        branch: "main"
      })
    ])
    const page = await fetchProjectCodeTracePage(request, access, query)
    expect(page.items[0]).toMatchObject({
      generationAvailable: false,
      commitUrl: "https://git.example/sha",
      branch: "main"
    })
    expect(query).toHaveBeenCalledTimes(3)
    expect(peak()).toBe(2)
    expect((query.mock.calls[2][0] as unknown as QueryBody).query.bool.filter).toContainEqual({
      terms: { "properties.commitSha": ["sha"] }
    })
  })

  it("does one small search for empty projects, with no metadata or Trace queries", async () => {
    const { query } = fakeEs([])
    expect(await fetchProjectCodeTracePage(request, access, query)).toMatchObject({
      items: [],
      total: 0,
      nextCursor: null
    })
    expect(query).toHaveBeenCalledTimes(1)
    expect((query.mock.calls[0][0].sort as Row[])[0]).toEqual({
      "properties.adoptedLineCount": { order: "desc", unmapped_type: "long" }
    })
  })

  it("rejects invalid or cross-scope cursors before querying", async () => {
    const query = vi.fn()
    await expect(
      fetchProjectCodeTracePage(
        { ...request, cursor: { after: [10, "x", "id"], asOf: "2025-01-01", scope: "other" } },
        access,
        query
      )
    ).rejects.toThrow("分页已失效")
    expect(query).not.toHaveBeenCalled()
  })

  it("fails visibly on partial ES results and missing summary data", async () => {
    const { query } = fakeEs([])
    await expect(
      fetchProjectCodeTracePage(
        request,
        access,
        vi.fn().mockResolvedValue({ _shards: { failed: 1 } })
      )
    ).rejects.toThrow("未完整返回")
    const good = await query({ query: { bool: { filter: [] } }, size: 20 })
    await expect(
      fetchProjectCodeTracePage(request, access, vi.fn().mockResolvedValue(good))
    ).rejects.toThrow("汇总未完整返回")
  })
})
