import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowLeft, Check, Loader2, Pencil } from "lucide-react"
import { toast } from "sonner"
import { useAppStore } from "@/lib/store"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { BUILTIN_BROWSER_LOG_PREFIX, type BrowserCdpConfig } from "../../../../shared/browser-types"

interface BrowserCdpConfigCardProps {
  className?: string
  description?: string
  title?: string
}

const BROWSER_CDP_CONFIG_LOG_PREFIX = `${BUILTIN_BROWSER_LOG_PREFIX}[BrowserCdpConfigCard]`
const APP_DOWNLOAD_URL = import.meta.env.VITE_APP_DOWNLOAD_URL?.trim()

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function BrowserCdpConfigCard({
  className,
  description = "在这里手动开启内置浏览器",
  title = "控制配置"
}: BrowserCdpConfigCardProps): React.JSX.Element {
  const showCustomizeView = useAppStore((state) => state.showCustomizeView)
  const [cdpConfig, setCdpConfig] = useState<BrowserCdpConfig | null>(null)
  const [savedCdpConfig, setSavedCdpConfig] = useState<BrowserCdpConfig | null>(null)
  const [isSavingCdpConfig, setIsSavingCdpConfig] = useState(false)
  const [isEditingCdpConfig, setIsEditingCdpConfig] = useState(false)
  const [restartDialogOpen, setRestartDialogOpen] = useState(false)
  const [isRestartingApp, setIsRestartingApp] = useState(false)
  const [pendingSwitchConfirmation, setPendingSwitchConfirmation] = useState<
    "agent" | "profile" | null
  >(null)
  const saveButtonRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    window.api.browser
      .getCdpConfig()
      .then((nextConfig) => {
        if (cancelled) return
        setCdpConfig(nextConfig)
        setSavedCdpConfig(nextConfig)
      })
      .catch((error) => {
        console.error(
          `${BROWSER_CDP_CONFIG_LOG_PREFIX} Failed to load Browser CDP config: ${formatError(error)}`
        )
        if (cancelled) return
        const fallbackConfig = {
          enabled: false,
          profileImportEnabled: false
        }
        setCdpConfig(fallbackConfig)
        setSavedCdpConfig(fallbackConfig)
        toast.error("读取内置浏览器配置失败，已禁用 Agent 控制")
      })

    return () => {
      cancelled = true
    }
  }, [])

  const hasCdpConfigChanges = Boolean(
    cdpConfig &&
    savedCdpConfig &&
    (cdpConfig.enabled !== savedCdpConfig.enabled ||
      cdpConfig.profileImportEnabled !== savedCdpConfig.profileImportEnabled)
  )

  const handleCdpEnabledChange = useCallback((enabled: boolean) => {
    if (enabled) {
      setPendingSwitchConfirmation("agent")
      return
    }
    setCdpConfig((current) => (current ? { ...current, enabled } : current))
    saveButtonRef?.current?.scrollIntoView({ behavior: "smooth" })
  }, [])

  const handleProfileImportEnabledChange = useCallback((profileImportEnabled: boolean) => {
    if (profileImportEnabled && window.electron.process.platform === "win32") {
      setPendingSwitchConfirmation("profile")
      return
    }
    setCdpConfig((current) => (current ? { ...current, profileImportEnabled } : current))
    saveButtonRef?.current?.scrollIntoView({ behavior: "smooth" })
  }, [])

  const handleConfirmSwitch = useCallback(() => {
    if (!pendingSwitchConfirmation) return
    setCdpConfig((current) => {
      if (!current) return current
      if (pendingSwitchConfirmation === "agent") {
        return { ...current, enabled: true }
      }
      return { ...current, profileImportEnabled: true }
    })
    setPendingSwitchConfirmation(null)
    saveButtonRef?.current?.scrollIntoView({ behavior: "smooth" })
  }, [pendingSwitchConfirmation])

  const handleSaveCdpConfig = useCallback(async () => {
    if (!cdpConfig || !hasCdpConfigChanges) return

    setIsSavingCdpConfig(true)
    try {
      const saved = await window.api.browser.saveCdpConfig({
        enabled: cdpConfig.enabled,
        profileImportEnabled: cdpConfig.profileImportEnabled
      })
      setCdpConfig(saved)
      setSavedCdpConfig(saved)
      setIsEditingCdpConfig(!(saved.enabled && saved.profileImportEnabled))
      setIsRestartingApp(false)
      setRestartDialogOpen(true)
    } catch (error) {
      console.error(
        `${BROWSER_CDP_CONFIG_LOG_PREFIX} Failed to save Browser CDP config: ${formatError(error)}`
      )
      toast.error("保存内置浏览器配置失败")
    } finally {
      setIsSavingCdpConfig(false)
    }
  }, [cdpConfig, hasCdpConfigChanges])

  const handleReturnFromEditing = useCallback(() => {
    if (!savedCdpConfig) return
    setCdpConfig(savedCdpConfig)
    setPendingSwitchConfirmation(null)
    setIsEditingCdpConfig(false)
  }, [savedCdpConfig])

  const handleRestartDialogOpenChange = useCallback(
    (open: boolean) => {
      if (isRestartingApp) return
      setRestartDialogOpen(open)
    },
    [isRestartingApp]
  )

  const handleRestartAppNow = useCallback(async () => {
    setIsRestartingApp(true)
    try {
      await new Promise((resolve) => window.setTimeout(resolve, 150))
      await window.api.app.restart()
    } catch (error) {
      console.error(`${BROWSER_CDP_CONFIG_LOG_PREFIX} Failed to restart app: ${formatError(error)}`)
      setIsRestartingApp(false)
      toast.error("重启应用失败，请稍后手动重启")
    }
  }, [])

  const isFullyEnabled = Boolean(cdpConfig?.enabled && cdpConfig.profileImportEnabled)
  const canReturnFromEditing = Boolean(
    isEditingCdpConfig && savedCdpConfig?.enabled && savedCdpConfig.profileImportEnabled
  )
  const saveDisabledReason = !cdpConfig
    ? "正在读取配置，请稍候。"
    : isSavingCdpConfig
      ? "正在保存配置，请稍候。"
      : !hasCdpConfigChanges
        ? "配置未发生变化，无需保存。"
        : null

  const saveButton = (
    <Button
      type="button"
      size="sm"
      disabled={Boolean(saveDisabledReason)}
      className={cn(saveDisabledReason && "pointer-events-none")}
      onClick={handleSaveCdpConfig}
    >
      {isSavingCdpConfig ? (
        <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
      ) : (
        <Check className="size-3.5" strokeWidth={1.8} />
      )}
      保存配置
    </Button>
  )

  return (
    <>
      <div
        className={cn(
          "overflow-hidden rounded-xl border border-border bg-background-elevated shadow-[0_14px_38px_rgba(0,0,0,0.08)]",
          className
        )}
      >
        <div className="border-b border-border px-4 py-2">
          <p className="text-xs font-semibold text-foreground">{title}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p>
        </div>

        {isFullyEnabled && !isEditingCdpConfig ? (
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                <Check className="size-3" strokeWidth={2} />
              </span>
              <p className="text-xs text-foreground">
                AI 浏览器操控和 Chrome 登录数据导入已全部开启
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
              aria-label="编辑进阶自动化配置"
              title="编辑配置"
              onClick={() => setIsEditingCdpConfig(true)}
            >
              <Pencil className="size-3.5" strokeWidth={1.8} />
            </Button>
          </div>
        ) : (
          <div className="space-y-2 p-2">
            <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/50 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground">开启 Agent操控内置浏览器</p>
                <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                  开启后，才能让Agent连接并操控当前内置浏览器。
                </p>
              </div>
              <Switch
                checked={cdpConfig?.enabled ?? false}
                disabled={!cdpConfig || isSavingCdpConfig}
                onCheckedChange={handleCdpEnabledChange}
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/50 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground">开启 导入已有Chrome登陆数据</p>
                <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                  开启后，支持加载导入已有Chrome浏览器数据所需能力。
                </p>
              </div>
              <Switch
                checked={cdpConfig?.profileImportEnabled ?? false}
                disabled={!cdpConfig || isSavingCdpConfig}
                onCheckedChange={handleProfileImportEnabledChange}
              />
            </div>

            <div className="flex items-center justify-between gap-3" ref={saveButtonRef}>
              <p className="text-[11px] leading-4 text-muted-foreground">保存后需重启应用生效。</p>
              <div className="flex items-center gap-2">
                {canReturnFromEditing && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isSavingCdpConfig}
                    onClick={handleReturnFromEditing}
                  >
                    <ArrowLeft className="size-3.5" strokeWidth={1.8} />
                    返回
                  </Button>
                )}
                {saveDisabledReason ? (
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className="inline-flex cursor-not-allowed rounded-md"
                          role="button"
                          tabIndex={0}
                          aria-label={`保存配置不可用：${saveDisabledReason}`}
                        >
                          {saveButton}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        <p>{saveDisabledReason}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  saveButton
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <Dialog
        open={restartDialogOpen && !showCustomizeView}
        onOpenChange={handleRestartDialogOpenChange}
      >
        <DialogContent className="sm:max-w-md">
          {isRestartingApp ? (
            <>
              <DialogHeader>
                <DialogTitle>正在重启应用</DialogTitle>
                <DialogDescription>
                  请稍候，应用即将自动重启并应用新的内置浏览器配置。
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center justify-center py-4">
                <Loader2 className="size-6 animate-spin text-primary" strokeWidth={1.8} />
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>内置浏览器配置已保存</DialogTitle>
                <DialogDescription>新配置将在应用重启后生效。是否现在立刻重启？</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setRestartDialogOpen(false)}>
                  取消
                </Button>
                <Button onClick={handleRestartAppNow}>立刻重启</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingSwitchConfirmation !== null}
        onOpenChange={(open) => {
          if (!open) setPendingSwitchConfirmation(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {pendingSwitchConfirmation === "agent"
                ? "确认开启 Agent 操控"
                : "确认开启 Chrome 登录数据导入"}
            </DialogTitle>
            <DialogDescription>
              {pendingSwitchConfirmation === "agent" ? (
                <>
                  1. 使用 Agent 操控内置浏览器，必须使用{" "}
                  <span className="font-semibold text-amber-600 dark:text-amber-400">
                    Node.js 20 或更高版本
                  </span>
                  。请确认你的系统已满足要求。
                  <span className="mt-4 block">
                    2. 开启后会额外占用资源、内存和上下文；如果不使用，建议不要开启。
                  </span>
                </>
              ) : (
                <>
                  1. Windows 系统需要先在 Chrome 浏览器中安装浏览器插件，才能导入已有登录数据。
                  {APP_DOWNLOAD_URL ? (
                    <a
                      href={APP_DOWNLOAD_URL}
                      className="ml-2 text-primary underline underline-offset-2 hover:text-primary/80"
                      onClick={(event) => {
                        event.preventDefault()
                        void window.electron.openExternal(APP_DOWNLOAD_URL)
                      }}
                    >
                      下载浏览器插件
                    </a>
                  ) : (
                    <span className="text-purple-500">下载浏览器插件</span>
                  )}
                  请确认插件已经安装。
                  <span className="mt-4 block">
                    2. 开启后会额外占用资源、内存；如果不使用，建议不要开启。
                  </span>
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingSwitchConfirmation(null)}>
              取消
            </Button>
            <Button onClick={handleConfirmSwitch}>确认开启</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
