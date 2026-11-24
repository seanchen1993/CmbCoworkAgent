import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import type { ProjectAgentRunEvent } from "../../shared/project-agent-run"
import type { IpcMainInvokeEvent } from "electron"
import type {
  ProjectReportDocument,
  ProjectReportResume,
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
import { generateProjectReport } from "../services/project-analysis/report-agent"
import {
  mockStreamingModel,
  TEST_PROJECT_BUDGET
} from "../services/project-analysis/streaming-model-test-fixture"
import { AIMessage, HumanMessage } from "@langchain/core/messages"

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
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, raw?: unknown, runId?: unknown) => Promise<unknown>
  >()
  const events: ProjectAgentRunEvent[] = []
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
    (await handlers.get(`dashboard:${name}`)!(
      {
        sender: {
          isDestroyed: () => false,
          send: (_channel: string, event: ProjectAgentRunEvent) => events.push(event)
        }
      } as unknown as IpcMainInvokeEvent,
      raw,
      randomUUID()
    )) as {
      success: boolean
      data: T
      error?: string
      cancelled?: boolean
      resume?: ProjectReportResume
    }
  return {
    root,
    deps,
    call,
    latest,
    events,
    controller,
    setAccess: (value: ReportAccess) => {
      access = value
    }
  }
}

describe("project report IPC workflow", () => {
  it.each([false, true])(
    "keeps a manually stopped task and resumes complete steps after restart (revision: %s)",
    async (revision) => {
      const s = setup()
      const original = revision
        ? await s.call("projectReportGenerate", { action: "create", scope, instruction: "原报告" })
        : undefined
      const input = original
        ? {
            action: "revise",
            reportId: original.data.summary.id,
            baseVersion: 1,
            instruction: "保留原要求"
          }
        : { action: "create", scope, instruction: "保留原要求" }
      const complete = vi.fn(async () => new AIMessage("已审阅数据"))
      const firstMessages = [new HumanMessage("审阅第一批")]
      const secondMessages = [new HumanMessage("生成报告")]
      s.deps.generate = vi.fn(async (options) => {
        await options.checkpoint!.run(
          "same-model",
          firstMessages,
          "第一批审阅",
          options.signal!,
          options.progress!,
          complete
        )
        await options.checkpoint!.run(
          "same-model",
          secondMessages,
          "报告生成",
          options.signal!,
          options.progress!,
          async () => {
            s.controller.abort()
            options.signal!.throwIfAborted()
            return new AIMessage("不应保存的半份报告")
          }
        )
        throw new Error("must stop")
      })
      expect((await s.call("projectReportGenerate", input)).cancelled).toBe(true)
      const event = s.events.filter((item) => item.type === "report-checkpoint").at(-1)!
      expect(event.resume).toMatchObject({ completedSteps: 1, nextStep: "报告生成" })
      s.deps.signal = () => undefined
      s.deps.generate = vi.fn(async (options) => {
        expect(options.instruction).toBe("保留原要求")
        expect(options.snapshot.periodData.dataAsOf).toBe(event.resume.dataAsOf)
        await options.checkpoint!.run(
          "same-model",
          firstMessages,
          "第一批审阅",
          options.signal!,
          options.progress!,
          complete
        )
        return { ...renderReportHtml(source, options.snapshot), modelName: "same-model" }
      })
      registerProjectReportHandlers(s.deps)
      const workspace = await s.call<ProjectReportWorkspace>("projectReportWorkspace")
      expect(workspace.data.pendingRun).toMatchObject({
        runId: event.resume.runId,
        completedSteps: 1,
        nextStep: "报告生成",
        dataAsOf: event.resume.dataAsOf
      })
      expect(workspace.data.reports).toHaveLength(revision ? 1 : 0)
      const continued = await s.call("projectReportGenerate", {
        action: "resume",
        runId: event.resume.runId
      })
      expect(continued.success).toBe(true)
      expect(continued.data.version.version).toBe(revision ? 2 : 1)
      expect(complete).toHaveBeenCalledTimes(1)
      expect(s.deps.loadPeriod).toHaveBeenCalledTimes(1)
      expect(s.deps.loadPages).toHaveBeenCalledTimes(1)
      expect(
        (await s.call<ProjectReportWorkspace>("projectReportWorkspace")).data.pendingRun
      ).toBeUndefined()
    }
  )
  it("recovers a legacy invalid binding after restart and saves the original frozen report", async () => {
    const s = setup()
    s.deps.generate = vi.fn(async (options) => {
      await options.checkpoint!.run(
        "legacy-context",
        [new HumanMessage("原会话")],
        "报告生成 · legacy-model · 第 4 轮",
        options.signal!,
        options.progress!,
        async () => new AIMessage(source.replace("meta.room", "overview.meta.period"))
      )
      throw new Error("未知数据引用：overview.meta.period")
    })
    const failed = await s.call("projectReportGenerate", {
      action: "create",
      scope,
      instruction: "原要求"
    })
    expect(failed.success).toBe(false)
    expect(failed.resume?.completedSteps).toBe(1)
    const invoke = vi.fn(async () => {
      throw new Error("Recovery must not invoke the model")
    })
    const model = mockStreamingModel({ invoke })
    s.deps.generate = (options) =>
      generateProjectReport({
        ...options,
        createModel: () => ({
          name: "legacy-model",
          budget: TEST_PROJECT_BUDGET,
          agent: model,
          final: model,
          reviewer: model
        })
      })
    registerProjectReportHandlers(s.deps)
    const recovered = await s.call("projectReportGenerate", {
      action: "resume",
      runId: failed.resume!.runId
    })
    expect(recovered.success).toBe(true)
    expect(recovered.data.html).toContain("2026-10-26 — 2026-11-01")
    expect(recovered.data.summary.dataAsOf).toBe(failed.resume!.dataAsOf)
    expect(recovered.data.version.modelName).toBe("legacy-model")
    expect(invoke).not.toHaveBeenCalled()
    expect(s.deps.loadPeriod).toHaveBeenCalledTimes(1)
    expect(s.deps.loadPages).toHaveBeenCalledTimes(1)
    expect(
      (await s.call("projectReportRead", { reportId: recovered.data.summary.id })).data.html
    ).toBe(recovered.data.html)
    expect(
      (await s.call<ProjectReportWorkspace>("projectReportWorkspace")).data.pendingRun
    ).toBeUndefined()
  })
  it("persists completed steps across restart and resumes the original scope, template and instruction", async () => {
    const s = setup()
    const firstReview = vi.fn(async () => new AIMessage("第一批审阅完成"))
    let interrupted = true
    s.deps.generate = vi.fn(async (options) => {
      await options.checkpoint!.run(
        "default",
        [new HumanMessage(JSON.stringify(options.snapshot.facts))],
        "全量数据审阅 1/5",
        options.signal!,
        options.progress!,
        firstReview
      )
      if (interrupted) {
        await options.checkpoint!.run(
          "default",
          [new HumanMessage("第二批")],
          "全量数据审阅 2/5",
          options.signal!,
          options.progress!,
          async () => {
            throw new Error("默认模型请求失败（HTTP 433），已自动重试3次仍失败")
          }
        )
      }
      return { ...renderReportHtml(source, options.snapshot), modelName: "test" }
    })
    const result = await s.call("projectReportGenerate", {
      action: "create",
      scope,
      instruction: "请按项目分析",
      templateId: RECOMMENDED_REPORT_TEMPLATE_ID
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain("HTTP 433")
    expect(result.resume).toMatchObject({ completedSteps: 1, nextStep: "全量数据审阅 2/5" })
    expect(firstReview).toHaveBeenCalledTimes(1)
    registerProjectReportHandlers(s.deps)
    const workspace = await s.call<ProjectReportWorkspace>("projectReportWorkspace")
    expect(workspace.data.pendingRun).toEqual(result.resume)
    expect(workspace.data.reports).toHaveLength(0)
    interrupted = false
    const resumed = await s.call("projectReportGenerate", {
      action: "resume",
      runId: result.resume!.runId
    })
    expect(resumed.success).toBe(true)
    expect(firstReview).toHaveBeenCalledTimes(1)
    expect(s.deps.loadPeriod).toHaveBeenCalledTimes(1)
    expect(s.deps.loadPages).toHaveBeenCalledTimes(1)
    expect(s.deps.loadAccumulation).toHaveBeenCalledTimes(1)
    const [first, second] = vi.mocked(s.deps.generate!).mock.calls.map(([options]) => options)
    expect(second.snapshot).toEqual(first.snapshot)
    expect(second.template).toEqual(first.template)
    expect(second.instruction).toBe("请按项目分析")
    expect(
      (await s.call<ProjectReportWorkspace>("projectReportWorkspace")).data.pendingRun
    ).toBeUndefined()
    expect(
      (await s.call("projectReportGenerate", { action: "resume", runId: result.resume!.runId }))
        .error
    ).toContain("不存在")
  })
  it("isolates resume state by owner, room and environment; new generation replaces the unfinished task", async () => {
    const s = setup()
    s.deps.generate = vi.fn(async () => {
      throw new Error("HTTP 433")
    })
    const first = await s.call("projectReportGenerate", {
      action: "create",
      scope,
      instruction: ""
    })
    const resume = { action: "resume", runId: first.resume!.runId }
    for (const access of [
      { ownerId: "sap:2", ownRoom: "开发一室", canChooseRoom: false },
      { ownerId: "sap:1", ownRoom: "开发二室", canChooseRoom: false }
    ]) {
      s.setAccess(access)
      expect(
        (await s.call<ProjectReportWorkspace>("projectReportWorkspace")).data.pendingRun
      ).toBeUndefined()
      expect((await s.call("projectReportGenerate", resume)).success).toBe(false)
    }
    s.setAccess({ ownerId: "sap:1", ownRoom: "开发一室", canChooseRoom: false })
    s.deps.exampleData = true
    expect((await s.call("projectReportGenerate", resume)).error).toContain("运行环境已变化")
    s.deps.exampleData = false
    const newer = await s.call("projectReportGenerate", {
      action: "create",
      scope,
      instruction: "新要求"
    })
    expect(newer.resume!.runId).not.toBe(first.resume!.runId)
    expect((await s.call("projectReportGenerate", resume)).error).toContain("替换")
    expect(s.deps.generate).toHaveBeenCalledTimes(2)
  })
  it.each([undefined, "provider/second"])(
    "changes the resume model only when requested: %s",
    async (modelId) => {
      const s = setup()
      s.deps.generate = vi
        .fn(async (options) => ({
          ...renderReportHtml(source, options.snapshot),
          modelName: options.modelId!
        }))
        .mockRejectedValueOnce(new Error("HTTP 433"))
      const first = await s.call("projectReportGenerate", {
        action: "create",
        scope,
        instruction: "保留原数据",
        modelId: "provider/first"
      })
      expect(first.resume?.modelId).toBe("provider/first")
      const workspace = await s.call<ProjectReportWorkspace>("projectReportWorkspace")
      expect(workspace.data.pendingRun?.modelId).toBe("provider/first")
      expect(s.deps.generate).toHaveBeenCalledTimes(1)
      const resumed = await s.call("projectReportGenerate", {
        action: "resume",
        runId: first.resume!.runId,
        ...(modelId ? { modelId } : {})
      })
      expect(resumed.success).toBe(true)
      expect(resumed.data.version.modelName).toBe(modelId ?? "provider/first")
      expect(s.deps.loadPeriod).toHaveBeenCalledTimes(1)
      expect(s.deps.loadPages).toHaveBeenCalledTimes(1)
      const [before, after] = vi.mocked(s.deps.generate).mock.calls.map(([options]) => options)
      expect(after.snapshot).toEqual(before.snapshot)
      expect(before.modelId).toBe("provider/first")
      expect(after.modelId).toBe(modelId ?? before.modelId)
      expect(after.instruction).toBe(before.instruction)
    }
  )
  it("resumes a failed revision without replacing v1 and rejects concurrent resumes", async () => {
    const s = setup()
    const first = await s.call("projectReportGenerate", {
      action: "create",
      scope,
      instruction: ""
    })
    s.deps.generate = vi.fn(async () => {
      throw new Error("HTTP 433")
    })
    const failed = await s.call("projectReportGenerate", {
      action: "revise",
      reportId: first.data.summary.id,
      baseVersion: 1,
      instruction: "换布局"
    })
    expect(
      (await s.call("projectReportRead", { reportId: first.data.summary.id })).data.versions
    ).toHaveLength(1)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    s.deps.generate = vi.fn(async (options) => {
      expect(options.previousSource).toContain('data-report-value="meta.room"')
      expect(options.loadStages).toBeUndefined()
      await gate
      return { ...renderReportHtml(source, options.snapshot), modelName: "test" }
    })
    const request = { action: "resume", runId: failed.resume!.runId }
    const running = s.call("projectReportGenerate", request)
    try {
      expect((await s.call("projectReportGenerate", request)).error).toContain("正在运行")
      expect(
        (await s.call<ProjectReportWorkspace>("projectReportWorkspace")).data.pendingRun
      ).toBeUndefined()
    } finally {
      release()
    }
    const resumed = await running
    expect(resumed.success).toBe(true)
    expect(resumed.data.version.version).toBe(2)
    expect(
      (await s.call("projectReportRead", { reportId: first.data.summary.id, version: 1 })).data.html
    ).toBe(first.data.html)
    expect(s.deps.loadPeriod).toHaveBeenCalledTimes(1)
  })
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
    registerProjectReportHandlers({ ...s.deps, signal: () => undefined })
    expect(
      (await s.call<ProjectReportWorkspace>("projectReportWorkspace")).data.pendingRun
    ).toMatchObject({ completedSteps: 0 })
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
