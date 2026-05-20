import React, { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Settings,
  Trash2,
  Webhook,
  Wrench
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

type GitHookStatus = Awaited<ReturnType<typeof window.api.workspace.getGitHookStatus>>
type GitHookState = GitHookStatus["state"]

interface GitHookSettingsButtonProps {
  workspacePath?: string | null
}

function getStatusLabel(state: GitHookState): string {
  switch (state) {
    case "installed":
      return "已安装"
    case "outdated":
      return "需升级"
    case "partial":
      return "未完整"
    case "modified":
      return "需修复"
    case "error":
      return "检测失败"
    case "not_git":
      return "非 Git 仓库"
    default:
      return "未安装"
  }
}

function getStatusTone(state: GitHookState): string {
  if (state === "installed") {
    return "border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
  }
  if (state === "error" || state === "modified") {
    return "border-red-500/40 text-red-700 dark:text-red-300"
  }
  return "border-amber-500/45 text-amber-700 dark:text-amber-300"
}

function getPromptLabel(state: GitHookState): string | null {
  if (state === "not_installed") return "Git Hook 未安装"
  if (state === "partial" || state === "outdated" || state === "modified") return "Git Hook 需修复"
  if (state === "error") return "Git Hook 检测失败"
  return null
}

export function GitHookSettingsButton({
  workspacePath
}: GitHookSettingsButtonProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<GitHookStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [action, setAction] = useState<"install" | "uninstall" | null>(null)

  const refreshStatus = useCallback(async (): Promise<void> => {
    if (!workspacePath) {
      setStatus(null)
      return
    }
    setLoading(true)
    try {
      const next = await window.api.workspace.getGitHookStatus(workspacePath)
      setStatus(next)
    } catch (e) {
      setStatus({
        state: "error",
        installed: false,
        canInstall: false,
        version: 0,
        hooks: [],
        message: "Git Hook 检测失败",
        error: e instanceof Error ? e.message : "Git Hook 检测失败"
      })
    } finally {
      setLoading(false)
    }
  }, [workspacePath])

  useEffect(() => {
    setStatus(null)
    void refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    if (open) void refreshStatus()
  }, [open, refreshStatus])

  const state = status?.state ?? "not_installed"
  const promptLabel = useMemo(() => getPromptLabel(state), [state])
  const canInstall = status?.canInstall !== false && state !== "not_git"
  const showButton = Boolean(workspacePath) && status !== null && state !== "not_git"

  const installOrRepair = useCallback(async (): Promise<void> => {
    if (!workspacePath) return
    setAction("install")
    try {
      const next = await window.api.workspace.installGitHooks(workspacePath)
      setStatus(next)
      if (next.state !== "installed") {
        throw new Error(next.error || next.message || "Git Hook 安装未完成")
      }
      toast.success("Git Hook 已安装")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Git Hook 安装失败")
      void refreshStatus()
    } finally {
      setAction(null)
    }
  }, [workspacePath, refreshStatus])

  const uninstall = useCallback(async (): Promise<void> => {
    if (!workspacePath) return
    setAction("uninstall")
    try {
      const next = await window.api.workspace.uninstallGitHooks(workspacePath)
      setStatus(next)
      toast.success("Git Hook 已卸载")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Git Hook 卸载失败")
      void refreshStatus()
    } finally {
      setAction(null)
    }
  }, [workspacePath, refreshStatus])

  if (!showButton) return null

  return (
    <>
      <div className="flex items-center gap-1.5">
        {promptLabel && (
          <span
            className={cn(
              "hidden sm:inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium whitespace-nowrap",
              getStatusTone(state)
            )}
            title={status?.message || promptLabel}
          >
            {promptLabel}
          </span>
        )}
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setOpen(true)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium transition-colors",
                  "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                )}
                aria-label="DevClaw Git Hook 配置"
              >
                {loading ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Settings className="size-3" />
                )}
                <span className="hidden md:inline">配置</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              <p>DevClaw Git Hook 配置</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[560px] gap-0 p-0">
          <DialogHeader className="border-b border-border px-5 py-4">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Webhook className="size-4 text-muted-foreground" />
              DevClaw Git Hook
            </DialogTitle>
            <DialogDescription className="leading-5">
              安装后，通过 IDEA、命令行等 DevClaw 外部方式提交代码，也可以计算代码采纳率。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                {state === "installed" ? (
                  <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
                ) : state === "error" ? (
                  <AlertCircle className="size-4 shrink-0 text-red-600" />
                ) : (
                  <AlertCircle className="size-4 shrink-0 text-amber-600" />
                )}
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">当前状态</span>
                    <Badge
                      variant="outline"
                      className={cn("h-5 px-2 text-[10px]", getStatusTone(state))}
                    >
                      {loading ? "检测中" : getStatusLabel(state)}
                    </Badge>
                  </div>
                  <p
                    className="mt-1 truncate text-xs text-muted-foreground"
                    title={status?.gitRoot || workspacePath || ""}
                  >
                    {status?.gitRoot || workspacePath}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  void refreshStatus()
                }}
                disabled={loading || action !== null}
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="刷新 Git Hook 状态"
                title="刷新"
              >
                <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
              </button>
            </div>

            <div className="divide-y divide-border rounded-md border border-border">
              {status?.hooks.map((hook) => (
                <div key={hook.hook} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="font-mono text-xs font-medium text-foreground">{hook.hook}</div>
                    <div
                      className="mt-0.5 truncate text-[11px] text-muted-foreground"
                      title={hook.path}
                    >
                      {hook.path}
                    </div>
                  </div>
                  <Badge
                    variant="outline"
                    className={cn(
                      "h-5 shrink-0 px-2 text-[10px]",
                      getStatusTone(hook.state === "managed" ? "installed" : state)
                    )}
                  >
                    {hook.state === "managed"
                      ? "已安装"
                      : hook.state === "user"
                        ? "已有 Hook"
                        : getStatusLabel(state)}
                  </Badge>
                </div>
              ))}
              {(!status || status.hooks.length === 0) && (
                <div className="px-3 py-3 text-xs text-muted-foreground">
                  {loading ? "正在检测 Git Hook..." : "未检测到可配置的 Git Hook。"}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2">
              {state === "installed" ? (
                <button
                  type="button"
                  onClick={() => {
                    void uninstall()
                  }}
                  disabled={action !== null || loading}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {action === "uninstall" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="size-3.5" />
                  )}
                  卸载
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    void installOrRepair()
                  }}
                  disabled={!canInstall || action !== null || loading}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-foreground px-3 text-xs text-background transition-colors hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {action === "install" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Wrench className="size-3.5" />
                  )}
                  {state === "not_installed" ? "安装" : "修复"}
                </button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
