import { botApi } from "@/lib/bot-api"
import { useBotViewVisibility } from "@/lib/use-bot-view-visibility"
import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowLeft, ChevronLeft, ChevronRight, LoaderCircle, Square, Terminal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { pendingShellStopStore } from "@/lib/bot-shell-pending"
import { useBotEpochOperation } from "@/lib/use-bot-epoch-operation"
import { matchesShellJobAddress, verifiesShellStop } from "@/lib/bot-run-operation-receipt"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"
import { BotDomainError } from "../../../../shared/bot-types"
import type {
  BotShellJobRead,
  BotShellJobStop,
  BotShellJobView
} from "../../../../shared/bot-shell-jobs"

const labels: Record<BotShellJobView["status"], string> = {
  queued: "等待执行",
  running: "运行中",
  cancelling: "正在停止",
  succeeded: "已完成",
  failed: "命令失败",
  cancelled: "已取消",
  needs_review: "结果待核对"
}
interface Props {
  address: Omit<BotShellJobRead, "offset">
  close(): void
  back(): void
}
export function BotShellJob(props: Props) {
  const { conversationId, runId, threadRootId, jobId } = props.address
  return (
    <BotShellJobForm
      key={JSON.stringify([conversationId, runId, threadRootId, jobId])}
      {...props}
    />
  )
}
function BotShellJobForm({ address, close, back }: Props) {
  const viewVisible = useBotViewVisibility()
  const supported = useBotWorkspaceStore(
    (state) =>
      Boolean(
        state.host?.capabilities?.includes("shell-job-controls-v1") ||
        state.host?.capabilities?.includes("background-shell-jobs")
      ) && state.host?.capabilities?.includes("mutation-data-epoch-v2") === true
  )
  const { conversationId, runId, threadRootId, jobId } = address
  const [offset, setOffset] = useState(0)
  const [loaded, setLoaded] = useState<{ key: string; value: BotShellJobView } | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const reading = useRef(0)
  const key = JSON.stringify([conversationId, runId, threadRootId, jobId, offset])
  const value = loaded?.key === key ? loaded.value : null
  const operation = useBotEpochOperation<BotShellJobStop, BotShellJobView>({
    scope: JSON.stringify([conversationId, runId, threadRootId, jobId]),
    pending: {
      inspect: (epoch) => pendingShellStopStore.inspect(jobId, epoch, address),
      remember: pendingShellStopStore.remember,
      acknowledge: pendingShellStopStore.acknowledge,
      discard: (epoch, raw) => pendingShellStopStore.discard(jobId, epoch, raw)
    },
    matchesInput: (input) =>
      input.jobId === jobId &&
      input.conversationId === conversationId &&
      input.runId === runId &&
      input.threadRootId === threadRootId,
    verifies: verifiesShellStop,
    change: botApi.stopShellJob,
    definitiveErrors: [
      "revision_conflict",
      "invalid_input",
      "shell_job_scope",
      "run_scope",
      "not_found",
      "nonce_conflict"
    ],
    onConfirmed: async (_receipt, live) => {
      if (live()) await readCurrent(live)
    }
  })
  const { pending, busy, restored, epoch, isCurrent, retire } = operation
  const readCurrent = useCallback(
    async (shouldApply: () => boolean) => {
      if (!shouldApply() || !isCurrent()) return
      const request = ++reading.current,
        next = await botApi.shellJob({ conversationId, runId, threadRootId, jobId, offset })
      if (!shouldApply() || !isCurrent() || request !== reading.current) return
      if (!matchesShellJobAddress({ conversationId, runId, threadRootId, jobId }, next))
        throw new Error("命令记录与当前任务不一致，请重新打开核对。")
      if (next.dataEpoch === undefined) {
        setReadError("后台未提供数据版本，请更新 Bot 后台后再停止命令。")
      } else if (next.dataEpoch !== epoch) {
        retire()
        throw new BotDomainError("data_epoch", "工作区数据已恢复，请重新打开命令记录。")
      } else setReadError(null)
      setLoaded({ key, value: next })
    },
    [conversationId, runId, threadRootId, jobId, offset, key, epoch, isCurrent, retire]
  )
  useEffect(() => {
    if (!viewVisible || busy || restored) return
    let disposed = false,
      timer: ReturnType<typeof setTimeout>
    const read = async () => {
      try {
        await readCurrent(() => !disposed)
      } catch (cause) {
        if (!disposed && isCurrent())
          setReadError(cause instanceof Error ? cause.message : "命令输出读取失败")
      } finally {
        if (!disposed) timer = setTimeout(() => void read(), 1500)
      }
    }
    void read()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [readCurrent, retry, viewVisible, busy, restored, isCurrent])
  const stop = async () => {
    if (
      !supported ||
      (!pending && !operation.acknowledged && (!value || value.dataEpoch !== epoch))
    )
      return
    ++reading.current
    await operation.save(() => ({
      ...address,
      revision: value!.revision,
      dataEpoch: epoch,
      nonce: crypto.randomUUID()
    }))
  }
  const error = restored ? null : operation.error || readError
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col gap-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal size={18} />
            {value?.keepAlive ? "后台服务" : "后台命令"}
          </DialogTitle>
          <DialogDescription>
            {value?.keepAlive
              ? "回复结束后继续运行，直至到期、手动停止或后台关闭。"
              : "查看实时输出与退出结果。"}
            停止不会撤销已经产生的修改。
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-2">
          <Button size="sm" variant="ghost" onClick={back}>
            <ArrowLeft size={14} />
            返回任务
          </Button>
          <span role="status" className="text-xs text-muted-foreground">
            {value ? (value.reviewed ? "人工已核对" : labels[value.status]) : "正在读取…"}
            {value?.exitCode != null ? ` · 退出码 ${value.exitCode}` : ""}
          </span>
          {(pending ||
            operation.acknowledged ||
            (value && ["queued", "running"].includes(value.status))) && (
            <Button
              size="sm"
              variant="outline"
              disabled={
                operation.saveDisabled ||
                !supported ||
                (!pending && !operation.acknowledged && value?.dataEpoch !== epoch)
              }
              onClick={() => void stop()}
            >
              {busy ? (
                <LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" />
              ) : (
                <Square size={13} />
              )}
              {busy
                ? "确认停止中…"
                : operation.acknowledged
                  ? "同步停止结果"
                  : pending
                    ? "确认停止结果"
                    : "停止命令"}
            </Button>
          )}
        </div>
        {restored && (
          <p role="alert" className="text-sm text-destructive">
            工作区数据已恢复，请关闭后重新打开命令记录。
            {operation.record.kind !== "empty" && !operation.acknowledged && "原操作记录仍保留。"}
          </p>
        )}
        {!supported && (
          <p role="alert" className="text-sm text-muted-foreground">
            请更新并重启 Bot 后台后再停止命令。
          </p>
        )}
        {operation.blocked && (
          <BotPendingSaveRecovery
            record={operation.record}
            dataEpoch={epoch}
            discard={operation.discard}
            onRepaired={operation.refreshRecord}
            operationLabel="停止"
          />
        )}
        {operation.acknowledged && (
          <p role="status" className="text-xs text-muted-foreground">
            原停止请求已确认，重试只核对本机记录和当前命令状态。
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {readError && !restored && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              if (isCurrent()) setRetry((n) => n + 1)
            }}
          >
            重新读取命令记录
          </Button>
        )}
        {pending && (
          <p className="text-xs text-muted-foreground">
            停止请求已保留。若连接中断，可确认原请求的处理结果。
          </p>
        )}
        {value?.status === "needs_review" && !value.reviewed && (
          <p className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-sm">
            命令执行中断，已保留收到的输出。请在对应任务中核对项目修改后决定是否继续。
          </p>
        )}
        <pre
          className="max-h-24 shrink-0 overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-xs"
          aria-label="执行命令"
        >
          {value?.command}
        </pre>
        <pre
          className="min-h-40 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-border/70 bg-background p-4 font-mono text-xs leading-6 selection:bg-primary/20"
          aria-label="命令输出"
        >
          {value?.output || "等待命令输出…"}
        </pre>
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>
            第 {Math.floor(offset / 16000) + 1} 页
            {value?.truncated ? " · 输出达到保存上限，已截断" : ""}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={!offset || restored || busy}
              onClick={() => setOffset((n) => Math.max(0, n - 16000))}
            >
              <ChevronLeft size={14} />
              上一页
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={value?.nextOffset == null || restored || busy}
              onClick={() => {
                if (value?.nextOffset != null) setOffset(value.nextOffset)
              }}
            >
              下一页
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
