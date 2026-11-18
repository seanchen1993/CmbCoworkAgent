import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from "typescript"
import { describe, expect, it, vi } from "vitest"

// Run the actual IPC gates without starting Electron or contacting Elasticsearch.
const source = createSourceFile(
  "dashboard.ts",
  readFileSync(new URL("./dashboard.ts", import.meta.url), "utf8"),
  ScriptTarget.Latest
)
const names = [
  "splitEnvIds",
  "isDashboardProjectAnalysisAllowed",
  "requireDashboardProjectAnalysisAccess",
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
const ids = ["383331", "231855", "319167", "312613", "256963"]
const analysisChannels = [
  "projectModeRunAnalysis",
  "projectModeRunAnalysisStages",
  "projectModeRunAnalysisSessions",
  "projectModeRunAnalysisTrace",
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

function fixture(ystId = "outside", dev = false) {
  const user = { loggedIn: true, ystId, sapId: "80383331", unrestricted: true, upperOrgLv1: "本室" }
  const operation = vi.fn(async () => ({ success: true }))
  const scope = vi.fn(async (_options: unknown, run: () => Promise<unknown>) => run())
  const ctx: Record<string, unknown> = {
    testEnv: { DEV: dev, VITE_DASHBOARD_PROJECT_ANALYSIS_YST_IDS: ids.join(",") },
    DASHBOARD_PROJECT_ANALYSIS_IDS_ENV: "VITE_DASHBOARD_PROJECT_ANALYSIS_YST_IDS",
    PROJECT_ANALYSIS_AGENT_ENABLED: false,
    getDashboardAccessContext: () => user,
    requireDashboardProjectModeAccess: () => user,
    excludesTestProjects: () => true,
    testProjectLookupScope: () => ({}),
    buildProjectModeOrgFilter: () => ({ term: { upperOrgLv1: user.upperOrgLv1 } }),
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
    isDashboardProjectAnalysisAllowed(): boolean
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
    run: (name: string) => api.runDashboardHandlerInProjectScope(`dashboard:${name}`, [], operation)
  }
}

describe("project analysis whitelist and Agent release gate", () => {
  it.each(ids)("allows %s without expanding room access", async (id) => {
    const h = fixture(id)
    expect(h.api.isDashboardProjectAnalysisAllowed()).toBe(true)
    for (const channel of analysisChannels) expect(await h.run(channel)).toEqual({ success: true })
    expect(h.scope.mock.calls[0][0]).toMatchObject({
      accessFilters: [{ term: { upperOrgLv1: "本室" } }]
    })
  })
  it.each(analysisChannels)("blocks a direct %s call before any query", async (channel) => {
    const h = fixture()
    expect(h.api.isDashboardProjectAnalysisAllowed()).toBe(false)
    expect(await h.run(channel)).toEqual({ success: false, error: "无项目分析访问权限" })
    expect(h.scope).not.toHaveBeenCalled()
    expect(h.operation).not.toHaveBeenCalled()
  })
  it("denies logged-out users, SAP-only matches, missing config and substring matches", () => {
    const h = fixture("38333")
    h.user.sapId = "383331"
    expect(h.api.isDashboardProjectAnalysisAllowed()).toBe(false)
    h.user.ystId = "383331"
    h.user.loggedIn = false
    expect(h.api.isDashboardProjectAnalysisAllowed()).toBe(false)
    h.user.loggedIn = true
    h.ctx.testEnv = { DEV: false }
    expect(h.api.isDashboardProjectAnalysisAllowed()).toBe(false)
  })
  it.each(agentChannels)("disables %s even for a whitelisted user and in DEV", async (channel) => {
    for (const dev of [false, true]) {
      const h = fixture(ids[0], dev)
      expect(await h.run(channel)).toEqual({ success: false, error: "项目分析 Agent 暂未开放" })
      expect(h.scope).not.toHaveBeenCalled()
      expect(h.operation).not.toHaveBeenCalled()
    }
  })
  it("continues to check the whitelist if Agent is explicitly re-enabled", async () => {
    const h = fixture()
    h.ctx.PROJECT_ANALYSIS_AGENT_ENABLED = true
    expect(await h.run("projectReportGenerate")).toEqual({
      success: false,
      error: "无项目分析访问权限"
    })
  })
  it("keeps the project list available and permits analysis preview in DEV", async () => {
    expect(await fixture().run("projectModeProjects")).toEqual({ success: true })
    expect(await fixture("dev", true).run("projectModeRunAnalysis")).toEqual({ success: true })
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
      success: false,
      error: "无项目分析访问权限"
    })
    expect(await handlers.get("dashboard:projectReportRead")!({ sender: {} })).toEqual({
      success: false,
      error: "项目分析 Agent 暂未开放"
    })
    expect(h.operation).not.toHaveBeenCalled()
  })
})
