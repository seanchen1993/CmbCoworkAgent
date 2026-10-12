import { useEffect, useRef, useState } from "react"
import { Archive, Monitor, FolderOpen, RotateCcw, Trash2, LoaderCircle } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { maintenancePending } from "@/lib/bot-browser-maintenance-pending"
import { createBotIpcClient } from "../../../../shared/bot-ipc-result"
import {
  BOT_BROWSER_CHECKPOINT_LIMIT,
  type BotBrowserCheckpoint,
  type BotBrowserMaintenanceAPI,
  type BotBrowserMaintenanceRequest
} from "../../../../shared/bot-browser-maintenance"
import { formatAttachmentBytes } from "./upstream/grok-composer-draft"

import {
  BOT_WORKSPACE_CHECKPOINT_LIMIT,
  type BotWorkspaceCheckpoint
} from "../../../../shared/bot-workspace-maintenance"

const browserMaintenanceApi = createBotIpcClient<BotBrowserMaintenanceAPI>(
  () => window.api.botBrowserMaintenance
)

export function BotEnvironmentMaintenance({
  close,
  kind
}: {
  close(): void
  kind: "browser" | "workspace"
}) {
  const workspace = kind === "workspace"
  const subject = workspace ? "共享工作文件" : "浏览器"
  const api = workspace ? window.api.botWorkspaceMaintenance : browserMaintenanceApi
  const pendingStore = maintenancePending(kind)
  const limit = workspace ? BOT_WORKSPACE_CHECKPOINT_LIMIT : BOT_BROWSER_CHECKPOINT_LIMIT
  const Icon = workspace ? FolderOpen : Monitor
  const labels = {
    create: "保存恢复点",
    reset: `重置${subject}`,
    restore: `恢复${subject}`,
    delete: "删除恢复点"
  }

  const [checkpoints, setCheckpoints] = useState<
    (BotBrowserCheckpoint | BotWorkspaceCheckpoint)[] | null
  >(null)
  const [request, setRequest] = useState<BotBrowserMaintenanceRequest | null>(pendingStore.pending)
  const [submitted, setSubmitted] = useState(() => !!pendingStore.pending())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const alive = useRef(true),
    executing = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    let cancelled = false
    void api
      .list()
      .then((value) => {
        if (!cancelled) setCheckpoints(value)
      })
      .catch((error) => {
        if (!cancelled) setError(error instanceof Error ? error.message : "恢复点读取失败")
      })
    return () => {
      cancelled = true
    }
  }, [reload, api])
  function select(value: BotBrowserMaintenanceRequest) {
    setRequest(value)
    setSubmitted(false)
    setError(null)
  }
  async function execute() {
    if (!request || executing.current) return
    executing.current = true
    setBusy(true)
    setError(null)
    try {
      pendingStore.remember(request)
      setSubmitted(true)
      const result = await api.execute(request)
      pendingStore.forget(request)
      if (!alive.current) return
      setRequest(null)
      setSubmitted(false)
      setReload((value) => value + 1)
      toast.success(
        request.action === "create"
          ? "恢复点已保存"
          : request.action === "delete"
            ? "恢复点已删除"
            : workspace
              ? "recoveryCopy" in result && result.recoveryCopy
                ? "共享工作文件已更新，原目录已保留"
                : "共享工作文件已更新"
              : "浏览器状态已更新，重新打开浏览器即可使用"
      )
      // The committed maintenance receipt remains valid if the Host is still
      // reconnecting. The store displays refresh failures and polling retries;
      // do not turn that failure into another destructive maintenance attempt.
      await useBotWorkspaceStore
        .getState()
        .refresh()
        .catch(() => {})
    } catch (error) {
      if (alive.current)
        setError(error instanceof Error ? error.message : "操作未确认完成，请重试核对")
    } finally {
      executing.current = false
      if (alive.current) setBusy(false)
    }
  }
  const selected =
    request && "checkpoint" in request
      ? checkpoints?.find((item) => item.id === request.checkpoint.id)
      : undefined
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
            <Icon className="size-4" />
            {workspace ? "共享工作文件恢复与重置" : "工作浏览器恢复与重置"}
          </DialogTitle>
          <DialogDescription>
            {workspace
              ? "管理所有 Bot 默认使用的共享工作目录。操作前请完成运行中的任务，并关闭正在编辑这些文件的程序。"
              : "管理所有 Bot 共用的专用浏览器环境。操作前请完成运行中的任务，并归还浏览器控制权。"}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-xl border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
          {workspace
            ? "恢复会替换共享目录内的文件，重置会清空目录；操作前自动保存恢复点，并保留被替换的原文件。自选项目目录、Bot 对话和任务记录保持原状，已提交的外部操作不会撤回。"
            : "恢复点包含站点数据和登录状态，仅供原电脑使用；站点过期或撤销的登录仍需重新登录。恢复会替换此后的浏览器状态，重置会清空当前状态，两者都会先保存一份恢复点。Bot 对话、任务记录和项目文件保持原状，已提交的外部操作不会撤回。"}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {checkpoints ? `${checkpoints.length} / ${limit} 份恢复点` : "正在读取…"}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !!request || !checkpoints}
              onClick={() => select({ action: "reset", nonce: crypto.randomUUID() })}
            >
              <RotateCcw className="mr-1.5 size-3.5" />
              {labels.reset}
            </Button>
            <Button
              size="sm"
              disabled={busy || !!request || !checkpoints || checkpoints.length >= limit}
              onClick={() => select({ action: "create", nonce: crypto.randomUUID() })}
            >
              <Archive className="mr-1.5 size-3.5" />
              保存恢复点
            </Button>
          </div>
        </div>
        <div className="max-h-64 overflow-y-auto rounded-xl border" aria-label={`${subject}恢复点`}>
          {checkpoints?.length === 0 && (
            <div className="px-5 py-9 text-center">
              <Icon className="mx-auto mb-3 size-6 text-muted-foreground" />
              <p className="text-sm">还没有{subject}恢复点</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {workspace
                  ? "保存一份恢复点，便于找回之后被修改或删除的文件。"
                  : "首次登录或配置完成后，可以保存当前状态。"}
              </p>
            </div>
          )}
          {checkpoints?.map((item) => (
            <div
              key={item.id}
              data-testid={`${kind}-checkpoint-${item.id}`}
              className="flex items-center gap-3 border-b px-3 py-3 last:border-0"
            >
              <Archive className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{new Date(item.createdAt).toLocaleString()}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {item.reason === "manual"
                    ? "手动保存"
                    : item.reason === "before-reset"
                      ? "重置前保存"
                      : "恢复前保存"}{" "}
                  · {formatAttachmentBytes(item.bytes)} ·{" "}
                  {"browser" in item
                    ? item.browser === "msedge"
                      ? "Edge"
                      : "Chrome"
                    : `${item.files} 个文件`}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || !!request}
                onClick={() =>
                  select({
                    action: "restore",
                    nonce: crypto.randomUUID(),
                    checkpoint: { id: item.id, sha256: item.sha256 }
                  })
                }
              >
                恢复
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="删除恢复点"
                disabled={busy || !!request}
                onClick={() =>
                  select({ action: "delete", checkpoint: { id: item.id, sha256: item.sha256 } })
                }
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
        {request && (
          <section className="space-y-3 rounded-xl border p-3" aria-label={`确认${subject}维护`}>
            <p className="text-sm font-medium">
              {submitted ? "核对上次操作" : labels[request.action]}
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {submitted
                ? `上次请求尚未确认。继续会核对同一操作，不会重复替换${subject}。`
                : request.action === "create"
                  ? workspace
                    ? "保存当前共享工作文件，后台会暂时断开后重连。"
                    : "保存当前专用浏览器的站点数据，后台会暂时断开后重连。"
                  : request.action === "delete"
                    ? `删除所选恢复点，无法撤销；当前${subject}不受影响。`
                    : request.action === "reset"
                      ? workspace
                        ? "所有 Bot 的共享工作目录将清空，自选项目目录不受影响。"
                        : "所有 Bot 将使用新的空白浏览器环境，需要重新登录网站。"
                      : `恢复至${selected ? new Date(selected.createdAt).toLocaleString() : "所选恢复点"}，${workspace ? "之后的共享文件变化将被替换，请核对后继续任务。" : "之后的浏览器变化将被替换，标签页需要重新打开。"}`}
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  if (submitted) pendingStore.forget(request)
                  setRequest(null)
                  setSubmitted(false)
                }}
              >
                {submitted ? "放弃重试" : "取消"}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void execute()}>
                {busy && <LoaderCircle className="mr-1.5 size-3.5 animate-spin" />}
                {busy ? "处理中…" : submitted ? "核对上次操作" : "确认"}
              </Button>
            </div>
            {submitted && !busy && (
              <p className="text-xs text-muted-foreground">
                放弃重试不会撤回已执行的操作；可关闭窗口后检查{subject}状态。
              </p>
            )}
          </section>
        )}
        {workspace && (
          <div className="text-xs leading-relaxed text-muted-foreground">
            <Button
              variant="link"
              size="sm"
              className="h-auto px-0"
              disabled={busy}
              onClick={() =>
                void window.api.botWorkspaceMaintenance
                  .revealRecovery()
                  .catch((error) =>
                    setError(error instanceof Error ? error.message : "无法打开目录")
                  )
              }
            >
              <FolderOpen className="mr-1.5 size-3.5" />
              查看保留的原文件
            </Button>
            <p>原目录保存在 recovery 开头的文件夹中，可另存后自行清理。</p>
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
          >
            {error}
            <Button
              variant="link"
              size="sm"
              className="ml-2 h-auto p-0"
              onClick={() => {
                setError(null)
                setReload((value) => value + 1)
              }}
            >
              刷新列表
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
