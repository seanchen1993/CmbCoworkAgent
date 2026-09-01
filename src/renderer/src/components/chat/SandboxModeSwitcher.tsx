import { memo, useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react"
import {
  Check,
  ChevronDown,
  Loader2,
  Shield,
  ShieldCheck,
  ShieldOff,
  ShieldPlus
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

type SandboxMode = "none" | "unelevated" | "readonly" | "elevated"

interface SandboxModeOption {
  value: SandboxMode
  label: string
  shortLabel: string
  description: string
  riskLabel: string
  icon: typeof Shield
}

interface SandboxModeSwitcherProps {
  onOpenSettings?: () => void
}

function isWindowsPlatform(): boolean {
  return typeof window !== "undefined" && window.electron?.process?.platform === "win32"
}

const SANDBOX_MODE_OPTIONS: SandboxModeOption[] = [
  {
    value: "none",
    label: "无沙箱",
    shortLabel: "无沙箱",
    description: "命令不经过沙箱隔离，直接使用当前用户权限执行。",
    riskLabel: "风险较高",
    icon: ShieldOff
  },
  {
    value: "unelevated",
    label: "受限令牌沙箱",
    shortLabel: "受限沙箱",
    description: "工作区外写保护，常见网络命令软阻断，无需管理员配置。",
    riskLabel: "推荐",
    icon: Shield
  },
  {
    value: "readonly",
    label: "只读沙箱",
    shortLabel: "只读沙箱",
    description: "命令可读取所有文件；普通权限下禁止写入，管理员运行时允许写入工作目录。",
    riskLabel: "受限",
    icon: ShieldCheck
  },
  {
    value: "elevated",
    label: "强隔离沙箱",
    shortLabel: "强隔离",
    description: "独立沙箱用户 + 防火墙 + ACL 隔离，首次启用需管理员配置。",
    riskLabel: "最强隔离",
    icon: ShieldPlus
  }
]

function isSandboxMode(value: unknown): value is SandboxMode {
  return SANDBOX_MODE_OPTIONS.some((option) => option.value === value)
}

function getModeOption(mode: SandboxMode | null): SandboxModeOption | null {
  if (!mode) return null
  return SANDBOX_MODE_OPTIONS.find((option) => option.value === mode) ?? null
}

const QUICK_SWITCH_MODES = SANDBOX_MODE_OPTIONS.filter((option) => option.value !== "readonly")

function getTriggerTone(mode: SandboxMode | null): string {
  if (!mode) return "text-muted-foreground hover:bg-muted/60"
  if (mode === "none") {
    return "text-orange-600 hover:bg-orange-500/10 dark:text-orange-300"
  }
  if (mode === "elevated") {
    return "text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-300"
  }
  return "text-sky-600 hover:bg-sky-500/10 dark:text-sky-300"
}

function getIconTone(mode: SandboxMode | null): string {
  if (!mode) return "text-muted-foreground"
  if (mode === "none") return "text-orange-500"
  if (mode === "elevated") return "text-emerald-500"
  return "text-sky-500"
}

function getRiskBadgeTone(option: SandboxModeOption): string {
  if (option.value === "none") {
    return "border-orange-300 bg-orange-500/15 text-orange-700 dark:border-orange-500/40 dark:bg-orange-500/15 dark:text-orange-300"
  }
  if (option.value === "elevated") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
  }
  return "border-border bg-background text-muted-foreground"
}

function getSelectedOptionTone(option: SandboxModeOption): string {
  if (option.value === "none") {
    return "border-orange-200 bg-orange-50/80 text-foreground shadow-sm dark:border-orange-500/30 dark:bg-orange-500/10"
  }
  if (option.value === "elevated") {
    return "border-emerald-200 bg-emerald-50/80 text-foreground shadow-sm dark:border-emerald-500/30 dark:bg-emerald-500/10"
  }
  return "border-sky-200 bg-sky-50/80 text-foreground shadow-sm dark:border-sky-500/30 dark:bg-sky-500/10"
}

function getOptionIconTone(option: SandboxModeOption): string {
  if (option.value === "none") {
    return "bg-orange-100 text-orange-600 dark:bg-orange-500/15 dark:text-orange-300"
  }
  if (option.value === "elevated") {
    return "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300"
  }
  return "bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300"
}

export const SandboxModeSwitcher = memo(SandboxModeSwitcherImpl)

function SandboxModeSwitcherImpl({
  onOpenSettings
}: SandboxModeSwitcherProps): JSX.Element | null {
  if (!isWindowsPlatform()) {
    return null
  }

  return (
    <>
      <div aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
      <SandboxModeSwitcherContent onOpenSettings={onOpenSettings} />
    </>
  )
}

function SandboxModeSwitcherContent({ onOpenSettings }: SandboxModeSwitcherProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<SandboxMode | null>(null)
  const [loading, setLoading] = useState(true)
  const [modeLoadFailed, setModeLoadFailed] = useState(false)
  const [pendingMode, setPendingMode] = useState<SandboxMode | null>(null)
  const mountedRef = useRef(true)
  const loadRequestIdRef = useRef(0)

  const displayMode = modeLoadFailed ? null : mode
  const activeOption = useMemo(
    () => (displayMode ? getModeOption(displayMode) : null),
    [displayMode]
  )
  const ActiveIcon = activeOption?.icon ?? ShieldOff
  const triggerLabel = loading
    ? "加载中"
    : (activeOption?.label ?? (modeLoadFailed ? "读取失败" : "未知"))
  const loadMode = useCallback(async (options?: { silent?: boolean }) => {
    const requestId = loadRequestIdRef.current + 1
    loadRequestIdRef.current = requestId
    if (!options?.silent) setLoading(true)
    setModeLoadFailed(false)
    try {
      const nextMode = await window.api.sandbox.getMode()
      if (!mountedRef.current || requestId !== loadRequestIdRef.current) return
      if (!isSandboxMode(nextMode)) {
        console.warn("[SandboxModeSwitcher] Unknown sandbox mode:", nextMode)
        setMode(null)
        return
      }
      setMode(nextMode)
    } catch (error) {
      console.error("[SandboxModeSwitcher] Failed to load sandbox mode:", error)
      if (!mountedRef.current || requestId !== loadRequestIdRef.current) return
      setModeLoadFailed(true)
    } finally {
      if (mountedRef.current && requestId === loadRequestIdRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    void loadMode()
  }, [loadMode])

  useEffect(() => {
    return window.api.sandbox.onChanged(() => {
      void loadMode({ silent: true })
    })
  }, [loadMode])

  const handleSelectMode = useCallback(
    async (nextMode: SandboxMode) => {
      if (!isWindowsPlatform()) {
        toast.info("Windows 沙箱仅在 Windows 平台可用")
        return
      }
      if (loading) {
        toast.info("正在读取沙箱模式，请稍后再试")
        return
      }
      if (pendingMode) {
        setOpen(false)
        return
      }
      if (nextMode === mode) {
        setOpen(false)
        return
      }
      if (modeLoadFailed) {
        toast.error("沙箱模式读取失败，请打开完整沙箱设置检查")
        onOpenSettings?.()
        setOpen(false)
        return
      }
      setPendingMode(nextMode)
      try {
        if (nextMode === "elevated") {
          const { setupComplete } = await window.api.sandbox.checkElevatedSetup()
          if (!setupComplete) {
            if (mountedRef.current) toast.info("正在配置强隔离沙箱，可能需要管理员授权")
            const result = await window.api.sandbox.runElevatedSetup()
            if (!result.success) {
              if (mountedRef.current) {
                toast.error(result.error || "强隔离沙箱配置失败")
                onOpenSettings?.()
                setOpen(false)
              }
              return
            }
            if (mountedRef.current) toast.success("强隔离沙箱配置完成")
          }
        }

        await window.api.sandbox.setMode(nextMode)
        if (!mountedRef.current) return
        setMode(nextMode)
        setOpen(false)
        toast.success(`${getModeOption(nextMode)?.label ?? "沙箱模式"}已设置，将在下一次对话中生效`)
      } catch (error) {
        if (!mountedRef.current) return
        toast.error(`沙箱模式切换失败：${error instanceof Error ? error.message : String(error)}`)
        void loadMode()
      } finally {
        if (mountedRef.current) setPendingMode(null)
      }
    },
    [loadMode, loading, mode, modeLoadFailed, onOpenSettings, pendingMode]
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title={`全局沙箱权限：${triggerLabel}`}
          aria-label={`全局沙箱权限：${triggerLabel}`}
          className={cn(
            "h-8 gap-1.5 rounded-md px-1.5 text-xs transition-colors",
            getTriggerTone(displayMode)
          )}
        >
          <span className={cn("grid size-5 place-items-center", getIconTone(displayMode))}>
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : !activeOption ? (
              <ShieldOff className="size-3.5" />
            ) : (
              <ActiveIcon className="size-3.5" />
            )}
          </span>
          <span className="font-medium">
            {loading
              ? "权限"
              : (activeOption?.shortLabel ?? (modeLoadFailed ? "读取失败" : "权限未知"))}
          </span>
          <ChevronDown className="size-3 opacity-70" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[440px] max-w-[calc(100vw-32px)] overflow-hidden border-border bg-background p-0 shadow-xl"
        align="start"
        sideOffset={8}
      >
        <div className="border-b border-border bg-gradient-to-br from-muted/80 via-background to-sky-50/60 px-4 py-3 dark:to-sky-500/10">
          <div className="flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-xl bg-foreground text-background shadow-sm">
              <Shield className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground">执行权限</div>
              <div className="text-xs leading-5 text-muted-foreground">
                控制命令是否通过 Windows 沙箱隔离运行。
              </div>
            </div>
          </div>
        </div>

        <div className="mx-2 mt-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-[11px] leading-5 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300">
          这是全局沙箱设置，会影响后续会话；当前已创建的运行不会中途换权限。
        </div>

        {modeLoadFailed && (
          <div className="mx-2 mt-2 flex items-start justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            <span>
              当前沙箱模式读取失败。为避免误判权限，快捷切换已暂停，请重试或打开完整沙箱设置检查。
            </span>
            <button
              type="button"
              onClick={() => {
                void loadMode()
              }}
              className="shrink-0 font-medium text-amber-900 underline-offset-2 hover:underline dark:text-amber-100"
            >
              重试
            </button>
          </div>
        )}

        <div className="space-y-1 p-2">
          {QUICK_SWITCH_MODES.map((option) => {
            const selected = option.value === displayMode
            const disabled = loading || modeLoadFailed || Boolean(pendingMode)
            const Icon = option.icon
            return (
              <button
                key={option.value}
                type="button"
                disabled={disabled}
                onClick={() => {
                  void handleSelectMode(option.value)
                }}
                className={cn(
                  "group flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-all",
                  selected
                    ? getSelectedOptionTone(option)
                    : "border-transparent text-muted-foreground hover:border-border hover:bg-muted/50 hover:text-foreground",
                  disabled && "cursor-not-allowed opacity-60"
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl transition-colors",
                    getOptionIconTone(option)
                  )}
                >
                  {pendingMode === option.value ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Icon className="size-4" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{option.label}</span>
                    <span
                      className={cn(
                        "rounded-full border px-1.5 py-0.5 text-[10px] leading-none",
                        getRiskBadgeTone(option)
                      )}
                    >
                      {option.riskLabel}
                    </span>
                  </span>
                  <span className="mt-1 block text-[11px] leading-5 text-muted-foreground">
                    {option.description}
                  </span>
                </span>
                {selected && (
                  <span className="mt-1 grid size-5 shrink-0 place-items-center rounded-full bg-foreground text-background">
                    <Check className="size-3.5" />
                  </span>
                )}
              </button>
            )
          })}
          {displayMode === "readonly" && (
            <div className="flex items-start gap-3 rounded-xl border border-dashed border-amber-200/70 p-3 text-left text-muted-foreground dark:border-amber-500/25">
              <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300">
                <ShieldCheck className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-semibold">只读沙箱</span>
                  <span className="rounded-full border border-foreground/15 bg-foreground px-1.5 py-0.5 text-[10px] leading-none text-background">
                    当前
                  </span>
                  <span className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] leading-none text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                    开发人员通道
                  </span>
                </span>
                <span className="mt-1 block text-[11px] leading-5 text-muted-foreground">
                  只读沙箱需在完整设置页通过开发人员通道管理。
                </span>
              </span>
            </div>
          )}
        </div>

        <div className="border-t border-border px-3 py-2">
          <button
            type="button"
            onClick={() => {
              onOpenSettings?.()
              setOpen(false)
            }}
            className="text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            打开完整沙箱设置
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
