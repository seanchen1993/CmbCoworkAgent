import { readFileSync } from "node:fs"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"
import { emptyOrgValueClauses, TRACE_BUDGET_PLACEHOLDER } from "./dashboard-org-fields"
import {
  chunkProjectMetricChatRoots,
  projectMetricChatRootFilter,
  type ProjectMetricChatBinding
} from "./project-metric-chat-bindings"
import { mergePersonalEfficiencyCodeRows } from "./dashboard-personal-efficiency"
import { projectMetricGroupFilter } from "./project-metric-group-scope"

type Row = Record<string, unknown>
const source = readFileSync(new URL("./dashboard.ts", import.meta.url), "utf8")
const ast = ts.createSourceFile("dashboard.ts", source, ts.ScriptTarget.Latest, true)
const names = new Set([
  "fetchDashboardPersonalEfficiency",
  "projectMetricDependencies",
  "projectMetricTelemetryFilters",
  "projectMetricHarnessFilter",
  "projectMetricChatScope",
  "projectMetricTelemetryScope",
  "buildUpperOrgLv1ListFilter",
  "buildUnclassifiedOrgClause",
  "appendOptionalFilter"
])
const functions = ast.statements.filter(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && Boolean(node.name && names.has(node.name.text))
)
if (functions.length !== names.size)
  throw new Error("Missing efficiency organization scope functions")
// Exercise production query builders without starting Electron or connecting to ES.
const compiled = ts.transpileModule(
  functions
    .map((node) => node.getText(ast))
    .join("\n")
    .replaceAll("import.meta.env.DEV", "false")
    .replaceAll("import.meta.env", "({})"),
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }
).outputText

function fixture(
  rooms: string[] | null,
  ids = ["h1"],
  chat: ProjectMetricChatBinding[] = []
) {
  const personal = vi.fn(async () => [])
  const organization = vi.fn(async () => ({ aggregations: { code_adopt_pushed: {} } }))
  const range = { from: "2026-10-01", to: "2026-10-31" }
  const dependencies = {
    DASHBOARD_UNCLASSIFIED_ORG: "__unclassified__",
    PROJECT_METRIC_TEAM: "统计团队",
    emptyOrgValueClauses,
    projectMetricGroupFilter,
    chunkProjectMetricChatRoots,
    projectMetricChatRootFilter,
    mergePersonalEfficiencyCodeRows,
    projectMetricFactGroupFieldCache: new Map(),
    projectMetricFactFieldsCheckedCache: new Map(),
    projectMetricAllowedRoomNames: () => null,
    getEsIndex: (name: string) => name,
    esQuery: vi.fn(),
    buildProjectModeCodeAggs: (_ids: unknown, _range: unknown, filters: Row[]) => ({
      codeGenFilters: filters,
      codeAdoptFilters: filters,
      perBucketAggs: {}
    }),
    fetchPersonalEfficiency: (
      _filters: unknown,
      _deps: unknown,
      query: (
        ids: string[],
        rooms: string[] | null,
        chat: ProjectMetricChatBinding[]
      ) => Promise<unknown>
    ) => query(ids, rooms, chat),
    fetchPersonalEfficiencyCode: personal,
    fetchProjectModeCodeAggs: organization,
    assertProjectModeResultComplete: () => {},
    asRecord: (value: unknown) => value as Row,
    normalizeCodeStatsFromAggs: () => ({
      pushedAdoptedLines: 0,
      pushedEffectiveGeneratedLines: 0,
      pushedAdoptionRate: null
    })
  }
  const api = new Function(
    ...Object.keys(dependencies),
    `${compiled}\nreturn { fetchDashboardPersonalEfficiency, projectMetricDependencies }`
  )(...Object.values(dependencies)) as {
    fetchDashboardPersonalEfficiency: (filters: unknown, access: unknown) => Promise<unknown>
    projectMetricDependencies: (access: unknown) => {
      codeStats: (
        range: unknown,
        rooms: string[] | null,
        ids: string[],
        groups?: unknown,
        chat?: ProjectMetricChatBinding[]
      ) => Promise<unknown>
    }
  }
  return {
    personal,
    organization,
    run: async () => {
      await api.fetchDashboardPersonalEfficiency({ range }, {})
      await api.projectMetricDependencies({}).codeStats(range, rooms, ids, undefined, chat)
    }
  }
}

describe("研发效能复用全局室筛选口径", () => {
  const unclassified = {
    bool: {
      should: [
        { bool: { must_not: { exists: { field: "upperOrgLv1" } } } },
        { term: { upperOrgLv1: "" } },
        { term: { upperOrgLv1: TRACE_BUDGET_PLACEHOLDER } }
      ],
      minimum_should_match: 1
    }
  }

  it.each([
    { rooms: ["__unclassified__"], clause: unclassified },
    {
      rooms: ["A室", "__unclassified__"],
      clause: {
        bool: {
          should: [{ terms: { upperOrgLv1: ["A室"] } }, unclassified],
          minimum_should_match: 1
        }
      }
    }
  ])("组织概览和个人查询都展开未归类条件：$rooms", async ({ rooms, clause }) => {
    const f = fixture(rooms)
    await f.run()
    const personalFilters = (f.personal.mock.calls[0] as unknown as [unknown, unknown, Row[]])[2]
    expect(personalFilters).toMatchObject([
      {
        bool: {
          should: [
            { bool: { filter: expect.arrayContaining([clause]) } },
            { bool: { filter: expect.arrayContaining([clause]) } }
          ]
        }
      },
      { bool: { should: [{ terms: { "properties.harnessProjectId": ["h1"] } }] } }
    ])
    expect((f.organization.mock.calls[0] as unknown as unknown[])[3]).toContainEqual(clause)
  })

  it("没有 Harness 项目时，组织和个人仍查询普通对话的代码", async () => {
    const chat = [{ sapId: "8001", rootThreadId: "chat1", prjCode: "P1" }]
    const f = fixture(["A室"], [], chat)
    await f.run()
    const scope = {
      bool: {
        filter: [projectMetricChatRootFilter(chat, "properties.rootThreadId")],
        must_not: [{ exists: { field: "properties.harnessProjectId" } }]
      }
    }
    const personalCall = f.personal.mock.calls[0] as unknown[]
    expect(personalCall[2]).toContainEqual(scope)
    const organizationCall = f.organization.mock.calls[0] as unknown[]
    expect(organizationCall[4]).toMatchObject({
      bool: {
        filter: expect.arrayContaining([
          { term: { "properties.pushed": true } },
          { bool: { should: [{ match_none: {} }, scope], minimum_should_match: 1 } }
        ])
      }
    })
  })

  it("空权限范围不能退化成全部室", async () => {
    const f = fixture([])
    await f.run()
    expect(f.personal).not.toHaveBeenCalled()
    expect((f.organization.mock.calls[0] as unknown as unknown[])[3]).toContainEqual({
      match_none: {}
    })
  })

  it("普通对话超过 200 名用户时，组织与个人查询按批次拆分避免触发 ES 子句上限", async () => {
    const chat = Array.from({ length: 410 }, (_, i) => ({
      sapId: `u${i}`,
      rootThreadId: `chat-${i}`,
      prjCode: `P${i % 5}`
    }))
    const f = fixture(["A室"], ["h1"], chat)
    await f.run()
    // 1 harness call + 3 chat batches (200 + 200 + 10)
    expect(f.personal).toHaveBeenCalledTimes(4)
    expect(f.organization).toHaveBeenCalledTimes(4)
    for (const call of f.personal.mock.calls.slice(1) as unknown[][]) {
      const filters = call[2] as Array<{ bool?: { filter?: Array<{ bool?: { should?: unknown[] } }> } }>
      const should = filters[1]?.bool?.filter?.[0]?.bool?.should ?? []
      expect(should.length).toBeLessThanOrEqual(200)
    }
  })
})
