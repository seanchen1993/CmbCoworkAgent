import { projectAgentProgress } from "./project-agent-progress"
import { createProjectRunReporter } from "../services/project-analysis/run-progress"
import { BrowserWindow, dialog, type IpcMainInvokeEvent } from "electron"
import { writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import type {
  KnowledgeAccumulationData,
  KnowledgeActiveDetails
} from "../../shared/dashboard-knowledge-overview"
import type { ProjectReportResume, ProjectReportScope } from "../../shared/project-analysis-report"
import type { ProjectOperationsPeriodData } from "../../shared/project-operations-period"
import { buildReportSnapshot } from "../services/project-analysis/report-data"
import {
  generateProjectReport,
  parseReportGeneration,
  parseReportTemplate
} from "../services/project-analysis/report-agent"
import { ProjectReportStore, type SavedReportRun } from "../services/project-analysis/report-store"
import { ProjectModelCheckpoint } from "../services/project-analysis/model-checkpoint"
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
class ReportRunFailed extends Error {
  constructor(
    message: string,
    readonly resume: ProjectReportResume
  ) {
    super(message)
  }
}

export function registerProjectReportHandlers(deps: ProjectReportDependencies): void {
  const activeRuns = new Set<string>()
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
            ...(error instanceof ReportRunFailed ? { resume: error.resume } : {}),
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
      rooms,
      pendingRun: (() => {
        const pending = store.pendingRun()
        return pending && !activeRuns.has(pending.runId) ? pending : undefined
      })()
    }
  })
  register("projectReportRead", async (store, _access, _event, raw) => {
    const input = reportRef.parse(raw)
    return store.read(input.reportId, input.version)
  })
  register(
    "projectReportGenerate",
    async (store, access, event, raw, check, runId) => {
      const request = parseReportGeneration(raw)
      const timeout = AbortSignal.timeout(3_600_000)
      const parent = deps.signal()
      const signal = parent ? AbortSignal.any([parent, timeout]) : timeout
      const progress = createProjectRunReporter(projectAgentProgress(event, runId, signal))
      let run: SavedReportRun | undefined
      let acquired = false
      try {
        signal.throwIfAborted()
        if (request.action === "resume") {
          run = store.readRun(request.runId)
          if (activeRuns.has(run.id)) throw new Error("这份报告任务正在运行，请展开查看进度")
          if (run.snapshot.exampleData !== deps.exampleData)
            throw new Error("运行环境已变化，请新建报告获取当前环境的数据")
          // Only an explicit resume request may change the selected model; retries never do.
          if (request.modelId !== undefined) run.input.modelId = request.modelId
          progress
            .begin("data", "恢复报告任务", "沿用原要求、模板和数据快照，不重新查询全室数据")
            .finish(
              `已保存 ${Object.keys(run.models.completed).length} 个完成步骤；继续 ${run.models.pendingStep ?? "后续生成"}`
            )
        } else if (request.action === "revise") {
          const previous = store.read(request.reportId, request.baseVersion)
          if (previous.summary.latestVersion !== request.baseVersion)
            throw new Error("请先切换到报告最新版本再修改")
          if (request.baseVersion >= 20) throw new Error("此报告已达20个版本，请新建报告继续调整")
          const readStep = progress.begin("data", "读取报告冻结数据", "复用原报告快照，不刷新数据")
          run = {
            schema: 1,
            id: randomUUID(),
            input: request,
            snapshot: store.snapshot(request.reportId),
            previousSource: store.source(request.reportId, request.baseVersion),
            models: { completed: {} },
            updatedAt: new Date().toISOString()
          }
          readStep.finish("原报告数据及已缓存明细读取完成")
        } else {
          if (!access.canChooseRoom && request.scope.upperOrgLv1 !== access.ownRoom)
            throw new Error("无该室报告生成权限")
          const template = request.templateId ? store.readTemplate(request.templateId) : undefined
          const knowledgeAsOf = new Date().toISOString()
          const readStep = progress.begin(
            "data",
            "读取全室报告数据",
            "查询周期活动、项目列表、项目分析和近30天知识数据"
          )
          const [period, accumulation, active, pages] = await Promise.allSettled([
            deps.loadPeriod(request.scope, signal),
            deps.loadAccumulation(request.scope.upperOrgLv1, signal),
            deps.loadActive(request.scope.upperOrgLv1, signal),
            deps.loadPages(request.scope, signal)
          ])
          signal.throwIfAborted()
          check()
          if (period.status !== "fulfilled") throw period.reason
          if (pages.status !== "fulfilled") throw pages.reason
          if (period.value.room !== request.scope.upperOrgLv1)
            throw new Error("查询数据与报告室范围不一致")
          readStep.finish(
            `本期活动 ${period.value.projects.length} 个项目 · 全室累计背景 ${pages.value.projectList.length} 个项目 / ${pages.value.analysis.rows.length} 条分析记录（仅自动审阅本期相关项目）${accumulation.status === "rejected" || active.status === "rejected" ? " · 部分知识数据不可用，将注明缺失" : ""}`
          )
          const snapshot = buildReportSnapshot({
            scope: request.scope,
            data: period.value,
            accumulation: accumulation.status === "fulfilled" ? accumulation.value : null,
            active: active.status === "fulfilled" ? active.value : null,
            knowledgeAsOf,
            exampleData: deps.exampleData
          })
          snapshot.pageData = pages.value
          snapshot.notes.push(
            "自动审阅本期全部活动及本期相关项目的累计背景；全室其他项目保留供工具按需查询。页面累计指标与报告自然周/月活动指标分别展示。"
          )
          run = {
            schema: 1,
            id: randomUUID(),
            input: request,
            snapshot,
            template,
            models: { completed: {} },
            updatedAt: new Date().toISOString()
          }
        }
        const input = run.input
        if (input.action === "revise") {
          const previous = store.read(input.reportId, input.baseVersion)
          if (previous.summary.latestVersion !== input.baseVersion)
            throw new Error("报告已有新版本，请打开最新版本重新修改")
        }
        check()
        signal.throwIfAborted()
        store.saveRun(run, request.action !== "resume")
        activeRuns.add(run.id)
        acquired = true
        const savedRun = run
        const checkpoint = new ProjectModelCheckpoint(run.models, () => {
          check()
          signal.throwIfAborted()
          store.saveRun(savedRun)
        })
        const result = await (deps.generate ?? generateProjectReport)({
          modelId: input.modelId,
          snapshot: run.snapshot,
          instruction: input.instruction,
          template: run.template,
          previousSource: run.previousSource,
          checkpoint,
          progress,
          signal,
          ...(input.action === "create"
            ? {
                loadStages: (projectId: string, featureSlug: string | null, signal: AbortSignal) =>
                  deps.loadStages(
                    savedRun.snapshot.scope.upperOrgLv1,
                    projectId,
                    featureSlug,
                    signal
                  ),
                loadSessions: (request: RunAnalysisSessionRequest, signal: AbortSignal) =>
                  deps.loadSessions(savedRun.snapshot.scope.upperOrgLv1, request, signal)
              }
            : {})
        })
        signal.throwIfAborted()
        check()
        // Verify ownership again before publishing: a newer generation may replace this checkpoint.
        store.readRun(run.id)
        if (result.reviewNote) run.snapshot.notes.push(result.reviewNote)
        const saveStep = progress.begin(
          "save",
          input.action === "revise" ? "保存报告新版本" : "保存报告"
        )
        const document =
          input.action === "revise"
            ? store.revise(
                input.reportId,
                input.baseVersion,
                result,
                input.instruction,
                result.modelName
              )
            : store.create(run.snapshot, result, input.instruction, result.modelName)
        store.clearRun(run.id)
        saveStep.finish(`已保存 v${document.version.version}，可预览和导出 HTML`)
        return document
      } catch (error) {
        if (parent?.aborted) {
          if (run && acquired) store.clearRun(run.id)
          throw error
        }
        check()
        const failure = timeout.aborted
          ? new Error("本轮报告查询或生成超时，已完成步骤及原版本保留")
          : error
        if (run && acquired) {
          // Persist any detail pages fetched since the last successful model step as well.
          store.saveRun(run)
          throw new ReportRunFailed(
            failure instanceof Error ? failure.message : "报告生成失败",
            store.runSummary(run)
          )
        }
        throw failure
      } finally {
        if (run && acquired) activeRuns.delete(run.id)
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
