import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { ArrowRight, ChevronDown, MessageSquare, Settings2, Sparkles, X } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  useClawSidebarHost,
  openClawSidebar,
  useClawNotices,
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
import { chatClawDefaultModel } from "@/lib/chat-claw-state"
import { BuiltinRunOverview } from "./BuiltinRunOverview"

export function ClawSidebar({
  threadId,
  workspace,
  flow,
  disabled,
  onFollowUp,
  records,
  children
}: {
  threadId: string
  workspace?: string | null
  flow: ChatFlowController
  disabled: boolean
  onFollowUp(text: string): void
  children: ReactNode
  records?: ReactNode
}) {
  const host = useClawSidebarHost(threadId)
  const binding = "binding" in flow ? flow.binding : undefined
  const profile = binding?.active
  const recoveryScope = JSON.stringify([threadId, workspace, profile, binding?.capabilities])
  const [tab, setTab] = useState<"run" | "configuration" | "results">("configuration")
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
  useEffect(() => useAppStore.subscribe(state => {
    if (state.rightModule !== "claw" || state.rightPanelCollapsed)
      setRecovery(previous => previous.open ? { ...previous, open: false } : previous)
  }), [])
  const visible = useAppStore((state) => state.rightModule === "claw" && !state.rightPanelCollapsed)
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
      aria-label="当前助手"
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) close()
      }}
    >
      <header className="flex items-start justify-between gap-3 border-b px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-semibold">
            <Sparkles className="size-4 text-primary" />
            当前助手
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            查看正在使用的插件、执行步骤和任务结果。
          </p>
        </div>
        <button
          type="button"
          aria-label="收起当前助手"
          className="rounded-md p-1.5 hover:bg-muted"
          onClick={close}
        >
          <X className="size-4" />
        </button>
      </header>
      <nav role="tablist" aria-label="当前助手页面" className="flex gap-1 border-b px-4 py-2">
        {(
          [
            ["run", "按步骤执行"],
            ["configuration", "设置"],
            ["results", "运行过程"]
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
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        <div hidden={tab !== "run"} inert={tab !== "run"}>
          <div className="mb-4 rounded-xl border bg-muted/30 p-4 text-xs leading-5">
            <p className="font-medium">平时直接聊天，需要固定步骤再运行流程</p>
            <p className="mt-1 text-muted-foreground">
              先选步骤，再到输入框选择“按步骤执行”，填写目标并发送。
              仅选择或查看步骤不会开始任务。平时提问使用“直接聊天”即可。
            </p>
          </div>
          <ChatFlowControls flow={flow} disabled={disabled} showRun={false} />
          <button
            type="button"
            className="mt-3 text-sm underline"
            onClick={() => setTab("results")}
          >
            查看运行过程与结果
          </button>
        </div>
        <section
          hidden={tab !== "configuration"}
          inert={tab !== "configuration"}
          data-desktop-selection-excluded
          className="space-y-4 text-sm"
        >
          <div className="space-y-3 rounded-xl border p-4">
            {profile && (
              <p className="text-[11px] font-medium text-muted-foreground">
                {flow.enabled ? "这段聊天正在使用" : "这段聊天已选择"}
              </p>
            )}
            <h3 className="break-words font-semibold">{profile?.name ?? "直接提问就可以"}</h3>
            {!profile && (
              <p className="text-xs leading-6 text-muted-foreground">
                直接聊天不需要先选助手组合。想把几个插件搭配在一起时，再选择组合。
              </p>
            )}
            {profile && !flow.enabled && (
              <p className="text-xs text-muted-foreground">
                {binding?.enabled === false
                  ? "灵件功能已关闭。请到‘自定义助手 → 添加功能’开启。"
                  : "这套组合暂不可用。请打开下方‘管理助手组合’查看并调整设置。"}
              </p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {profile?.capabilities.map((capability) => (
                <span
                  key={capability.pluginId}
                  className="max-w-full break-all rounded-md bg-muted px-2 py-1 text-xs"
                >
                  {capability.name}
                  {capability.components?.mode === "selected"
                    ? ` · ${capability.components.ids.join("、")}`
                    : " · 全部功能"}
                </span>
              ))}
              {profile && !profile.capabilities.length && (
                <span className="text-xs text-muted-foreground">未添加灵件，可以照常聊天。</span>
              )}
            </div>
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
                        需要时切到“按步骤执行”，填写任务后发送。
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
                只用于这段聊天，其他聊天不变。
              </p>
            )}
            {profile?.models?.default && defaultModel.note && (
              <p className="text-[11px] leading-5 text-muted-foreground">
                打开输入框下方“原聊天模型与智能路由”查看模型配置。名称未确认或有多个匹配时，
                先从模型配置入口手动核对，再在“助手组合”选择明确模型并保存应用。
              </p>
            )}
          </div>
          {binding?.capabilities
            .filter(
              (item) =>
                (!!item.userConfigFieldCount ||
                  (recovery.open && recovery.scope === recoveryScope && item.state === "ready")) &&
                (profile
                  ? profile.capabilities.some((capability) => capability.pluginId === item.pluginId)
                  : item.state === "ready")
            )
            .map((item) => (
              <div key={item.pluginId} className="space-y-2">
                <p className="text-xs font-medium">{item.name}</p>
                <FunctionUserConfig threadId={threadId} pluginId={item.pluginId} />
              </div>
            ))}
          <div className="rounded-xl border bg-muted/20 p-4">
            <h3 className="font-medium">{profile ? "想调整这套组合？" : "想把几个插件一起用？"}</h3>
            <p className="mt-2 text-xs leading-6 text-muted-foreground">
              挑选需要的插件，保存后点击“应用到当前对话”。任务仍由你在聊天框发送。
            </p>
            <button
              type="button"
              className="mt-3 flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs text-primary-foreground"
              onClick={() => useAppStore.getState().setShowCustomizeView(true, "claw")}
            >
              <Settings2 className="size-3.5" />
              {profile ? "管理助手组合" : "选择助手组合"}
              <ArrowRight className="size-3.5" />
            </button>
          </div>
        </section>
        <div
          hidden={tab !== "results"}
          inert={tab !== "results"}
          data-claw-results
          className="space-y-4"
        >
          <p className="mb-3 text-xs leading-5 text-muted-foreground">
            在这里看进度、结果和下一步。查看记录不会启动任务或重新执行检查。
          </p>
          {flow.error && (
            <p role="alert" className="text-sm text-destructive">
              读取或执行遇到问题：<span>{flow.error}</span>
            </p>
          )}
          <ChatFlowRun flow={flow} disabled={disabled} onFollowUp={onFollowUp} />
          {!flow.run && (
            <p className="rounded-lg border p-3 text-xs text-muted-foreground">
              {flow.loading
                ? "正在读取流程记录…"
                : flow.error
                  ? "流程记录暂不可用，请稍后重新打开。"
                  : "暂无可显示的流程记录。普通聊天的回复仍在对话中；灵件提供的记录显示在下方。"}
            </p>
          )}
          {records}
          <BuiltinRunOverview
            threadId={threadId}
            workspace={workspace}
            visible={visible && tab === "results"}
          />
          <ClawResultsVisibility.Provider value={visible && tab === "results"}>
            {children}
          </ClawResultsVisibility.Provider>
          {flow.enabled && binding?.workspace && (
            <ModsAudit threadId={threadId} expectedWorkspace={binding.workspace} />
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
  mode,
  onModeChange,
  children
}: {
  threadId: string
  flow: ChatFlowController
  mode: "chat" | "flow"
  onModeChange(mode: "chat" | "flow"): void
  children?: ReactNode
}) {
  const [modeOpen, setModeOpen] = useState(false)
  const notices = useClawNotices(threadId)
  const storedModels = useAppStore((state) => state.models)
  const modelCatalog = useSyncExternalStore(
    subscribeModelCatalog,
    readModelCatalogCache,
    readModelCatalogCache
  )
  // Keep the exit to ordinary chat available if Mods is disabled while a flow is selected.
  const flowAvailable = flow.enabled || Boolean(flow.choice) || mode === "flow"
  if (!flowAvailable && !children) return null
  const model = chatClawDefaultModel(flow.enabled, "binding" in flow ? flow.binding : undefined)
  const modelDisplay = resolveModelDisplay(
    model,
    modelCatalog?.models ?? storedModels,
    modelCatalog !== null
  )
  const attention = Boolean(
    flow.error || flow.run?.pendingApproval || flow.run?.status === "failed"
  )
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs" data-claw-composer>
      {flowAvailable && (
        <Popover open={modeOpen} onOpenChange={setModeOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="选择发送方式"
              className="inline-flex items-center gap-1.5 rounded-lg border bg-background px-2.5 py-1.5"
            >
              <MessageSquare className="size-3.5" />
              {mode === "flow" ? "按步骤执行" : "直接聊天"}
              <ChevronDown className="size-3" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            side="top"
            className="w-64 space-y-1 p-2"
            aria-label="发送方式"
          >
            {(
              [
                ["chat", "直接聊天"],
                ["flow", "按步骤执行"]
              ] as const
            ).map(([id, name]) => (
              <button
                key={id}
                type="button"
                aria-label={name}
                aria-pressed={mode === id}
                disabled={!flow.enabled && id === "flow"}
                onClick={() => {
                  onModeChange(id)
                  setModeOpen(false)
                  if (id === "flow") {
                    openClawSidebar("run")
                    void flow.load()
                  }
                }}
                className={`block w-full rounded-md px-3 py-2 text-left ${mode === id ? "bg-muted font-medium" : "text-muted-foreground"}`}
              >
                <span className="block text-sm">{name}</span>
                <span className="mt-1 block text-xs font-normal text-muted-foreground">
                  {id === "chat" ? "直接向助手提问或交代任务" : "按已保存的步骤完成任务"}
                </span>
              </button>
            ))}
          </PopoverContent>
        </Popover>
      )}
      {flowAvailable && (
        <button
          type="button"
          aria-label="打开当前助手"
          onClick={() => openClawSidebar("configuration")}
          className="flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-muted-foreground hover:bg-muted"
        >
          <Sparkles className="size-3.5 shrink-0" />
          <span className="max-w-44 truncate">
            {("binding" in flow && flow.binding?.active?.name) || flow.choice?.name || "当前助手"}
          </span>
          <ArrowRight className="size-3" />
        </button>
      )}
      {children}
      {model && (
        <span
          aria-label="当前助手指定的聊天模型"
          title="用于本聊天的助手；具体步骤和灵件可能使用各自指定的模型。"
          className="max-w-56 truncate text-muted-foreground"
        >
          聊天模型：{modelDisplay.name}
          {modelDisplay.note ? ` · ${modelDisplay.note}` : ""}
        </span>
      )}
      {(flow.active || attention) && (
        <button
          type="button"
          onClick={() => openClawSidebar("results")}
          aria-live={attention ? "polite" : undefined}
          className={`rounded-full px-2 py-1 ${attention ? "bg-amber-500/10 text-amber-700 dark:text-amber-400" : "bg-primary/10 text-primary"}`}
        >
          {flow.run?.pendingApproval
            ? "等待你确认 · 查看"
            : flow.error
              ? "配置或运行错误 · 查看"
              : flow.run?.status === "failed"
                ? "流程失败 · 查看"
                : "流程执行中 · 查看"}
        </button>
      )}
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
          停止流程
        </button>
      )}
    </div>
  )
}
