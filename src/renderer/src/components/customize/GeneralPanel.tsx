import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { AlertTriangle, Loader2, Settings2, Sparkles } from "lucide-react"
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

        <section className="rounded-lg border border-border/80 bg-background">
          <div className="border-b border-border/70 px-5 py-4">
            <h2 className="text-sm font-semibold text-foreground">窗口</h2>
          </div>
          <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 sm:pr-8">
              <div className="text-sm font-medium text-foreground">关闭主窗口时</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                设置点击窗口右上角 × 时的行为；从{trayAreaName}菜单选择“退出”始终会退出应用。
              </p>
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

        <section className="rounded-lg border border-border/80 bg-background">
          <div className="border-b border-border/70 px-5 py-4">
            <h2 className="text-sm font-semibold text-foreground">外观</h2>
          </div>
          <div className="flex items-center justify-between gap-4 px-5 py-5">
            <div className="flex min-w-0 items-start gap-3 sm:pr-8">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted/50">
                <Sparkles className="size-4 text-muted-foreground" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">输入框动态光效</div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Agent 运行时在输入框中显示彩色动态光晕。默认关闭，可按需开启。
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
