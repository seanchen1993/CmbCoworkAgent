import { Button } from "@/components/ui/button"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"
import type { BotSkillSaveSession } from "@/lib/use-bot-skill-save"

export function BotSkillSaveStatus({
  session,
  retry = false
}: {
  session: BotSkillSaveSession
  retry?: boolean
}) {
  return (
    <>
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
          className="mt-3 space-y-2 rounded-lg border border-border/70 bg-muted/25 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
        >
          <p>
            {session.acknowledged
              ? "保存结果已确认。重试只同步列表和核对本机记录。"
              : `「${session.pending?.name}」的保存尚未确认。重试使用原内容${session.pending?.version ? `和版本 ${session.pending.version}` : ""}，不会重复创建或修改。`}
          </p>
          {retry && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={session.busy || session.restored || !session.supported}
              onClick={() => void session.save()}
            >
              重试核对保存
            </Button>
          )}
        </div>
      )}
      {(!session.supported || session.restored) && (
        <p role="alert" className="mt-2 text-xs text-muted-foreground">
          {session.restored
            ? "数据已恢复，请关闭后重新打开技能面板。"
            : "当前 Bot 服务暂不支持可靠保存，请更新服务后重试。"}
        </p>
      )}
      {session.error && (
        <p role="alert" className="mt-2 text-xs leading-relaxed text-destructive">
          {session.error}
        </p>
      )}
    </>
  )
}
