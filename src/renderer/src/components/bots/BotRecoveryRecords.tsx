import { useMemo, useState } from "react"
import { Check, LoaderCircle, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { botApi } from "@/lib/bot-api"
import { pendingBotRecoveryIdentities } from "@/lib/bot-recovery-inventory"
import { pendingBotRecoveryStore } from "@/lib/bot-recovery-pending"
import { verifiesBotRecoveryResult } from "@/lib/bot-run-operation-receipt"
import { useBotEpochOperation } from "@/lib/use-bot-epoch-operation"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import type { PendingBotRecovery } from "../../../../shared/bot-recovery"
import type { BotRun } from "../../../../shared/bot-types"
import { BotDialogContent } from "./BotDialog"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"

/** Original identities remain reachable when a task has already resumed or left the active snapshot. */
export function BotRecoveryRecords({ close }: { close(): void }) {
  const dataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const [revision, setRevision] = useState(0)
  const [selection, setSelection] = useState("")
  const refresh = () => setRevision((value) => value + 1)
  const inventory = useMemo(() => {
    try {
      return { ...pendingBotRecoveryIdentities(), error: null }
    } catch (error) {
      return {
        ids: [] as string[],
        hasMore: false,
        error: error instanceof Error ? error.message : "无法读取原恢复记录，请重新打开。"
      }
    }
    // ACK or explicit archive invalidates this bounded storage inventory; no additional index or poller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, dataEpoch])
  const selected = inventory.ids.includes(selection) ? selection : inventory.ids[0]
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <BotDialogContent className="flex max-h-[85vh] max-w-xl flex-col gap-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw size={18} />
            待确认的任务恢复
          </DialogTitle>
          <DialogDescription>
            核对上次提交的恢复请求。即使任务已经继续或结束，也不会重新发起任务。
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto">
          {inventory.error && (
            <p role="alert" className="text-sm text-destructive">
              {inventory.error}
            </p>
          )}
          {!selected && !inventory.error && (
            <div
              role="status"
              className="flex items-center gap-2 rounded-xl bg-muted/40 p-4 text-sm text-muted-foreground"
            >
              <Check size={16} />
              没有待确认的任务恢复
            </div>
          )}
          {selected && (
            <>
              {inventory.ids.length > 1 && (
                <label className="block space-y-2 text-xs text-muted-foreground">
                  选择恢复记录
                  <select
                    aria-label="选择恢复记录"
                    className="w-full rounded-xl border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={selected}
                    onChange={(event) => setSelection(event.target.value)}
                  >
                    {inventory.ids.map((id, index) => (
                      <option key={id} value={id}>
                        恢复记录 {index + 1}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <RecoveryRecord key={`${selected}:${dataEpoch}`} id={selected} changed={refresh} />
              {inventory.hasMore && (
                <p className="text-xs leading-5 text-muted-foreground">
                  当前显示前 {inventory.ids.length} 条记录，处理后会显示其余记录。
                </p>
              )}
            </>
          )}
        </div>
        <div className="flex justify-end border-t border-border/60 pt-3">
          <Button variant="ghost" onClick={close}>
            关闭
          </Button>
        </div>
      </BotDialogContent>
    </Dialog>
  )
}

function RecoveryRecord({ id, changed }: { id: string; changed(): void }) {
  const supported = useBotWorkspaceStore((state) =>
    ["recovery-receipts", "mutation-data-epoch-v2"].every((cap) =>
      state.host?.capabilities?.includes(cap)
    )
  )
  const operation = useBotEpochOperation<PendingBotRecovery, BotRun>({
    scope: `recovery-record:${id}`,
    pending: {
      inspect: (epoch) => pendingBotRecoveryStore.inspect(id, epoch),
      remember: pendingBotRecoveryStore.remember,
      acknowledge: pendingBotRecoveryStore.acknowledge,
      discard: (epoch, raw) => pendingBotRecoveryStore.discard(id, epoch, raw)
    },
    matchesInput: (input) => input.id === id,
    verifies: verifiesBotRecoveryResult,
    change: botApi.recover,
    definitiveErrors: [
      "invalid_input",
      "revision_conflict",
      "not_found",
      "nonce_conflict",
      "review_required",
      "group_epoch",
      "workflow_child_review",
      "workflow_child_scope"
    ],
    onConfirmed: async (_receipt, live) => {
      if (!live()) return
      await useBotWorkspaceStore.getState().refresh()
      if (live()) changed()
    }
  })
  return (
    <section
      aria-label="原任务恢复记录"
      className="space-y-3 rounded-2xl border border-border/70 p-4"
    >
      {!supported && (
        <p role="alert" className="text-sm text-muted-foreground">
          请更新并重启 Bot 后台后再核对任务。
        </p>
      )}
      {operation.restored && (
        <p role="alert" className="text-sm text-destructive">
          工作区数据已恢复，请关闭后重新打开核对。
          {operation.record.kind !== "empty" && !operation.acknowledged && "原记录仍保留。"}
        </p>
      )}
      {operation.blocked && (
        <BotPendingSaveRecovery
          record={operation.record}
          dataEpoch={operation.epoch}
          discard={operation.discard}
          onRepaired={() => {
            operation.refreshRecord()
            changed()
          }}
          operationLabel="核对"
        />
      )}
      {operation.pending && (
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">原决定</dt>
            <dd className="mt-1 font-medium">
              {operation.pending.decision === "resume" ? "继续任务" : "结束任务"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">核对说明</dt>
            <dd className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words leading-6">
              {operation.pending.note}
            </dd>
          </div>
          {!!operation.pending.effects.length && (
            <div>
              <dt className="text-xs text-muted-foreground">操作核对</dt>
              <dd className="mt-1">已记录 {operation.pending.effects.length} 项实际结果</dd>
            </div>
          )}
        </dl>
      )}
      {operation.error && !operation.restored && (
        <p role="alert" className="text-sm text-destructive">
          {operation.error}
        </p>
      )}
      {operation.acknowledged && (
        <p role="status" className="text-xs leading-5 text-muted-foreground">
          原请求已确认，重试只清理本机记录并同步当前任务。
        </p>
      )}
      {(operation.pending || operation.acknowledged) && (
        <Button
          disabled={!supported || operation.saveDisabled}
          onClick={() => void operation.save()}
        >
          {operation.busy && (
            <LoaderCircle size={15} className="animate-spin motion-reduce:animate-none" />
          )}
          {operation.busy
            ? "正在确认…"
            : operation.acknowledged
              ? "同步已确认任务"
              : "确认上次提交"}
        </Button>
      )}
      {operation.record.kind === "empty" && !operation.acknowledged && (
        <p role="status" className="text-sm text-muted-foreground">
          此条恢复记录已处理。
        </p>
      )}
    </section>
  )
}
