import { useState } from "react"
import { BotCreationReview } from "./BotCreationReview"
import { Dialog, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { BotDialogContent } from "./BotDialog"
import { BotErrorNoticeBody } from "./BotErrorNoticeBody"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"
import type { BotQuickCreateState } from "@/lib/bot-quick-create"

export function BotQuickCreateFeedback({
  state,
  dataEpoch,
  open,
  close,
  retry,
  repair,
  confirmReview,
  onCloseAutoFocus
}: {
  state: BotQuickCreateState
  dataEpoch: string
  open: boolean
  close(): void
  retry(): Promise<void>
  repair(raw: string): boolean
  confirmReview(enabled: boolean): Promise<void>
  onCloseAutoFocus?: (event: Event) => void
}) {
  const [reviewDraft, setReviewDraft] = useState<{
    source: BotQuickCreateState
    enabled: boolean
  } | null>(null)
  const enabled = reviewDraft?.source === state ? reviewDraft.enabled : true
  const configuring = state.phase === "configure"
  if (!state.notice && state.phase !== "blocked" && !configuring) return null
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !state.busy) close()
      }}
    >
      <BotDialogContent className="max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>创建 Bot</DialogTitle>
          <DialogDescription>
            {configuring
              ? "选择新 Bot 执行操作时的审核方式。"
              : "已提交的创建请求会保留，关闭窗口不会撤销操作。"}
          </DialogDescription>
        </DialogHeader>
        {configuring && (
          <BotCreationReview
            enabled={enabled}
            onChange={(next) => setReviewDraft({ source: state, enabled: next })}
          />
        )}
        {state.notice && <BotErrorNoticeBody notice={state.notice} />}
        {state.record && state.phase === "blocked" && (
          <BotPendingSaveRecovery
            key={state.record.kind}
            record={state.record}
            dataEpoch={dataEpoch}
            discard={repair}
            onRepaired={close}
          />
        )}
        <div className="flex justify-end gap-2 border-t border-border/60 pt-4">
          <Button variant="ghost" onClick={close} disabled={state.busy}>
            {configuring ? "取消" : "关闭"}
          </Button>
          {configuring ? (
            <Button onClick={() => void confirmReview(enabled)}>创建 Bot</Button>
          ) : (
            state.phase !== "blocked" && (
              <Button disabled={state.busy} onClick={() => void retry()}>
                {state.busy
                  ? "正在核对…"
                  : state.phase === "sync_failed"
                    ? "重新读取列表"
                    : state.phase === "cleanup_failed"
                      ? "核对已完成操作记录"
                      : state.phase === "uncertain"
                        ? "核对原请求"
                        : "重试"}
              </Button>
            )
          )}
        </div>
      </BotDialogContent>
    </Dialog>
  )
}
