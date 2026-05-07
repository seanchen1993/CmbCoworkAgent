import { useState, useEffect, useCallback, useRef } from "react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

type UpdateStage = "idle" | "available" | "downloading" | "downloaded" | "installing" | "error"

interface UpdateInfo {
  version: string
  updateType: string
  releaseNotes: string
  size: number
  mandatory: boolean
}

interface DownloadProgress {
  percent: number
  transferred: number
  total: number
  speed: string
  phase: "downloading" | "verifying" | "extracting"
  message: string
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function getProgressTitle(progress: DownloadProgress | null, version?: string): string {
  if (progress?.phase === "verifying") {
    return version ? `正在校验 v${version}` : "正在校验更新..."
  }
  if (progress?.phase === "extracting") {
    return version ? `正在解压 v${version}` : "正在解压更新..."
  }
  return version ? `正在下载 v${version}` : "正在下载更新..."
}

function getProgressDescription(progress: DownloadProgress | null): string {
  if (progress?.phase === "verifying") return "下载已完成，正在校验文件完整性"
  if (progress?.phase === "extracting") return "下载已完成，正在解压更新文件"
  return "下载完成后将提示您重启应用"
}

export function UpdateDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const [stage, setStage] = useState<UpdateStage>("idle")
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [errorMsg, setErrorMsg] = useState("")
  const [checking, setChecking] = useState(false)

  // Show post-update success toast once on first mount
  const startupChecked = useRef(false)
  useEffect(() => {
    if (startupChecked.current) return
    startupChecked.current = true
    window.api.update
      .getStartupResult()
      .then((r) => {
        if (r.updatedTo) {
          toast.success(`已成功更新到 v${r.updatedTo}`, { duration: 5000 })
        }
      })
      .catch(() => {
        /* ignore */
      })
  }, [])

  // Listen for main process push events
  useEffect(() => {
    const api = window.api.update

    // On mount, pull current status in case update was detected before renderer loaded
    api
      .getStatus()
      .then((s) => {
        if (s.status === "available" && s.update) {
          setUpdateInfo(s.update)
          setStage("available")
          onOpenChange(true)
        } else if (s.status === "downloading" && s.update) {
          // Background download already in progress — only show if dialog is manually opened
          setUpdateInfo(s.update)
          setProgress(s.progress)
          setStage("downloading")
        } else if (s.status === "downloaded" && s.update) {
          setUpdateInfo(s.update)
          setProgress(null)
          setStage("downloaded")
          onOpenChange(true)
        } else if (s.status === "error" && s.update) {
          setUpdateInfo(s.update)
          setProgress(null)
          setErrorMsg(s.errorMessage ?? "更新失败")
          setStage("error")
          onOpenChange(true)
        }
      })
      .catch(() => {
        /* ignore */
      })

    const removeAvailable = api.onAvailable((info) => {
      setUpdateInfo(info)
      if ((info as UpdateInfo & { autoDownloading?: boolean }).autoDownloading) {
        // Background download started automatically — don't interrupt user
        setStage("downloading")
      } else {
        // Manual check — show available dialog
        setStage("available")
        onOpenChange(true)
      }
    })

    const removeProgress = api.onProgress((p) => {
      setProgress(p)
    })

    const removeDownloaded = api.onDownloaded((info) => {
      setUpdateInfo((prev) =>
        prev
          ? { ...prev, ...info }
          : {
              version: info.version,
              updateType: info.updateType,
              releaseNotes: info.releaseNotes ?? "",
              size: info.size ?? 0,
              mandatory: info.mandatory ?? false
            }
      )
      setProgress(null)
      setStage("downloaded")
      onOpenChange(true) // always pop up when download completes
    })

    const removeError = api.onError((err) => {
      setProgress(null)
      setErrorMsg(err.message)
      setStage("error")
      onOpenChange(true)
    })

    return () => {
      removeAvailable()
      removeProgress()
      removeDownloaded()
      removeError()
    }
  }, [onOpenChange])

  const handleCheck = useCallback(async () => {
    setChecking(true)
    setErrorMsg("")
    try {
      const result = await window.api.update.check()
      if (result.hasUpdate) {
        setUpdateInfo({
          version: result.version,
          updateType: result.updateType,
          releaseNotes: result.releaseNotes,
          size: result.size,
          mandatory: result.mandatory
        })
        // Restore the correct stage based on what main process reports
        const status = (result as { currentStatus?: string }).currentStatus
        const currentProgress = (result as { currentProgress?: DownloadProgress | null })
          .currentProgress
        const currentError = (result as { currentError?: string | null }).currentError
        if (status === "downloading") {
          setProgress(currentProgress ?? null)
          setStage("downloading")
        } else if (status === "downloaded") {
          setProgress(null)
          setStage("downloaded")
        } else if (status === "error") {
          setProgress(null)
          setErrorMsg(currentError ?? "更新失败")
          setStage("error")
        } else {
          setStage("available")
        }
      } else {
        setUpdateInfo(null)
        setStage("idle")
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "检查更新失败")
      setStage("error")
    } finally {
      setChecking(false)
    }
  }, [])

  const handleDownload = useCallback(async () => {
    setStage((prev) => {
      // If already downloading in background, don't reset progress
      if (prev === "downloading") return prev
      setProgress(null)
      return "downloading"
    })
    try {
      await window.api.update.download()
    } catch {
      // Error handled via onError event
    }
  }, [])

  const handleInstall = useCallback(async () => {
    setStage("installing")
    // Give renderer time to show the installing state before app quits
    await new Promise((r) => setTimeout(r, 800))
    try {
      await window.api.update.install()
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "安装失败")
      setStage("error")
    }
  }, [])

  const handleDismiss = useCallback(() => {
    window.api.update.dismiss()
    setStage("idle")
    setUpdateInfo(null)
    setProgress(null)
    onOpenChange(false)
  }, [onOpenChange])

  const handleHideDownloading = useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])

  const handleRetry = useCallback(() => {
    setErrorMsg("")
    if (updateInfo) {
      setStage("available")
    } else {
      setStage("idle")
      handleCheck()
    }
  }, [updateInfo, handleCheck])

  // Auto-check when dialog opens manually and nothing is happening
  useEffect(() => {
    if (open && stage === "idle" && !updateInfo) {
      handleCheck()
    }
  }, [open, stage, updateInfo, handleCheck])

  const isMandatory = updateInfo?.mandatory ?? false

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && stage === "installing") return
        if (!v && stage === "downloading") {
          handleHideDownloading()
          return
        }
        if (!v && isMandatory && stage !== "downloaded") return
        if (!v) handleDismiss()
        else onOpenChange(v)
      }}
    >
      <DialogContent className="sm:max-w-md">
        {/* idle / checking */}
        {stage === "idle" && (
          <>
            <DialogHeader>
              <DialogTitle>检查更新</DialogTitle>
              <DialogDescription>
                {checking ? "正在检查更新..." : "当前已是最新版本"}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                关闭
              </Button>
              <Button onClick={handleCheck} disabled={checking}>
                {checking ? "检查中..." : "重新检查"}
              </Button>
            </DialogFooter>
          </>
        )}

        {/* update available — only shown for manual check */}
        {stage === "available" && updateInfo && (
          <>
            <DialogHeader>
              <DialogTitle>发现新版本 v{updateInfo.version}</DialogTitle>
              <DialogDescription>
                {updateInfo.updateType === "asar"
                  ? "轻量更新（仅替换业务代码，无需重新安装）"
                  : "完整更新（需要重新安装应用文件）"}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              <div className="text-sm text-muted-foreground">
                <div className="font-medium text-foreground mb-1">更新内容：</div>
                <div className="whitespace-pre-line bg-muted/50 rounded-md p-3 max-h-40 overflow-y-auto">
                  {updateInfo.releaseNotes}
                </div>
              </div>
              {updateInfo.size > 0 && (
                <div className="text-xs text-muted-foreground">
                  下载大小：约 {formatSize(updateInfo.size)}
                </div>
              )}
            </div>

            <DialogFooter>
              {!isMandatory && (
                <Button variant="outline" onClick={handleDismiss}>
                  稍后提醒
                </Button>
              )}
              <Button onClick={handleDownload}>立即下载</Button>
            </DialogFooter>
          </>
        )}

        {/* downloading — background or manual */}
        {stage === "downloading" && (
          <>
            <DialogHeader>
              <DialogTitle>{getProgressTitle(progress, updateInfo?.version)}</DialogTitle>
              <DialogDescription>{getProgressDescription(progress)}</DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              <div className="w-full bg-muted rounded-full h-2.5 overflow-hidden">
                <div
                  className="bg-primary h-full rounded-full transition-all duration-300"
                  style={{ width: `${progress?.percent ?? 0}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>
                  {progress?.phase === "downloading" && progress
                    ? `${formatSize(progress.transferred)} / ${formatSize(progress.total)}`
                    : (progress?.message ?? "准备下载...")}
                </span>
                <span>
                  {progress
                    ? progress.phase === "downloading"
                      ? `${progress.speed}  ${progress.percent}%`
                      : "处理中..."
                    : ""}
                </span>
              </div>
            </div>

            {!isMandatory && (
              <DialogFooter>
                <Button variant="outline" onClick={handleHideDownloading}>
                  后台下载
                </Button>
              </DialogFooter>
            )}
          </>
        )}

        {/* downloaded, ready to install */}
        {stage === "downloaded" && updateInfo && (
          <>
            <DialogHeader>
              <DialogTitle>v{updateInfo.version} 已就绪</DialogTitle>
              <DialogDescription>
                新版本已下载完成，重启应用即可完成更新。请先保存当前工作。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              {!isMandatory && (
                <Button variant="outline" onClick={handleDismiss}>
                  稍后重启
                </Button>
              )}
              <Button onClick={handleInstall}>立即重启</Button>
            </DialogFooter>
          </>
        )}

        {/* installing */}
        {stage === "installing" && (
          <>
            <DialogHeader>
              <DialogTitle>正在安装更新</DialogTitle>
              <DialogDescription>请稍候，应用即将自动重启...</DialogDescription>
            </DialogHeader>
            <div className="flex items-center justify-center py-4">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            </div>
          </>
        )}

        {/* error */}
        {stage === "error" && (
          <>
            <DialogHeader>
              <DialogTitle>更新失败</DialogTitle>
              <DialogDescription>{errorMsg || "未知错误"}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setStage("idle")
                  onOpenChange(false)
                }}
              >
                关闭
              </Button>
              <Button onClick={handleRetry}>重试</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
