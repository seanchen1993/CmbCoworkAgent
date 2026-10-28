import { readFileSync } from "node:fs"
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from "typescript"
import { runInNewContext } from "node:vm"
import { describe, expect, it, vi } from "vitest"
import {
  excludesTestProjects,
  excludeTestProjectsFromQuery,
  fetchTestProjectIds,
  projectModeTestScopeCacheKey,
  TEST_PROJECT_PAGE_SIZE,
  withProjectModeTestExclusion,
  testProjectLookupScope
} from "./project-mode-test-projects"

const EVENT = "events"
const TRACE = "traces"
const page = (ids: string[], after?: string) => ({
  aggregations: {
    projects: {
      buckets: ids.map((projectId) => ({ key: { projectId } })),
      ...(after ? { after_key: { projectId: after } } : {})
    }
  }
})
const options = (query = vi.fn(async () => page(["test-project"]))) => ({
  eventIndex: EVENT,
  traceIndex: TRACE,
  accessFilters: [{ term: { upperOrgLv1: "allowed-room" } }],
  query
})

describe("project overview test-project scope", () => {
  it("narrows ID lookups by project and exact rooms, without treating department search text as an exact room", () => {
    expect(
      testProjectLookupScope("dashboard:projectModeFeatureNodes", [
        "p1",
        "feature",
        null,
        { upperOrgLv1: ["room"] }
      ])
    ).toEqual({ projectId: "p1", upperOrgLv1: ["room"] })
    expect(
      testProjectLookupScope("dashboard:projectCodeTrace", [
        { projectId: "p2", upperOrgLv1: ["room"] }
      ])
    ).toEqual({ projectId: "p2", upperOrgLv1: ["room"] })
    expect(
      testProjectLookupScope("dashboard:nonGitAdoptionReports", [
        {},
        { upperOrgLv1: "part of a department", orgLv1List: ["exact room"] }
      ])
    ).toEqual({ upperOrgLv1: ["exact room"] })
    expect(
      testProjectLookupScope("dashboard:projectModeProjectCommits", [
        "p1",
        null,
        { upperOrgLv1: "part of a department" }
      ])
    ).toEqual({ projectId: "p1" })
  })
  it("reads only test snapshot IDs, with permission filters, complete composite pagination and no time/Lean restriction", async () => {
    const first = Array.from({ length: TEST_PROJECT_PAGE_SIZE }, (_, i) => `p${i}`)
    const query = vi
      .fn()
      .mockResolvedValueOnce(page(first, "p499"))
      .mockResolvedValueOnce(page(["last"]))
    const opts = options(query)
    const ids = await fetchTestProjectIds(EVENT, opts.accessFilters, query)
    expect(ids).toHaveLength(501)
    expect(query).toHaveBeenCalledTimes(2)
    const body = query.mock.calls[0][1]
    expect(body.size).toBe(0)
    expect(body.track_total_hits).toBe(false)
    expect(body.query.bool.filter).toEqual([
      { term: { eventName: "harness.project.snapshot" } },
      { term: { "properties.isTestProject": true } },
      ...opts.accessFilters
    ])
    expect(body).not.toHaveProperty("_source")
    expect(JSON.stringify(body)).not.toContain("_raw")
    expect(query.mock.calls[1][1].aggs.projects.composite.after).toEqual({ projectId: "p499" })
  })

  it.each([
    { timed_out: true },
    { _shards: { failed: 1 } },
    { aggregations: {} },
    { aggregations: { projects: { buckets: [{ key: {} }] } } },
    {
      aggregations: {
        projects: {
          buckets: [{ key: { projectId: "a" } }],
          after_key: { projectId: "a", stale: "b" }
        }
      }
    }
  ])("fails closed on incomplete results or malformed IDs/cursors: %j", async (raw) => {
    await expect(
      fetchTestProjectIds(EVENT, [], async () => ({ ...page(["a"]), ...raw }))
    ).rejects.toThrow()
  })

  it("rejects a repeated cursor instead of silently truncating or looping", async () => {
    const query = vi.fn(async () => page(["a"], "a"))
    await expect(fetchTestProjectIds(EVENT, [], query)).rejects.toThrow("游标重复")
    expect(query).toHaveBeenCalledTimes(2)
  })

  it("one lookup covers every batch, main/child Trace and event query without mutating the original DSL", async () => {
    const opts = options()
    const original = {
      size: 0,
      query: { bool: { filter: [{ term: { room: "allowed-room" } }] } },
      aggs: { tokens: { sum: { field: "inputTokens" } } }
    }
    await withProjectModeTestExclusion(opts, async () => {
      for (let batch = 0; batch < 11; batch++) {
        const filtered = excludeTestProjectsFromQuery(TRACE, original)
        expect(filtered.aggs).toBe(original.aggs)
        expect(filtered.query).toEqual({
          bool: {
            filter: [original.query],
            must_not: [{ terms: { harnessProjectId: ["test-project"] } }]
          }
        })
      }
      expect(excludeTestProjectsFromQuery(EVENT, { size: 0 }).query).toEqual({
        bool: {
          filter: [],
          must_not: [
            { term: { "properties.isTestProject": true } },
            { terms: { "properties.harnessProjectId": ["test-project"] } },
            { terms: { "properties.projectId": ["test-project"] } }
          ]
        }
      })
      expect(opts.query).toHaveBeenCalledTimes(1)
      expect(original.query).toEqual({ bool: { filter: [{ term: { room: "allowed-room" } }] } })
    })
    expect(excludeTestProjectsFromQuery(TRACE, original)).toBe(original)
    expect(projectModeTestScopeCacheKey()).toBe("")
  })

  it("preserves ordinary/legacy projects and filters test main+child history from both counts and sums", async () => {
    const rows = [
      { project: "normal", kind: "root", tokens: 100 },
      { project: "normal", kind: "workflow", tokens: 50 },
      { project: "test-project", kind: "root", tokens: 200 },
      { project: "test-project", kind: "team", tokens: 300 },
      { project: "legacy-no-snapshot", kind: "root", tokens: 70 }
    ]
    await withProjectModeTestExclusion(options(), async () => {
      const filtered = excludeTestProjectsFromQuery(TRACE, {}) as {
        query: { bool: { must_not: { terms: { harnessProjectId: string[] } }[] } }
      }
      const excluded = filtered.query.bool.must_not.flatMap(
        (clause) => clause.terms.harnessProjectId
      )
      const included = rows.filter((row) => !excluded.includes(row.project))
      expect(included).toHaveLength(3)
      expect(included.reduce((sum, row) => sum + row.tokens, 0)).toBe(220)
    })
    // The platform still reports all actual usage.
    expect(rows.reduce((sum, row) => sum + row.tokens, 0)).toBe(720)
  })

  it("batches exclusions beyond ES terms limits without dropping any project", async () => {
    const ids = Array.from({ length: 10_001 }, (_, i) => `p${i}`)
    await withProjectModeTestExclusion(options(vi.fn(async () => page(ids))), async () => {
      const filtered = excludeTestProjectsFromQuery(TRACE, {}) as {
        query: { bool: { must_not: { terms: { harnessProjectId: string[] } }[] } }
      }
      const batches = filtered.query.bool.must_not.map((v) => v.terms.harnessProjectId)
      expect(batches.map((batch) => batch.length)).toEqual([10_000, 1])
      expect(new Set(batches.flat()).size).toBe(10_001)
    })
  })

  it("isolates simultaneous scopes and refreshes cache identity on true→false changes", async () => {
    let firstKey = ""
    await Promise.all([
      withProjectModeTestExclusion(options(), async () => {
        firstKey = projectModeTestScopeCacheKey()
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(JSON.stringify(excludeTestProjectsFromQuery(TRACE, {}))).toContain("test-project")
      }),
      withProjectModeTestExclusion(options(vi.fn(async () => page([]))), async () => {
        expect(projectModeTestScopeCacheKey()).not.toBe("")
        expect(projectModeTestScopeCacheKey()).not.toBe(firstKey)
        const query = { query: { match_all: {} } }
        expect(excludeTestProjectsFromQuery(TRACE, query)).toBe(query)
      })
    ])
    expect(projectModeTestScopeCacheKey()).toBe("")
  })

  it.each([
    "projectMode",
    "projectModeProjects",
    "projectModeExportData",
    "projectModeCodeStats",
    "projectModeFeatureCommits",
    "projectModeProjectCommits",
    "projectModeFeatureNodes",
    "projectModeStageAnalysis",
    "projectModeOperationalDetails",
    "projectModeTraces",
    "projectCodeTrace",
    "pluginAggregate"
  ])("enables %s", (name) => {
    expect(excludesTestProjects(`dashboard:${name}`, [])).toBe(true)
  })

  it.each([
    "overview",
    "modelStats",
    "efficiency",
    "knowledgeAccumulation",
    "knowledgeProjectStats",
    "knowledgeRecentConstraintFiles",
    "projectMetricSummary",
    "userDetail",
    "threadTraces",
    "exportUserTraces"
  ])("leaves other entry point %s unchanged", (name) => {
    expect(excludesTestProjects(`dashboard:${name}`, [])).toBe(false)
  })

  it("covers project-specific user/uncommitted/non-Git/session details and exports", () => {
    for (const [channel, args] of [
      ["userDetail", ["user", {}, { projectMode: true }]],
      ["uncommittedRanking", [{}, { projectMode: true }]],
      ["uncommittedDetail", ["user", {}, { projectMode: true }]],
      ["nonGitAdoptionReports", [{}, { projectMode: true }]],
      ["threadTraces", ["thread", { scope: "project" }]],
      ["exportUserTraces", [{ projectMode: true }]],
      ["exportSkillTraces", [{ projectMode: true }]],
      ["skillDetail", ["skill", {}, { projectMode: true }]]
    ] as const)
      expect(excludesTestProjects(`dashboard:${channel}`, args)).toBe(true)
  })

  it("both latest-request and legacy IPC registrations actually apply the scoped dispatcher", async () => {
    const source = createSourceFile(
      "dashboard.ts",
      readFileSync(new URL("./dashboard.ts", import.meta.url), "utf8"),
      ScriptTarget.Latest
    )
    const names = ["registerLatestDashboardHandler", "registerScopedDashboardHandler"]
    const functions = source.statements.filter(
      (node) => isFunctionDeclaration(node) && names.includes(node.name?.text ?? "")
    )
    const calls: string[] = []
    const compiled = transpileModule(
      `${functions.map((node) => node.getText(source)).join("\n")}\nglobalThis.latest=registerLatestDashboardHandler;globalThis.legacy=registerScopedDashboardHandler`,
      { compilerOptions: { target: ScriptTarget.ES2022 } }
    ).outputText
    const ctx: Record<string, unknown> = {
      runDashboardHandlerInProjectScope: async (
        channel: string,
        _args: unknown[],
        run: () => Promise<unknown>
      ) => {
        calls.push(channel)
        return run()
      },
      dashboardRequestCoordinator: {
        run: (_sender: unknown, _family: unknown, run: () => Promise<unknown>) => run()
      }
    }
    runInNewContext(compiled, ctx)
    const handlers = new Map<string, (event: unknown) => Promise<unknown>>()
    const target = {
      handle: (channel: string, handler: (event: unknown) => Promise<unknown>) =>
        handlers.set(channel, handler)
    }
    for (const kind of ["latest", "legacy"]) {
      ;(ctx[kind] as (target: unknown, channel: string, fn: () => string) => void)(
        target,
        `dashboard:${kind}`,
        () => "ok"
      )
      expect(await handlers.get(`dashboard:${kind}`)!({ sender: {} })).toBe("ok")
    }
    expect(calls).toEqual(["dashboard:latest", "dashboard:legacy"])
    const text = source.getFullText()
    for (const name of [
      "projectModeExportData",
      "projectModeFeatureCommits",
      "projectModeProjectCommits",
      "userDetail",
      "uncommittedRanking",
      "uncommittedDetail",
      "threadTraces",
      "nonGitAdoptionReports",
      "exportUserTraces",
      "skillDetail",
      "exportSkillTraces"
    ]) {
      expect(text).toMatch(
        new RegExp(`registerScopedDashboardHandler\\(\\s*_ipcMain,\\s*"dashboard:${name}"`)
      )
    }
  })

  it("the actual ES transport sends exclusions in the request body, leaving platform requests unchanged", async () => {
    const source = createSourceFile(
      "dashboard.ts",
      readFileSync(new URL("./dashboard.ts", import.meta.url), "utf8"),
      ScriptTarget.Latest
    )
    const fn = source.statements.find(
      (node) => isFunctionDeclaration(node) && node.name?.text === "esQuery"
    )!
    const sent: Record<string, unknown>[] = []
    const ctx: Record<string, unknown> = {
      excludeTestProjectsFromQuery,
      getEsNodes: () => ["http://es.test"],
      getEsAuth: () => null,
      nodeIndex: 0,
      getDashboardRequestSignal: () => undefined,
      queryDashboardEsInWorker: async (request: { bodyText: string }) => {
        sent.push(JSON.parse(request.bodyText))
        return {}
      }
    }
    runInNewContext(
      transpileModule(`${fn.getText(source)}\nglobalThis.query=esQuery`, {
        compilerOptions: { target: ScriptTarget.ES2022 }
      }).outputText,
      ctx
    )
    const query = ctx.query as (index: string, body: Record<string, unknown>) => Promise<unknown>
    const body = { size: 0, query: { term: { harnessProjectId: "normal" } } }
    await query(TRACE, body)
    await withProjectModeTestExclusion(options(), async () => {
      await Promise.all([query(TRACE, body), query(EVENT, body)])
    })
    await query(TRACE, body)
    expect(sent[0]).toEqual(body)
    expect(sent[1].query).toHaveProperty("bool.must_not.0.terms.harnessProjectId", ["test-project"])
    expect(sent[2].query).toHaveProperty(
      ["bool", "must_not", "0", "term", "properties.isTestProject"],
      true
    )
    expect(sent[3]).toEqual(body)
  })
})
