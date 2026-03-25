import { useCallback, useEffect, useRef, useState } from "react"
import { Shield, ShieldOff, ShieldCheck, ShieldPlus, Zap, Info, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

type SandboxMode = "none" | "unelevated" | "readonly" | "elevated"

const isWindows = navigator.userAgent.toLowerCase().includes("windows")

interface ModeOption {
  value: SandboxMode
  label: string
  description: string
  icon: React.ReactNode
}

const MODE_OPTIONS: ModeOption[] = [
  {
    value: "elevated",
    label: "强隔离沙箱",
    description: "使用独立沙箱用户 + 防火墙 + 强 ACL 隔离运行命令。首次启用需要管理员权限进行一次性配置（UAC 提示）。提供最强的隔离级别。",
    icon: <ShieldPlus className="size-4" />
  },
  {
    value: "unelevated",
    label: "受限令牌沙箱",
    description: "使用 Codex 受限令牌沙箱隔离命令执行：工作目录外文件写保护、主流网络工具软阻断（npm/pip/git/curl）。无需管理员权限，零配置。",
    icon: <Shield className="size-4" />
  },
  {
    value: "readonly",
    label: "只读沙箱",
    description: "命令可读取所有文件，普通权限下禁止写入；以管理员身份运行时允许写入工作目录。适合安全审查、代码分析等场景。",
    icon: <ShieldCheck className="size-4" />
  },
  {
    value: "none",
    label: "关闭",
    description: "不启用沙箱，命令直接在当前用户权限下执行。",
    icon: <ShieldOff className="size-4" />
  }
]

type ElevatedSetupStatus = "idle" | "checking" | "running" | "done" | "error"

export function SandboxPanel(): React.JSX.Element {
  const [mode, setMode] = useState<SandboxMode>("none")
  const [yolo, setYolo] = useState(false)
  const [loading, setLoading] = useState(true)
  const [yoloPending, setYoloPending] = useState(false)
  const [modePending, setModePending] = useState(false)
  const [elevatedSetupStatus, setElevatedSetupStatus] = useState<ElevatedSetupStatus>("idle")
  const [elevatedSetupError, setElevatedSetupError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  // Developer backdoor
  const [devMode, setDevMode] = useState(false)
  const [devPassword, setDevPassword] = useState("")
  const [unlocked, setUnlocked] = useState(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadSettings = useCallback(async () => {
    try {
      const [currentMode, currentYolo] = await Promise.all([
        window.api.sandbox.getMode(),
        window.api.sandbox.getYoloMode()
      ])
      if (mountedRef.current) {
        setMode(currentMode)
        setYolo(currentYolo)
        setLoading(false)
      }
    } catch (e) {
      console.error("[SandboxPanel] Failed to load settings:", e)
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  useEffect(() => {
    return window.api.sandbox.onChanged(() => {
      loadSettings()
    })
  }, [loadSettings])

  const handleSelectMode = useCallback(async (newMode: SandboxMode) => {
    if (newMode === mode || modePending) return

    // Elevated mode requires setup flow
    if (newMode === "elevated") {
      setModePending(true)
      setElevatedSetupError(null)

      try {
        // Step 1: Check if setup is already complete
        setElevatedSetupStatus("checking")
        const { setupComplete } = await window.api.sandbox.checkElevatedSetup()

        if (setupComplete) {
          // Setup already done, just switch mode
          await window.api.sandbox.setMode("elevated")
          // BUG 3 fix: explicitly reload to ensure mode badge updates immediately
          await loadSettings()
          if (mountedRef.current) {
            setElevatedSetupStatus("done")
            // BUG 5 fix: auto-clear done status after 3 seconds
            setTimeout(() => { if (mountedRef.current) setElevatedSetupStatus("idle") }, 3000)
          }
        } else {
          // Step 2: Run setup with UAC
          setElevatedSetupStatus("running")
          const result = await window.api.sandbox.runElevatedSetup()

          if (result.success) {
            await window.api.sandbox.setMode("elevated")
            await loadSettings()
            if (mountedRef.current) {
              setElevatedSetupStatus("done")
              setTimeout(() => { if (mountedRef.current) setElevatedSetupStatus("idle") }, 3000)
            }
          } else {
            if (mountedRef.current) {
              setElevatedSetupError(result.error || "配置失败")
              setElevatedSetupStatus("error")
            }
          }
        }
      } catch (e) {
        if (mountedRef.current) {
          setElevatedSetupError(String(e))
          setElevatedSetupStatus("error")
        }
      } finally {
        if (mountedRef.current) setModePending(false)
      }
      return
    }

    // Other modes: direct switch
    setModePending(true)
    setElevatedSetupStatus("idle")
    setElevatedSetupError(null)
    try {
      await window.api.sandbox.setMode(newMode)
    } catch (e) {
      console.error("[SandboxPanel] Failed to set mode:", e)
      loadSettings()
    } finally {
      if (mountedRef.current) setModePending(false)
    }
  }, [mode, modePending, loadSettings])

  const handleFallbackToUnelevated = useCallback(async () => {
    if (modePending) return
    setElevatedSetupStatus("idle")
    setElevatedSetupError(null)
    setModePending(true)
    try {
      await window.api.sandbox.setMode("unelevated")
      await loadSettings()
    } catch (e) {
      console.error("[SandboxPanel] Failed to fallback:", e)
      await loadSettings()
    } finally {
      if (mountedRef.current) setModePending(false)
    }
  }, [modePending, loadSettings])

  const handleToggleYolo = useCallback(async () => {
    if (yoloPending) return
    setYoloPending(true)
    try {
      await window.api.sandbox.setYoloMode(!yolo)
    } catch (e) {
      console.error("[SandboxPanel] Failed to set yolo mode:", e)
      loadSettings()
    } finally {
      if (mountedRef.current) setYoloPending(false)
    }
  }, [yolo, yoloPending, loadSettings])

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm p-8">
        加载中...
      </div>
    )
  }

  return (
    <div className="flex flex-1 overflow-hidden isolate">
      <div className="w-full flex flex-col p-6 gap-8 overflow-y-auto">

        {/* Yolo 模式 */}
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Zap className="size-5" />
            <h2 className="text-lg font-bold">YOLO 模式</h2>
          </div>

          <div className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-3 text-sm text-amber-600 dark:text-amber-400">
            <Info className="size-4 mt-0.5 shrink-0" />
            <p>开启后，Agent 执行命令时不再弹出审批确认，所有操作自动放行。适合熟悉任务内容、希望全自动运行的场景。切换后将在下一次对话中生效。</p>
          </div>

          <button
            onClick={handleToggleYolo}
            disabled={yoloPending}
            className={cn(
              "flex items-center justify-between max-w-lg rounded-lg border-2 p-4 text-left transition-colors",
              yoloPending && "opacity-60 cursor-not-allowed",
              yolo
                ? "border-amber-500 bg-amber-500/5"
                : "border-border hover:border-amber-500/40 hover:bg-muted/40"
            )}
          >
            <div className="flex items-center gap-3">
              <Zap className={cn("size-4 shrink-0", yolo ? "text-amber-500" : "text-muted-foreground")} />
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">YOLO 模式</span>
                <p className="text-xs text-muted-foreground">跳过所有命令执行审批，Agent 全自动运行</p>
              </div>
            </div>
            <div className={cn(
              "relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors",
              yolo ? "bg-amber-500" : "bg-muted-foreground/30"
            )}>
              <span className={cn(
                "inline-block size-4 rounded-full bg-white shadow transition-transform mt-0.5",
                yolo ? "translate-x-4" : "translate-x-0.5"
              )} />
            </div>
          </button>
        </div>

        {/* Windows 沙箱 */}
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Shield className="size-5" />
            <h2 className={cn("text-lg font-bold", !isWindows && "text-muted-foreground")}>Windows 沙箱</h2>
            {!isWindows && (
              <span className="text-xs text-muted-foreground">（仅 Windows 可用）</span>
            )}
            {/* Developer backdoor — anchored to header so always visible */}
            {!unlocked && isWindows && (
              <div className="ml-auto">
                {!devMode ? (
                  <button
                    className="text-xs text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                    title="开发人员专用通道：解锁后可切换受限令牌沙箱、只读沙箱等调试模式，普通用户无需使用"
                    onClick={() => setDevMode(true)}
                  >
                    开发人员通道
                  </button>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="password"
                      className="w-32 px-2 py-1 text-xs border border-border rounded-md bg-background focus:outline-none focus:border-primary"
                      placeholder="开发密码"
                      value={devPassword}
                      onChange={(e) => setDevPassword(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && devPassword === "admin123456") {
                          setUnlocked(true)
                          setDevMode(false)
                        }
                        if (e.key === "Escape") {
                          setDevMode(false)
                          setDevPassword("")
                        }
                      }}
                      autoFocus
                    />
                    <button
                      className="px-2 py-1 text-xs border border-border rounded-md hover:bg-muted transition-colors"
                      onClick={() => {
                        if (devPassword === "admin123456") {
                          setUnlocked(true)
                          setDevMode(false)
                        }
                      }}
                    >
                      确认
                    </button>
                    <button
                      className="px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => { setDevMode(false); setDevPassword("") }}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {isWindows ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-400">
                <Info className="size-4 mt-0.5 shrink-0" />
                <p>根据公司安全管控要求，Agent 执行命令须在隔离环境中运行，<strong>非经审批不得关闭或降级沙箱模式</strong>。日常开发请保持使用<strong>强隔离沙箱</strong>，其他模式仅限经授权的开发人员在调试场景下使用。</p>
              </div>
              {unlocked && (
                <div className="flex items-start gap-2 rounded-md border border-blue-500/20 bg-blue-500/5 p-3 text-sm text-blue-600 dark:text-blue-400">
                  <Info className="size-4 mt-0.5 shrink-0" />
                  <p>切换沙箱模式后，将在下一次对话中生效。</p>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-md border border-muted bg-muted/30 p-3 text-sm text-muted-foreground">
              <Info className="size-4 mt-0.5 shrink-0" />
              <p>Windows 沙箱仅在 Windows 平台上可用，当前平台不支持此功能。</p>
            </div>
          )}

          <div className={cn("flex flex-col gap-3 max-w-lg", !isWindows && "opacity-40")}>
            {MODE_OPTIONS.map((opt) => {
              const isRestricted = opt.value !== "elevated" && opt.value !== "unelevated" && !unlocked
              const isDisabled = !isWindows || modePending || isRestricted
              return (
                <div key={opt.value} className="relative">
                  <button
                    onClick={() => handleSelectMode(opt.value)}
                    disabled={isDisabled}
                    className={cn(
                      "flex items-start gap-3 rounded-lg border-2 p-4 text-left transition-colors w-full",
                      isDisabled && "opacity-50 cursor-not-allowed",
                      !isDisabled && modePending && "opacity-60 cursor-not-allowed",
                      mode === opt.value
                        ? "border-primary bg-primary/5"
                        : isDisabled
                          ? "border-border"
                          : "border-border hover:border-primary/40 hover:bg-muted/40"
                    )}
                  >
                    <div className={cn(
                      "mt-0.5 shrink-0",
                      mode === opt.value ? "text-primary" : "text-muted-foreground"
                    )}>
                      {opt.icon}
                    </div>
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{opt.label}</span>
                        {mode === opt.value && (
                          <span className="text-xs rounded-full bg-primary/10 text-primary px-2 py-0.5">
                            当前
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {opt.description}
                      </p>
                      {isRestricted && (
                        <p className="text-xs text-amber-500 mt-0.5">如需选择请联系开发人员</p>
                      )}
                    </div>
                  </button>
                </div>
              )
            })}

          </div>

          {/* Elevated setup status */}
          {elevatedSetupStatus === "checking" && (
            <div className="flex items-center gap-2 max-w-lg rounded-md border border-blue-500/20 bg-blue-500/5 p-3 text-sm text-blue-600 dark:text-blue-400">
              <Loader2 className="size-4 shrink-0 animate-spin" />
              <p>正在检查沙箱配置状态...</p>
            </div>
          )}

          {elevatedSetupStatus === "running" && (
            <div className="flex items-center gap-2 max-w-lg rounded-md border border-blue-500/20 bg-blue-500/5 p-3 text-sm text-blue-600 dark:text-blue-400">
              <Loader2 className="size-4 shrink-0 animate-spin" />
              <p>正在进行一次性安全配置，请在 UAC 提示中确认管理员权限...</p>
            </div>
          )}

          {elevatedSetupStatus === "done" && (
            <div className="flex items-center gap-2 max-w-lg rounded-md border border-green-500/20 bg-green-500/5 p-3 text-sm text-green-600 dark:text-green-400">
              <ShieldCheck className="size-4 shrink-0" />
              <p>强隔离沙箱配置完成，将在下一次对话中生效。</p>
            </div>
          )}

          {elevatedSetupStatus === "error" && elevatedSetupError && (
            <div className="flex flex-col gap-2 max-w-lg rounded-md border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-600 dark:text-red-400">
              <div className="flex items-start gap-2">
                <Info className="size-4 mt-0.5 shrink-0" />
                <p>{elevatedSetupError}</p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => { setElevatedSetupStatus("idle"); setElevatedSetupError(null) }}
                  className="self-start rounded-md border border-red-500/30 px-3 py-1.5 text-xs hover:bg-red-500/10 transition-colors"
                >
                  重试
                </button>
                {unlocked && (
                  <button
                    onClick={handleFallbackToUnelevated}
                    className="self-start rounded-md border border-red-500/30 px-3 py-1.5 text-xs hover:bg-red-500/10 transition-colors"
                  >
                    回退到受限令牌沙箱
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  )
}
