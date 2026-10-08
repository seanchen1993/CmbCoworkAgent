import { readFileSync } from "node:fs"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"

type Json = Record<string, unknown>
interface Access {
  loggedIn: boolean
  unrestricted: boolean
  sapId: string
  ystId: string
  upperOrgLv1: string
}

const source = readFileSync(new URL("./dashboard.ts", import.meta.url), "utf8")
const ast = ts.createSourceFile("dashboard.ts", source, ts.ScriptTarget.Latest, true)
const names = new Set([
  "requireDashboardUncommittedAnalysisAccess",
  "isDashboardProjectModeAdmin",
  "buildProjectModeAccessFilter",
  "buildNoAccessFilter",
  "buildUpperOrgLv1Filter",
  "normalizeUpperOrgLv1List",
  "buildUncommittedSelfUserFilter",
  "uncommittedScopeFilters",
  "fetchUncommittedRanking",
  "fetchUncommittedDetail",
  "pushBreakdown",
  "breakdownToSortedList"
])
const functions = ast.statements.filter(
  (statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && Boolean(statement.name && names.has(statement.name.text))
)
if (functions.length !== names.size) throw new Error("Missing uncommitted access function source")
const constants = ast.statements.filter(
  (statement) =>
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(
      (declaration) =>
        ts.isIdentifier(declaration.name) && declaration.name.text.startsWith("UNCOMMITTED_")
    )
)
// Run production permission branches and actual fetchers without loading Electron.
const compiled = ts.transpileModule(
  [...functions, ...constants]
    .map((statement) => statement.getText(ast))
    .join("\n")
    .replaceAll("import.meta.env.DEV", "false"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText
const range = { from: "2026-10-01T00:00:00Z", to: "2026-10-08T00:00:00Z" }
const record = (value: unknown): Json => (value && typeof value === "object" ? (value as Json) : {})

function fixture(override: Partial<Access> = {}) {
  const access: Access = {
    loggedIn: true,
    unrestricted: true,
    sapId: "80398340",
    ystId: "398340",
    upperOrgLv1: "own-room",
    ...override
  }
  const esQuery = vi.fn(async (index: string, body: Json) => {
    expect(index).toBe("event")
    expect(body.query).toBeDefined()
    return {
      aggregations: { by_sap: { buckets: [] } },
      hits: { hits: [], total: { value: 0 } }
    }
  })
  const deps = {
    getDashboardAccessContext: () => access,
    getDashboardAllowedIds: () => new Set(["398340"]),
    getTraceEvolverReviewAdminIds: () => new Set(["review-admin"]),
    esQuery,
    getEsIndex: () => "event",
    timeRangeFilter: (field: string, value: unknown) => ({ range: { [field]: value } }),
    buildNonEmptySapIdFilter: () => ({ exists: { field: "sapId" } }),
    buildUpperOrgLv1ListFilter: (list: string[]) =>
      list.length ? { terms: { upperOrgLv1: list } } : null,
    buildCodeSourceFilterClause: (source?: string) =>
      source ? { term: { "properties.source": source } } : null,
    normalizeCommitUserKeyword: (keyword?: string) => keyword?.trim() || null,
    buildCommitUserMatchFilter: (keyword: string) => ({ term: { userName: keyword } }),
    asRecord: record,
    asString: (value: unknown) => (typeof value === "string" ? value : ""),
    asNumber: (value: unknown) => (typeof value === "number" ? value : 0)
  }
  const api = new Function(
    ...Object.keys(deps),
    `${compiled}
    return { fetchUncommittedRanking, fetchUncommittedDetail, buildProjectModeAccessFilter }
  `
  )(...Object.values(deps)) as {
    fetchUncommittedRanking: (range: unknown, options?: Json) => Promise<unknown>
    fetchUncommittedDetail: (sapId: string, range: unknown, options?: Json) => Promise<unknown>
    buildProjectModeAccessFilter: (access: Access) => Json | null
  }
  async function requests(options?: Json): Promise<Json[][]> {
    await api.fetchUncommittedRanking(range, options)
    await api.fetchUncommittedDetail("other-user", range, options)
    return esQuery.mock.calls.map(([, body]) => record(record(body.query).bool).filter as Json[])
  }
  return { access, esQuery, api, requests }
}

describe("uncommitted analysis access", () => {
  it.each([
    { projectMode: true },
    { projectId: "project-1" },
    { featureSlug: "feature-1" },
    { projectMode: false, projectId: "project-1" }
  ])("lets 398340 use project overview access for ranking and detail: %j", async (options) => {
    const { requests } = fixture()
    for (const filters of await requests(options)) {
      expect(JSON.stringify(filters)).not.toContain("own-room")
      expect(JSON.stringify(filters)).not.toContain("398340")
      expect(JSON.stringify(filters)).toContain("properties.harnessProjectId")
    }
  })

  it.each([
    { ystId: "ordinary", unrestricted: false },
    { ystId: "room-manager", unrestricted: true },
    { ystId: "review-admin", unrestricted: false }
  ])(
    "uses the same room restriction as project overview for non-project-admins: %j",
    async (override) => {
      const { requests, api, access } = fixture(override)
      const overviewFilter = api.buildProjectModeAccessFilter(access)
      expect(overviewFilter).toEqual({ term: { upperOrgLv1: "own-room" } })
      for (const filters of await requests({ projectMode: true })) {
        expect(filters).toContainEqual(overviewFilter)
        expect(JSON.stringify(filters)).not.toContain(access.sapId)
      }
    }
  )

  it("allows project admins without room metadata", async () => {
    const { requests } = fixture({ upperOrgLv1: "" })
    for (const filters of await requests({ projectMode: true })) {
      expect(JSON.stringify(filters)).not.toContain("__dashboard_no_access__")
      expect(JSON.stringify(filters)).not.toContain("398340")
    }
  })

  it("denies project access for non-admins without room metadata instead of exposing all data", async () => {
    const { requests, api, access } = fixture({
      ystId: "ordinary",
      unrestricted: false,
      upperOrgLv1: ""
    })
    const overviewFilter = api.buildProjectModeAccessFilter(access)
    expect(overviewFilter).toEqual({ term: { traceId: "__dashboard_no_access__" } })
    for (const filters of await requests({ projectMode: true }))
      expect(filters).toContainEqual(overviewFilter)
  })

  it("keeps all explicit scope filters for project admins", async () => {
    const { requests } = fixture()
    for (const filters of await requests({
      projectMode: true,
      projectId: " project-1 ",
      featureSlug: " feature-1 ",
      upperOrgLv1: [" selected-room "],
      usedSkillsOnly: true,
      source: "adapter",
      userKeyword: "selected-user"
    })) {
      expect(filters).toEqual(
        expect.arrayContaining([
          { terms: { upperOrgLv1: ["selected-room"] } },
          { term: { "properties.harnessProjectId": "project-1" } },
          { term: { "properties.harnessFeatureSlug": "feature-1" } },
          { exists: { field: "properties.usedSkills" } },
          { term: { "properties.source": "adapter" } },
          { term: { userName: "selected-user" } }
        ])
      )
      expect(JSON.stringify(filters)).not.toContain("own-room")
    }
  })

  it("keeps platform analysis limited to the room for 398340", async () => {
    const { requests } = fixture()
    for (const filters of await requests({
      projectMode: false,
      projectId: " ",
      featureSlug: " "
    })) {
      expect(filters).toContainEqual({ term: { upperOrgLv1: "own-room" } })
      expect(JSON.stringify(filters)).not.toContain("properties.harnessProjectId")
    }
  })

  it("keeps platform analysis limited to self for ordinary users", async () => {
    const { requests } = fixture({ ystId: "ordinary", unrestricted: false })
    for (const filters of await requests()) {
      expect(JSON.stringify(filters)).toContain("80398340")
      expect(JSON.stringify(filters)).toContain("ordinary")
    }
  })

  it("keeps full platform access for review admins", async () => {
    const { requests } = fixture({ ystId: "review-admin", unrestricted: false })
    for (const filters of await requests())
      expect(JSON.stringify(filters)).not.toContain("own-room")
  })

  it("rejects unauthenticated ranking and detail requests before querying ES", async () => {
    const { api, esQuery } = fixture({ loggedIn: false, sapId: "", ystId: "" })
    await expect(api.fetchUncommittedRanking(range, { projectMode: true })).rejects.toThrow(
      "请先登录"
    )
    await expect(
      api.fetchUncommittedDetail("other-user", range, { projectId: "p" })
    ).rejects.toThrow("请先登录")
    expect(esQuery).not.toHaveBeenCalled()
  })
})
