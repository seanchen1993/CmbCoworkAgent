import { useCallback, useEffect, useRef, useState } from "react"
import { Check, Loader2 } from "lucide-react"
import { toast } from "sonner"
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
  const [cdpConfig, setCdpConfig] = useState<BrowserCdpConfig | null>(null)
  const [isSavingCdpConfig, setIsSavingCdpConfig] = useState(false)
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
      })
      .catch((error) => {
        console.error(
          `${BROWSER_CDP_CONFIG_LOG_PREFIX} Failed to load Browser CDP config: ${formatError(error)}`
        )
        if (cancelled) return
        setCdpConfig({
          enabled: false,
          profileImportEnabled: false
        })
        toast.error("读取内置浏览器配置失败，已禁用 Agent 控制")
      })

    return () => {
      cancelled = true
    }
  }, [])

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
    if (!cdpConfig) return

    setIsSavingCdpConfig(true)
    try {
      const saved = await window.api.browser.saveCdpConfig({
        enabled: cdpConfig.enabled,
        profileImportEnabled: cdpConfig.profileImportEnabled
      })
      setCdpConfig(saved)
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
  }, [cdpConfig])

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

  return (
    <>
      <div
        className={cn(
          "overflow-hidden rounded-xl border border-border bg-background-elevated shadow-[0_14px_38px_rgba(0,0,0,0.16)]",
          className
        )}
      >
        <div className="border-b border-border px-4 py-2">
          <p className="text-xs font-semibold text-foreground">{title}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p>
        </div>

        <div className="space-y-2 p-2">
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-background-interactive px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-xs font-medium text-foreground">
                开启 Agent操控内置浏览器
                {/*（{cdpConfig?.enabled ? "已启用" : "未启用"}）*/}
              </p>
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

          <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-background-interactive px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-xs font-medium text-foreground">
                开启 导入已有Chrome登陆数据
                {/*（{cdpConfig?.profileImportEnabled ? "已启用" : "未启用"}）*/}
              </p>
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
            <Button
              type="button"
              size="sm"
              disabled={!cdpConfig || isSavingCdpConfig}
              onClick={handleSaveCdpConfig}
            >
              {isSavingCdpConfig ? (
                <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
              ) : (
                <Check className="size-3.5" strokeWidth={1.8} />
              )}
              保存配置
            </Button>
          </div>
        </div>
      </div>

      <Dialog open={restartDialogOpen} onOpenChange={handleRestartDialogOpenChange}>
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
