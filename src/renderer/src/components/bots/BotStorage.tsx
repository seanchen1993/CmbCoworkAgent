import { HardDrive, Archive, AlertTriangle } from "lucide-react"
import { useSyncExternalStore } from "react"
import { DEFAULT_ASYNC_TASKS_CLOCK } from "./upstream/grok-async-clock"
import { Button } from "@/components/ui/button"
import { Dialog, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import type { BotStorageStatus } from "../../../../shared/bot-storage"
import { formatAttachmentBytes } from "./upstream/grok-composer-draft"

function formatCapacity(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TiB`
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
  return formatAttachmentBytes(bytes)
}

export function BotStorage({
  status,
  close,
  openBackups
}: {
  status: BotStorageStatus
  close(): void
  openBackups?: () => void
}) {
  const now = useSyncExternalStore(
    DEFAULT_ASYNC_TASKS_CLOCK.subscribe,
    DEFAULT_ASYNC_TASKS_CLOCK.now
  )
  const stale = status.checkedAt !== null && now - status.checkedAt > 90_000
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HardDrive className="size-4" />
            磁盘容量
          </DialogTitle>
          <DialogDescription>
            查看 Bot 数据和已配置项目所在磁盘，同一磁盘只显示一次。
          </DialogDescription>
        </DialogHeader>
        {(!status.complete || stale) && (
          <p
            role="status"
            className="rounded-lg border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground"
          >
            {status.checkedAt === null
              ? "正在读取磁盘信息…"
              : "部分磁盘信息未能更新，下方保留最近读取结果。未读到的数据不表示空间充足。"}
          </p>
        )}
        <div className="space-y-3">
          {status.volumes.map((volume, index) => {
            const used = Math.max(
              0,
              Math.min(100, 100 * (1 - volume.availableBytes / volume.totalBytes))
            )
            return (
              <section
                key={index}
                aria-label={volume.name}
                className="space-y-2.5 rounded-lg border p-3"
              >
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium">{volume.name}</span>
                  <span
                    className={
                      volume.level === "healthy" ? "text-muted-foreground" : "text-destructive"
                    }
                  >
                    {volume.level === "hard"
                      ? "空间严重不足"
                      : volume.level === "soft"
                        ? "空间不足"
                        : "空间充足"}
                  </span>
                </div>
                <div
                  className="h-1.5 overflow-hidden rounded-full bg-muted"
                  role="meter"
                  aria-label={`${volume.name}已用空间`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(used)}
                >
                  <div
                    className={`h-full rounded-full ${volume.level === "healthy" ? "bg-primary/70" : "bg-destructive/80"}`}
                    style={{ width: `${used}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  可用 {formatCapacity(volume.availableBytes)} / 共{" "}
                  {formatCapacity(volume.totalBytes)}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  读取于 {new Date(volume.sampledAt).toLocaleString()}
                </p>
              </section>
            )
          })}
        </div>
        {(status.level === "soft" || status.level === "hard") && (
          <p
            role="alert"
            className="flex gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs leading-5 text-destructive"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            磁盘空间不足可能影响任务、下载和备份。请先核对要保留的数据，再清理不需要的文件。
          </p>
        )}
        <div className="space-y-3 rounded-lg bg-muted/30 p-3">
          <p className="text-xs leading-5 text-muted-foreground">
            容量包含此磁盘上的其他应用和文件。可先检查历史备份，另存需要保留的副本，再逐份确认删除。
          </p>
          {openBackups && (
            <Button size="sm" variant="outline" onClick={openBackups}>
              <Archive className="mr-1.5 size-3.5" />
              管理历史备份
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
