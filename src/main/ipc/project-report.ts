import { projectAgentProgress } from "./project-agent-progress"
import { createProjectRunReporter } from "../services/project-analysis/run-progress"
import { BrowserWindow, dialog, type IpcMainInvokeEvent } from "electron"
import { writeFile } from "node:fs/promises"
import { z } from "zod"
import type {
  KnowledgeAccumulationData,
  KnowledgeActiveDetails
} from "../../shared/dashboard-knowledge-overview"
import type { ProjectReportScope } from "../../shared/project-analysis-report"
import type { ProjectOperationsPeriodData } from "../../shared/project-operations-period"
import { buildReportSnapshot } from "../services/project-analysis/report-data"
import {
  generateProjectReport,
  parseReportGeneration,
  parseReportTemplate
} from "../services/project-analysis/report-agent"
import { ProjectReportStore } from "../services/project-analysis/report-store"
import type { ProjectPageData } from "../services/project-analysis/page-data"
import type {
  RunAnalysisSessionRequest,
  RunAnalysisSessions,
  RunAnalysisStages
} from "../../shared/project-run-analysis"

export interface ReportAccess {
  ownerId: string
  ownRoom: string
  canChooseRoom: boolean
}
type Handler = (event: IpcMainInvokeEvent, raw?: unknown, runId?: unknown) => Promise<unknown>
export interface ProjectReportDependencies {
  register(channel: string, handler: Handler, latest: boolean): void
  access(): ReportAccess
  appDirectory(): string
  signal(): AbortSignal | undefined
  loadRooms(): Promise<string[]>
  loadPeriod(scope: ProjectReportScope, signal: AbortSignal): Promise<ProjectOperationsPeriodData>
  loadAccumulation(room: string, signal: AbortSignal): Promise<KnowledgeAccumulationData>
  loadActive(room: string, signal: AbortSignal): Promise<KnowledgeActiveDetails>
  loadPages(scope: ProjectReportScope, signal: AbortSignal): Promise<ProjectPageData>
  loadStages(
    room: string,
    projectId: string,
    featureSlug: string | null,
    signal: AbortSignal
  ): Promise<RunAnalysisStages>
  loadSessions(
    room: string,
    request: RunAnalysisSessionRequest,
    signal: AbortSignal
  ): Promise<RunAnalysisSessions>
  exampleData: boolean
  generate?: typeof generateProjectReport
}
const reportRef = z
  .object({ reportId: z.string().uuid(), version: z.number().int().min(1).max(20).optional() })
  .strict()
const templateRef = z.object({ templateId: z.string().uuid() }).strict()
class ReportActionCancelled extends Error {}

export function registerProjectReportHandlers(deps: ProjectReportDependencies): void {
  function register(
    name: string,
    action: (
      store: ProjectReportStore,
      access: ReportAccess,
      event: IpcMainInvokeEvent,
      raw: unknown,
      checkAccess: () => void,
      runId?: unknown
    ) => Promise<unknown>,
    latest = false
  ) {
    deps.register(
      `dashboard:${name}`,
      async (event, raw, runId) => {
        try {
          const access = deps.access()
          const canReadRoom = (room: string) =>
            access.canChooseRoom || (!!access.ownRoom && room === access.ownRoom)
          const store = new ProjectReportStore(deps.appDirectory(), access.ownerId, canReadRoom)
          const checkAccess = () => {
            const current = deps.access()
            if (
              current.ownerId !== access.ownerId ||
              current.ownRoom !== access.ownRoom ||
              current.canChooseRoom !== access.canChooseRoom
            )
              throw new Error("登录身份或室权限已变化，请重新打开报告")
            deps.signal()?.throwIfAborted()
          }
          const data = await action(store, access, event, raw, checkAccess, runId)
          return { success: true, data }
        } catch (error) {
          if (deps.signal()?.aborted || error instanceof ReportActionCancelled)
            return { success: false, cancelled: true }
          return {
            success: false,
            error:
              error instanceof z.ZodError
                ? "报告参数无效，请重新选择"
                : error instanceof Error
                  ? error.message
                  : "报告操作失败，请重试"
          }
        }
      },
      latest
    )
  }
  register("projectReportWorkspace", async (store, access, _event, _raw, check) => {
    const rooms = access.canChooseRoom
      ? await deps.loadRooms().catch(() => [])
      : [access.ownRoom].filter(Boolean)
    check()
    return {
      reports: store.listReports(),
      templates: store.listTemplates(),
      ownRoom: access.ownRoom,
      canChooseRoom: access.canChooseRoom,
      rooms
    }
  })
  register("projectReportRead", async (store, _access, _event, raw) => {
    const input = reportRef.parse(raw)
    return store.read(input.reportId, input.version)
  })
  register(
    "projectReportGenerate",
    async (store, access, event, raw, check, runId) => {
      const input = parseReportGeneration(raw)
      const timeout = AbortSignal.timeout(900_000)
      const parent = deps.signal()
      const signal = parent ? AbortSignal.any([parent, timeout]) : timeout
      const progress = createProjectRunReporter(projectAgentProgress(event, runId, signal))
      try {
        signal.throwIfAborted()
        if (input.action === "revise") {
          const previous = store.read(input.reportId, input.baseVersion)
          if (previous.summary.latestVersion !== input.baseVersion)
            throw new Error("请先切换到报告最新版本再修改")
          if (input.baseVersion >= 20) throw new Error("此报告已达20个版本，请新建报告继续调整")
          const readStep = progress.begin("data", "读取报告冻结数据", "复用原报告快照，不刷新数据")
          const snapshot = store.snapshot(input.reportId)
          readStep.finish("原报告数据及已缓存明细读取完成")
          const result = await (deps.generate ?? generateProjectReport)({
            snapshot,
            instruction: input.instruction,
            previousSource: store.source(input.reportId, input.baseVersion),
            progress,
            signal
          })
          signal.throwIfAborted()
          check()
          const saveStep = progress.begin("save", "保存报告新版本")
          const document = store.revise(
            input.reportId,
            input.baseVersion,
            result,
            input.instruction,
            result.modelName
          )
          saveStep.finish(`已保存 v${document.version.version}`)
          return document
        }
        if (!access.canChooseRoom && input.scope.upperOrgLv1 !== access.ownRoom)
          throw new Error("无该室报告生成权限")
        const template = input.templateId ? store.readTemplate(input.templateId) : undefined
        const knowledgeAsOf = new Date().toISOString()
        const readStep = progress.begin(
          "data",
          "读取全室报告数据",
          "查询周期活动、项目列表、项目分析和近30天知识数据"
        )
        const [period, accumulation, active, pages] = await Promise.allSettled([
          deps.loadPeriod(input.scope, signal),
          deps.loadAccumulation(input.scope.upperOrgLv1, signal),
          deps.loadActive(input.scope.upperOrgLv1, signal),
          deps.loadPages(input.scope, signal)
        ])
        signal.throwIfAborted()
        check()
        if (period.status !== "fulfilled") throw period.reason
        if (pages.status !== "fulfilled") throw pages.reason
        if (period.value.room !== input.scope.upperOrgLv1)
          throw new Error("查询数据与报告室范围不一致")
        readStep.finish(
          `项目列表 ${pages.value.projectList.length} 个项目 · 项目分析 ${pages.value.analysis.rows.length} 条记录${accumulation.status === "rejected" || active.status === "rejected" ? " · 部分知识数据不可用，将注明缺失" : ""}`
        )
        const snapshot = buildReportSnapshot({
          scope: input.scope,
          data: period.value,
          accumulation: accumulation.status === "fulfilled" ? accumulation.value : null,
          active: active.status === "fulfilled" ? active.value : null,
          knowledgeAsOf,
          exampleData: deps.exampleData
        })
        snapshot.pageData = pages.value
        snapshot.notes.push(
          "项目列表（含归档）和项目分析（当前进行中）采用页面现有累计口径，作为当前项目诊断背景；与报告自然周/月活动指标分别展示。"
        )
        const result = await (deps.generate ?? generateProjectReport)({
          snapshot,
          instruction: input.instruction,
          template,
          progress,
          signal,
          loadStages: (projectId, featureSlug, signal) =>
            deps.loadStages(input.scope.upperOrgLv1, projectId, featureSlug, signal),
          loadSessions: (request, signal) =>
            deps.loadSessions(input.scope.upperOrgLv1, request, signal)
        })
        signal.throwIfAborted()
        check()
        if (result.reviewNote) snapshot.notes.push(result.reviewNote)
        const saveStep = progress.begin("save", "保存报告")
        const document = store.create(snapshot, result, input.instruction, result.modelName)
        saveStep.finish("报告已保存，可预览和导出 HTML")
        return document
      } catch (error) {
        if (timeout.aborted && !parent?.aborted)
          throw new Error("报告查询或生成超时，已保留原版本；请重试")
        throw error
      }
    },
    true
  )
  register("projectReportSaveTemplate", async (store, _access, _event, raw) => {
    const input = parseReportTemplate(raw)
    return store.saveTemplate(input.reportId, input.version, input.name, input.preferences)
  })
  register("projectReportDeleteTemplate", async (store, _access, _event, raw) => {
    store.deleteTemplate(templateRef.parse(raw).templateId)
    return null
  })
  register("projectReportDelete", async (store, _access, _event, raw) => {
    store.deleteReport(reportRef.parse(raw).reportId)
    return null
  })
  register("projectReportExport", async (store, _access, event, raw, check) => {
    const input = reportRef.required().parse(raw)
    const document = store.read(input.reportId, input.version)
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
    const options = {
      title: "导出综合报告",
      defaultPath: `${Array.from(document.summary.title)
        .map((char) => (char.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(char) ? "-" : char))
        .join("")}-v${input.version}.html`,
      filters: [{ name: "HTML 报告", extensions: ["html"] }]
    }
    const chosen = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    if (chosen.canceled || !chosen.filePath) throw new ReportActionCancelled()
    check()
    // Recheck after the save dialog: the report might have been deleted while it was open.
    const current = store.read(input.reportId, input.version)
    await writeFile(chosen.filePath, current.html, { encoding: "utf8", mode: 0o600 })
    return { filePath: chosen.filePath }
  })
}
