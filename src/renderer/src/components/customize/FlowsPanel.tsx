import { requestChatFlowUse } from "@/lib/chat-flow-use"
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { ArrowRight, GitBranch, LayoutTemplate, Plus, RefreshCw, Save, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { HelpHint } from "@/components/ui/help-hint"
import { useAppStore } from "@/lib/store"
import { flowDraftId } from "@/lib/flow-draft-id"
import {
  CHAT_TASK_TEMPLATES,
  createChatTaskTemplate,
  chatTaskTemplateIssue,
  findSavedChatTaskTemplate
} from "../../../../shared/mods/flows/chat-task-templates"
import { parseFlowDefinition, flowRunnableInCatalog } from "../../../../shared/mods/flows/schema"
import { AUTOBIZ_PRESETS, createAutobizPreset } from "../../../../shared/mods/flows/autobiz-presets"
import {
  createHostDevelopmentFlow,
  createHostReviewFlow
} from "../../../../shared/mods/flows/templates"
import type {
  FlowApi,
  FlowActiveSummary,
  FlowCatalog,
  FlowDefinition,
  FlowMcpToolDescriptor,
  FlowRun,
  SavedFlow
} from "../../../../shared/mods/flows/types"
import { FlowEditor } from "./FlowEditor"
import { FlowRunView } from "./FlowRunView"
import { FlowNativeApprovalHint } from "./FlowNativeApprovalHint"
import { FlowUsageGuide } from "./FlowUsageGuide"
import { normalizeWorkspacePathKey } from "../../../../shared/workspace-path"
import {
  captureConfigurationScope,
  goToConfigurationThread,
  useConfigurationDraft
} from "@/lib/configuration-target"

const activeRun = (run: FlowRun) => ["queued", "running", "waiting"].includes(run.status)
const clone = (value: FlowDefinition): FlowDefinition => JSON.parse(JSON.stringify(value))
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const runLabels = {
  queued: "排队中",
  running: "执行中",
  waiting: "待确认",
  complete: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断"
}

export function FlowsPanel({
  threadId,
  initialDigest,
  workspaceHint,
  onOpenMods
}: {
  threadId: string | null
  initialDigest?: string
  workspaceHint?: string | null
  onOpenMods?: () => void
}) {
  const accountRevision = useAppStore((state) => state.accountRevision)
  if (!threadId)
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6 text-sm">
        <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <GitBranch className="size-5 text-primary" aria-hidden="true" />
          聊天任务模板
        </h2>
        <p className="text-muted-foreground">
          请先打开带项目目录的本地聊天。这里选择下一条聊天任务的执行顺序。
        </p>
        <FlowUsageGuide />
      </div>
    )
  return (
    <ScopedFlowsPanel
      key={JSON.stringify([accountRevision, threadId, workspaceHint, initialDigest])}
      threadId={threadId}
      initialDigest={initialDigest}
      workspaceHint={workspaceHint}
      onOpenMods={onOpenMods}
    />
  )
}

function ScopedFlowsPanel({
  threadId,
  initialDigest,
  workspaceHint,
  onOpenMods
}: {
  threadId: string
  initialDigest?: string
  workspaceHint?: string | null
  onOpenMods?: () => void
}) {
  const api = window.api.mods as typeof window.api.mods & FlowApi
  const initialSelection = useRef(initialDigest)
  const canonicalWorkspace = useRef(workspaceHint)
  const [scopeInvalid, setScopeInvalid] = useState(false)
  const [catalog, setCatalog] = useState<FlowCatalog | null>(null)
  const [flows, setFlows] = useState<SavedFlow[]>([])
  const [baseline, setBaseline] = useState<SavedFlow | null>(null)
  const [draft, setDraft] = useState<FlowDefinition | null>(null)
  const [runs, setRuns] = useState<FlowRun[]>([])
  const [workspaceActive, setWorkspaceActive] = useState<FlowActiveSummary | null>(null)
  const [run, setRun] = useState<FlowRun | null>(null)
  const [view, setView] = useState<"configure" | "records">("configure")
  const [advanced, setAdvanced] = useState(!!initialDigest)
  const account = useRef(useAppStore.getState().accountRevision)
  const workspaceId = useId()
  const configureTab = useRef<HTMLButtonElement>(null)
  const recordsTab = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [editorState, setEditorState] = useState({ dirty: false, valid: true })
  const [editorSession, setEditorSession] = useState(0)
  const [notice, setNotice] = useState("")
  const [mcpTools, setMcpTools] = useState<FlowMcpToolDescriptor[]>()
  const [mcpLoading, setMcpLoading] = useState(false)
  const [mcpError, setMcpError] = useState("")
  const mcpRead = useRef(0)
  const alive = useRef(true)
  const reading = useRef(0)
  const busyRef = useRef(false)
  const selectedRun = useRef<string | null>(null)
  const execution = useRef<HTMLDivElement>(null)
  const runRead = useRef(0)
  const acceptWorkspace = useCallback((actual: string | undefined) => {
    const expected = canonicalWorkspace.current
    if (
      !actual ||
      (expected !== undefined &&
        normalizeWorkspacePathKey(expected) !== normalizeWorkspacePathKey(actual))
    ) {
      setScopeInvalid(true)
      throw Error("项目范围已变化，当前草稿已保留。请回到原项目后刷新，或重新选择当前项目。")
    }
    canonicalWorkspace.current = actual
    setScopeInvalid(false)
  }, [])
  const verifyWorkspace = useCallback(async () => {
    const current = await api.flowCatalog(threadId)
    if (!alive.current) throw Error("流程面板已关闭")
    acceptWorkspace(current.workspace)
    return canonicalWorkspace.current!
  }, [api, threadId, acceptWorkspace])
  const invalidateReads = useCallback(() => {
    reading.current++
    runRead.current++
    mcpRead.current++
  }, [])

  const applyRun = useCallback((next: FlowRun | null) => {
    setRun(next)
    selectedRun.current = next?.id ?? null
    if (next)
      setRuns((old) =>
        [next, ...old.filter((item) => item.id !== next.id)].sort(
          (a, b) => b.startedAt - a.startedAt
        )
      )
  }, [])

  const readRun = useCallback(
    async (id: string) => {
      if (!alive.current) return
      const sequence = ++runRead.current
      const next = await api.flowRun(threadId, id)
      if (alive.current && sequence === runRead.current && selectedRun.current === id)
        applyRun(next)
    },
    [api, threadId, applyRun]
  )

  const refresh = useCallback(async () => {
    mcpRead.current++
    setMcpTools(undefined)
    setMcpLoading(false)
    setMcpError("")
    const sequence = ++reading.current
    const runSequence = ++runRead.current
    setLoading(true)
    try {
      if (typeof api.flowCatalog !== "function")
        throw new Error("当前版本尚未提供 按步骤执行接口，请更新应用后重试。")
      const available = await api.flowCatalog(threadId)
      if (!alive.current || sequence !== reading.current) return
      if (available.workspace || available.available) acceptWorkspace(available.workspace)
      setCatalog(available)
      if (!available.available) return
      const [definitions, history, active] = await Promise.all([
        api.flowList(threadId),
        api.flowRuns(threadId),
        api.flowActive(threadId)
      ])
      if (!alive.current || sequence !== reading.current) return
      await verifyWorkspace()
      if (!alive.current || sequence !== reading.current) return
      setFlows(definitions)
      setWorkspaceActive(active)
      if (initialSelection.current) {
        const selected = definitions.find((item) => item.digest === initialSelection.current)
        initialSelection.current = undefined
        if (selected) {
          setBaseline(selected)
          setDraft(clone(selected.definition))
          setEditorSession((old) => old + 1)
          setNotice("已打开评测候选版本；使用或保存仍需显式操作。")
        } else setNotice("评测候选版本已改变或不存在，请重新选择；不会自动使用其它版本。")
      }
      const chosen =
        history.find((item) => item.id === selectedRun.current) ??
        history.find(activeRun) ??
        history[0] ??
        null
      if (chosen && activeRun(chosen)) setAdvanced(true)
      if (runSequence === runRead.current) {
        setRuns(history)
        applyRun(chosen)
      }
      setError("")
    } catch (reason) {
      if (alive.current && sequence === reading.current) setError(message(reason))
    } finally {
      if (alive.current && sequence === reading.current) setLoading(false)
    }
  }, [api, threadId, applyRun, acceptWorkspace, verifyWorkspace])

  const loadMcpTools = async () => {
    const sequence = ++mcpRead.current
    setMcpTools(undefined)
    setMcpLoading(true)
    setMcpError("")
    try {
      if (typeof api.flowMcpTools !== "function") throw Error("当前版本尚未提供 MCP 工具目录接口")
      const tools = await api.flowMcpTools(threadId)
      if (alive.current && sequence === mcpRead.current) setMcpTools(tools)
    } catch (reason) {
      if (alive.current && sequence === mcpRead.current) setMcpError(message(reason))
    } finally {
      if (alive.current && sequence === mcpRead.current) setMcpLoading(false)
    }
  }

  useEffect(() => {
    return window.api.mods.onConfigurationChanged?.(() => {
      mcpRead.current++
      setMcpTools(undefined)
      setMcpLoading(false)
      setMcpError("")
      void refresh()
    })
  }, [refresh])

  useEffect(() => {
    alive.current = true
    void refresh()
    let running = false
    let pending = false
    const readCurrent = async () => {
      if (running) {
        pending = true
        return
      }
      const id = selectedRun.current
      if (!id || !alive.current) return
      running = true
      const sequence = ++runRead.current
      try {
        const next = await api.flowRun(threadId, id)
        if (alive.current && sequence === runRead.current && selectedRun.current === id)
          applyRun(next)
      } catch (reason) {
        if (alive.current && sequence === runRead.current) setError(message(reason))
      } finally {
        running = false
        if (pending && alive.current) {
          pending = false
          void readCurrent()
        }
      }
    }
    const stop =
      typeof api.onFlowChanged === "function"
        ? api.onFlowChanged(threadId, () => {
            void readCurrent()
          })
        : () => {}
    return () => {
      alive.current = false
      invalidateReads()
      stop()
    }
  }, [api, threadId, refresh, applyRun, invalidateReads])

  useEffect(() => {
    let disposed = false
    let pending = false
    const read = async () => {
      if (pending || !catalog?.available) return
      pending = true
      try {
        const active = await api.flowActive(threadId)
        if (!disposed) setWorkspaceActive(active)
      } catch {
        // Keep the last known owner until a successful refresh; do not imply it stopped.
      } finally {
        pending = false
      }
    }
    const timer = window.setInterval(() => void read(), 2000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [api, threadId, catalog?.available])

  const validation = useMemo(() => {
    if (!draft) return ""
    try {
      parseFlowDefinition(draft)
      return ""
    } catch (reason) {
      return message(reason)
    }
  }, [draft])
  const dirty =
    draft !== null &&
    (editorState.dirty ||
      !baseline ||
      JSON.stringify(draft) !== JSON.stringify(baseline.definition))
  useConfigurationDraft(
    { threadId, workspace: catalog?.workspace ?? workspaceHint ?? null },
    dirty,
    busy
  )
  const resetEditor = () => {
    setEditorSession((old) => old + 1)
    setEditorState({ dirty: false, valid: true })
  }
  const authorized = !!draft && flowRunnableInCatalog(draft, catalog)
  const openMods = () => {
    if (onOpenMods) {
      onOpenMods()
      return
    }
    if (dirty && !window.confirm("当前流程有未保存的改动。前往 灵件设置会丢弃草稿，是否继续？"))
      return
    useAppStore.getState().setShowCustomizeView(true, "mods")
  }

  const operate = async (action: () => Promise<void>) => {
    if (busyRef.current || scopeInvalid) return
    busyRef.current = true
    setBusy(true)
    setError("")
    setNotice("")
    runRead.current++
    try {
      await verifyWorkspace()
      await action()
    } catch (reason) {
      if (alive.current) setError(message(reason))
    } finally {
      if (alive.current) setBusy(false)
      busyRef.current = false
    }
  }
  const select = (saved: SavedFlow) => {
    if (dirty && !window.confirm("当前草稿尚未保存，是否放弃草稿并打开另一份流程？")) return
    resetEditor()
    setBaseline(saved)
    setDraft(clone(saved.definition))
    setNotice("")
    setError("")
  }
  const create = (copy: boolean, starter: "review" | "development" = "development") => {
    if (copy && !editorState.valid) {
      setError("当前参数草稿尚未完成，请先修正后复制；也可以重新打开已保存版本并明确放弃草稿。")
      return
    }
    if (dirty && !window.confirm("当前草稿尚未保存，是否放弃草稿？")) return
    resetEditor()
    const id = flowDraftId("flow")
    const next =
      copy && draft
        ? { ...clone(draft), id, name: `${draft.name} 副本` }
        : starter === "review"
          ? createHostReviewFlow(id)
          : createHostDevelopmentFlow(id)
    setBaseline(null)
    setDraft(next)
    setError("")
    setNotice(
      starter === "development" && !copy
        ? "通用开发流程尚未保存。请填写目标并检查步骤；此流程由应用运行，不会自动推进项目阶段。"
        : "新草稿尚未保存。修改任务目标，点击步骤卡片配置，然后保存并运行。"
    )
  }
  const selectTemplate = (preset: (typeof CHAT_TASK_TEMPLATES)[number]["id"]) => {
    const scope = { threadId, workspace: catalog?.workspace ?? workspaceHint ?? null }
    const captured = captureConfigurationScope(scope)
    const current = () =>
      alive.current && account.current === useAppStore.getState().accountRevision && captured()
    if (!current()) return
    if (dirty && !window.confirm("高级编辑器还有未保存的草稿。选用模板会返回聊天，是否继续？"))
      return
    void operate(async () => {
      if (!current()) return
      const available = await api.flowCatalog(threadId)
      if (!current()) return
      acceptWorkspace(available.workspace)
      setCatalog(available)
      const issue = chatTaskTemplateIssue(preset, available)
      if (issue) throw Error(issue)
      const active = await api.flowActive(threadId)
      if (!current()) return
      if (active)
        throw Error(
          "本项目已有正在运行或等待确认的聊天任务，请先在高级执行记录中处理，再选用模板。"
        )
      const definitions = await api.flowList(threadId)
      if (!current()) return
      await verifyWorkspace()
      if (!current()) return
      const existing = findSavedChatTaskTemplate(preset, definitions)
      const definition = createChatTaskTemplate(
        preset,
        existing?.definition.id ?? flowDraftId("flow")
      )
      const saved = existing ?? (await api.flowSave(threadId, definition, 0, available.workspace))
      if (!current()) return
      const currentDefinitions = await api.flowList(threadId)
      if (!current()) return
      const refreshed = await api.flowCatalog(threadId)
      if (!current()) return
      acceptWorkspace(refreshed.workspace)
      setCatalog(refreshed)
      const changed = chatTaskTemplateIssue(preset, refreshed)
      if (changed) throw Error(`模板尚未选用：${changed}`)
      const confirmed = currentDefinitions.find(
        (item) =>
          item.definition.id === saved.definition.id &&
          item.revision === saved.revision &&
          item.digest === saved.digest
      )
      if (
        saved.definition.id !== definition.id ||
        !Number.isInteger(saved.revision) ||
        saved.revision < 1 ||
        !confirmed ||
        !findSavedChatTaskTemplate(preset, [confirmed])
      )
        throw Error("已保存模板的版本或内容已变化，请刷新核对；尚未选用。")
      setFlows(currentDefinitions)
      if (!current()) return
      goToConfigurationThread(scope, () =>
        requestChatFlowUse({
          threadId,
          workspace: available.workspace!,
          id: saved.definition.id,
          revision: saved.revision,
          name: saved.definition.name
        })
      )
    })
  }

  return (
    <section
      className="@container/flows mx-auto min-w-0 w-full max-w-6xl space-y-5 p-4 sm:p-6"
      data-diy-flows
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5">
            <h2 className="text-lg font-semibold">聊天任务模板</h2>
            <HelpHint label="聊天任务模板说明">
              <p>
                模板保存本次任务的执行安排，可以调用已授权插件的技能或动作。插件则是可安装、
                可分发的能力与资源包，两者可以组合使用。
              </p>
              <p>
                点击“选用并返回聊天”会保存并选择模板。随后在原聊天输入目标并发送，才会按模板执行。
              </p>
              <p>
                执行记录显示这段聊天已经运行的任务，与正在编辑的草稿分开。修改草稿不会改变已运行的任务。
              </p>
              <p>项目要求的完成检查和人工确认仍会执行。关闭配置页面不会停止任务。</p>
            </HelpHint>
          </div>
          <p className="text-sm text-muted-foreground">
            为下一条任务选择执行安排，例如先检视修改、再运行项目测试。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={loading || busy}
            onClick={() => {
              void refresh()
            }}
          >
            <RefreshCw className="mr-1.5 size-3.5" aria-hidden="true" />
            刷新项目状态
          </Button>
          <Button variant="link" size="sm" disabled={busy} onClick={openMods}>
            <Upload className="mr-1.5 size-3.5" aria-hidden="true" />
            添加 / 授权灵件
          </Button>
        </div>
      </div>
      <section aria-label="常用聊天任务模板" className="space-y-3">
        <p className="text-sm leading-relaxed text-muted-foreground">
          内置模板无需安装新插件；手工方案也可以使用已安装插件的技能或动作。 AutoBiz
          等项目已有自己的业务流程，无需在这里重复配置。
          选用只保存并选择模板；发送下一条消息后才执行，工具操作仍按原规则审批。
        </p>
        <div className="grid gap-3 lg:grid-cols-3">
          {CHAT_TASK_TEMPLATES.map((template) => (
            <article
              key={template.id}
              aria-label={template.name}
              className="flex flex-col gap-3 rounded-xl border bg-card p-4"
            >
              <h3 className="font-medium">{template.name}</h3>
              <p className="flex-1 text-sm text-muted-foreground">{template.description}</p>
              <p className="text-xs text-muted-foreground">{template.sequence}</p>
              {template.id !== "review" && catalog?.unitTest?.ready && (
                <p className="text-xs text-muted-foreground">
                  项目测试入口：{catalog.unitTest.command}（尚未执行）
                </p>
              )}
              <Button
                disabled={busy || loading || scopeInvalid || !catalog?.available}
                onClick={() => selectTemplate(template.id)}
              >
                选用并返回聊天
              </Button>
            </article>
          ))}
        </div>
        {!loading && catalog && !catalog.hostAvailable && (
          <div role="status" className="rounded-lg border p-3 text-sm">
            <p>{catalog.reason || "请先开启灵件功能。无需另装插件。"}</p>
            <Button variant="link" onClick={openMods}>
              前往开启灵件功能
            </Button>
          </div>
        )}
        {error && (
          <p
            role="alert"
            className="whitespace-pre-wrap rounded-lg border border-destructive/50 p-3 text-sm"
          >
            {error}
          </p>
        )}
        {error && /模型/.test(error) && (
          <Button variant="outline" onClick={() => useAppStore.getState().setSettingsOpen(true)}>
            打开模型设置
          </Button>
        )}
        {error && /测试入口|配置无法|project-checks/.test(error) && (
          <Button
            variant="outline"
            onClick={() =>
              goToConfigurationThread({
                threadId,
                workspace: catalog?.workspace ?? workspaceHint ?? null
              })
            }
          >
            回原聊天配置测试入口
          </Button>
        )}
      </section>
      <details
        open={advanced}
        onToggle={(event) => setAdvanced(event.currentTarget.open)}
        className="space-y-4 rounded-xl border p-4"
      >
        <summary className="cursor-pointer text-sm font-medium">高级：编辑模板与执行记录</summary>
        <div
          role="tablist"
          aria-label="流程工作区"
          className="flex gap-1 rounded-lg bg-muted/50 p-1"
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
            event.preventDefault()
            const next =
              event.key === "Home"
                ? "configure"
                : event.key === "End"
                  ? "records"
                  : view === "configure"
                    ? "records"
                    : "configure"
            setView(next)
            if (next === "configure") configureTab.current?.focus()
            else recordsTab.current?.focus()
          }}
        >
          <button
            ref={configureTab}
            type="button"
            id={`${workspaceId}-configure-tab`}
            role="tab"
            tabIndex={view === "configure" ? 0 : -1}
            aria-selected={view === "configure"}
            aria-controls={`${workspaceId}-configure-panel`}
            className={`rounded-md px-4 py-2 text-sm font-medium ${view === "configure" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => setView("configure")}
          >
            流程配置
          </button>
          <button
            ref={recordsTab}
            type="button"
            id={`${workspaceId}-records-tab`}
            role="tab"
            tabIndex={view === "records" ? 0 : -1}
            aria-selected={view === "records"}
            aria-controls={view === "records" ? `${workspaceId}-records-panel` : undefined}
            className={`rounded-md px-4 py-2 text-sm font-medium ${view === "records" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => setView("records")}
          >
            执行记录
            {runs.some((item) => item.status === "waiting")
              ? " · 待你确认"
              : runs.some(activeRun)
                ? " · 进行中"
                : ""}
          </button>
        </div>
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
        {workspaceActive && workspaceActive.threadId !== threadId && (
          <section role="status" className="space-y-2 rounded border p-3 text-sm">
            <p>
              本项目的另一会话正在运行“{workspaceActive.flowName}”（
              {runLabels[workspaceActive.status]}）。请先查看该运行，再决定等待或取消。
            </p>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void operate(async () => {
                  const scope = { threadId, workspace: catalog?.workspace ?? workspaceHint ?? null }
                  const current = captureConfigurationScope(scope)
                  const active = await api.flowActive(threadId)
                  if (!current()) return
                  setWorkspaceActive(active)
                  if (!active || active.threadId === threadId) return
                  goToConfigurationThread(scope, undefined, active.threadId)
                })
              }
            >
              前往运行所在会话
            </Button>
          </section>
        )}
        {loading && <p className="text-sm text-muted-foreground">正在读取当前项目…</p>}
        {catalog && !catalog.available && (
          <p role="status" className="rounded border p-4 text-sm">
            {catalog.reason || "当前会话尚不能运行 按步骤执行，请检查本地工作区、灵件开关及授权。"}
          </p>
        )}
        <div
          role="tabpanel"
          id={`${workspaceId}-configure-panel`}
          aria-labelledby={`${workspaceId}-configure-tab`}
          hidden={view !== "configure"}
          inert={view !== "configure"}
          className="space-y-4"
        >
          <FlowUsageGuide onOpenMods={openMods} />
          {catalog?.available && (
            <>
              {catalog.diagnostics?.length ? (
                <div
                  role="status"
                  aria-label="可选目录读取提示"
                  className="rounded border p-3 text-sm"
                >
                  {catalog.diagnostics.map((diagnostic) => (
                    <p key={`${diagnostic.source}:${diagnostic.code}`}>{diagnostic.message}</p>
                  ))}
                </div>
              ) : null}
              {catalog.reason && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/30 p-4 text-sm">
                  <div>
                    <p className="font-medium">先准备运行能力</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {catalog.reason}。你仍可先创建草稿，运行前再完成授权。
                    </p>
                  </div>
                  <Button size="sm" variant="outline" disabled={busy} onClick={openMods}>
                    开启与授权
                    <ArrowRight className="ml-2 size-3.5" aria-hidden="true" />
                  </Button>
                </div>
              )}
              <div className="grid min-w-0 gap-5 @4xl/flows:grid-cols-[190px_minmax(0,1fr)]">
                <aside
                  className="min-w-0 self-start space-y-4 rounded-xl border bg-muted/20 p-3"
                  aria-label="流程库"
                >
                  <p className="px-1 text-xs font-medium text-muted-foreground">
                    我的流程 · {flows.length}
                  </p>
                  <div className="flex flex-col gap-2">
                    <Button
                      variant="default"
                      disabled={busy || loading}
                      onClick={() => create(false, "review")}
                    >
                      <Plus className="mr-1.5 size-4" aria-hidden="true" />
                      新建代码检视流程
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy || loading}
                      onClick={() => create(false)}
                    >
                      <LayoutTemplate className="mr-1.5 size-4" aria-hidden="true" />
                      新建通用开发流程
                    </Button>
                    <details className="rounded-lg border p-2">
                      <summary className="cursor-pointer text-sm">通用开发流程示例</summary>
                      <div className="mt-2 space-y-2">
                        {AUTOBIZ_PRESETS.map((preset) => (
                          <Button
                            key={preset.id}
                            className="h-auto w-full whitespace-normal text-left"
                            variant="ghost"
                            size="sm"
                            disabled={busy || loading}
                            title={preset.description}
                            onClick={() => {
                              if (dirty && !window.confirm("当前草稿尚未保存，是否放弃草稿？"))
                                return
                              resetEditor()
                              setBaseline(null)
                              setDraft(createAutobizPreset(preset.id, flowDraftId("flow")))
                              setError("")
                              setNotice(
                                "已创建通用开发流程草稿。请检查任务目标、模型和测试配置，保存后再运行。"
                              )
                            }}
                          >
                            {preset.name}
                          </Button>
                        ))}
                      </div>
                    </details>
                    <Button
                      variant="outline"
                      disabled={busy || !draft}
                      onClick={() => create(true)}
                    >
                      复制当前流程
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    新流程由应用运行，无需先安装插件。已保存的旧版流程仍保留原插件授权与阶段设置；可新建通用流程后逐项迁移。
                  </p>
                  <div className="flex flex-col gap-2 border-t pt-3" aria-label="已保存流程">
                    {flows.map((saved) => (
                      <Button
                        key={saved.definition.id}
                        variant={draft?.id === saved.definition.id ? "secondary" : "outline"}
                        size="sm"
                        className="h-auto justify-start whitespace-normal break-words px-3 py-2.5 text-left"
                        disabled={busy}
                        onClick={() => select(saved)}
                      >
                        {saved.definition.name}
                      </Button>
                    ))}
                    {!flows.length && (
                      <p className="text-sm text-muted-foreground">
                        还没有保存的流程。从模板创建后可修改每一步。
                      </p>
                    )}
                  </div>
                </aside>
                <div className="min-w-0">
                  {!draft && (
                    <div className="flex min-h-80 flex-col items-center justify-center rounded-2xl border border-dashed bg-muted/10 p-6 text-center">
                      <div className="mb-4 rounded-2xl border bg-card p-4 shadow-sm">
                        <GitBranch className="size-7 text-primary" aria-hidden="true" />
                      </div>
                      <h3 className="text-lg font-semibold">让助手按你设定的步骤做事</h3>
                      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
                        第一次使用，先试两步：检视代码 → 人工确认。之后再加入测试、修复或阶段推进。
                      </p>
                      <Button
                        className="mt-5"
                        disabled={busy || loading}
                        onClick={() => create(false, "review")}
                      >
                        开始搭建
                        <ArrowRight className="ml-2 size-4" aria-hidden="true" />
                      </Button>
                      <p className="mt-3 text-xs text-muted-foreground">
                        不需要先创建 AutoBiz 需求。保存后可以在当前项目重复使用。
                      </p>
                    </div>
                  )}
                  {draft && (
                    <div className="min-w-0 space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="font-medium">
                          {baseline ? `编辑 · 保存修订 ${baseline.revision}` : "新建流程"}
                          {dirty ? " · 有未保存改动" : " · 已保存"}
                        </h3>
                        <span className="text-xs text-muted-foreground">
                          正在运行的任务会继续使用原来的步骤，修改只影响下次运行。
                        </span>
                      </div>
                      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-xl border bg-background/95 p-3 shadow-sm backdrop-blur">
                        <Button
                          variant="outline"
                          disabled={
                            scopeInvalid || busy || !dirty || !!validation || !editorState.valid
                          }
                          onClick={() => {
                            if (!dirty || validation || !editorState.valid) return
                            void operate(async () => {
                              const saved = await api.flowSave(
                                threadId,
                                parseFlowDefinition(draft),
                                baseline?.revision ?? 0,
                                canonicalWorkspace.current ?? ""
                              )
                              if (!alive.current) return
                              setFlows((old) => [
                                saved,
                                ...old.filter((f) => f.definition.id !== saved.definition.id)
                              ])
                              setBaseline(saved)
                              setDraft(clone(saved.definition))
                              resetEditor()
                              setNotice(`已保存修订 ${saved.revision}，可开始运行。`)
                            })
                          }}
                        >
                          <Save className="mr-2 size-4" aria-hidden="true" />
                          保存流程
                        </Button>
                        <Button
                          variant="outline"
                          disabled={
                            scopeInvalid ||
                            busy ||
                            dirty ||
                            !editorState.valid ||
                            !baseline ||
                            !!validation ||
                            !authorized ||
                            !catalog.workspace ||
                            runs.some(activeRun) ||
                            !!workspaceActive
                          }
                          onClick={() => {
                            if (
                              scopeInvalid ||
                              dirty ||
                              !editorState.valid ||
                              validation ||
                              !baseline ||
                              !catalog.workspace
                            )
                              return
                            const workspace = catalog.workspace
                            goToConfigurationThread({ threadId, workspace }, () => {
                              requestChatFlowUse({
                                threadId,
                                workspace,
                                id: baseline.definition.id,
                                revision: baseline.revision,
                                name: baseline.definition.name
                              })
                            })
                          }}
                        >
                          去这段聊天使用
                        </Button>
                        {dirty && (
                          <span className="text-xs text-muted-foreground">
                            先保存草稿才能运行。
                          </span>
                        )}
                        {runs.some(activeRun) && (
                          <span className="text-xs text-muted-foreground">
                            当前会话有活动流程，请先完成或取消。
                          </span>
                        )}
                      </div>
                      <FlowEditor
                        key={`${draft.id}:${editorSession}`}
                        value={draft}
                        catalog={catalog}
                        disabled={busy}
                        onChange={setDraft}
                        onEditorStateChange={setEditorState}
                        mcpTools={mcpTools}
                        mcpLoading={mcpLoading}
                        mcpError={mcpError}
                        onLoadMcpTools={() => {
                          void loadMcpTools()
                        }}
                      />
                      {validation && (
                        <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
                          请先修正流程：{validation}
                        </p>
                      )}
                      {!authorized && (
                        <p className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
                          {draft.schemaVersion === 2
                            ? "请开启灵件功能，并打开已选择项目文件夹的聊天。内置流程无需另外安装插件。"
                            : "此流程保留旧版授权方式，请选择已授权的灵件；不会自动转换或授予权限。"}
                        </p>
                      )}
                      <div className="rounded-xl border bg-muted/20 p-4 text-sm">
                        <strong>执行预览：</strong>
                        {draft.steps
                          .filter((s) => s.enabled)
                          .map((s) => s.name)
                          .join(" → ") || "没有启用步骤"}
                        <p className="mt-1 text-xs text-muted-foreground">
                          每一步按设置决定继续、回退或停止，项目必需的检查和人工确认仍然生效。
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
        {view === "records" && (
          <div
            ref={execution}
            role="tabpanel"
            id={`${workspaceId}-records-panel`}
            aria-labelledby={`${workspaceId}-records-tab`}
            className="scroll-mt-4 space-y-4"
          >
            {runs.length === 0 && (
              <div className="rounded-xl border border-dashed p-5 text-sm">
                <h3 className="font-medium">这段聊天还没有执行记录</h3>
                <p className="mt-2 leading-relaxed text-muted-foreground">
                  先保存执行步骤，再点击“去这段聊天使用”。发送任务后，聊天原任务卡与这里都会保留真实进度和结果。
                </p>
              </div>
            )}
            {runs.length > 0 && (
              <section className="space-y-2" aria-label="运行历史">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <h3 className="font-semibold">这段聊天执行过的任务</h3>
                    <HelpHint label="执行记录说明">
                      <p>
                        选择一次任务，查看当时的步骤、结果和需要确认的事项。这些记录属于所选聊天，不是正在编辑的流程草稿。
                      </p>
                      <p>修改流程不会改动历史结果；停止任务不会撤销已经完成的操作。</p>
                    </HelpHint>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      goToConfigurationThread({
                        threadId,
                        workspace: catalog?.workspace ?? workspaceHint ?? null
                      })
                    }}
                  >
                    回聊天查看任务
                    <ArrowRight className="ml-1.5 size-3.5" aria-hidden="true" />
                  </Button>
                </div>
                <div className="flex max-h-40 flex-wrap gap-2 overflow-auto">
                  {runs.map((item) => (
                    <Button
                      key={item.id}
                      variant={run?.id === item.id ? "secondary" : "outline"}
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        void operate(async () => {
                          selectedRun.current = item.id
                          await readRun(item.id)
                        })
                      }}
                    >
                      {item.flow.definition.name} · {runLabels[item.status]} ·{" "}
                      {new Date(item.startedAt).toLocaleTimeString()}
                    </Button>
                  ))}
                </div>
              </section>
            )}
            <FlowNativeApprovalHint threadId={threadId} active={runs.some(activeRun)} />
            {run && (
              <FlowRunView
                run={run}
                busy={busy}
                onResumed={(next) => {
                  if (
                    !alive.current ||
                    selectedRun.current !== run.id ||
                    next.threadId !== threadId ||
                    next.workspace !== run.workspace
                  )
                    return
                  runRead.current++
                  applyRun(next)
                  setNotice("已建立续跑记录；后续步骤与最终检查仍需完成。")
                }}
                onCancel={() => {
                  void operate(async () => {
                    await api.flowCancel(threadId, run.id)
                    await readRun(run.id)
                  })
                }}
                onDecide={(nonce, approve) => {
                  void operate(async () => {
                    await api.flowDecide(threadId, run.id, nonce, approve)
                    await readRun(run.id)
                  })
                }}
              />
            )}
          </div>
        )}
      </details>
    </section>
  )
}
