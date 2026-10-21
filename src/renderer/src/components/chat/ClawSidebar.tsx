import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { ArrowRight, Settings2, Sparkles, X } from "lucide-react"
import {
  useClawSidebarHost,
  openClawSidebar,
  useClawNotices,
  protectFlowTaskView,
  publishClawNotice,
  ClawResultsVisibility
} from "@/lib/claw-sidebar"
import { useAppStore } from "@/lib/store"
import type { ChatFlowController } from "@/lib/use-chat-flow"
import { ChatFlowControls, ChatFlowRun } from "./ChatFlowControls"
import { ModsAudit } from "../customize/ModsAudit"
import { clawSourceSummary } from "@/lib/claw-source-summary"
import { FunctionUserConfig } from "../customize/FunctionUserConfig"
import { readModelCatalogCache, subscribeModelCatalog } from "@/lib/model-catalog-cache"
import { resolveModelDisplay } from "@/lib/model-display"
import { BuiltinRunOverview } from "./BuiltinRunOverview"
import type { ModCommandDescriptor } from "../../../../shared/mods/types"
import { chatClawEffectiveView } from "@/lib/chat-claw-effective-view"
import { ModsUsageSettingsEntry } from "../customize/ModsUsageSettingsEntry"

export function ClawSidebar({
  threadId,
  workspace,
  flow,
  disabled,
  onFollowUp,
  onRequestCreator,
  onStart,
  taskOverview,
  taskWorking = false,
  records,
  children
}: {
  threadId: string
  workspace?: string | null
  flow: ChatFlowController
  disabled: boolean
  onStart(goal: string): Promise<boolean>
  onFollowUp(text: string): void
  onRequestCreator?: (prompt: string) => Promise<void>
  children: ReactNode
  taskOverview?: ReactNode
  taskWorking?: boolean
  records?: ReactNode
}) {
  const host = useClawSidebarHost(threadId)
  const binding = "binding" in flow ? flow.binding : undefined
  const profile = binding?.active
  const effective = binding ? chatClawEffectiveView(binding) : null
  const usingSelection = flow.enabled &&
    (effective?.state === "selected" || effective?.state === "inherited")
  const recoveryScope = JSON.stringify([threadId, workspace, profile, binding?.capabilities])
  const creatorScope = JSON.stringify([threadId, workspace])
  const latestCreatorScope = useRef(creatorScope)
  latestCreatorScope.current = creatorScope
  const creatorPending = useRef<symbol | null>(null)
  const [creatorAction, setCreatorAction] = useState({ scope: creatorScope, busy: false, error: "" })
  const creatorBusy = creatorAction.scope === creatorScope && creatorAction.busy
  useEffect(() => () => { creatorPending.current = null }, [creatorScope])
  const [tab, setTab] = useState<"run" | "configuration" | "results">("run")
  const [auditOpen, setAuditOpen] = useState(false)
  const [overviewOpen, setOverviewOpen] = useState(false)
  const [recovery, setRecovery] = useState({ scope: recoveryScope, open: false })
  if (recovery.scope !== recoveryScope) setRecovery({ scope: recoveryScope, open: false })
  useEffect(() => {
    const open = (event: Event) => {
      if ((event as CustomEvent<{ threadId?: string }>).detail?.threadId === threadId) {
        setRecovery({ scope: recoveryScope, open: true })
        setTab("configuration")
      }
    }
    window.addEventListener("claw:runtime-recovery", open)
    return () => window.removeEventListener("claw:runtime-recovery", open)
  }, [threadId, recoveryScope])
  useEffect(
    () =>
      useAppStore.subscribe((state) => {
        if (state.rightModule !== "claw" || state.rightPanelCollapsed)
          setRecovery((previous) => (previous.open ? { ...previous, open: false } : previous))
      }),
    []
  )
  const visible = useAppStore((state) => state.rightModule === "claw" && !state.rightPanelCollapsed)
  const [commandView, setCommandView] = useState<{
    scope: string
    commands: ModCommandDescriptor[]
  }>({ scope: "", commands: [] })
  useEffect(() => {
    if (!visible || !flow.enabled || !binding) return
    let alive = true
    void window.api.mods
      .commands(threadId)
      .then((commands) => {
        if (alive)
          setCommandView({
            scope: recoveryScope,
            commands: commands.filter((command) => !command.isHidden)
          })
      })
      .catch(() => {
        if (alive) setCommandView({ scope: recoveryScope, commands: [] })
      })
    return () => {
      alive = false
    }
  }, [visible, flow.enabled, threadId, recoveryScope, binding])
  const commands = commandView.scope === recoveryScope ? commandView.commands : []
  useEffect(
    () => protectFlowTaskView(threadId, visible && tab === "run" && (flow.active || taskWorking)),
    [threadId, visible, tab, flow.active, taskWorking]
  )
  useEffect(() => {
    if (visible && tab === "results") publishClawNotice(threadId, "flow-panes", "")
  }, [threadId, visible, tab])
  const loadRef = useRef(flow.load)
  useEffect(() => {
    loadRef.current = flow.load
  }, [flow.load])
  useEffect(() => {
    if (visible) void loadRef.current()
  }, [visible, threadId])
  useEffect(() => {
    const select = (event: Event) => setTab((event as CustomEvent).detail)
    window.addEventListener("claw:sidebar-tab", select)
    return () => window.removeEventListener("claw:sidebar-tab", select)
  }, [])
  const close = () => {
    useAppStore.getState().setRightPanelCollapsed(true)
    document.querySelector<HTMLTextAreaElement>("textarea.composer-textarea")?.focus()
  }
  const storedModels = useAppStore((state) => state.models)
  const modelCatalog = useSyncExternalStore(
    subscribeModelCatalog,
    readModelCatalogCache,
    readModelCatalogCache
  )
  const modelNames = modelCatalog?.models ?? storedModels
  const defaultModel = resolveModelDisplay(
    profile?.models?.default,
    modelNames,
    modelCatalog !== null
  )
  if (!host) return null
  return createPortal(
    <aside
      aria-label="任务进展"
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) close()
      }}
    >
      <header className="flex items-start justify-between gap-3 border-b px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-semibold">
            <Sparkles className="size-4 text-primary" />
            任务进展
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            查看做到哪里了、需要你做什么，以及已经完成的结果。
          </p>
        </div>
        <button
          type="button"
          aria-label="收起任务进展"
          className="rounded-md p-1.5 hover:bg-muted"
          onClick={close}
        >
          <X className="size-4" />
        </button>
      </header>
      <nav role="tablist" aria-label="任务进展页面" className="flex gap-1 border-b px-4 py-2">
        {(
          [
            ["run", "当前任务"],
            ["results", "结果"],
            ["configuration", "高级设置"]
          ] as const
        ).map(([id, name]) => (
          <button
            type="button"
            key={id}
            role="tab"
            aria-selected={tab === id}
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
            className={`flex-1 rounded-lg px-2 py-2 text-xs font-medium ${tab === id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"}`}
          >
            {name}
          </button>
        ))}
      </nav>
      <div className="border-b px-4 py-2">
        <ModsUsageSettingsEntry />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        <div hidden={tab !== "run"} inert={tab !== "run"} className="space-y-4">
          {taskOverview}
          {flow.workspaceActive && flow.workspaceActive.threadId !== threadId && (
            <div role="status" className="space-y-3 rounded-xl border p-4 text-sm">
              <p>这个项目还有一项任务需要处理：{flow.workspaceActive.flowName}。</p>
              <button type="button" className="rounded-lg border px-3 py-2 text-xs hover:bg-muted"
                onClick={() => void flow.openActive()}>
                前往处理
              </button>
            </div>
          )}
          {flow.error && <p role="alert" className="whitespace-pre-wrap break-words text-sm text-destructive">
            {flow.error}
          </p>}
          {!flow.run && !taskOverview && <section aria-label="开始任务" className="space-y-3 rounded-xl border p-4 text-sm">
            <h3 className="font-medium">直接说你想完成什么</h3>
            <p className="text-xs leading-6 text-muted-foreground">
              回到聊天框描述需求并发送。已有的任务进展、待确认事项和结果会显示在这里。
            </p>
            {flow.choice && <div className="space-y-2 rounded-lg bg-muted/30 p-3 text-xs">
              <p>下一条消息将使用“{flow.choice.name}”。</p>
              <button type="button" disabled={flow.busy} onClick={flow.clear} className="underline disabled:opacity-50">
                改为普通发送
              </button>
            </div>}
            <button type="button" onClick={close}
              className="rounded-lg bg-primary px-3 py-2 text-xs text-primary-foreground">
              回到聊天输入
            </button>
          </section>}
          {visible && tab === "run" && <ChatFlowRun
            flow={flow}
            disabled={disabled}
            onFollowUp={onFollowUp}
            presentation="task"
          />}
        </div>
        <section
          hidden={tab !== "configuration"}
          inert={tab !== "configuration"}
          data-desktop-selection-excluded
          className="space-y-4 text-sm"
        >
          <p className="text-xs leading-6 text-muted-foreground">
            这里用于手动调整功能和预设。日常使用可以直接在聊天中描述需求。
          </p>
          <details className="rounded-xl border p-4">
            <summary className="cursor-pointer text-sm font-medium">高级：为下一条消息使用预设任务</summary>
            <div className="mt-3">
              <ChatFlowControls flow={flow} disabled={disabled} onStart={onStart} showRun={false} />
            </div>
          </details>
          <div className="space-y-3 rounded-xl border p-4">
            {binding && (
              <p className="text-[11px] font-medium text-muted-foreground">
                {usingSelection
                  ? profile ? "这段聊天正在使用" : "这段聊天使用默认功能"
                  : profile ? "这段聊天已选择，当前未生效" : "当前没有生效的灵件"}
              </p>
            )}
            <h3 className="break-words font-semibold">
              {profile?.name ?? (binding ? "默认聊天设置" : "正在读取聊天设置")}
            </h3>
            {binding && !profile && (
              <p className="text-xs leading-6 text-muted-foreground">
                尚未选择专用组合，沿用已授权的默认功能。要调整使用范围，可在创造者模式直接描述。
              </p>
            )}
            {binding && !usingSelection && (
              <div role="alert" className="space-y-1 text-xs text-destructive">
                <p>
                  {effective?.state === "disabled"
                    ? "灵件功能已关闭。点击上方‘灵件与使用设置’，核对当前聊天后明确开启，无需进入创造者模式。"
                    : "这段聊天的组合暂不可用，请在‘管理助手组合’中核对。"}
                </p>
                {effective?.issues.map((issue) => <p key={issue}>{issue}</p>)}
              </div>
            )}
            <div className="flex flex-wrap gap-1.5">
              {(profile?.capabilities ?? effective?.plugins ?? []).map((capability) => (
                <span
                  key={capability.pluginId}
                  className="max-w-full break-all rounded-md bg-muted px-2 py-1 text-xs"
                >
                  {capability.name}
                  {!usingSelection && " · 未生效"}
                  {usingSelection && profile && !effective?.plugins.some(
                    (item) => item.pluginId === capability.pluginId
                  ) && " · 未启用功能"}
                </span>
              ))}
              {profile && !profile.capabilities.length && (
                <span className="text-xs text-muted-foreground">未添加灵件，可以照常聊天。</span>
              )}
            </div>
            {usingSelection && effective?.plugins.some((item) => item.components?.length) && (
              <details className="text-xs">
                <summary className="cursor-pointer">本聊天使用的具体功能</summary>
                <ul className="mt-2 space-y-1">
                  {effective.plugins.flatMap((item) => (item.components ?? []).map((component) => (
                    <li key={`${item.pluginId}:${component.id}`}>
                      {item.name}：{component.name}
                    </li>
                  )))}
                </ul>
              </details>
            )}
            {profile && (
              <details key={profile.id}>
                <summary className="cursor-pointer text-xs">查看这套组合的设置</summary>
                <dl className="mt-3 space-y-2 text-xs">
                  <div>
                    <dt className="text-muted-foreground">做事方法（技能）</dt>
                    <dd className="mt-1">{clawSourceSummary(profile?.skills, "技能")}</dd>
                    <dd className="mt-1 text-muted-foreground">
                      告诉助手怎样完成任务，例如代码检视。
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">可调用的工具</dt>
                    <dd className="mt-1">{clawSourceSummary(profile?.mcp, "工具")}</dd>
                    <dd className="mt-1 text-muted-foreground">
                      让助手连接文件、数据库或其他服务。
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">回答问题的模型</dt>
                    <dd className="mt-1 break-words">
                      {profile?.models?.default
                        ? defaultModel.name
                        : "以聊天输入框旁选择的模型为准"}
                      {defaultModel.note && (
                        <span className="ml-1 text-muted-foreground">· {defaultModel.note}</span>
                      )}
                    </dd>
                  </div>
                  {Object.entries(profile?.models?.roles ?? {}).map(([role, model]) => {
                    const display = resolveModelDisplay(model, modelNames, modelCatalog !== null)
                    return (
                      <div key={role}>
                        <dt className="text-muted-foreground">{role} 步骤使用的模型</dt>
                        <dd className="mt-1 break-words">
                          {display.name}
                          {display.note && (
                            <span className="ml-1 text-muted-foreground">· {display.note}</span>
                          )}
                        </dd>
                      </div>
                    )
                  })}
                  {profile.flow && (
                    <div>
                      <dt className="text-muted-foreground">组合自带的执行步骤</dt>
                      <dd className="mt-1">{profile.flow.definition.name}</dd>
                      <dd className="mt-1 text-muted-foreground">
                        可在上方高级选项中为下一条消息指定预设，再回到聊天发送任务。
                      </dd>
                    </div>
                  )}
                </dl>
                <p className="mt-3 text-[11px] leading-5 text-muted-foreground">
                  在“助手组合”里修改后，点击“应用到当前对话”，这段聊天才会使用新设置。
                </p>
              </details>
            )}
            {profile && (
              <p className="text-[11px] leading-5 text-muted-foreground">
                这套组合的功能选择只用于这段聊天。
              </p>
            )}
            {profile?.models?.default && defaultModel.note && (
              <p className="text-[11px] leading-5 text-muted-foreground">
                打开输入框下方“原聊天模型与智能路由”查看模型配置。名称未确认或有多个匹配时，
                先从模型配置入口手动核对，再在“助手组合”选择明确模型并保存应用。
              </p>
            )}
          </div>
          {effective?.plugins
            .filter(
              (item) =>
                (!!item.userConfigFieldCount ||
                  (recovery.open && recovery.scope === recoveryScope && item.state === "ready"))
            )
            .map((item) => (
              <div key={item.pluginId} className="space-y-2">
                <p className="text-xs font-medium">{item.name}</p>
                <FunctionUserConfig
                  threadId={threadId}
                  pluginId={item.pluginId}
                  expectedWorkspace={binding?.workspace}
                />
              </div>
            ))}
          {effective?.plugins
            .map((item) => {
              const registered = commands.filter(
                (command) =>
                  command.modId === `function:${item.name}` && command.digest === item.digest
              )
              if (!registered.length) return null
              return (
                <div key={`commands:${item.pluginId}`} className="space-y-2 rounded-lg border p-3">
                  <p className="text-xs font-medium">{item.name} · 使用命令</p>
                  {!item.userConfigFieldCount && (
                    <p className="text-xs text-muted-foreground">
                      这个灵件没有设置表单，可通过以下命令使用或设置。点击只填入聊天框，由你发送。
                    </p>
                  )}
                  {registered.map((command) => (
                    <button
                      key={command.command}
                      type="button"
                      className="block text-left text-xs text-primary"
                      disabled={disabled}
                      onClick={() => onFollowUp(`/${command.command.replace(/^\//, "")} `)}
                    >
                      /{command.command.replace(/^\//, "")} {command.argumentHint ?? ""} ·{" "}
                      {command.name}
                    </button>
                  ))}
                </div>
              )
            })}
          <div className="rounded-xl border bg-muted/20 p-4">
            <h3 className="font-medium">{profile ? "想调整这套组合？" : "想把几个插件一起用？"}</h3>
            <p className="mt-2 text-xs leading-6 text-muted-foreground">
              直接描述想保留、增加或移除的功能，助手会结合当前设置完成调整。
            </p>
            <button
              type="button"
              className="mt-3 flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs text-primary-foreground"
              disabled={disabled || creatorBusy || !onRequestCreator}
              onClick={async () => {
                if (!onRequestCreator || creatorPending.current || disabled) return
                const scope = creatorScope
                const ticket = Symbol()
                creatorPending.current = ticket
                setCreatorAction({ scope, busy: true, error: "" })
                const names = (profile?.capabilities ?? effective?.plugins ?? []).map((item) => item.name)
                const prompt = `请调整当前聊天的助手组合${profile ? `“${profile.name}”` : "（当前使用默认功能）"}。当前选择的功能：${names.join("、") || "未选择具体功能"}。保留我没有要求修改的功能、模型与执行步骤，先读取当前真实设置再调整。我的调整需求：`
                try {
                  await onRequestCreator(prompt)
                  if (latestCreatorScope.current === scope && creatorPending.current === ticket) close()
                } catch {
                  if (latestCreatorScope.current === scope && creatorPending.current === ticket)
                    setCreatorAction({ scope, busy: false, error: "暂时无法进入创造者模式，请重新核对当前聊天后重试。" })
                } finally {
                  if (latestCreatorScope.current === scope && creatorPending.current === ticket) {
                    creatorPending.current = null
                    setCreatorAction((value) => ({ ...value, busy: false }))
                  }
                }
              }}
            >
              <Sparkles className="size-3.5" />
              {creatorBusy ? "正在进入创造者模式…" : "用对话调整组合"}
              <ArrowRight className="size-3.5" />
            </button>
            {creatorAction.scope === creatorScope && creatorAction.error &&
              <p role="status" className="mt-2 text-xs text-destructive">{creatorAction.error}</p>}
            <details className="mt-3 text-xs text-muted-foreground">
              <summary className="cursor-pointer">高级：手动管理组合</summary>
              <button type="button" className="mt-2 flex items-center gap-2 rounded-lg border px-3 py-2 hover:bg-muted"
                onClick={() => useAppStore.getState().setShowCustomizeView(true, "claw")}>
                <Settings2 className="size-3.5" />
                {profile ? "管理助手组合" : "选择助手组合"}
              </button>
            </details>
          </div>
        </section>
        <div
          hidden={tab !== "results"}
          inert={tab !== "results"}
          data-claw-results
          className="space-y-4"
        >
          <p className="text-xs text-muted-foreground">
            已产生的结果显示在这里。任务进度和需要你确认的事项在“当前任务”中查看。
          </p>
          <details>
            <summary className="cursor-pointer text-sm">命令与完成记录</summary>
            {records}
          </details>
          <details onToggle={(event) => setOverviewOpen(event.currentTarget.open)}>
            <summary className="cursor-pointer text-xs">排查详情：规范与运行记录</summary>
            {overviewOpen && <BuiltinRunOverview
              threadId={threadId}
              workspace={workspace}
              visible={visible && tab === "results"}
            />}
          </details>
          <ClawResultsVisibility.Provider value={visible && tab === "results"}>
            {children}
          </ClawResultsVisibility.Provider>
          {flow.enabled && binding?.workspace && (
            <details onToggle={(event) => setAuditOpen(event.currentTarget.open)}>
              <summary className="cursor-pointer text-xs">排查详情：技术日志</summary>
              {visible && tab === "results" && auditOpen && (
                <ModsAudit threadId={threadId} expectedWorkspace={binding.workspace} />
              )}
            </details>
          )}
        </div>
      </div>
    </aside>,
    host
  )
}

export function ClawComposerBar({
  threadId,
  flow,
  children
}: {
  threadId: string
  flow: ChatFlowController
  children?: ReactNode
}) {
  const notices = useClawNotices(threadId)
  const attention = Boolean(
    flow.error || flow.run?.pendingApproval || flow.run?.status === "failed"
  )
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs" data-claw-composer>
        <button
          type="button"
          aria-label="查看任务进展"
          data-app-guide="progress"
          aria-live={attention ? "polite" : undefined}
          onClick={() => openClawSidebar("run")}
          className={`flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 hover:bg-muted ${attention ? "bg-amber-500/10 text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}
        >
          <Sparkles className="size-3.5 shrink-0" />
          <span className="max-w-44 truncate">
            {flow.run?.pendingApproval ? "需要你确认"
              : flow.error || flow.run?.status === "failed" ? "任务需要处理"
                : flow.run?.status === "complete" ? "查看任务结果"
                  : flow.run?.status === "cancelled" ? "任务已停止"
                    : flow.run?.status === "interrupted" ? "任务中断 · 查看"
                      : flow.run ? "查看任务进展" : "任务进展"}
          </span>
          <ArrowRight className="size-3" />
        </button>
      {flow.choice && <button type="button" disabled={flow.busy} onClick={flow.clear}
        aria-label="改为普通发送" title={`下一条消息已使用“${flow.choice.name}”，点击改为普通发送`}
        className="inline-flex max-w-full items-center gap-1 rounded-lg border px-2 py-1.5 hover:bg-muted disabled:opacity-50">
        <span className="truncate">下一条任务：{flow.choice.name}</span><X className="size-3.5 shrink-0" />
      </button>}
      {children}
      {Object.entries(notices).map(([source, text]) => (
        <button
          key={source}
          type="button"
          aria-live="polite"
          onClick={() => openClawSidebar("results")}
          className="rounded-full bg-amber-500/10 px-2 py-1 text-amber-700 dark:text-amber-400"
        >
          {text} · 查看
        </button>
      ))}
      {flow.active && (
        <button
          type="button"
          disabled={flow.busy}
          onClick={() => void flow.act("cancel")}
          className="rounded px-2 py-1 text-destructive hover:bg-destructive/10"
        >
          {flow.stopping ? "正在停止" : "停止任务"}
        </button>
      )}
    </div>
  )
}
