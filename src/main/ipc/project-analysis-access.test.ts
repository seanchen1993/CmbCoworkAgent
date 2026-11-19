import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from "typescript"
import { describe, expect, it, vi } from "vitest"
import { excludesTestProjects, testProjectLookupScope } from "./project-mode-test-projects"

// Run the actual IPC gates without starting Electron or contacting Elasticsearch.
const source = createSourceFile(
  "dashboard.ts",
  readFileSync(new URL("./dashboard.ts", import.meta.url), "utf8"),
  ScriptTarget.Latest
)
const names = [
  "getDashboardAccessContext",
  "isDashboardProjectModeAllowed",
  "requireDashboardProjectModeAccess",
  "isDashboardProjectModeAdmin",
  "buildProjectModeOrgFilter",
  "buildProjectModeAccessFilter",
  "buildUpperOrgLv1Filter",
  "buildUpperOrgLv1ListFilter",
  "normalizeUpperOrgLv1List",
  "appendOptionalFilter",
  "buildNoAccessFilter",
  "requireDashboardProjectAnalysisAgentAccess",
  "runDashboardHandlerInProjectScope",
  "registerLatestDashboardHandler",
  "registerScopedDashboardHandler"
]
const functions = source.statements.filter(
  (node) => isFunctionDeclaration(node) && names.includes(node.name?.text ?? "")
)
expect(functions).toHaveLength(names.length)
const compiled = transpileModule(
  `${functions
    .map((node) => node.getText(source))
    .join("\n")
    .replaceAll("import.meta.env", "testEnv")}\nglobalThis.api = { ${names.join(",")} }`,
  { compilerOptions: { target: ScriptTarget.ES2022 } }
).outputText
const analysisChannels = [
  "projectModeRunAnalysis",
  "projectModeRunAnalysisStages",
  "projectModeRunAnalysisExportStages",
  "projectModeRunAnalysisSessions",
  "projectModeRunAnalysisThread",
  "projectModePeriodMetrics"
]
const agentChannels = [
  "projectModeAnalysisAgent",
  "projectReportWorkspace",
  "projectReportRead",
  "projectReportGenerate",
  "projectReportSaveTemplate",
  "projectReportDeleteTemplate",
  "projectReportDelete",
  "projectReportExport"
]

function fixture(ystId = "ordinary", sapId = "SAP-user", dev = false) {
  const user = { ystId, sapId, pathName: "本室" }
  const operation = vi.fn(async () => ({ success: true }))
  const scope = vi.fn(async (_options: unknown, run: () => Promise<unknown>) => run())
  const ctx: Record<string, unknown> = {
    testEnv: { DEV: dev },
    PROJECT_ANALYSIS_AGENT_ENABLED: false,
    getUserInfo: () => user,
    deriveUpperOrgLv1FromPath: (path: string) => path,
    getDashboardAllowedIds: () => new Set(["cross-room-admin"]),
    getDashboardUnrestrictedIds: () => new Set(),
    DASHBOARD_UNCLASSIFIED_ORG: "未归类",
    excludesTestProjects,
    testProjectLookupScope,
    withProjectModeTestExclusion: scope,
    getEsIndex: (name: string) => name,
    esQuery: vi.fn(),
    isDashboardRequestCancelled: () => false,
    isDashboardEsRequestCancelled: () => false,
    logDashboardRequestError: () => undefined,
    dashboardRequestCoordinator: {
      run: (_sender: unknown, _family: string, run: () => Promise<unknown>) => run()
    }
  }
  runInNewContext(compiled, ctx)
  const api = ctx.api as {
    isDashboardProjectModeAllowed(): boolean
    runDashboardHandlerInProjectScope(
      channel: string,
      args: unknown[],
      run: typeof operation
    ): Promise<unknown>
    registerLatestDashboardHandler: (
      target: unknown,
      channel: string,
      handler: typeof operation
    ) => void
    registerScopedDashboardHandler: (
      target: unknown,
      channel: string,
      handler: typeof operation
    ) => void
  }
  return {
    ctx,
    user,
    api,
    scope,
    operation,
    run: (name: string, args: unknown[] = []) =>
      api.runDashboardHandlerInProjectScope(`dashboard:${name}`, args, operation)
  }
}

describe("project analysis uses project-mode access and the independent Agent release switch", () => {
  it.each([
    ["ordinary", ""],
    ["", "SAP-user"]
  ])(
    "opens every analysis entry for a logged-in user (%s, %s) within their room",
    async (ystId, sapId) => {
      const h = fixture(ystId, sapId)
      expect(h.api.isDashboardProjectModeAllowed()).toBe(true)
      for (const channel of analysisChannels) {
        expect(await h.run(channel)).toEqual({ success: true })
        expect(h.scope.mock.calls.at(-1)?.[0]).toMatchObject({
          accessFilters: [{ term: { upperOrgLv1: "本室" } }]
        })
      }
    }
  )
  it.each(analysisChannels)("requires login before data queries through %s", async (channel) => {
    const h = fixture("", "")
    expect(h.api.isDashboardProjectModeAllowed()).toBe(false)
    expect(await h.run(channel)).toEqual({ success: false, error: "请先登录后再查看项目运营面板" })
    expect(h.scope).not.toHaveBeenCalled()
    expect(h.operation).not.toHaveBeenCalled()
  })
  it("intersects requested rooms with existing access for detail and export", async () => {
    const h = fixture()
    for (const channel of [
      "projectModeRunAnalysisSessions",
      "projectModeRunAnalysisExportStages"
    ]) {
      expect(await h.run(channel, [{ upperOrgLv1: ["其他室"] }])).toEqual({ success: true })
      expect(h.scope.mock.calls.at(-1)?.[0]).toMatchObject({
        accessFilters: [
          {
            bool: {
              filter: [{ term: { upperOrgLv1: "本室" } }, { terms: { upperOrgLv1: ["其他室"] } }]
            }
          }
        ]
      })
    }
    h.user.pathName = ""
    await h.run("projectModeRunAnalysis")
    expect(h.scope.mock.calls.at(-1)?.[0]).toMatchObject({
      accessFilters: [{ term: { traceId: "__dashboard_no_access__" } }]
    })
    const admin = fixture("cross-room-admin")
    await admin.run("projectModeRunAnalysis")
    expect(admin.scope.mock.calls[0][0]).toMatchObject({ accessFilters: [] })
  })
  it.each(agentChannels)("keeps %s gated by the separate Agent switch", async (channel) => {
    for (const dev of [false, true]) {
      const h = fixture("ordinary", "", dev)
      expect(await h.run(channel)).toEqual({ success: false, error: "项目分析 Agent 暂未开放" })
      expect(h.scope).not.toHaveBeenCalled()
      expect(h.operation).not.toHaveBeenCalled()
    }
  })
  it("requires login even if the Agent release switch is enabled", async () => {
    const h = fixture("", "")
    h.ctx.PROJECT_ANALYSIS_AGENT_ENABLED = true
    expect(await h.run("projectReportGenerate")).toEqual({
      success: false,
      error: "请先登录后再查看项目运营面板"
    })
  })
  it("applies gates through both real IPC registration paths", async () => {
    const h = fixture()
    const handlers = new Map<string, (event: unknown) => Promise<unknown>>()
    const target = {
      handle: (channel: string, handler: (event: unknown) => Promise<unknown>) =>
        handlers.set(channel, handler)
    }
    h.api.registerLatestDashboardHandler(target, "dashboard:projectModeRunAnalysis", h.operation)
    h.api.registerScopedDashboardHandler(target, "dashboard:projectReportRead", h.operation)
    expect(await handlers.get("dashboard:projectModeRunAnalysis")!({ sender: {} })).toEqual({
      success: true
    })
    expect(await handlers.get("dashboard:projectReportRead")!({ sender: {} })).toEqual({
      success: false,
      error: "项目分析 Agent 暂未开放"
    })
    expect(h.operation).toHaveBeenCalledTimes(1)
  })
})
