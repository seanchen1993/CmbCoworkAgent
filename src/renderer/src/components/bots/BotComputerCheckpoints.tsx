import { useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  Archive,
  Check,
  Copy,
  Download,
  FolderOpen,
  GitBranch,
  LoaderCircle,
  Monitor,
  RotateCcw,
  Trash2
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import { BotErrorNoticeBody } from "./BotErrorNoticeBody"
import { botErrorNotice, type BotErrorNotice } from "@/lib/bot-error-notice"
import {
  discardCorruptComputerMaintenance,
  maintenancePending,
  type BotComputerMaintenanceRequest
} from "@/lib/bot-browser-maintenance-pending"
import {
  isDefiniteComputerCheckpointFailure,
  verifyComputerCheckpointReceipt
} from "@/lib/bot-computer-checkpoint-operation"
import { createBotIpcClient } from "../../../../shared/bot-ipc-result"
import {
  BOT_COMPUTER_CHECKPOINT_LIMIT,
  BOT_COMPUTER_RECOVERY_COPY_LIMIT,
  type BotComputerCheckpointAPI,
  type BotComputerCheckpointResult,
  type BotComputerCheckpointSummary
} from "../../../../shared/bot-computer-checkpoint"
import {
  botComputerMaintenancePublicProgress,
  type BotComputerMaintenancePublicProgress
} from "../../../../shared/bot-computer-maintenance-progress"
import { formatAttachmentBytes } from "./upstream/grok-composer-draft"

const computerApi = createBotIpcClient<BotComputerCheckpointAPI>(
  () => window.api.botComputerCheckpoints
)
const pendingStore = maintenancePending("computer")
type RestoreReceipt = Extract<BotComputerCheckpointResult, { action: "restore" }>
type RecoveryCopy = Awaited<ReturnType<BotComputerCheckpointAPI["recoveryCopies"]>>[number]
type CodeDeliverables = Awaited<ReturnType<BotComputerCheckpointAPI["deliverables"]>>[number]
const labels: Record<BotComputerMaintenanceRequest["action"], string> = {
  create: "保存电脑检查点",
  restore: "恢复电脑检查点",
  delete: "删除电脑检查点",
  "delete-recovery": "删除原现场"
}
const phases: Record<BotComputerMaintenancePublicProgress["phase"], string> = {
  capture: "保存文件",
  verify: "校验数据",
  prepare: "准备恢复",
  replace: "替换工作环境",
  publish: "提交检查点",
  cleanup: "清理临时文件"
}
const components: Record<BotComputerMaintenancePublicProgress["component"], string> = {
  data: "Bot 数据",
  shared: "共享文件",
  browser: "工作浏览器",
  managed: "托管项目",
  control: "恢复记录"
}
function hasManagedGit(point: BotComputerCheckpointSummary | undefined): boolean {
  return !!point && point.managedGit.complete + point.managedGit.filesOnly > 0
}

export function BotComputerCheckpoints({
  close,
  onRestored
}: {
  close(): void
  onRestored?(receipt: RestoreReceipt): Promise<void>
}) {
  const [checkpoints, setCheckpoints] = useState<BotComputerCheckpointSummary[] | null>(null)
  const [copies, setCopies] = useState<RecoveryCopy[] | null>(null)
  const [deliverables, setDeliverables] = useState<CodeDeliverables[] | null>(null)
  const [request, setRequest] = useState<BotComputerMaintenanceRequest | null>(pendingStore.pending)
  const [record, setRecord] = useState(pendingStore.inspect)
  const [acknowledgedPending, setAcknowledgedPending] =
    useState<BotComputerMaintenanceRequest | null>(null)
  const [submitted, setSubmitted] = useState(() => !!pendingStore.pending())
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [readError, setReadError] = useState<BotErrorNotice | null>(null)
  const [error, setError] = useState<BotErrorNotice | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [restoreReceipt, setRestoreReceipt] = useState<RestoreReceipt | null>(null)
  const [syncFailed, setSyncFailed] = useState(false)
  const [progress, setProgress] = useState<BotComputerMaintenancePublicProgress | null>(null)
  const [reload, setReload] = useState(0)
  const instance = useRef({ active: false, executing: false })
  const confirm = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    const current = instance.current
    current.active = true
    return () => {
      current.active = false
    }
  }, [])
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setReadError(null)
    void Promise.all([computerApi.list(), computerApi.recoveryCopies(), computerApi.deliverables()])
      .then(([points, originals, code]) => {
        if (cancelled) return
        setCheckpoints(points)
        setCopies(originals)
        setDeliverables(code)
      })
      .catch((failure) => {
        if (!cancelled) setReadError(botErrorNotice(failure, "电脑检查点读取失败"))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [reload])
  useEffect(() => {
    if (request && !submitted) confirm.current?.focus({ preventScroll: true })
  }, [request, submitted])
  useEffect(() => {
    // One bounded observer exists only while this dialog owns an active call.
    // Native SQLite/Git phases have no truthful percentage; show their phase.
    if (!busy || !request || !("nonce" in request)) {
      setProgress(null)
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const observe = async () => {
      try {
        if (!document.hidden) {
          const parsed = botComputerMaintenancePublicProgress.safeParse(
            await computerApi.progress()
          )
          if (!cancelled)
            setProgress(
              parsed.success &&
                parsed.data.nonce === request.nonce &&
                (parsed.data.operation === request.action ||
                  (request.action === "restore" && parsed.data.operation === "startup-restore"))
                ? parsed.data
                : null
            )
        }
      } catch {
        /* Progress is optional; a read failure never replays maintenance. */
      }
      if (!cancelled) timer = setTimeout(() => void observe(), 1000)
    }
    void observe()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [busy, request])

  function select(value: BotComputerMaintenanceRequest) {
    if (
      instance.current.executing ||
      request ||
      restoreReceipt ||
      acknowledgedPending ||
      record.kind === "corrupt" ||
      record.kind === "unreadable"
    )
      return
    setRequest(value)
    setSubmitted(false)
    setError(null)
    setStatus(null)
  }
  async function reconnect(receipt: RestoreReceipt) {
    try {
      await onRestored?.(receipt)
      if (instance.current.active) {
        setSyncFailed(false)
        setError(null)
      }
    } catch (failure) {
      if (instance.current.active) {
        setSyncFailed(true)
        setError(botErrorNotice(failure, "电脑已恢复，后台连接尚未完成"))
      }
    }
  }
  async function execute() {
    const current = instance.current
    if (!request || current.executing) return
    const input = request
    current.executing = true
    setBusy(true)
    setError(null)
    let dispatched = false
    try {
      pendingStore.remember(input)
      if (current.active) setSubmitted(true)
      dispatched = true
      const result =
        input.action === "delete-recovery"
          ? (await computerApi.deleteRecovery(input.checkpoint), null)
          : verifyComputerCheckpointReceipt(input, await computerApi.execute(input))
      // A receipt is authoritative even if epoch refresh has already unmounted
      // this dialog. Never turn a cleanup/refresh error into another restore.
      let cleanupFailed = false
      try {
        pendingStore.forget(input)
      } catch {
        cleanupFailed = true
      }
      if (!current.active) return
      setRecord(pendingStore.inspect())
      setAcknowledgedPending(cleanupFailed ? input : null)
      setRequest(null)
      setSubmitted(false)
      setReload((value) => value + 1)
      setStatus(
        cleanupFailed
          ? "操作已完成，本机操作记录未能清理；再次核对仍使用同一请求。"
          : input.action === "create"
            ? "电脑检查点已保存"
            : input.action === "restore"
              ? "电脑已恢复，请核对原现场和项目成果后继续工作。"
              : input.action === "delete"
                ? "电脑检查点已删除"
                : "原现场已删除"
      )
      if (result?.action === "restore") {
        setRestoreReceipt(result)
        await reconnect(result)
      }
    } catch (failure) {
      let definitive = false
      if (dispatched && isDefiniteComputerCheckpointFailure(failure)) {
        try {
          pendingStore.forget(input)
          definitive = true
        } catch {
          /* Keep the exact request if durable cleanup failed. */
        }
      }
      if (!current.active) return
      if (definitive) {
        setRequest(null)
        setSubmitted(false)
        setReload((value) => value + 1)
      }
      if (!dispatched) {
        setRecord(pendingStore.inspect())
        const previous = pendingStore.pending()
        if (previous) {
          setRequest(previous)
          setSubmitted(true)
        }
      }
      setError(
        botErrorNotice(failure, dispatched ? "操作结果尚未确认，请核对原请求" : "本次操作尚未提交")
      )
    } finally {
      current.executing = false
      if (current.active) setBusy(false)
    }
  }
  async function retryConnection() {
    if (!restoreReceipt || instance.current.executing) return
    instance.current.executing = true
    setBusy(true)
    try {
      await reconnect(restoreReceipt)
    } finally {
      instance.current.executing = false
      if (instance.current.active) setBusy(false)
    }
  }
  async function reveal(id: string, kind: "original" | "deliverables" = "original") {
    if (instance.current.executing) return
    instance.current.executing = true
    setBusy(true)
    setError(null)
    try {
      if (kind === "deliverables") await computerApi.revealDeliverables(id)
      else await computerApi.revealRecovery(id)
    } catch (failure) {
      if (instance.current.active)
        setError(
          botErrorNotice(
            failure,
            kind === "deliverables" ? "恢复的代码成果目录打开失败" : "原现场目录打开失败"
          )
        )
    } finally {
      instance.current.executing = false
      if (instance.current.active) setBusy(false)
    }
  }
  function rereadRecord() {
    const value = pendingStore.inspect()
    setRecord(value)
    setRequest(value.kind === "valid" ? value.value : null)
    setSubmitted(value.kind === "valid")
    setError(null)
  }
  function cleanupAcknowledgedRecord() {
    if (!acknowledgedPending || instance.current.executing) return
    try {
      pendingStore.forget(acknowledgedPending)
      setAcknowledgedPending(null)
      rereadRecord()
    } catch (failure) {
      setRecord(pendingStore.inspect())
      setError(botErrorNotice(failure, "操作已完成，本机操作记录未能清理"))
    }
  }
  const selected =
    request && "checkpoint" in request
      ? checkpoints?.find(
          (point) =>
            point.id === request.checkpoint.id && point.sha256 === request.checkpoint.sha256
        )
      : undefined
  const restoredPoint = restoreReceipt
    ? checkpoints?.find(
        (point) =>
          point.id === restoreReceipt.checkpoint.id &&
          point.sha256 === restoreReceipt.checkpoint.sha256
      )
    : undefined
  const locked =
    busy ||
    !!request ||
    !!restoreReceipt ||
    !!acknowledgedPending ||
    record.kind === "corrupt" ||
    record.kind === "unreadable"
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close()
      }}
    >
      <DialogContent
        className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault()
        }}
      >
        <DialogHeader className="shrink-0 border-b px-6 pb-4 pt-6">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Monitor className="size-4" />
            电脑检查点
          </DialogTitle>
          <DialogDescription className="pr-4 text-xs leading-5">
            保存和恢复这台电脑上的 Bot 工作环境。检查点与原现场分别管理，操作会暂时断开后台。
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div className="rounded-xl border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
            包含 Bot
            数据、共享工作文件、专用浏览器和托管项目；不包含用户外部仓库、系统凭证或运行中的程序。浏览器登录仍受网站有效期和本机系统限制。
          </div>
          {record.kind === "unreadable" && (
            <div role="alert" className="space-y-2 rounded-xl border border-destructive/25 p-3">
              <p className="text-xs leading-5 text-muted-foreground">
                无法读取本机操作记录，暂不能发起电脑维护。原记录仍保留，请恢复本机存储访问后重新读取。
              </p>
              <Button size="sm" variant="outline" disabled={busy} onClick={rereadRecord}>
                重新读取操作记录
              </Button>
            </div>
          )}
          {record.kind === "corrupt" && (
            <CorruptMaintenanceRecord raw={record.raw} repaired={rereadRecord} />
          )}
          {acknowledgedPending && (
            <div className="space-y-2 rounded-xl border p-3">
              <p className="text-xs leading-5 text-muted-foreground">
                上次操作已确认完成，但本机记录未能清理。此处只清理已完成的记录，不会再次执行操作。
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={cleanupAcknowledgedRecord}
              >
                清理已完成操作记录
              </Button>
            </div>
          )}
          {readError && (
            <div role="alert" className="rounded-xl border border-destructive/25 p-3">
              <BotErrorNoticeBody notice={readError}>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || loading}
                  onClick={() => setReload((value) => value + 1)}
                >
                  重新读取
                </Button>
              </BotErrorNoticeBody>
            </div>
          )}
          <section aria-label="电脑检查点列表" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium">已保存的检查点</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {checkpoints
                    ? `${checkpoints.length} / ${BOT_COMPUTER_CHECKPOINT_LIMIT} 份`
                    : "正在读取…"}
                </p>
              </div>
              <Button
                size="sm"
                disabled={
                  locked ||
                  loading ||
                  !checkpoints ||
                  checkpoints.length >= BOT_COMPUTER_CHECKPOINT_LIMIT
                }
                onClick={() => select({ action: "create", nonce: crypto.randomUUID() })}
              >
                <Archive className="mr-1.5 size-3.5" />
                保存检查点
              </Button>
            </div>
            <div className="overflow-hidden rounded-xl border">
              {checkpoints?.length === 0 && (
                <div className="px-5 py-8 text-center">
                  <Archive className="mx-auto mb-3 size-6 text-muted-foreground" />
                  <p className="text-sm">还没有电脑检查点</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    工作环境配置完成后，可保存当前状态。
                  </p>
                </div>
              )}
              {checkpoints?.map((point) => (
                <div
                  key={point.id}
                  data-testid={`computer-checkpoint-${point.id}`}
                  className="flex items-start gap-3 border-b px-3 py-3 last:border-0"
                >
                  <Archive className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium">
                      {new Date(point.createdAt).toLocaleString()}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatAttachmentBytes(point.bytes)} · {point.files.toLocaleString()} 个文件 ·{" "}
                      {point.platform === "darwin"
                        ? "macOS"
                        : point.platform === "win32"
                          ? "Windows"
                          : "Linux"}
                    </p>
                    <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                      {[
                        point.data === "established" && "Bot 数据",
                        point.shared === "established" && "共享文件",
                        point.browser === "established" && "浏览器"
                      ]
                        .filter(Boolean)
                        .join(" · ") || "无已建立的组件"}
                    </p>
                    <p className="flex flex-wrap items-center gap-1 text-[11px] leading-5 text-muted-foreground">
                      <GitBranch className="size-3" />
                      {point.managedGit.complete} 个完整 Git 项目
                      {point.managedGit.filesOnly > 0 && (
                        <> · {point.managedGit.filesOnly} 个仅文件目录</>
                      )}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={locked}
                      onClick={() =>
                        select({
                          action: "restore",
                          nonce: crypto.randomUUID(),
                          checkpoint: { id: point.id, sha256: point.sha256 }
                        })
                      }
                    >
                      恢复
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`删除 ${new Date(point.createdAt).toLocaleString()} 的电脑检查点`}
                      disabled={locked}
                      onClick={() =>
                        select({
                          action: "delete",
                          checkpoint: { id: point.id, sha256: point.sha256 }
                        })
                      }
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </section>
          <section aria-label="已恢复的代码成果" className="space-y-3">
            <div>
              <h3 className="text-sm font-medium">已恢复的代码成果</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {deliverables ? `${deliverables.length} 份` : "正在读取…"}
                {" · "}代码保存在独立目录中，请核对后另存；删除原现场不会删除这些代码。
              </p>
            </div>
            {deliverables?.length === 0 && (
              <p className="py-2 text-xs text-muted-foreground">暂无恢复的代码成果</p>
            )}
            {deliverables?.map((code) => (
              <div
                key={code.id}
                data-testid={`computer-deliverables-${code.id}`}
                className="flex items-center gap-2 rounded-xl border p-3"
              >
                <GitBranch className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium">
                    代码成果 {code.id.slice(0, 8)} · {code.projects} 个项目
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    来自检查点 {code.checkpoint.id.slice(0, 8)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void reveal(code.id, "deliverables")}
                >
                  打开代码成果
                </Button>
              </div>
            ))}
          </section>
          <section aria-label="恢复前原现场" className="space-y-3">
            <div>
              <h3 className="text-sm font-medium">恢复前原现场</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {copies ? `${copies.length} / ${BOT_COMPUTER_RECOVERY_COPY_LIMIT} 份` : "正在读取…"}{" "}
                · 每次恢复前保留一份原现场，便于核对被替换的文件。
              </p>
            </div>
            {copies && copies.length >= BOT_COMPUTER_RECOVERY_COPY_LIMIT && (
              <p className="text-xs leading-5 text-muted-foreground">
                原现场已达到上限，请先核对并清理一份，再发起新的恢复。
              </p>
            )}
            {copies?.length === 0 && (
              <p className="py-2 text-xs text-muted-foreground">暂无恢复前原现场</p>
            )}
            {copies?.map((copy) => {
              const point = checkpoints?.find(
                (candidate) =>
                  candidate.id === copy.checkpoint.id && candidate.sha256 === copy.checkpoint.sha256
              )
              return (
                <div
                  key={copy.id}
                  className="flex flex-wrap items-center gap-2 rounded-xl border p-3"
                >
                  <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium">原现场 {copy.id.slice(0, 8)}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      恢复检查点 {copy.checkpoint.id.slice(0, 8)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void reveal(copy.id)}
                  >
                    打开原现场
                  </Button>
                  {hasManagedGit(point) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void reveal(copy.id, "deliverables")}
                    >
                      打开代码成果
                    </Button>
                  )}
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`删除原现场 ${copy.id.slice(0, 8)}`}
                    disabled={locked}
                    onClick={() =>
                      select({
                        action: "delete-recovery",
                        checkpoint: { id: copy.id, sha256: copy.sha256 }
                      })
                    }
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              )
            })}
          </section>
          {request && (
            <section
              aria-label="确认电脑维护"
              className="space-y-3 rounded-xl border bg-muted/20 p-3"
            >
              <h3 className="text-[13px] font-medium">
                {submitted ? "核对上次操作" : labels[request.action]}
              </h3>
              <p className="text-xs leading-5 text-muted-foreground">
                {submitted
                  ? "上次请求尚未确认。继续会核对同一请求，不会新建检查点或重复恢复。"
                  : request.action === "create"
                    ? "保存当前 Bot 工作环境；后台会暂时断开，请先完成运行中的任务并关闭正在编辑这些文件的程序。"
                    : request.action === "restore"
                      ? `恢复至${selected ? new Date(selected.createdAt).toLocaleString() : "所选检查点"}。之后的 Bot 数据、共享文件和浏览器变化将被替换，旧任务停止，例程、Webhook 和备份计划关闭。项目成果恢复到新的独立目录，需人工核对后继续；已提交的外部操作不会撤回。`
                      : request.action === "delete"
                        ? "删除所选检查点，无法撤销；当前工作环境不受影响。"
                        : "删除这份恢复前原现场，无法撤销。请先核对目录中的文件；正在恢复的原现场不能删除。"}
              </p>
              <div className="flex justify-end gap-2">
                {!submitted && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setRequest(null)
                      setError(null)
                    }}
                  >
                    取消
                  </Button>
                )}
                <Button
                  ref={confirm}
                  size="sm"
                  variant={
                    request.action === "delete" || request.action === "delete-recovery"
                      ? "destructive"
                      : "default"
                  }
                  disabled={busy}
                  onClick={() => void execute()}
                >
                  {busy ? (
                    <LoaderCircle className="mr-1.5 size-3.5 animate-spin motion-reduce:animate-none" />
                  ) : request.action === "restore" ? (
                    <RotateCcw className="mr-1.5 size-3.5" />
                  ) : null}
                  {busy ? "正在处理…" : submitted ? "核对原请求" : "确认操作"}
                </Button>
              </div>
            </section>
          )}
          {busy && progress && (
            <p role="status" className="text-xs text-muted-foreground">
              {phases[progress.phase]} · {components[progress.component]} ·{" "}
              {progress.entries.toLocaleString()} 项 · {formatAttachmentBytes(progress.bytes)}
            </p>
          )}
          {status && (
            <p
              role="status"
              className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"
            >
              <Check className="mt-0.5 size-3.5 shrink-0" />
              {status}
            </p>
          )}
          {restoreReceipt && hasManagedGit(restoredPoint) && (
            <section aria-label="恢复的代码成果" className="space-y-2 rounded-xl border p-3">
              <p className="text-xs leading-5 text-muted-foreground">
                代码已恢复到新的独立目录，与恢复前原现场分别保存。请核对后另存，再继续开发。
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void reveal(restoreReceipt.recoveryCopy, "deliverables")}
              >
                <GitBranch className="mr-1.5 size-3.5" />
                打开恢复的代码成果
              </Button>
            </section>
          )}
          {error && (
            <div role="alert" className="rounded-xl border border-destructive/25 p-3">
              <BotErrorNoticeBody
                notice={error}
                hint={
                  submitted
                    ? "保留原请求；关闭此窗口后仍可继续核对。"
                    : syncFailed
                      ? "恢复已确认，只需重连后台，不会再次恢复。"
                      : undefined
                }
              >
                {syncFailed && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void retryConnection()}
                  >
                    重试连接
                  </Button>
                )}
              </BotErrorNoticeBody>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 border-t px-6 py-3">
          <p className="text-[11px] text-muted-foreground">检查点仅用于这台电脑的 Bot 工作环境</p>
          <Button size="sm" variant="outline" disabled={busy} onClick={close}>
            关闭
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function CorruptMaintenanceRecord({ raw, repaired }: { raw: string; repaired(): void }) {
  const [saved, setSaved] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [copying, setCopying] = useState(false)
  const [error, setError] = useState<BotErrorNotice | null>(null)
  const instance = useRef({ active: false, generation: 0 })
  const download = useRef<{ url: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  useLayoutEffect(() => {
    const current = instance.current
    current.active = true
    current.generation++
    setSaved(false)
    setDownloaded(false)
    setCopying(false)
    setError(null)
    return () => {
      current.active = false
      current.generation++
      if (download.current) {
        clearTimeout(download.current.timer)
        URL.revokeObjectURL(download.current.url)
        download.current = null
      }
    }
  }, [raw])
  async function copy() {
    if (copying) return
    const generation = instance.current.generation
    setCopying(true)
    try {
      if (!navigator.clipboard?.writeText) throw new Error("剪贴板不可用，请保存原始记录。")
      await navigator.clipboard.writeText(raw)
      if (instance.current.active && generation === instance.current.generation) {
        setSaved(true)
        setError(null)
      }
    } catch (failure) {
      if (instance.current.active && generation === instance.current.generation)
        setError(botErrorNotice(failure, "复制失败，原记录仍保留"))
    } finally {
      if (instance.current.active && generation === instance.current.generation) setCopying(false)
    }
  }
  function save() {
    try {
      if (download.current) {
        clearTimeout(download.current.timer)
        URL.revokeObjectURL(download.current.url)
      }
      const url = URL.createObjectURL(new Blob([raw], { type: "text/plain;charset=utf-8" }))
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = "cmbdevclaw-computer-operation-record.txt"
      anchor.click()
      download.current = {
        url,
        timer: setTimeout(() => {
          URL.revokeObjectURL(url)
          download.current = null
        }, 1000)
      }
      setDownloaded(true)
      setError(null)
    } catch (failure) {
      setError(botErrorNotice(failure, "原始记录保存失败，原记录仍保留"))
    }
  }
  function clear() {
    if (!saved || copying) return
    try {
      if (!discardCorruptComputerMaintenance(raw))
        setError({ message: "操作记录已变化，请重新读取后核对。" })
      repaired()
    } catch (failure) {
      setError(botErrorNotice(failure, "原记录未能清理"))
    }
  }
  return (
    <section
      aria-label="修复损坏的操作记录"
      className="space-y-3 rounded-xl border border-destructive/25 p-3"
    >
      <h3 className="text-[13px] font-medium">本机操作记录损坏</h3>
      <p className="text-xs leading-5 text-muted-foreground">
        原始记录共 {raw.length.toLocaleString()}{" "}
        个字符，无法用于核对。请先复制或保存原始记录，再确认清理；清理后不会自动重做任何操作。
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={copying} onClick={() => void copy()}>
          <Copy className="mr-1.5 size-3.5" />
          {copying ? "正在复制…" : saved ? "已复制原始记录" : "复制原始记录"}
        </Button>
        <Button size="sm" variant="outline" disabled={copying} onClick={save}>
          <Download className="mr-1.5 size-3.5" />
          保存原始记录
        </Button>
      </div>
      {downloaded && !saved && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={saved}
            onChange={(event) => setSaved(event.target.checked)}
          />
          我已确认原始记录保存成功
        </label>
      )}
      <Button size="sm" variant="destructive" disabled={!saved || copying} onClick={clear}>
        确认清理损坏记录
      </Button>
      {error && (
        <div role="alert">
          <BotErrorNoticeBody notice={error} />
        </div>
      )}
    </section>
  )
}
