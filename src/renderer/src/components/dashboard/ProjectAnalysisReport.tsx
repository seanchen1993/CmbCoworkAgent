import { ProjectAgentRunProgress } from "./ProjectAgentRunProgress"
import { useProjectAgentRun } from "./use-project-agent-run"
import { useCallback, useEffect, useRef, useState } from "react"
import { Download, FileText, Loader2, MoreHorizontal, PencilLine, Plus, Square } from "lucide-react"
import { ProjectReportPreview } from "./ProjectReportPreview"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import {
  PROJECT_REPORT_GENERATION_FAMILY,
  RECOMMENDED_REPORT_TEMPLATE_ID,
  type ProjectReportDocument,
  type ProjectReportGenerateInput,
  type ProjectReportWorkspace
} from "../../../../shared/project-analysis-report"
import {
  resolveOperationsPeriod,
  type OperationsPeriodSelection
} from "../../../../shared/project-operations-period"

function previousWeek(): OperationsPeriodSelection {
  const today = new Date(Date.now() + 8 * 3600000)
  today.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7) - 7)
  return { kind: "week", anchorDate: today.toISOString().slice(0, 10) }
}

function dateTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
}

const message = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback

// State lives with the Agent dialog, not its unmounted tab/portal contents.
// Closing the dialog or visiting analysis therefore preserves finished reports and drafts.
export function useProjectAnalysisReport({
  active,
  selectedRooms
}: {
  active: boolean
  selectedRooms: string[]
}): React.JSX.Element {
  const runProgress = useProjectAgentRun()
  const { end: endRun, clear: clearRun } = runProgress
  const [workspace, setWorkspace] = useState<ProjectReportWorkspace | null>(null)
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  const [workspaceError, setWorkspaceError] = useState("")
  const [room, setRoom] = useState("")
  const [selection, setSelection] = useState<OperationsPeriodSelection>(previousWeek)
  const [templateId, setTemplateId] = useState<string>(RECOMMENDED_REPORT_TEMPLATE_ID)
  const [document, setDocument] = useState<ProjectReportDocument | null>(null)
  const [draft, setDraft] = useState(true)
  const [input, setInput] = useState("")
  const [loading, setLoading] = useState(false)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [actionBusy, setActionBusy] = useState(false)
  const [dialog, setDialog] = useState<"template" | "delete-report" | "delete-template" | null>(
    null
  )
  const [templateName, setTemplateName] = useState("")
  const [preferences, setPreferences] = useState("")
  const [dialogError, setDialogError] = useState("")
  const sequence = useRef(0)
  const readSequence = useRef(0)
  const workspaceSequence = useRef(0)
  const mutationSequence = useRef(0)
  const busy = useRef(false)
  const requestedWorkspace = useRef(false)
  const lastRequest = useRef<ProjectReportGenerateInput | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const fallbackRoom = selectedRooms.length === 1 ? selectedRooms[0] : ""
  const current = draft ? null : document
  const selectedTemplate = workspace?.templates.find((template) => template.id === templateId)
  const builtinTemplates =
    workspace?.templates.filter((template) => template.kind === "builtin") ?? []
  const personalTemplates =
    workspace?.templates.filter((template) => template.kind !== "builtin") ?? []

  const stop = useCallback(() => {
    sequence.current++
    if (busy.current) {
      busy.current = false
      setLoading(false)
      endRun("cancelled")
      setNotice("报告生成已停止，已有成功版本仍可查看")
      void window.api.dashboard
        .cancelRequests([PROJECT_REPORT_GENERATION_FAMILY])
        .catch(() => undefined)
    }
  }, [endRun])

  const loadWorkspace = useCallback(async () => {
    requestedWorkspace.current = true
    const ticket = ++workspaceSequence.current
    setWorkspaceLoading(true)
    setWorkspaceError("")
    try {
      const response = await window.api.dashboard.projectReportWorkspace()
      if (ticket !== workspaceSequence.current) return
      if (!response.success || !response.data)
        throw new Error(response.error || "无法加载报告工作区")
      const next = response.data
      setWorkspace(next)
      setRoom(
        (previous) =>
          previous ||
          (next.canChooseRoom ? fallbackRoom || next.ownRoom : next.ownRoom || fallbackRoom)
      )
    } catch (e) {
      if (ticket === workspaceSequence.current) setWorkspaceError(message(e, "无法加载报告工作区"))
    } finally {
      if (ticket === workspaceSequence.current) setWorkspaceLoading(false)
    }
  }, [fallbackRoom])

  useEffect(() => {
    if (active && !requestedWorkspace.current) void loadWorkspace()
    if (!active) {
      stop()
      readSequence.current++
      setReading(false)
      setDialog(null)
    }
  }, [active, loadWorkspace, stop])

  useEffect(
    () => () => {
      sequence.current++
      readSequence.current++
      workspaceSequence.current++
      mutationSequence.current++
      if (busy.current)
        void window.api.dashboard
          .cancelRequests([PROJECT_REPORT_GENERATION_FAMILY])
          .catch(() => undefined)
    },
    []
  )

  const acceptDocument = (next: ProjectReportDocument) => {
    setDocument(next)
    setDraft(false)
    setWorkspace((previous) =>
      previous
        ? {
            ...previous,
            reports: [
              next.summary,
              ...previous.reports.filter((report) => report.id !== next.summary.id)
            ]
          }
        : previous
    )
  }

  const run = async (request: ProjectReportGenerateInput) => {
    if (busy.current) return
    readSequence.current++
    setReading(false)
    busy.current = true
    const ticket = ++sequence.current
    lastRequest.current = request
    runProgress.begin()
    setLoading(true)
    setError("")
    setNotice("")
    try {
      const response = await window.api.dashboard.projectReportGenerate(request, (event) => {
        if (ticket === sequence.current && activeRef.current) runProgress.receive(event)
      })
      if (ticket !== sequence.current || !activeRef.current) return
      if (response.cancelled) {
        endRun("cancelled")
        setNotice("报告生成已停止，已有成功版本仍可查看")
        return
      }
      if (!response.success || !response.data)
        throw new Error(response.error || "报告生成失败，请重试")
      endRun("completed")
      acceptDocument(response.data)
      setInput("")
      setNotice(`已保存版本 v${response.data.version.version}`)
    } catch (e) {
      if (ticket === sequence.current) {
        endRun("failed")
        setError(message(e, "报告生成失败，请重试"))
      }
    } finally {
      if (ticket === sequence.current) {
        busy.current = false
        setLoading(false)
      }
    }
  }

  const openReport = async (reportId: string, version?: number) => {
    stop()
    clearRun()
    lastRequest.current = null
    const ticket = ++readSequence.current
    setReading(true)
    setError("")
    setNotice("")
    try {
      const response = await window.api.dashboard.projectReportRead({
        reportId,
        ...(version ? { version } : {})
      })
      if (ticket !== readSequence.current || !activeRef.current) return
      if (!response.success || !response.data) throw new Error(response.error || "无法打开报告")
      acceptDocument(response.data)
      setInput("")
    } catch (e) {
      if (ticket === readSequence.current) setError(message(e, "无法打开报告"))
    } finally {
      if (ticket === readSequence.current) setReading(false)
    }
  }

  const changeScope = (change: () => void) => {
    stop()
    readSequence.current++
    setReading(false)
    lastRequest.current = null
    setError("")
    change()
  }

  const startNew = () => {
    clearRun()
    changeScope(() => {
      setDraft(true)
      setInput("")
      setNotice(document ? "已有报告保存在最近报告中；新报告会重新获取所选周期的数据" : "")
    })
  }

  let periodLabel = "请选择有效的周或月"
  let periodValid = false
  try {
    periodLabel = resolveOperationsPeriod(selection).label
    periodValid = true
  } catch {
    /* A date input may temporarily be empty. */
  }

  const submit = () => {
    if (busy.current || reading || !workspace) return
    const instruction = input.trim()
    if (instruction.length > 4000) return
    if (current) {
      if (instruction)
        void run({
          action: "revise",
          reportId: current.summary.id,
          baseVersion: current.version.version,
          instruction
        })
    } else if (periodValid && room.trim()) {
      void run({
        action: "create",
        scope: { upperOrgLv1: room.trim(), period: selection },
        instruction,
        ...(templateId ? { templateId } : {})
      })
    }
  }

  const mutate = async (action: "export" | "template" | "delete-report" | "delete-template") => {
    if (actionBusy || busy.current || (action !== "delete-template" && !current)) return
    const ticket = ++mutationSequence.current
    lastRequest.current = null
    setActionBusy(true)
    setDialogError("")
    setError("")
    try {
      if (action === "export" && current) {
        const response = await window.api.dashboard.projectReportExport({
          reportId: current.summary.id,
          version: current.version.version
        })
        if (ticket !== mutationSequence.current) return
        if (response.cancelled) return
        if (!response.success || !response.data) throw new Error(response.error || "下载失败")
        setNotice(`HTML 已保存：${response.data.filePath}`)
      } else if (action === "template" && current) {
        const response = await window.api.dashboard.projectReportSaveTemplate({
          reportId: current.summary.id,
          version: current.version.version,
          name: templateName.trim(),
          preferences: preferences.trim()
        })
        if (ticket !== mutationSequence.current) return
        if (!response.success || !response.data) throw new Error(response.error || "模板保存失败")
        const saved = response.data
        setWorkspace((previous) =>
          previous
            ? {
                ...previous,
                templates: [saved, ...previous.templates.filter((item) => item.id !== saved.id)]
              }
            : previous
        )
        setTemplateId(saved.id)
        setDialog(null)
        setNotice(`已保存我的模板「${saved.name}」，下次生成时可使用`)
      } else if (action === "delete-template") {
        const response = await window.api.dashboard.projectReportDeleteTemplate({ templateId })
        if (ticket !== mutationSequence.current) return
        if (!response.success) throw new Error(response.error || "模板删除失败")
        setWorkspace((previous) =>
          previous
            ? {
                ...previous,
                templates: previous.templates.filter((item) => item.id !== templateId)
              }
            : previous
        )
        setTemplateId(RECOMMENDED_REPORT_TEMPLATE_ID)
        setDialog(null)
        setNotice("模板已删除，已生成的报告不受影响")
      } else if (action === "delete-report" && current) {
        const response = await window.api.dashboard.projectReportDelete({
          reportId: current.summary.id
        })
        if (ticket !== mutationSequence.current) return
        if (!response.success) throw new Error(response.error || "报告删除失败")
        setWorkspace((previous) =>
          previous
            ? {
                ...previous,
                reports: previous.reports.filter((item) => item.id !== current.summary.id)
              }
            : previous
        )
        setDocument(null)
        setDraft(true)
        setInput("")
        lastRequest.current = null
        setDialog(null)
        setNotice("报告及其版本已删除")
      }
    } catch (e) {
      if (ticket === mutationSequence.current) {
        if (action === "export") setError(message(e, "操作失败"))
        else setDialogError(message(e, "操作失败"))
      }
    } finally {
      if (ticket === mutationSequence.current) setActionBusy(false)
    }
  }

  const rooms = [
    ...new Set(
      [...(workspace?.rooms ?? []), ...selectedRooms, workspace?.ownRoom ?? ""].filter(Boolean)
    )
  ]
  const reportDialogTitle =
    dialog === "template"
      ? "保存为我的模板"
      : dialog === "delete-template"
        ? "删除我的模板"
        : "删除报告"

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" aria-label="综合报告工作区">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 basis-48">
          <Select
            value={current?.summary.id ?? ""}
            onValueChange={(id) => void openReport(id)}
            disabled={!workspace?.reports.length || actionBusy}
          >
            <SelectTrigger aria-label="最近报告">
              <SelectValue placeholder="最近报告" />
            </SelectTrigger>
            <SelectContent className="max-w-[90vw]">
              {workspace?.reports.map((report) => (
                <SelectItem key={report.id} value={report.id}>
                  {report.title} · v{report.latestVersion}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button size="sm" variant="outline" onClick={startNew} disabled={!workspace || actionBusy}>
          <Plus className="mr-1 size-3.5" />
          新报告
        </Button>
      </div>
      <div
        className="min-h-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto overscroll-contain pr-1"
        data-testid="project-report-body"
      >
        {workspaceLoading && (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在加载报告与我的模板…
          </p>
        )}
        {workspaceError && (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
            {workspaceError}
            <Button variant="outline" size="sm" onClick={() => void loadWorkspace()}>
              重试加载
            </Button>
          </div>
        )}
        {draft && workspace && (
          <>
            <div className="rounded-md bg-muted/50 p-3 text-xs leading-5 text-muted-foreground">
              报告覆盖所选室在周期内的全部项目活动（含归档）。当前列表筛选不影响报告。
            </div>
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="min-w-0 space-y-1 text-xs text-muted-foreground">
                报告所属室
                <Input
                  aria-label="报告所属室"
                  list={workspace.canChooseRoom ? "project-report-rooms" : undefined}
                  value={room}
                  disabled={!workspace.canChooseRoom}
                  onChange={(event) => changeScope(() => setRoom(event.target.value))}
                  placeholder="输入准确的室名称"
                  className="mt-1"
                />
                <datalist id="project-report-rooms">
                  {rooms.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
                <span className="block">
                  {workspace.canChooseRoom ? "可选择或输入准确室名" : "仅生成本室报告"}
                </span>
              </label>
              <div className="min-w-0 space-y-1 text-xs text-muted-foreground">
                <span>报告周期 · 北京时间</span>
                <div className="flex min-w-0 gap-2">
                  <Select
                    value={selection.kind}
                    onValueChange={(kind) =>
                      changeScope(() =>
                        setSelection(
                          kind === "week"
                            ? previousWeek()
                            : {
                                kind: "month",
                                month: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7)
                              }
                        )
                      )
                    }
                  >
                    <SelectTrigger aria-label="报告周期" className="w-24 shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="week">自然周</SelectItem>
                      <SelectItem value="month">自然月</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    aria-label={selection.kind === "week" ? "报告周内日期" : "报告月份"}
                    type={selection.kind === "week" ? "date" : "month"}
                    value={selection.kind === "week" ? selection.anchorDate : selection.month}
                    onChange={(event) =>
                      changeScope(() =>
                        setSelection(
                          selection.kind === "week"
                            ? { kind: "week", anchorDate: event.target.value }
                            : { kind: "month", month: event.target.value }
                        )
                      )
                    }
                    className="min-w-0 flex-1"
                  />
                </div>
                <span className="block">
                  {periodLabel}
                  {selection.kind === "week" && periodValid ? " · 周一至周日" : ""}
                </span>
              </div>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 flex-1">
                <Select
                  value={templateId || "__none__"}
                  onValueChange={(id) =>
                    changeScope(() => setTemplateId(id === "__none__" ? "" : id))
                  }
                >
                  <SelectTrigger aria-label="报告模板">
                    <SelectValue placeholder="选择报告模板" />
                  </SelectTrigger>
                  <SelectContent className="max-w-[90vw]">
                    {builtinTemplates.map((template) => (
                      <SelectItem key={template.id} value={template.id}>
                        {template.name}
                      </SelectItem>
                    ))}
                    <SelectItem value="__none__">自由生成 · 由 Agent 设计</SelectItem>
                    {personalTemplates.length > 0 && (
                      <>
                        <SelectSeparator />
                        <SelectGroup>
                          <SelectLabel>我的模板</SelectLabel>
                          {personalTemplates.map((template) => (
                            <SelectItem key={template.id} value={template.id}>
                              {template.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </>
                    )}
                  </SelectContent>
                </Select>
              </div>
              {selectedTemplate && selectedTemplate.kind !== "builtin" && (
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="更多模板操作"
                      disabled={loading || actionBusy}
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-48 p-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start text-destructive"
                      onClick={() => {
                        setDialogError("")
                        setDialog("delete-template")
                      }}
                    >
                      删除选中的模板
                    </Button>
                  </PopoverContent>
                </Popover>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {selectedTemplate?.kind === "builtin"
                ? "从推荐版式开始，生成后可继续调整，满意后保存为我的模板。"
                : selectedTemplate
                  ? "沿用我的模板布局与偏好，按本次数据重新生成内容。"
                  : "由 Agent 自主设计内容与样式，满意后也可保存为我的模板。"}
            </p>
            <p className="text-xs text-muted-foreground">
              默认上个完整周；可选周内任一天。正在进行的周或月只统计截至生成时的数据。
            </p>
          </>
        )}
        {current && (
          <>
            <div className="space-y-2 rounded-md bg-muted/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="min-w-0 break-words text-sm font-medium">{current.summary.title}</h3>
                <div className="w-32 shrink-0">
                  <Select
                    value={String(current.version.version)}
                    onValueChange={(version) =>
                      void openReport(current.summary.id, Number(version))
                    }
                    disabled={reading || actionBusy}
                  >
                    <SelectTrigger aria-label="报告版本">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {current.versions.map((version) => (
                        <SelectItem key={version.version} value={String(version.version)}>
                          版本 v{version.version}
                          {version.version === current.summary.latestVersion ? " · 最新" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <p className="break-words text-xs leading-5 text-muted-foreground">
                室：{current.summary.room} ·{" "}
                {current.summary.period.kind === "week" ? "周报" : "月报"} ·{" "}
                {current.summary.period.label}
                <br />
                数据截至 {dateTime(current.summary.dataAsOf)} · {current.version.modelName}
                {current.summary.exampleData && (
                  <span className="ml-2 text-amber-600">开发示例数据</span>
                )}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={loading || actionBusy || reading}
                  onClick={() => void mutate("export")}
                >
                  <Download className="mr-1 size-3.5" />
                  下载 HTML
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={loading || actionBusy || reading}
                  onClick={() => {
                    setTemplateName("")
                    setPreferences("")
                    setDialogError("")
                    setDialog("template")
                  }}
                >
                  保存为我的模板
                </Button>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="更多报告操作"
                      disabled={loading || actionBusy || reading}
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-44 p-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start text-destructive"
                      onClick={() => {
                        setDialogError("")
                        setDialog("delete-report")
                      }}
                    >
                      删除报告及其版本
                    </Button>
                  </PopoverContent>
                </Popover>
              </div>
            </div>
            {current.notes.length > 0 && (
              <details className="rounded border px-3 py-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer">数据说明（{current.notes.length}）</summary>
                <ul className="mt-2 list-disc space-y-1 break-words pl-4">
                  {current.notes.map((note, index) => (
                    <li key={index}>{note}</li>
                  ))}
                </ul>
              </details>
            )}
            <ProjectReportPreview
              key={`${current.summary.id}:${current.version.version}`}
              html={current.html}
              title={current.summary.title}
              version={current.version.version}
            />
          </>
        )}
        {reading && (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在打开报告…
          </p>
        )}
        {error && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-destructive/30 p-2 text-xs text-destructive"
          >
            <span className="min-w-0 break-words">{error}</span>
            {lastRequest.current && (
              <Button
                size="sm"
                variant="outline"
                disabled={loading || reading}
                onClick={() => lastRequest.current && void run(lastRequest.current)}
              >
                重试生成
              </Button>
            )}
          </div>
        )}
        {notice && (
          <p role="status" className="break-words text-xs text-muted-foreground">
            {notice}
          </p>
        )}
      </div>
      <div className="shrink-0 space-y-1">
        {loading && current && (
          <p className="text-xs text-muted-foreground">
            正在按要求修改 v{current.version.version}，完成后保存为新版本。
          </p>
        )}
        <ProjectAgentRunProgress state={runProgress.state} fallback="正在读取全室数据并准备报告…" />
      </div>
      {workspace && (
        <form
          className="flex shrink-0 flex-col gap-2 border-t pt-3 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <div className="min-w-0 flex-1 space-y-2">
            {current && (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  调整当前报告 · v{current.version.version}
                </span>
                <span className="ml-2">输入修改要求，沿用本次数据并保存为新版本，原版本保留。</span>
              </p>
            )}
            <textarea
              aria-label={current ? "报告修改要求" : "报告生成要求"}
              rows={2}
              maxLength={4000}
              value={input}
              disabled={loading || reading || actionBusy}
              onChange={(event) => setInput(event.target.value)}
              placeholder={
                current
                  ? "例如：把成员贡献改成表格，并突出本周需要关注的事项"
                  : "简短要求（可选），例如：先概览，再列出成员贡献与需关注的特性"
              }
              className="block w-full min-w-0 resize-none rounded border bg-background p-2 text-sm"
            />
          </div>
          {loading ? (
            <Button
              type="button"
              variant="outline"
              onClick={(event) => {
                // React replaces this control with a submit button during the click.
                // Cancel its default action so stopping cannot submit the draft again.
                event.preventDefault()
                stop()
              }}
            >
              <Square className="mr-1 size-3.5" />
              停止生成
            </Button>
          ) : (
            <Button
              type="submit"
              disabled={
                reading || actionBusy || (current ? !input.trim() : !periodValid || !room.trim())
              }
            >
              {current ? (
                <PencilLine className="mr-1 size-3.5" />
              ) : (
                <FileText className="mr-1 size-3.5" />
              )}
              {current ? "应用修改" : "生成报告"}
            </Button>
          )}
        </form>
      )}
      <Dialog
        open={dialog !== null && active}
        onOpenChange={(open) => {
          if (!open && !actionBusy) setDialog(null)
        }}
      >
        <DialogContent className="w-[min(440px,92vw)]">
          <DialogHeader>
            <DialogTitle>{reportDialogTitle}</DialogTitle>
            <DialogDescription>
              {dialog === "template"
                ? "将当前版本另存为个人模板，保留版式与偏好，不带入本期数字、日期和结论。内置推荐不受影响。"
                : dialog === "delete-template"
                  ? "删除后无法再次选择这个模板，已生成的报告仍会保留。"
                  : "将删除这份报告的所有版本；已下载的 HTML 文件不受影响。"}
            </DialogDescription>
          </DialogHeader>
          {dialog === "template" && (
            <div className="space-y-3">
              <label className="block space-y-1 text-sm">
                模板名称
                <Input
                  aria-label="模板名称"
                  value={templateName}
                  maxLength={80}
                  onChange={(event) => setTemplateName(event.target.value)}
                  placeholder="例如：室级运营简报"
                />
              </label>
              <label className="block space-y-1 text-sm">
                我的偏好（可选）
                <textarea
                  aria-label="模板偏好"
                  value={preferences}
                  maxLength={4000}
                  rows={3}
                  onChange={(event) => setPreferences(event.target.value)}
                  placeholder="例如：结论在前，突出个人贡献，控制在三屏内"
                  className="w-full resize-none rounded border bg-background p-2 text-sm"
                />
              </label>
            </div>
          )}
          {dialogError && (
            <p role="alert" className="text-sm text-destructive">
              {dialogError}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={actionBusy} onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button
              disabled={actionBusy || (dialog === "template" && !templateName.trim())}
              variant={dialog === "template" ? "default" : "destructive"}
              onClick={() => dialog && void mutate(dialog)}
            >
              {actionBusy && <Loader2 className="mr-1 size-3.5 animate-spin" />}
              {dialog === "template" ? "保存模板" : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
