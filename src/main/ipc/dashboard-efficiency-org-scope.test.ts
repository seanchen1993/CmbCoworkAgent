import { readFileSync } from "node:fs"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"
import { emptyOrgValueClauses, TRACE_BUDGET_PLACEHOLDER } from "./dashboard-org-fields"

type Row = Record<string, unknown>
const source = readFileSync(new URL("./dashboard.ts", import.meta.url), "utf8")
const ast = ts.createSourceFile("dashboard.ts", source, ts.ScriptTarget.Latest, true)
const names = new Set([
  "fetchDashboardPersonalEfficiency",
  "projectMetricDependencies",
  "projectMetricHarnessFilter",
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

function fixture(rooms: string[] | null) {
  const personal = vi.fn(async () => [])
  const organization = vi.fn(async () => ({ aggregations: { code_adopt_pushed: {} } }))
  const range = { from: "2026-10-01", to: "2026-10-31" }
  const dependencies = {
    DASHBOARD_UNCLASSIFIED_ORG: "__unclassified__",
    PROJECT_METRIC_TEAM: "统计团队",
    emptyOrgValueClauses,
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
      query: (ids: string[], rooms: string[] | null) => Promise<unknown>
    ) => query(["h1"], rooms),
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
      codeStats: (range: unknown, rooms: string[] | null, ids: string[]) => Promise<unknown>
    }
  }
  return {
    personal,
    organization,
    run: async () => {
      await api.fetchDashboardPersonalEfficiency({ range }, {})
      await api.projectMetricDependencies({}).codeStats(range, rooms, ["h1"])
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
      }
    ])
    expect((f.organization.mock.calls[0] as unknown as unknown[])[3]).toContainEqual(clause)
  })

  it("空权限范围不能退化成全部室", async () => {
    const f = fixture([])
    await f.run()
    expect(f.personal).not.toHaveBeenCalled()
    expect((f.organization.mock.calls[0] as unknown as unknown[])[3]).toContainEqual({
      match_none: {}
    })
  })
})
