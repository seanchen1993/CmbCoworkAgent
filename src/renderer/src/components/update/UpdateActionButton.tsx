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
    scheduleUpdateStatusSync()

    const removeAvailable = updateApi.onAvailable((info) => {
      setStatus("available")
      setVersion(info.version)
    })
    const removeDownloaded = updateApi.onDownloaded((info) => {
      setStatus("downloaded")
      setVersion(info.version)
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
  // const hasUpdate = true

  if (hideWhenCurrent && !hasUpdate) return null

  const tagText =
    status === "downloaded"
      ? "重启更新"
      : status === "downloading"
        ? "下载中"
        : status === "error"
          ? "更新失败"
          : "可更新"

  if (variant === "tag") {
    return (
      <>
        <button
          type="button"
          className={cn(
            "cursor-pointer rounded-full bg-status-warning/15 px-1.5 py-0.5 text-[9px] font-medium text-status-warning hover:bg-status-warning/25",
            className
          )}
          title={version ? `发现新版本 v${version}` : "发现新版本"}
          onClick={() => setDialogOpen(true)}
        >
          {tagText}
        </button>
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
