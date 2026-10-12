import { useCallback, useEffect, useState } from "react"
import { BotBackupSchedule } from "./BotBackupSchedule"
import { Archive, FolderOpen, LoaderCircle, Monitor, RotateCcw, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import {
  BOT_BACKUP_LIMIT,
  type BotBackupRequest,
  type BotBackupSummary
} from "../../../../shared/bot-backup"
import { formatAttachmentBytes } from "./upstream/grok-composer-draft"

export function BotBackups({
  close,
  openComputer,
  openBrowser,
  openWorkspace
}: {
  close(): void
  openComputer?(): void
  openBrowser?(): void
  openWorkspace?(): void
}) {
  const [backups, setBackups] = useState<BotBackupSummary[] | null>(null)
  const [request, setRequest] = useState<BotBackupRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const dataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const onBackup = useCallback(() => setReload((value) => value + 1), [])
  useEffect(() => {
    let disposed = false
    void window.api.botBackups
      .list()
      .then((value) => {
        if (!disposed) setBackups(value)
      })
      .catch((error) => {
        if (!disposed) setError(error instanceof Error ? error.message : "备份列表读取失败")
      })
    return () => {
      disposed = true
    }
  }, [reload])
  const selected =
    request && "backup" in request
      ? backups?.find((item) => item.id === request.backup.id)
      : undefined
  async function execute(input: BotBackupRequest) {
    if (busy) return
    setRequest(input)
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.botBackups.execute(input)
      if (result.recoveryCopy) toast.info("恢复前的原始数据已保留在备份目录，供另存与排查。")
      setRequest(null)
      setBackups(await window.api.botBackups.list())
      toast.success(
        input.action === "restore"
          ? "备份已恢复，原未完成任务已停止，例程已禁用"
          : input.action === "create"
            ? "备份已保存"
            : "备份已删除"
      )
      await useBotWorkspaceStore.getState().refresh()
    } catch (error) {
      setError(error instanceof Error ? error.message : "操作失败，请重试")
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close()
      }}
    >
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-xl"
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Archive className="size-4" />
            备份与恢复
          </DialogTitle>
          <DialogDescription>
            保存 Bot
            的消息、任务、记忆、技能、文件和示范资料。手动备份与恢复前需完成或停止运行中的任务。
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border bg-muted/30 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
          备份保存在本机，最多保留 {BOT_BACKUP_LIMIT} 份。工作文件（含共享工作目录、项目和 Bot
          独立代码工作区）、浏览器登录状态和模型密钥不包含在内；可打开目录，将备份另存到安全位置。
        </div>
        <BotBackupSchedule key={dataEpoch} disabled={busy || !!request} onBackup={onBackup} />
        {openComputer && (
          <Button
            variant="outline"
            className="h-auto justify-start gap-3 rounded-xl px-3 py-3 text-left"
            disabled={busy || !!request}
            onClick={openComputer}
          >
            <Monitor className="size-4 shrink-0 text-muted-foreground" />
            <span className="grid gap-1">
              <span className="text-sm font-medium">电脑恢复点</span>
              <span className="whitespace-normal text-xs font-normal leading-relaxed text-muted-foreground">
                一起保存 Bot 数据、共享工作文件、浏览器和独立代码成果
              </span>
            </span>
          </Button>
        )}
        {(openBrowser || openWorkspace) && (
          <div className="grid gap-2 sm:grid-cols-2">
            {openBrowser && (
              <Button
                variant="outline"
                size="sm"
                className="h-auto justify-start whitespace-normal rounded-lg py-3 text-left leading-relaxed"
                disabled={busy || !!request}
                onClick={openBrowser}
              >
                <Monitor className="mr-1 size-4 shrink-0 text-muted-foreground" />
                工作浏览器恢复与重置
              </Button>
            )}
            {openWorkspace && (
              <Button
                variant="outline"
                size="sm"
                className="h-auto justify-start whitespace-normal rounded-lg py-3 text-left leading-relaxed"
                disabled={busy || !!request}
                onClick={openWorkspace}
              >
                <FolderOpen className="mr-1 size-4 shrink-0 text-muted-foreground" />
                共享工作文件恢复与重置
              </Button>
            )}
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {backups ? `${backups.length} 份备份` : "正在读取…"}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void window.api.botBackups
                  .reveal()
                  .catch((error) => setError(String(error.message ?? error)))
              }
            >
              <FolderOpen className="mr-1.5 size-3.5" />
              打开目录
            </Button>
            <Button
              size="sm"
              disabled={busy || !!request || !backups || backups.length >= BOT_BACKUP_LIMIT}
              onClick={() => void execute({ action: "create", nonce: crypto.randomUUID() })}
            >
              <Archive className="mr-1.5 size-3.5" />
              创建备份
            </Button>
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto rounded-lg border" aria-label="备份列表">
          {backups?.length === 0 && (
            <div className="px-5 py-9 text-center">
              <Archive className="mx-auto mb-3 size-6 text-muted-foreground" />
              <p className="text-sm">还没有备份</p>
              <p className="mt-1 text-xs text-muted-foreground">
                为当前工作区保存一份可恢复的副本。
              </p>
            </div>
          )}
          {backups?.map((backup) => (
            <div
              key={backup.id}
              className="flex items-center gap-3 border-b px-3 py-3 last:border-b-0"
              data-testid={`bot-backup-${backup.id}`}
            >
              <Archive className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{new Date(backup.createdAt).toLocaleString()}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {backup.reason === "before-restore"
                    ? "恢复前自动保存"
                    : backup.reason === "scheduled"
                      ? "定时备份"
                      : "手动备份"}{" "}
                  · {formatAttachmentBytes(backup.bytes)} · {backup.files} 个文件
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || !!request}
                onClick={() => {
                  setError(null)
                  setRequest({
                    action: "restore",
                    nonce: crypto.randomUUID(),
                    backup: { id: backup.id, sha256: backup.sha256 }
                  })
                }}
              >
                <RotateCcw className="mr-1 size-3.5" />
                恢复
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground"
                aria-label="删除此备份"
                disabled={busy || !!request}
                onClick={() => {
                  setError(null)
                  setRequest({ action: "delete", backup: { id: backup.id, sha256: backup.sha256 } })
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
        {request && (
          <section className="rounded-lg border bg-muted/30 p-3 text-sm" aria-label="备份操作确认">
            <p className="font-medium">
              {busy
                ? "正在处理，请保持应用打开…"
                : request.action === "restore"
                  ? "恢复这份备份？"
                  : request.action === "delete"
                    ? "删除这份备份？"
                    : "创建备份"}
            </p>
            {request.action === "restore" && (
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                工作区将回到 {selected ? new Date(selected.createdAt).toLocaleString() : "所选备份"}
                。已删除的资料和已撤回的共享技能不会恢复。当前数据会先另存；损坏数据将保留原始文件。旧任务不会自动继续，例程和定时备份需重新启用。外部系统中的操作不会被撤销。
              </p>
            )}
            {request.action === "delete" && (
              <p className="mt-2 text-xs text-muted-foreground">
                这份备份将永久删除，当前工作区不受影响。
              </p>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setRequest(null)
                  setError(null)
                }}
              >
                取消
              </Button>
              <Button
                size="sm"
                disabled={busy}
                variant={request.action === "delete" ? "destructive" : "default"}
                onClick={() => void execute(request)}
              >
                {busy ? (
                  <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                ) : request.action === "restore" ? (
                  "确认恢复"
                ) : request.action === "delete" ? (
                  "确认删除"
                ) : (
                  "重试备份"
                )}
              </Button>
            </div>
          </section>
        )}
        {error && (
          <div role="alert" className="text-xs text-destructive">
            {error}
            {!request && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setError(null)
                  setReload((value) => value + 1)
                }}
              >
                重新读取
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
