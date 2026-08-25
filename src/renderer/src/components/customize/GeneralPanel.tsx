import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import {
  AlertTriangle,
  Gauge,
  Loader2,
  PanelTopClose,
  Settings2,
  Sparkles,
  TimerReset,
  Trash2
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { isWindowCloseBehavior, type WindowCloseBehavior } from "../../../../shared/close-to-tray"
import {
  AGENT_GRAPH_RECURSION_LIMIT_DEFAULT,
  AGENT_GRAPH_RECURSION_LIMIT_MAX,
  AGENT_GRAPH_RECURSION_LIMIT_MIN,
  isAgentGraphRecursionLimit,
  isWorkflowWorktreeRemoveTimeoutMinutes,
  isWorkflowWorktreeTimeoutMinutes,
  WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_DEFAULT,
  WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_MAX,
  WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_MIN,
  WORKFLOW_WORKTREE_TIMEOUT_MINUTES_DEFAULT,
  WORKFLOW_WORKTREE_TIMEOUT_MINUTES_MAX,
  WORKFLOW_WORKTREE_TIMEOUT_MINUTES_MIN
} from "../../../../shared/agent-runtime-limits"
import {
  getAppleIntelligenceGlowEnabled,
  setAppleIntelligenceGlowEnabled,
  subscribeAppleIntelligenceGlow
} from "@/lib/apple-intelligence-glow"
import { useAppStore } from "@/lib/store"
import {
  CHAT_AUTO_SCROLL_ALWAYS,
  DEFAULT_CHAT_AUTO_SCROLL_MESSAGE_LIMIT,
  normalizeChatAutoScrollMessageLimit,
  type ChatScrollSettings
} from "../../../../shared/chat-scroll"

export function GeneralPanel(): React.JSX.Element {
  const [closeBehavior, setCloseBehavior] = useState<WindowCloseBehavior | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recursionLimit, setRecursionLimit] = useState<number | null>(null)
  const [recursionLimitDraft, setRecursionLimitDraft] = useState("")
  const [worktreeTimeoutMinutes, setWorktreeTimeoutMinutes] = useState<number | null>(null)
  const [worktreeTimeoutDraft, setWorktreeTimeoutDraft] = useState("")
  const [worktreeRemoveTimeoutMinutes, setWorktreeRemoveTimeoutMinutes] = useState<number | null>(
    null
  )
  const [worktreeRemoveTimeoutDraft, setWorktreeRemoveTimeoutDraft] = useState("")
  const [runtimeSettingsLoading, setRuntimeSettingsLoading] = useState(true)
  const [runtimeSettingsSaving, setRuntimeSettingsSaving] = useState(false)
  const [worktreeTimeoutSaving, setWorktreeTimeoutSaving] = useState(false)
  const [worktreeRemoveTimeoutSaving, setWorktreeRemoveTimeoutSaving] = useState(false)
  const [runtimeSettingsError, setRuntimeSettingsError] = useState<string | null>(null)
  const [worktreeSettingsError, setWorktreeSettingsError] = useState<string | null>(null)
  const closeBehaviorRevisionRef = useRef(0)
  const chatScrollSettings = useAppStore((state) => state.chatScrollSettings)
  const setStoredChatScrollSettings = useAppStore((state) => state.setChatScrollSettings)
  const [chatScrollMessageLimitInput, setChatScrollMessageLimitInput] = useState(
    String(DEFAULT_CHAT_AUTO_SCROLL_MESSAGE_LIMIT)
  )
  const [chatScrollSaving, setChatScrollSaving] = useState(false)
  const [alwaysScrollDialogOpen, setAlwaysScrollDialogOpen] = useState(false)
  const trayAreaName = window.electron.process.platform === "darwin" ? "菜单栏" : "系统托盘"
  const appleIntelligenceGlowEnabled = useSyncExternalStore(
    subscribeAppleIntelligenceGlow,
    getAppleIntelligenceGlowEnabled,
    () => false
  )

  const loadCloseBehavior = useCallback(async (): Promise<void> => {
    const revision = ++closeBehaviorRevisionRef.current
    setLoading(true)
    setError(null)
    setCloseBehavior(null)
    try {
      const behavior = await window.electron.getWindowCloseBehavior()
      if (closeBehaviorRevisionRef.current === revision) {
        setCloseBehavior(behavior)
      }
    } catch (loadError) {
      console.error("[GeneralPanel] Failed to load window close behavior:", loadError)
      if (closeBehaviorRevisionRef.current === revision) {
        setError("无法读取关闭窗口设置，请稍后重试。")
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadCloseBehavior()
  }, [loadCloseBehavior])

  const loadRuntimeSettings = useCallback(async (): Promise<void> => {
    setRuntimeSettingsLoading(true)
    setRuntimeSettingsError(null)
    setWorktreeSettingsError(null)
    try {
      const settings = await window.electron.getAgentRuntimeSettings()
      setRecursionLimit(settings.recursionLimit)
      setRecursionLimitDraft(String(settings.recursionLimit))
      setWorktreeTimeoutMinutes(settings.workflowWorktreeTimeoutMinutes)
      setWorktreeTimeoutDraft(String(settings.workflowWorktreeTimeoutMinutes))
      setWorktreeRemoveTimeoutMinutes(settings.workflowWorktreeRemoveTimeoutMinutes)
      setWorktreeRemoveTimeoutDraft(String(settings.workflowWorktreeRemoveTimeoutMinutes))
    } catch (loadError) {
      console.error("[GeneralPanel] Failed to load agent runtime settings:", loadError)
      setRuntimeSettingsError("无法读取任务运行设置，请稍后重试。")
      setWorktreeSettingsError("无法读取 Worktree 设置，请稍后重试。")
    } finally {
      setRuntimeSettingsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadRuntimeSettings()
  }, [loadRuntimeSettings])

  useEffect(() => {
    return window.electron.onWindowCloseBehaviorChanged((behavior) => {
      closeBehaviorRevisionRef.current += 1
      setCloseBehavior(behavior)
      setLoading(false)
      setError(null)
    })
  }, [])

  useEffect(() => {
    setChatScrollMessageLimitInput(
      chatScrollSettings.autoScrollMessageLimit === CHAT_AUTO_SCROLL_ALWAYS
        ? String(DEFAULT_CHAT_AUTO_SCROLL_MESSAGE_LIMIT)
        : String(chatScrollSettings.autoScrollMessageLimit)
    )
  }, [chatScrollSettings.autoScrollMessageLimit])

  const handleCloseBehaviorChange = useCallback(
    async (value: string): Promise<void> => {
      if (!isWindowCloseBehavior(value) || closeBehavior === null || value === closeBehavior) return
      const previousBehavior = closeBehavior
      const revision = ++closeBehaviorRevisionRef.current
      setCloseBehavior(value)
      setSaving(true)
      setError(null)
      try {
        const savedBehavior = await window.electron.setWindowCloseBehavior(value)
        if (closeBehaviorRevisionRef.current === revision) {
          setCloseBehavior(savedBehavior)
        }
        toast.success("关闭窗口设置已保存")
      } catch (saveError) {
        console.error("[GeneralPanel] Failed to save window close behavior:", saveError)
        if (closeBehaviorRevisionRef.current === revision) {
          setCloseBehavior(previousBehavior)
          setError("保存失败，设置未更改。")
        }
      } finally {
        setSaving(false)
      }
    },
    [closeBehavior]
  )

  const handleInputGlowChange = useCallback((enabled: boolean): void => {
    try {
      setAppleIntelligenceGlowEnabled(enabled)
      toast.success(enabled ? "输入框光效已开启" : "输入框光效已关闭")
    } catch (saveError) {
      console.error("[GeneralPanel] Failed to save input glow setting:", saveError)
      toast.error("光效设置保存失败")
    }
  }, [])

  const persistChatScrollSettings = useCallback(
    async (autoScrollMessageLimit: ChatScrollSettings["autoScrollMessageLimit"]): Promise<void> => {
      const previousSettings = chatScrollSettings
      const nextSettings = { autoScrollMessageLimit }
      setStoredChatScrollSettings(nextSettings)
      setChatScrollSaving(true)
      try {
        const savedSettings = await window.electron.setChatScrollSettings(nextSettings)
        setStoredChatScrollSettings(savedSettings)
        toast.success("会话滚动设置已保存")
      } catch (saveError) {
        console.error("[GeneralPanel] Failed to save chat scroll settings:", saveError)
        setStoredChatScrollSettings(previousSettings)
        toast.error("会话滚动设置保存失败")
      } finally {
        setChatScrollSaving(false)
      }
    },
    [chatScrollSettings, setStoredChatScrollSettings]
  )

  const handleChatScrollModeChange = useCallback(
    (value: string): void => {
      if (value === CHAT_AUTO_SCROLL_ALWAYS) {
        if (chatScrollSettings.autoScrollMessageLimit !== CHAT_AUTO_SCROLL_ALWAYS) {
          setAlwaysScrollDialogOpen(true)
        }
        return
      }

      if (value !== "limited") return
      const limit = normalizeChatAutoScrollMessageLimit(chatScrollMessageLimitInput)
      if (limit !== CHAT_AUTO_SCROLL_ALWAYS) {
        void persistChatScrollSettings(limit)
      }
    },
    [chatScrollMessageLimitInput, chatScrollSettings, persistChatScrollSettings]
  )

  const handleChatScrollMessageLimitBlur = useCallback((): void => {
    if (
      chatScrollSettings.autoScrollMessageLimit === CHAT_AUTO_SCROLL_ALWAYS
    ) {
      return
    }
    const limit = normalizeChatAutoScrollMessageLimit(chatScrollMessageLimitInput)
    setChatScrollMessageLimitInput(String(limit))
    if (limit !== chatScrollSettings.autoScrollMessageLimit) {
      void persistChatScrollSettings(limit)
    }
  }, [chatScrollMessageLimitInput, chatScrollSettings, persistChatScrollSettings])

  const chatScrollIsAlwaysEnabled =
    chatScrollSettings.autoScrollMessageLimit === CHAT_AUTO_SCROLL_ALWAYS

  const handleRecursionLimitSave = useCallback(async (): Promise<void> => {
    const value = Number(recursionLimitDraft)
    if (!isAgentGraphRecursionLimit(value)) {
      setRuntimeSettingsError(
        `请输入 ${AGENT_GRAPH_RECURSION_LIMIT_MIN}～${AGENT_GRAPH_RECURSION_LIMIT_MAX} 之间的整数。`
      )
      return
    }
    if (value === recursionLimit) return

    setRuntimeSettingsSaving(true)
    setRuntimeSettingsError(null)
    try {
      const settings = await window.electron.setAgentRuntimeRecursionLimit(value)
      setRecursionLimit(settings.recursionLimit)
      setRecursionLimitDraft(String(settings.recursionLimit))
      toast.success("任务运行上限已保存，将从下一次任务开始生效")
    } catch (saveError) {
      console.error("[GeneralPanel] Failed to save agent runtime settings:", saveError)
      setRuntimeSettingsError("保存失败，设置未更改。")
    } finally {
      setRuntimeSettingsSaving(false)
    }
  }, [recursionLimit, recursionLimitDraft])

  const handleWorktreeTimeoutSave = useCallback(async (): Promise<void> => {
    const value = Number(worktreeTimeoutDraft)
    if (!isWorkflowWorktreeTimeoutMinutes(value)) {
      setWorktreeSettingsError(
        `请输入 ${WORKFLOW_WORKTREE_TIMEOUT_MINUTES_MIN}～${WORKFLOW_WORKTREE_TIMEOUT_MINUTES_MAX} 之间的整数。`
      )
      return
    }
    if (value === worktreeTimeoutMinutes) return

    setWorktreeTimeoutSaving(true)
    setWorktreeSettingsError(null)
    try {
      const settings = await window.electron.setWorkflowWorktreeTimeoutMinutes(value)
      setWorktreeTimeoutMinutes(settings.workflowWorktreeTimeoutMinutes)
      setWorktreeTimeoutDraft(String(settings.workflowWorktreeTimeoutMinutes))
      toast.success("动态工作区等待时间已保存，对后续操作生效")
    } catch (saveError) {
      console.error("[GeneralPanel] Failed to save workflow worktree timeout:", saveError)
      setWorktreeSettingsError("保存失败，设置未更改。")
    } finally {
      setWorktreeTimeoutSaving(false)
    }
  }, [worktreeTimeoutDraft, worktreeTimeoutMinutes])

  const handleWorktreeRemoveTimeoutSave = useCallback(async (): Promise<void> => {
    const value = Number(worktreeRemoveTimeoutDraft)
    if (!isWorkflowWorktreeRemoveTimeoutMinutes(value)) {
      setWorktreeSettingsError(
        `请输入 ${WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_MIN}～${WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_MAX} 之间的整数。`
      )
      return
    }
    if (value === worktreeRemoveTimeoutMinutes) return

    setWorktreeRemoveTimeoutSaving(true)
    setWorktreeSettingsError(null)
    try {
      const settings = await window.electron.setWorkflowWorktreeRemoveTimeoutMinutes(value)
      setWorktreeRemoveTimeoutMinutes(settings.workflowWorktreeRemoveTimeoutMinutes)
      setWorktreeRemoveTimeoutDraft(String(settings.workflowWorktreeRemoveTimeoutMinutes))
      toast.success("Worktree 删除等待时间已保存，对后续删除操作生效")
    } catch (saveError) {
      console.error("[GeneralPanel] Failed to save workflow worktree removal timeout:", saveError)
      setWorktreeSettingsError("保存失败，设置未更改。")
    } finally {
      setWorktreeRemoveTimeoutSaving(false)
    }
  }, [worktreeRemoveTimeoutDraft, worktreeRemoveTimeoutMinutes])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6 sm:p-8">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <div>
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-muted/40">
              <Settings2 className="size-5 text-foreground" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-foreground">通用</h1>
              <p className="mt-1 text-sm text-muted-foreground">管理应用窗口、外观和基础行为。</p>
            </div>
          </div>
        </div>

        <section className="overflow-hidden rounded-xl border border-border/70 bg-muted/20">
          <div className="border-b border-border/60 bg-muted/35 px-5 py-4">
            <h2 className="text-sm font-semibold text-foreground">窗口</h2>
          </div>
          <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3 sm:pr-8">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-background/80 text-muted-foreground shadow-sm ring-1 ring-border/60">
                <PanelTopClose className="size-4" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">关闭主窗口时</div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  设置点击窗口右上角 × 时的行为；从{trayAreaName}
                  菜单选择“退出”始终会退出应用。
                </p>
              </div>
            </div>
            <div className="flex w-full shrink-0 items-center gap-2 sm:w-[250px]">
              <Select
                value={closeBehavior ?? undefined}
                onValueChange={(value) => void handleCloseBehaviorChange(value)}
                disabled={loading || saving || closeBehavior === null}
              >
                <SelectTrigger aria-label="关闭主窗口时" className="w-full">
                  <SelectValue placeholder={loading ? "正在加载…" : "无法读取设置"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ask">每次询问</SelectItem>
                  <SelectItem value="minimize-to-tray">最小化到{trayAreaName}</SelectItem>
                  <SelectItem value="quit">退出应用</SelectItem>
                </SelectContent>
              </Select>
              {(loading || saving) && (
                <Loader2
                  className="size-4 shrink-0 animate-spin text-muted-foreground"
                  aria-label={loading ? "正在加载" : "正在保存"}
                />
              )}
            </div>
          </div>
          {error && (
            <div className="flex items-center justify-between gap-3 border-t border-status-critical/25 bg-status-critical/5 px-5 py-3 text-xs text-status-critical">
              <span>{error}</span>
              {!loading && (
                <Button variant="outline" size="sm" className="h-7" onClick={loadCloseBehavior}>
                  重试
                </Button>
              )}
            </div>
          )}
        </section>

        <section className="rounded-lg border border-border/80 bg-background">
          <div className="border-b border-border/70 px-5 py-4">
            <h2 className="text-sm font-semibold text-foreground">会话滚动</h2>
          </div>
          <div className="flex flex-col gap-4 px-5 py-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 sm:pr-8">
                <div className="text-sm font-medium text-foreground">流式输出时自动置底</div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  默认仅在会话消息数不超过限制时跟随最新内容；超过限制后会自动停止，以降低长会话的渲染和布局开销。
                </p>
              </div>
              <div className="flex w-full shrink-0 flex-col gap-2 sm:w-[250px]">
                <Select
                  value={chatScrollIsAlwaysEnabled ? CHAT_AUTO_SCROLL_ALWAYS : "limited"}
                  onValueChange={handleChatScrollModeChange}
                  disabled={chatScrollSaving}
                >
                  <SelectTrigger aria-label="流式输出时自动置底模式" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="limited">按消息数量限制</SelectItem>
                    <SelectItem value={CHAT_AUTO_SCROLL_ALWAYS}>永远保持置底</SelectItem>
                  </SelectContent>
                </Select>
                {!chatScrollIsAlwaysEnabled && (
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={1}
                      max={100000}
                      value={chatScrollMessageLimitInput}
                      onChange={(event) => setChatScrollMessageLimitInput(event.target.value)}
                      onBlur={handleChatScrollMessageLimitBlur}
                      disabled={chatScrollSaving}
                      aria-label="自动置底消息数量"
                    />
                    <span className="shrink-0 text-xs text-muted-foreground">条消息</span>
                  </div>
                )}
                {chatScrollSaving && (
                  <Loader2
                    className="size-4 self-end animate-spin text-muted-foreground"
                    aria-label="正在保存"
                  />
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="overflow-hidden rounded-xl border border-border/70 bg-muted/20">
          <div className="border-b border-border/60 bg-muted/35 px-5 py-4">
            <h2 className="text-sm font-semibold text-foreground">任务运行</h2>
          </div>
          <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3 sm:pr-8">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-background/80 text-muted-foreground shadow-sm ring-1 ring-border/60">
                <Gauge className="size-4" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">单次任务运行上限</div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  限制一次任务最多可以连续处理多少步。默认
                  {AGENT_GRAPH_RECURSION_LIMIT_DEFAULT}
                  ，数值越高越适合复杂任务，但任务异常时也可能运行更久。修改后从下一次任务开始生效。
                </p>
              </div>
            </div>
            <div className="flex w-full shrink-0 items-center gap-2 sm:w-[250px]">
              <Input
                type="number"
                min={AGENT_GRAPH_RECURSION_LIMIT_MIN}
                max={AGENT_GRAPH_RECURSION_LIMIT_MAX}
                step={1}
                value={recursionLimitDraft}
                disabled={runtimeSettingsLoading || runtimeSettingsSaving}
                aria-label="单次任务运行上限"
                onChange={(event) => {
                  setRecursionLimitDraft(event.target.value)
                  setRuntimeSettingsError(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleRecursionLimitSave()
                }}
              />
              <Button
                type="button"
                variant="outline"
                disabled={
                  runtimeSettingsLoading ||
                  runtimeSettingsSaving ||
                  recursionLimitDraft === String(recursionLimit ?? "")
                }
                onClick={() => void handleRecursionLimitSave()}
              >
                {runtimeSettingsSaving ? <Loader2 className="size-4 animate-spin" /> : "保存"}
              </Button>
            </div>
          </div>
          {runtimeSettingsError && (
            <div className="flex items-center justify-between gap-3 border-t border-status-critical/25 bg-status-critical/5 px-5 py-3 text-xs text-status-critical">
              <span>{runtimeSettingsError}</span>
              {!runtimeSettingsLoading && recursionLimit === null && (
                <Button variant="outline" size="sm" className="h-7" onClick={loadRuntimeSettings}>
                  重试
                </Button>
              )}
            </div>
          )}
        </section>

        <section className="overflow-hidden rounded-xl border border-border/70 bg-muted/20">
          <div className="border-b border-border/60 bg-muted/35 px-5 py-4">
            <h2 className="text-sm font-semibold text-foreground">Worktree</h2>
          </div>
          <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3 sm:pr-8">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-background/80 text-muted-foreground shadow-sm ring-1 ring-border/60">
                <TimerReset className="size-4" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">Git 操作等待时间</div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  控制创建、合并和保存 Worktree 时，单次最多等待多久，不限制 Agent 的运行时长。默认
                  {WORKFLOW_WORKTREE_TIMEOUT_MINUTES_DEFAULT}
                  分钟；大型项目可适当调高。修改后对后续操作生效。
                </p>
              </div>
            </div>
            <div className="flex w-full shrink-0 items-center gap-2 sm:w-[250px]">
              <div className="relative min-w-0 flex-1">
                <Input
                  type="number"
                  min={WORKFLOW_WORKTREE_TIMEOUT_MINUTES_MIN}
                  max={WORKFLOW_WORKTREE_TIMEOUT_MINUTES_MAX}
                  step={1}
                  value={worktreeTimeoutDraft}
                  disabled={runtimeSettingsLoading || worktreeTimeoutSaving}
                  aria-label="Worktree Git 操作等待时间（分钟）"
                  className="pr-12"
                  onChange={(event) => {
                    setWorktreeTimeoutDraft(event.target.value)
                    setWorktreeSettingsError(null)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleWorktreeTimeoutSave()
                  }}
                />
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
                  分钟
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={
                  runtimeSettingsLoading ||
                  worktreeTimeoutSaving ||
                  worktreeTimeoutDraft === String(worktreeTimeoutMinutes ?? "")
                }
                onClick={() => void handleWorktreeTimeoutSave()}
              >
                {worktreeTimeoutSaving ? <Loader2 className="size-4 animate-spin" /> : "保存"}
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-4 border-t border-border/60 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3 sm:pr-8">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-background/80 text-muted-foreground shadow-sm ring-1 ring-border/60">
                <Trash2 className="size-4" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">删除等待时间</div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  删除独立工作区时，单次最多等待多久。默认
                  {WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_DEFAULT}
                  分钟；大型项目或 Windows 环境可适当调高。
                </p>
              </div>
            </div>
            <div className="flex w-full shrink-0 items-center gap-2 sm:w-[250px]">
              <div className="relative min-w-0 flex-1">
                <Input
                  type="number"
                  min={WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_MIN}
                  max={WORKFLOW_WORKTREE_REMOVE_TIMEOUT_MINUTES_MAX}
                  step={1}
                  value={worktreeRemoveTimeoutDraft}
                  disabled={runtimeSettingsLoading || worktreeRemoveTimeoutSaving}
                  aria-label="Worktree 删除等待时间（分钟）"
                  className="pr-12"
                  onChange={(event) => {
                    setWorktreeRemoveTimeoutDraft(event.target.value)
                    setWorktreeSettingsError(null)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleWorktreeRemoveTimeoutSave()
                  }}
                />
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
                  分钟
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={
                  runtimeSettingsLoading ||
                  worktreeRemoveTimeoutSaving ||
                  worktreeRemoveTimeoutDraft === String(worktreeRemoveTimeoutMinutes ?? "")
                }
                onClick={() => void handleWorktreeRemoveTimeoutSave()}
              >
                {worktreeRemoveTimeoutSaving ? <Loader2 className="size-4 animate-spin" /> : "保存"}
              </Button>
            </div>
          </div>
          {worktreeSettingsError && (
            <div className="flex items-center justify-between gap-3 border-t border-status-critical/25 bg-status-critical/5 px-5 py-3 text-xs text-status-critical">
              <span>{worktreeSettingsError}</span>
              {!runtimeSettingsLoading &&
                (worktreeTimeoutMinutes === null || worktreeRemoveTimeoutMinutes === null) && (
                  <Button variant="outline" size="sm" className="h-7" onClick={loadRuntimeSettings}>
                    重试
                  </Button>
                )}
            </div>
          )}
        </section>

        <section className="overflow-hidden rounded-xl border border-border/70 bg-muted/20">
          <div className="border-b border-border/60 bg-muted/35 px-5 py-4">
            <h2 className="text-sm font-semibold text-foreground">外观</h2>
          </div>
          <div className="flex items-center justify-between gap-4 px-5 py-5">
            <div className="flex min-w-0 items-start gap-3 sm:pr-8">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-background/80 text-muted-foreground shadow-sm ring-1 ring-border/60">
                <Sparkles className="size-4" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">输入框动态光效</div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  任务运行时在输入框中显示彩色动态光晕。默认关闭，可按需开启。
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2.5">
              <span className="text-xs text-muted-foreground">
                {appleIntelligenceGlowEnabled ? "已开启" : "已关闭"}
              </span>
              <Switch
                checked={appleIntelligenceGlowEnabled}
                onCheckedChange={handleInputGlowChange}
                aria-label="输入框动态光效"
              />
            </div>
          </div>
        </section>
      </div>
      <Dialog open={alwaysScrollDialogOpen} onOpenChange={setAlwaysScrollDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-status-warning" />
              确认开启永久置底？
            </DialogTitle>
            <DialogDescription className="leading-6">
              在较长会话中，持续跟随新内容会让页面频繁进行布局与滚动计算，可能增加 CPU
              和内存占用，并影响交互流畅度。建议仅在短会话或确实需要实时跟随时开启；你也可以随时改回按消息数量限制。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAlwaysScrollDialogOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => {
                setAlwaysScrollDialogOpen(false)
                void persistChatScrollSettings(CHAT_AUTO_SCROLL_ALWAYS)
              }}
            >
              仍然开启
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
