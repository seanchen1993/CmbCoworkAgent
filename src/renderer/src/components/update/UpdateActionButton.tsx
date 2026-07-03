import { useCallback, useEffect, useState } from "react"
import { Megaphone } from "lucide-react"
import { cn } from "@/lib/utils"
import { UpdateDialog } from "./UpdateDialog"

type UpdateStatus = "idle" | "available" | "downloading" | "downloaded" | "error"
type UpdateActionVariant = "card" | "tag"

interface UpdateActionButtonProps {
  variant?: UpdateActionVariant
  className?: string
  hideWhenCurrent?: boolean
}

// Module-level so multiple UpdateActionButton instances coordinate: each downloaded
// version pops the dialog at most once per app session, regardless of how many
// instances are mounted.
const autoOpenedVersions = new Set<string>()

function consumeAutoOpenForVersion(version: string | null | undefined): boolean {
  if (!version || autoOpenedVersions.has(version)) return false
  autoOpenedVersions.add(version)
  return true
}

export function UpdateActionButton({
  variant = "card",
  className,
  hideWhenCurrent = false
}: UpdateActionButtonProps): React.JSX.Element | null {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [status, setStatus] = useState<UpdateStatus>("idle")
  const [version, setVersion] = useState<string | null>(null)

  const syncUpdateStatus = useCallback(async () => {
    try {
      const updateStatus = await window.api.update.getStatus()
      setStatus(updateStatus.status as UpdateStatus)
      setVersion(updateStatus.update?.version ?? null)
    } catch {
      setStatus("idle")
      setVersion(null)
    }
  }, [])

  const scheduleUpdateStatusSync = useCallback(() => {
    void Promise.resolve().then(syncUpdateStatus)
  }, [syncUpdateStatus])

  useEffect(() => {
    const updateApi = window.api.update

    // Initial sync covers in-session races only: the update:downloaded IPC may
    // fire before this component mounts and registers its listener (e.g. the
    // sidebar was collapsed at the time, or the component remounted after a
    // route change). It does NOT cover restart-with-pending-download — main
    // process updater state (updateStatus / lastCheckResult / downloadedFilePath
    // in src/main/updater/index.ts) is in-memory and resets to idle on every
    // launch. Restoring a previous-session download would require persisting
    // the downloaded file path + sha + version on the main side and re-checking
    // the file on startup before broadcasting update:downloaded.
    void window.api.update
      .getStatus()
      .then((s) => {
        setStatus(s.status as UpdateStatus)
        setVersion(s.update?.version ?? null)
        if (s.status === "downloaded" && consumeAutoOpenForVersion(s.update?.version)) {
          setDialogOpen(true)
        }
      })
      .catch(() => {
        setStatus("idle")
        setVersion(null)
      })

    const removeAvailable = updateApi.onAvailable((info) => {
      setStatus("available")
      setVersion(info.version)
    })
    const removeDownloaded = updateApi.onDownloaded((info) => {
      setStatus("downloaded")
      setVersion(info.version)
      if (consumeAutoOpenForVersion(info.version)) {
        setDialogOpen(true)
      }
    })
    const removeError = updateApi.onError(() => {
      scheduleUpdateStatusSync()
    })

    return () => {
      removeAvailable()
      removeDownloaded()
      removeError()
    }
  }, [scheduleUpdateStatusSync])

  useEffect(() => {
    if (!dialogOpen) {
      scheduleUpdateStatusSync()
    }
  }, [dialogOpen, scheduleUpdateStatusSync])

  const hasUpdate = Boolean(version) && status !== "idle"

  if (variant !== "tag" && hideWhenCurrent && !hasUpdate) return null

  const statusTagText =
    status === "downloaded"
      ? "重启更新"
      : status === "downloading"
        ? "下载中"
        : status === "error"
          ? "更新失败"
          : hasUpdate
            ? "可更新"
            : null

  if (variant === "tag") {
    return (
      <>
        <div className={cn("inline-flex shrink-0 items-center gap-1", className)}>
          <button
            type="button"
            className="cursor-pointer rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground shrink-0"
            title="检查是否有新版本"
            onClick={() => setDialogOpen(true)}
          >
            检查
          </button>
          {statusTagText && (
            <button
              type="button"
              className={cn(
                "cursor-pointer rounded-full px-1.5 py-0.5 text-[9px] font-medium transition-colors shrink-0",
                status === "error"
                  ? "bg-red-100 text-red-700 hover:bg-red-200"
                  : "bg-status-warning/15 text-status-warning hover:bg-status-warning/25"
              )}
              title={version ? `发现新版本 v${version}` : "查看更新状态"}
              onClick={() => setDialogOpen(true)}
            >
              {statusTagText}
            </button>
          )}
        </div>
        {dialogOpen && <UpdateDialog open={dialogOpen} onOpenChange={setDialogOpen} />}
      </>
    )
  }

  return (
    <>
      <button
        onClick={() => setDialogOpen(true)}
        type="button"
        className={cn(
          "group relative w-full rounded-xl px-4 py-3.5 text-left transition-all duration-300 ease-out hover:shadow-lg hover:scale-[1.01] active:scale-[0.99] backdrop-blur-sm",
          hasUpdate
            ? "border-red-400/60 bg-gradient-to-br from-red-50/90 to-red-100/70 hover:border-red-500 hover:from-red-100 hover:to-red-150/80 shadow-red-100/50"
            : "border border-border/70 bg-background/90 hover:bg-accent/35 hover:border-border transition-colors",
          className
        )}
      >
        <div className="flex items-center gap-3.5">
          <div
            className={cn(
              "rounded-lg border p-1 transition-all duration-300 shadow-sm group-hover:shadow-md",
              hasUpdate
                ? "bg-red-100 text-red-600 border-red-200 group-hover:bg-red-200 group-hover:text-red-700 group-hover:shadow-red-200/50"
                : "rounded-md border-border/80 p-1.5 text-muted-foreground group-hover:text-foreground transition-colors"
            )}
          >
            <Megaphone size={14} className="drop-shadow-sm" />
          </div>
          <div className="flex-1 min-w-0">
            <div
              className={cn(
                "text-sm font-semibold leading-5 transition-colors duration-200",
                hasUpdate && "text-red-700"
              )}
            >
              {hasUpdate ? "发现新版本！" : "检测版本"}
            </div>
          </div>
          {hasUpdate && (
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse shadow-sm" />
            </div>
          )}
        </div>

        <div
          className={cn(
            "absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none",
            hasUpdate
              ? "bg-gradient-to-br from-red-400/8 via-transparent to-red-500/6"
              : "bg-gradient-to-br from-blue-400/8 via-transparent to-indigo-500/6"
          )}
        />

        <div
          className={cn(
            "absolute inset-0 rounded-xl opacity-0 group-hover:opacity-30 transition-opacity duration-300 pointer-events-none border blur-sm",
            hasUpdate ? "border-red-300" : "border-blue-300"
          )}
        />
      </button>
      <UpdateDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  )
}
