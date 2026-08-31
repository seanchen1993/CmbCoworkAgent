import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import {
  Check,
  Gauge,
  Loader2,
  Palette,
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
import {
  getDarkThemePreference,
  getLightThemePreference,
  getThemeModePreference,
  setThemeForColorScheme,
  setThemeModePreference,
  subscribeThemePreference,
  type ThemeModePreference,
  type ThemePreference
} from "@/lib/theme-preference"
import { DEFAULT_THEME_ID, THEME_DEFINITIONS } from "@/lib/theme-registry"
import { cn } from "@/lib/utils"

const THEME_GROUPS = [
  {
    colorScheme: "light",
    label: "浅色主题",
    themes: THEME_DEFINITIONS.filter((theme) => theme.colorScheme === "light")
  },
  {
    colorScheme: "dark",
    label: "深色主题",
    themes: THEME_DEFINITIONS.filter((theme) => theme.colorScheme === "dark")
  }
] as const

const THEME_MODE_OPTIONS: ReadonlyArray<{
  value: ThemeModePreference
  label: string
}> = [
  { value: "system", label: "系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" }
]

function ThemeModePreview({
  mode,
  selected
}: {
  mode: ThemeModePreference
  selected: boolean
}): React.JSX.Element {
  const shellBackground =
    mode === "system"
      ? "linear-gradient(90deg, #e5e5e5 0 50%, #5b5b5b 50% 100%)"
      : mode === "light"
        ? "#f1f1f1"
        : "#5b5b5b"
  const contentBackground =
    mode === "system"
      ? "linear-gradient(90deg, #ffffff 0 50%, #343434 50% 100%)"
      : mode === "dark"
        ? "#343434"
        : "#ffffff"

  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative block aspect-[1.55] overflow-hidden rounded-lg border-2",
        selected ? "border-foreground" : "border-border/70 group-hover:border-border-emphasis"
      )}
      style={{ background: shellBackground }}
    >
      <span className="absolute left-[31%] right-[20%] top-[23%] h-1.5 rounded-full bg-[#c4c4c4]" />
      <span className="absolute left-[21%] right-[12%] top-[34%] h-1 rounded-full bg-[#cfcfcf]" />
      <span
        className="absolute inset-x-[9%] bottom-0 h-[54%] overflow-hidden rounded-t-lg"
        style={{ background: contentBackground }}
      >
        <span className="absolute left-[8%] top-[20%] h-1.5 w-[28%] rounded-full bg-[#d2d2d2]" />
        <span className="absolute left-[8%] top-[38%] h-1 w-[52%] rounded-full bg-[#e2e2e2]" />
        <span className="absolute inset-x-0 top-[58%] h-px bg-[#dedede]" />
        <span className="absolute left-[8%] top-[72%] h-1.5 w-[28%] rounded-full bg-[#d2d2d2]" />
      </span>
    </span>
  )
}

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
  const trayAreaName = window.electron.process.platform === "darwin" ? "菜单栏" : "系统托盘"
  const appleIntelligenceGlowEnabled = useSyncExternalStore(
    subscribeAppleIntelligenceGlow,
    getAppleIntelligenceGlowEnabled,
    () => false
  )
  const themeMode = useSyncExternalStore(
    subscribeThemePreference,
    getThemeModePreference,
    () => "light"
  )
  const lightThemePreference = useSyncExternalStore(
    subscribeThemePreference,
    getLightThemePreference,
    () => DEFAULT_THEME_ID
  )
  const darkThemePreference = useSyncExternalStore(
    subscribeThemePreference,
    getDarkThemePreference,
    () => "codex-dark"
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

  const handleThemeChange = useCallback((theme: ThemePreference): void => {
    const definition = THEME_DEFINITIONS.find((item) => item.id === theme)
    setThemeForColorScheme(theme)
    toast.success(`已设置${definition?.colorScheme === "dark" ? "深色" : "浅色"}主题`)
  }, [])

  const handleThemeModeChange = useCallback((mode: string): void => {
    if (mode !== "system" && mode !== "light" && mode !== "dark") return
    setThemeModePreference(mode as ThemeModePreference)
    const label = mode === "system" ? "跟随系统" : mode === "light" ? "浅色" : "深色"
    toast.success(`外观模式已切换为${label}`)
  }, [])
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
          <div className="px-5 py-5">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">智能跟随最新消息</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                打开会话时会定位到最新消息；当你停留在底部附近时，新消息和流式内容会自动跟随。向上查看历史后会保持当前位置，不会抢夺滚动。
              </p>
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
          <div className="px-5 py-5">
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-background-elevated text-muted-foreground shadow-sm ring-1 ring-border/60">
                <Palette className="size-4" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">界面主题</div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  使用 CMBDevClaw 经典配色或其他内置主题；选择会在下次启动时保留。
                </p>
              </div>
            </div>
            <div className="mt-4">
              <div className="mb-2 px-0.5">
                <div className="text-[11px] font-medium text-foreground">外观模式</div>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  系统模式会根据电脑的浅色或深色设置自动切换。
                </p>
              </div>
              <div role="radiogroup" aria-label="外观模式" className="grid grid-cols-3 gap-3">
                {THEME_MODE_OPTIONS.map((option) => {
                  const selected = themeMode === option.value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => handleThemeModeChange(option.value)}
                      className="group min-w-0 rounded-lg p-0.5 text-center outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      <ThemeModePreview mode={option.value} selected={selected} />
                      <span
                        className={cn(
                          "mt-1.5 block text-xs",
                          selected ? "font-semibold text-foreground" : "text-muted-foreground"
                        )}
                      >
                        {option.label}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="mt-5 space-y-5">
              {THEME_GROUPS.filter(
                (group) => themeMode === "system" || group.colorScheme === themeMode
              ).map((group) => (
                <section key={group.colorScheme}>
                  <div className="mb-2 flex items-center gap-2 px-0.5">
                    <span className="text-[11px] font-medium text-muted-foreground">
                      {group.label}
                    </span>
                    <span className="rounded-full bg-background-interactive px-1.5 py-0.5 text-[9px] tabular-nums text-tertiary-foreground">
                      {group.themes.length}
                    </span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {group.themes.map((theme) => {
                      const configuredTheme =
                        theme.colorScheme === "dark" ? darkThemePreference : lightThemePreference
                      const selected = configuredTheme === theme.id
                      return (
                        <button
                          key={theme.id}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => handleThemeChange(theme.id)}
                          className={cn(
                            "group relative min-w-0 rounded-xl border p-3 text-left transition-colors",
                            selected
                              ? "border-primary bg-primary/10 ring-1 ring-primary/25"
                              : "border-border bg-background-elevated hover:border-border-emphasis hover:bg-background-interactive"
                          )}
                        >
                          <span className="flex items-center gap-2.5">
                            <span
                              className="flex h-9 w-12 shrink-0 overflow-hidden rounded-lg border shadow-sm"
                              style={{
                                backgroundColor: theme.palette.background,
                                borderColor: theme.palette.border
                              }}
                            >
                              <span
                                className="h-full w-1/2"
                                style={{ backgroundColor: theme.palette.backgroundElevated }}
                              />
                              <span
                                className="m-auto size-2.5 rounded-full"
                                style={{ backgroundColor: theme.palette.primary }}
                              />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                                <span className="truncate">{theme.label}</span>
                                {selected ? (
                                  <Check className="size-3.5 shrink-0 text-primary" />
                                ) : null}
                              </span>
                              <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                                {theme.description}
                              </span>
                            </span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </section>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-4 border-t border-border/60 px-5 py-5">
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
    </div>
  )
}
