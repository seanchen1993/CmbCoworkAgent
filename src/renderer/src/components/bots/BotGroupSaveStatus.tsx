import { Button } from "@/components/ui/button"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"
import type { BotGroupSaveSession } from "@/lib/use-bot-group-save"

export function BotGroupSaveStatus({
  session,
  retry = false
}: {
  session: BotGroupSaveSession
  retry?: boolean
}) {
  return (
    <>
      {!session.supported && (
        <p role="status" className="text-xs leading-relaxed text-muted-foreground">
          请更新 Bot 后台后保存群聊。原记录保持不变。
        </p>
      )}
      {session.blocked && (
        <BotPendingSaveRecovery
          record={session.record}
          dataEpoch={session.epoch}
          discard={session.discard}
          onRepaired={session.refreshRecord}
        />
      )}
      {(session.pending || session.acknowledged) && !session.blocked && (
        <div
          role="status"
          className="space-y-2 rounded-xl border p-3 text-xs leading-relaxed text-muted-foreground"
        >
          <p>
            {session.acknowledged
              ? "群聊保存结果已确认。重试只同步列表和核对本机记录。"
              : `「${session.pending?.name}」的保存尚未确认${session.pending?.revision ? `（原版本 ${session.pending.revision}）` : ""}，共 ${session.pending?.members.length} 位成员。核对使用原请求，关闭页面仍保留记录。`}
          </p>
          {retry && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={session.saveDisabled}
              onClick={() => void session.save()}
            >
              {session.busy ? "正在核对…" : "核对群聊修改"}
            </Button>
          )}
        </div>
      )}
      {session.error && (
        <p role="alert" className="text-xs leading-relaxed text-destructive">
          {session.error}
        </p>
      )}
    </>
  )
}
