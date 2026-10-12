import { botApi } from "@/lib/bot-api"
import { useEffect, useState } from "react"
import { Check, ChevronDown, ChevronUp, Loader2, RotateCcw } from "lucide-react"
import { BotEffectDetails } from "./BotEffectDetails"
import { Button } from "@/components/ui/button"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { pendingBotRecoveryStore } from "@/lib/bot-recovery-pending"
import { useBotEpochOperation } from "@/lib/use-bot-epoch-operation"
import { verifiesBotRecovery } from "@/lib/bot-run-operation-receipt"
import { botEffectResultPreview } from "@/lib/bot-effect-result-preview"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"
import type { PendingBotRecovery } from "../../../../shared/bot-recovery"
import type { BotEffect, BotRun, BotRecoveryInput } from "../../../../shared/bot-types"

const inputClass =
  "w-full resize-y rounded-xl border border-input bg-background px-3 py-2 text-sm leading-relaxed outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
const rejected = [
  "invalid_input",
  "revision_conflict",
  "not_found",
  "nonce_conflict",
  "review_required",
  "service_stopping",
  "group_epoch",
  "workflow_child_review",
  "workflow_child_scope"
] as const

type Props = {
  run: BotRun
  close(): void
  refresh(): Promise<void>
}
export function BotRecovery(props: Props) {
  return <BotRecoveryForm key={props.run.id} {...props} />
}
function BotRecoveryForm({ run, close, refresh }: Props) {
  const supported = useBotWorkspaceStore((state) =>
    ["recovery-receipts", "mutation-data-epoch-v2"].every((capability) =>
      state.host?.capabilities?.includes(capability)
    )
  )
  const operation = useBotEpochOperation<PendingBotRecovery, BotRun>({
    scope: JSON.stringify([run.id, run.botId, run.conversationId, run.threadRootId]),
    pending: {
      inspect: (epoch) => pendingBotRecoveryStore.inspect(run.id, epoch),
      remember: pendingBotRecoveryStore.remember,
      acknowledge: pendingBotRecoveryStore.acknowledge,
      discard: (epoch, raw) => pendingBotRecoveryStore.discard(run.id, epoch, raw)
    },
    matchesInput: (input) => input.id === run.id,
    verifies: (input, receipt) => verifiesBotRecovery(run, input, receipt),
    change: botApi.recover,
    definitiveErrors: rejected,
    onConfirmed: async (_receipt, live) => {
      if (!live()) return
      await refresh()
      if (live()) close()
    }
  })
  const { pending, busy, restored, epoch, isCurrent, retire } = operation
  const [detail, setDetail] = useState<string | null>(null)
  const [loadRetry, setLoadRetry] = useState(0)
  const [loadedEffects, setLoadedEffects] = useState<{ key: string; value: BotEffect[] } | null>(
    null
  )
  const effectsKey = JSON.stringify([run.id, loadRetry])
  const effects = loadedEffects?.key === effectsKey ? loadedEffects.value : null
  const [resolutions, setResolutions] = useState<
    Record<string, { outcome: "succeeded" | "failed"; note: string }>
  >(() => Object.fromEntries(pending?.effects.map((effect) => [effect.id, effect]) ?? []))
  const [note, setNote] = useState(pending?.note ?? ""),
    [readError, setReadError] = useState<string | null>(null)
  useEffect(() => {
    if (!supported || busy || restored) return
    let disposed = false
    void Promise.all([botApi.effects(run.id), botApi.status()])
      .then(([value, host]) => {
        if (disposed || !isCurrent()) return
        if (host.dataEpoch !== epoch) {
          retire()
          return
        }
        setLoadedEffects({ key: effectsKey, value })
        setReadError(null)
      })
      .catch((failure: unknown) => {
        if (!disposed && isCurrent())
          setReadError(failure instanceof Error ? failure.message : "记录读取失败")
      })
    return () => {
      disposed = true
    }
  }, [run.id, effectsKey, supported, busy, restored, epoch, isCurrent, retire])
  const error = restored ? null : operation.error || readError
  const unresolved =
    effects?.filter((effect) => ["started", "unknown"].includes(effect.status)) ?? []
  const ready = Boolean(
    effects &&
    note.trim() &&
    unresolved.every(
      (effect) =>
        resolutions[effect.id]?.note.trim() &&
        ["succeeded", "failed"].includes(resolutions[effect.id].outcome)
    )
  )
  const fieldsDisabled = operation.fieldsDisabled || !supported
  const submit = async (decision?: BotRecoveryInput["decision"]) => {
    if (!supported || (!pending && !operation.acknowledged && (!ready || !decision))) return
    await operation.save(() => ({
      id: run.id,
      revision: run.revision,
      nonce: crypto.randomUUID(),
      dataEpoch: epoch,
      decision: decision!,
      note,
      effects: unresolved.map((effect) => ({ id: effect.id, ...resolutions[effect.id] }))
    }))
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !operation.isSaving()) close()
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="shrink-0 px-6 pb-4 pt-6 text-left">
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <RotateCcw size={19} />
          </div>
          <DialogTitle>核对中断的任务</DialogTitle>
          <DialogDescription>
            确认外部系统中的实际结果，再决定继续或结束。已确认完成的操作不会重复提交。
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto px-6 pb-5">
          {!supported && (
            <p role="alert" className="text-sm text-muted-foreground">
              请更新并重启 Bot 后台后再核对任务。
            </p>
          )}
          {restored && (
            <p role="alert" className="text-sm text-destructive">
              工作区数据已恢复，请关闭后重新核对任务。
              {operation.record.kind !== "empty" && !operation.acknowledged && "原操作记录仍保留。"}
            </p>
          )}
          {operation.blocked && (
            <BotPendingSaveRecovery
              record={operation.record}
              dataEpoch={epoch}
              discard={operation.discard}
              onRepaired={operation.refreshRecord}
              operationLabel="核对"
            />
          )}
          {operation.acknowledged && (
            <p role="status" className="text-sm text-muted-foreground">
              原核对结果已确认，重试只清理本机记录并同步当前任务。
            </p>
          )}
          {pending && !busy && !restored && (
            <p role="status" className="rounded-xl bg-muted/60 px-3 py-2 text-sm leading-relaxed">
              提交结果尚未确认，已保留原核对内容。点击下方按钮确认，不会重复恢复任务。
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {!effects && readError && !restored && (
            <Button
              variant="outline"
              disabled={busy || restored}
              onClick={() => {
                if (isCurrent()) {
                  setReadError(null)
                  setLoadRetry((n) => n + 1)
                }
              }}
            >
              重新读取记录
            </Button>
          )}
          {!effects && !error && !restored && supported && (
            <p className="text-sm">正在读取执行记录…</p>
          )}
          {effects && effects.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {effects.length} 项操作 · {unresolved.length} 项待核对
            </p>
          )}
          {effects?.map((effect, index) => (
            <section
              key={effect.id}
              className="space-y-3 rounded-2xl border border-border/70 p-4 text-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium">操作 {index + 1}</p>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-expanded={detail === effect.id}
                  onClick={() => setDetail((id) => (id === effect.id ? null : effect.id))}
                >
                  {detail === effect.id ? "收起详情" : "查看操作与审批"}
                  {detail === effect.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </Button>
              </div>
              {detail === effect.id && (
                <BotEffectDetails
                  key={effect.id}
                  address={{
                    conversationId: run.conversationId,
                    runId: run.id,
                    threadRootId: run.threadRootId
                  }}
                  effectId={effect.id}
                />
              )}
              {detail !== effect.id && (
                <p className="whitespace-pre-wrap break-words text-muted-foreground">
                  {botEffectResultPreview(effect.result)}
                </p>
              )}
              {["started", "unknown"].includes(effect.status) ? (
                <>
                  <Select
                    disabled={fieldsDisabled}
                    value={resolutions[effect.id]?.outcome ?? ""}
                    onValueChange={(outcome: "succeeded" | "failed") =>
                      setResolutions((current) => ({
                        ...current,
                        [effect.id]: {
                          outcome,
                          note: current[effect.id]?.note ?? ""
                        }
                      }))
                    }
                  >
                    <SelectTrigger
                      aria-label={`操作 ${index + 1} 的实际结果`}
                      className="w-full rounded-xl"
                    >
                      <SelectValue placeholder="请选择实际结果" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="succeeded">已完成，禁止重复</SelectItem>
                      <SelectItem value="failed">确认未完成</SelectItem>
                    </SelectContent>
                  </Select>
                  <textarea
                    aria-label="操作核对依据"
                    className={inputClass}
                    rows={2}
                    maxLength={8000}
                    placeholder="记录你在目标系统中确认的结果"
                    disabled={fieldsDisabled || !resolutions[effect.id]}
                    value={resolutions[effect.id]?.note ?? ""}
                    onChange={(event) =>
                      setResolutions((current) => ({
                        ...current,
                        [effect.id]: { ...current[effect.id], note: event.target.value }
                      }))
                    }
                  />
                </>
              ) : (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Check size={14} />
                  {effect.status === "succeeded" ? "已确认完成" : "已确认失败"}
                </p>
              )}
            </section>
          ))}
          {effects?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              没有结果不明的外部操作记录，可以从已保存进度继续。
            </p>
          )}
          <label className="block space-y-2 text-sm">
            <span className="font-medium">核对说明</span>
            <textarea
              aria-label="任务核对说明"
              className={inputClass}
              rows={3}
              placeholder="填写核对说明"
              value={note}
              maxLength={8000}
              disabled={fieldsDisabled}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border/60 px-6 py-4">
          {pending || operation.acknowledged ? (
            <Button disabled={operation.saveDisabled || !supported} onClick={() => void submit()}>
              {busy && <Loader2 size={15} className="animate-spin" />}
              {busy ? "确认中…" : operation.acknowledged ? "同步已确认任务" : "确认上次提交"}
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={fieldsDisabled || !ready}
                onClick={() => void submit("cancel")}
              >
                结束任务
              </Button>
              <Button disabled={fieldsDisabled || !ready} onClick={() => void submit("resume")}>
                继续任务
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
