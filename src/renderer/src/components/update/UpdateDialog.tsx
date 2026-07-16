import { useState, useEffect, useCallback, useRef, type ReactElement } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"
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
import { normalizeReleaseNotesForDisplay, sanitizeReleaseNotesUrl } from "./release-notes"

type UpdateStage = "idle" | "available" | "downloading" | "downloaded" | "installing" | "error"

interface UpdateInfo {
  version: string
  targetVersion: string
  updateType: string
  releaseNotes: string
  size: number
  mandatory: boolean
}

interface UpdateSourceInfo {
  channel: "production" | "selftest"
  baseUrl: string
  manifestFile: string
  configPath?: string
  expiresAt?: string
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

const releaseNotesMarkdownComponents: Components = {
  h1: ({ children }) => (
    <h3 className="mb-2 text-base font-semibold text-foreground">{children}</h3>
  ),
  h2: ({ children }) => <h4 className="mb-2 text-sm font-semibold text-foreground">{children}</h4>,
  h3: ({ children }) => (
    <h5 className="mb-1.5 text-sm font-semibold text-foreground">{children}</h5>
  ),
  p: ({ children }) => <p className="my-1.5 leading-6 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1 pl-5 marker:text-primary">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1 pl-5 marker:font-medium marker:text-primary">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-1 leading-6">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-primary/50 pl-3 italic">{children}</blockquote>
  ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md bg-background/80 p-3 text-xs text-foreground">
      {children}
    </pre>
  ),
  code: ({ children, className }) =>
    className ? (
      <code className={`${className} font-mono`}>{children}</code>
    ) : (
      <code className="rounded bg-background/80 px-1 py-0.5 font-mono text-[0.85em] text-foreground">
        {children}
      </code>
    ),
  a: ({ children, href }) =>
    href ? (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-primary underline underline-offset-2"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }) => <span className="italic">{alt ? `[图片：${alt}]` : "[图片已隐藏]"}</span>,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-md border border-border/70">
      <table className="w-full border-collapse text-left text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-border/70 bg-background/70 px-2 py-1.5 font-semibold text-foreground">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border-b border-border/50 px-2 py-1.5">{children}</td>,
  hr: () => <hr className="my-3 border-border/70" />
}

function ReleaseNotes({ children }: { children: string }): ReactElement {
  const content = normalizeReleaseNotesForDisplay(children)

  return (
    <div className="max-h-52 overflow-y-auto rounded-lg border border-border/70 bg-gradient-to-br from-muted/60 to-muted/20 px-3.5 py-3 text-sm text-muted-foreground shadow-sm">
      {content.trim() ? (
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkBreaks]}
          components={releaseNotesMarkdownComponents}
          urlTransform={sanitizeReleaseNotesUrl}
        >
          {content}
        </ReactMarkdown>
      ) : (
        <span>暂无更新说明</span>
      )}
    </div>
  )
}

export function UpdateDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const [stage, setStage] = useState<UpdateStage>("idle")
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [errorMsg, setErrorMsg] = useState("")
  const [checking, setChecking] = useState(false)
  const [sourceInfo, setSourceInfo] = useState<UpdateSourceInfo | null>(null)

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
        setSourceInfo(s.source)
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
          // Don't self-open: UpdateActionButton owns the per-version auto-open
          // coordination so card/tag variants and any future mount points stay
          // consistent. We just hydrate stage so an already-open dialog shows
          // the correct UI.
          setUpdateInfo(s.update)
          setProgress(null)
          setStage("downloaded")
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
      setSourceInfo(info.source ?? null)
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
      setSourceInfo(info.source ?? null)
      setUpdateInfo((prev) =>
        prev
          ? { ...prev, ...info }
          : {
              version: info.version,
              targetVersion: info.targetVersion,
              updateType: info.updateType,
              releaseNotes: info.releaseNotes ?? "",
              size: info.size ?? 0,
              mandatory: info.mandatory ?? false
            }
      )
      setProgress(null)
      setStage("downloaded")
      // Don't self-open here. UpdateActionButton owns the per-version auto-open
      // gate (autoOpenedVersions Set) and will set dialogOpen=true. Opening
      // ourselves would bypass that coordination if/when the dialog is ever
      // mounted while closed (e.g. variant="card", which keeps UpdateDialog
      // mounted regardless of dialogOpen).
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
      setSourceInfo(result.source ?? null)
      if (result.hasUpdate) {
        setUpdateInfo({
          version: result.version,
          targetVersion: result.targetVersion,
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
    setSourceInfo(null)
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
  const isIntermediate = !!updateInfo && updateInfo.version !== updateInfo.targetVersion
  const isSelfTestSource = sourceInfo?.channel === "selftest"
  const sourceNotice = isSelfTestSource ? (
    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      <div className="font-medium">自测更新通道</div>
      <div className="mt-1 break-all">manifest：{sourceInfo.manifestFile}</div>
      {sourceInfo.baseUrl && <div className="mt-0.5 break-all">baseUrl：{sourceInfo.baseUrl}</div>}
      {sourceInfo.expiresAt && <div className="mt-0.5">过期时间：{sourceInfo.expiresAt}</div>}
    </div>
  ) : null

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (v) return onOpenChange(true)
        if (stage === "installing") return
        if (stage === "downloading") return handleHideDownloading()
        // Keep main process state so the sidebar tag stays red and the user
        // can re-open this dialog later to install.
        if (stage === "downloaded") return onOpenChange(false)
        if (isMandatory) return
        handleDismiss()
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
            {sourceNotice}
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
              <DialogTitle>
                {isIntermediate
                  ? `需要兼容性更新 v${updateInfo.version}`
                  : `发现新版本 v${updateInfo.version}`}
              </DialogTitle>
              <DialogDescription>
                {isIntermediate
                  ? `本次先升级至 v${updateInfo.version}，完成后可继续升级至 v${updateInfo.targetVersion}`
                  : updateInfo.updateType === "asar"
                    ? "轻量更新（仅替换业务代码，无需重新安装）"
                    : "完整更新（需要重新安装应用文件）"}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              {sourceNotice}
              <div className="text-sm text-muted-foreground">
                <div className="font-medium text-foreground mb-1">
                  {isIntermediate
                    ? `最终版本 v${updateInfo.targetVersion} 更新内容：`
                    : "更新内容："}
                </div>
                <ReleaseNotes>{updateInfo.releaseNotes}</ReleaseNotes>
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
              {sourceNotice}
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
                {isIntermediate
                  ? `这是升级至 v${updateInfo.targetVersion} 的第一阶段，重启完成后应用会继续检查最终更新。`
                  : updateInfo.updateType === "asar"
                    ? "轻量更新已下载完成，重启应用即可完成更新。请先保存当前工作。"
                    : "完整更新已下载完成，重启应用将自动安装新版本。请先保存当前工作。"}
              </DialogDescription>
            </DialogHeader>
            {sourceNotice}

            {updateInfo.releaseNotes && (
              <div className="space-y-3">
                <div className="text-sm text-muted-foreground">
                  <div className="font-medium text-foreground mb-1">
                    {isIntermediate
                      ? `最终版本 v${updateInfo.targetVersion} 更新内容：`
                      : "更新内容："}
                  </div>
                  <ReleaseNotes>{updateInfo.releaseNotes}</ReleaseNotes>
                </div>
                {updateInfo.size > 0 && (
                  <div className="text-xs text-muted-foreground">
                    下载大小：约 {formatSize(updateInfo.size)}
                  </div>
                )}
              </div>
            )}

            <DialogFooter>
              {!isMandatory && (
                <Button variant="outline" onClick={() => onOpenChange(false)}>
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
            {sourceNotice}
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
