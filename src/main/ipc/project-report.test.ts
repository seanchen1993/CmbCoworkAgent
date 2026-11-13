import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { IpcMainInvokeEvent } from "electron"
import type {
  ProjectReportDocument,
  ProjectReportTemplate,
  ProjectReportWorkspace
} from "../../shared/project-analysis-report"
import { RECOMMENDED_REPORT_TEMPLATE_ID } from "../../shared/project-analysis-report"
vi.mock("../models/registry", () => ({ getDefaultModelConfig: () => null }))
vi.mock("../models/connection", () => ({ getModelClientOptions: () => ({}) }))
const saveDialog = vi.hoisted(() => vi.fn())
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => null, getFocusedWindow: () => null },
  dialog: { showSaveDialog: saveDialog }
}))
import {
  registerProjectReportHandlers,
  type ProjectReportDependencies,
  type ReportAccess
} from "./project-report"
import { makeReportPeriodExample } from "../services/project-analysis/report-mock"
import { projectListPageData } from "../services/project-analysis/page-data"
import { makeMockRunAnalysis } from "./project-run-analysis-mock"
import { renderReportHtml } from "../services/project-analysis/report-html"

const roots: string[] = []
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true })
  vi.clearAllMocks()
})
const source =
  '<html><head><style>body{color:#234}</style></head><body><h1 data-report-value="meta.room"></h1><span data-report-value="summary.projectCount"></span></body></html>'
const scope = {
  upperOrgLv1: "开发一室",
  period: { kind: "week" as const, anchorDate: "2026-10-27" }
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), "report-ipc-"))
  roots.push(root)
  let access: ReportAccess = { ownerId: "sap:1", ownRoom: "开发一室", canChooseRoom: false }
  const controller = new AbortController()
  const handlers = new Map<string, (event: IpcMainInvokeEvent, raw?: unknown) => Promise<unknown>>()
  const latest: string[] = []
  const deps: ProjectReportDependencies = {
    register: (name, handler, isLatest) => {
      handlers.set(name, handler)
      if (isLatest) latest.push(name)
    },
    access: () => access,
    appDirectory: () => root,
    signal: () => controller.signal,
    loadRooms: vi.fn(async () => ["开发一室", "开发二室"]),
    loadPeriod: vi.fn(async (s) => makeReportPeriodExample(s)),
    loadAccumulation: vi.fn(async () => ({
      totals: null,
      users: null,
      orgs: null,
      systems: null,
      errors: {}
    })),
    loadActive: vi.fn(async () => ({ items: [] })),
    loadPages: vi.fn(async (scope) =>
      projectListPageData(
        [],
        makeMockRunAnalysis(
          { from: "2026-10-26T00:00:00Z", to: "2026-11-02T00:00:00Z" },
          { upperOrgLv1: scope.upperOrgLv1 }
        )
      )
    ),
    loadStages: vi.fn(async () => ({ rows: [], dataAsOf: new Date().toISOString() })),
    loadSessions: vi.fn(async () => ({ rows: [], total: 0, after: null })),
    exampleData: false,
    generate: vi.fn(async (options) => ({
      ...renderReportHtml(source, options.snapshot),
      modelName: "test-model"
    }))
  }
  registerProjectReportHandlers(deps)
  const call = async <T = ProjectReportDocument>(name: string, raw?: unknown) =>
    (await handlers.get(`dashboard:${name}`)!({ sender: {} } as IpcMainInvokeEvent, raw)) as {
      success: boolean
      data: T
      error?: string
      cancelled?: boolean
    }
  return {
    root,
    deps,
    call,
    latest,
    controller,
    setAccess: (value: ReportAccess) => {
      access = value
    }
  }
}

describe("project report IPC workflow", () => {
  it("uses local lazy workspace without fetching period data, locks non-admin rooms", async () => {
    const s = setup()
    const workspace = await s.call<ProjectReportWorkspace>("projectReportWorkspace")
    expect(workspace.data).toMatchObject({
      ownRoom: "开发一室",
      canChooseRoom: false,
      rooms: ["开发一室"],
      reports: [],
      templates: [expect.objectContaining({ id: RECOMMENDED_REPORT_TEMPLATE_ID, kind: "builtin" })]
    })
    expect(s.deps.loadPeriod).not.toHaveBeenCalled()
    expect(s.deps.loadRooms).not.toHaveBeenCalled()
    const deletion = await s.call("projectReportDeleteTemplate", {
      templateId: RECOMMENDED_REPORT_TEMPLATE_ID
    })
    expect(deletion.error).toContain("内置推荐不能删除")
    const denied = await s.call("projectReportGenerate", {
      action: "create",
      scope: { ...scope, upperOrgLv1: "开发二室" },
      instruction: ""
    })
    expect(denied.success).toBe(false)
    expect(s.deps.generate).not.toHaveBeenCalled()
    expect(s.latest).toEqual(["dashboard:projectReportGenerate"])
  })
  it("completes create → revise on frozen facts → save template → create on fresh facts", async () => {
    const s = setup()
    const first = await s.call("projectReportGenerate", {
      action: "create",
      scope,
      instruction: "简洁",
      templateId: RECOMMENDED_REPORT_TEMPLATE_ID
    })
    expect(first.success).toBe(true)
    expect(vi.mocked(s.deps.generate!).mock.calls[0][0].template).toMatchObject({
      id: RECOMMENDED_REPORT_TEMPLATE_ID,
      kind: "builtin"
    })
    const reportId = first.data.summary.id
    const revised = await s.call("projectReportGenerate", {
      action: "revise",
      reportId,
      baseVersion: 1,
      instruction: "换颜色"
    })
    expect(revised.data.version.version).toBe(2)
    expect(s.deps.loadPeriod).toHaveBeenCalledTimes(1)
    expect(s.deps.loadAccumulation).toHaveBeenCalledTimes(1)
    expect(s.deps.loadPages).toHaveBeenCalledTimes(1)
    const saved = await s.call<ProjectReportTemplate>("projectReportSaveTemplate", {
      reportId,
      version: 2,
      name: "我的周报",
      preferences: "浅色"
    })
    expect(saved.success).toBe(true)
    expect(saved.data.kind).toBe("personal")
    expect(saved.data.id).not.toBe(RECOMMENDED_REPORT_TEMPLATE_ID)
    expect(s.deps.generate).toHaveBeenCalledTimes(2)
    await s.call("projectReportGenerate", {
      action: "create",
      scope,
      instruction: "",
      templateId: saved.data.id
    })
    expect(s.deps.loadPeriod).toHaveBeenCalledTimes(2)
    expect(vi.mocked(s.deps.generate!).mock.calls[2][0].template?.preferences).toBe("浅色")
    expect(
      (await s.call<ProjectReportWorkspace>("projectReportWorkspace")).data.templates.map(
        (t) => t.id
      )
    ).toEqual([RECOMMENDED_REPORT_TEMPLATE_ID, saved.data.id])
    const old = await s.call("projectReportRead", { reportId, version: 1 })
    expect(old.data.version.version).toBe(1)
    expect(old.data.versions).toHaveLength(2)
  })
  it("does not commit late model results after cancellation or login change", async () => {
    const s = setup()
    s.deps.generate = vi.fn(async (options) => {
      s.controller.abort()
      return { ...renderReportHtml(source, options.snapshot), modelName: "test" }
    })
    const cancelled = await s.call("projectReportGenerate", {
      action: "create",
      scope,
      instruction: ""
    })
    expect(cancelled.cancelled).toBe(true)
    const other = setup()
    other.deps.generate = vi.fn(async (options) => {
      other.setAccess({ ownerId: "sap:2", ownRoom: "开发一室", canChooseRoom: false })
      return { ...renderReportHtml(source, options.snapshot), modelName: "test" }
    })
    const changed = await other.call("projectReportGenerate", {
      action: "create",
      scope,
      instruction: ""
    })
    expect(changed.error).toContain("身份")
    other.setAccess({ ownerId: "sap:1", ownRoom: "开发一室", canChooseRoom: false })
    expect(
      (await other.call<ProjectReportWorkspace>("projectReportWorkspace")).data.reports
    ).toEqual([])
  })
  it("keeps a valid original version when revision fails; unavailable knowledge does not become zero", async () => {
    const s = setup()
    s.deps.loadAccumulation = vi.fn(async () => {
      throw new Error("unavailable")
    })
    const created = await s.call("projectReportGenerate", {
      action: "create",
      scope,
      instruction: ""
    })
    expect(created.success).toBe(true)
    expect(created.data.notes.join(" ")).toContain("缺失指标不补零")
    s.deps.generate = vi.fn(async () => {
      throw new Error("model unavailable")
    })
    expect(
      (
        await s.call("projectReportGenerate", {
          action: "revise",
          reportId: created.data.summary.id,
          baseVersion: 1,
          instruction: "修改"
        })
      ).success
    ).toBe(false)
    expect(
      (await s.call("projectReportRead", { reportId: created.data.summary.id })).data.versions
    ).toHaveLength(1)
  })
  it("exports the selected immutable version and handles cancellation explicitly", async () => {
    const s = setup()
    const created = await s.call("projectReportGenerate", {
      action: "create",
      scope,
      instruction: ""
    })
    saveDialog.mockResolvedValueOnce({ canceled: true })
    expect(
      (await s.call("projectReportExport", { reportId: created.data.summary.id, version: 1 }))
        .cancelled
    ).toBe(true)
    const filePath = join(s.root, "report.html")
    saveDialog.mockResolvedValueOnce({ canceled: false, filePath })
    expect(
      (
        await s.call<{ filePath: string }>("projectReportExport", {
          reportId: created.data.summary.id,
          version: 1
        })
      ).data.filePath
    ).toBe(filePath)
    expect(readFileSync(filePath, "utf8")).toBe(created.data.html)
  })
  it("does not generate a sampled report if either page data source fails", async () => {
    const s = setup()
    s.deps.loadPages = vi.fn(async () => {
      throw new Error("项目列表未完整返回")
    })
    const result = await s.call("projectReportGenerate", {
      action: "create",
      scope,
      instruction: ""
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain("未完整")
    expect(s.deps.generate).not.toHaveBeenCalled()
    expect(
      (await s.call<ProjectReportWorkspace>("projectReportWorkspace")).data.reports
    ).toHaveLength(0)
  })
  it("binds detail queries to the report room and withholds live loaders when revising frozen data", async () => {
    const s = setup()
    s.deps.generate = vi.fn(async (options) => {
      if (!options.previousSource) {
        await options.loadSessions!(
          { projectId: "p1", featureSlug: "f1", metric: "noSkill", nodeName: null },
          options.signal!
        )
        await options.loadStages!("p1", "f1", options.signal!)
      } else {
        expect(options.loadSessions).toBeUndefined()
        expect(options.loadStages).toBeUndefined()
      }
      return { ...renderReportHtml(source, options.snapshot), modelName: "test" }
    })
    const created = await s.call("projectReportGenerate", {
      action: "create",
      scope,
      instruction: "分析后生成"
    })
    expect(created.success).toBe(true)
    expect(s.deps.loadSessions).toHaveBeenCalledWith(
      scope.upperOrgLv1,
      { projectId: "p1", featureSlug: "f1", metric: "noSkill", nodeName: null },
      expect.any(AbortSignal)
    )
    expect(s.deps.loadStages).toHaveBeenCalledWith(
      scope.upperOrgLv1,
      "p1",
      "f1",
      expect.any(AbortSignal)
    )
    const revised = await s.call("projectReportGenerate", {
      action: "revise",
      reportId: created.data.summary.id,
      baseVersion: 1,
      instruction: "调样式"
    })
    expect(revised.success).toBe(true)
    expect(s.deps.loadSessions).toHaveBeenCalledTimes(1)
    expect(s.deps.loadStages).toHaveBeenCalledTimes(1)
  })
})
