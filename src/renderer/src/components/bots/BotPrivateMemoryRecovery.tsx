import type { BotPrivateMemorySession } from "@/lib/use-bot-private-memory-mutation"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"
import { Button } from "@/components/ui/button"
export function BotPrivateMemoryRecovery({ session }: { session: BotPrivateMemorySession }) {
  return (
    <>
      {!session.supported && (
        <p role="alert" className="text-xs text-muted-foreground">
          请更新 Bot 后台后修改记忆，原内容保持不变。
        </p>
      )}
      {session.restored && (
        <p role="alert" className="text-xs text-muted-foreground">
          工作区数据已恢复，请重新打开核对原记忆操作。
        </p>
      )}
      <BotPendingSaveRecovery
        record={session.record}
        dataEpoch={session.epoch}
        discard={session.discard}
        onRepaired={session.refreshRecord}
        operationLabel="记忆操作"
      />
      {(session.pending || session.acknowledged) && (
        <div role="status" className="space-y-2 rounded-lg border p-3 text-xs">
          <p>
            {session.acknowledged
              ? "原记忆操作已确认，重试只核对本机记录和当前列表。"
              : "有一次记忆操作尚未确认，重试只提交原请求。"}
          </p>
          {session.pending && (
            <p className="break-all text-muted-foreground">
              {session.pending.operation === "delete"
                ? "删除"
                : session.pending.request.id
                  ? "修订"
                  : "新增"}{" "}
              · {session.pending.request.id ?? "新记忆"}
            </p>
          )}
          <Button
            type="button"
            size="sm"
            disabled={session.saveDisabled}
            onClick={() => void session.saveMemory()}
          >
            核对原记忆操作
          </Button>
        </div>
      )}
      {session.error && !session.restored && (
        <p role="alert" className="text-xs text-destructive">
          {session.error}
        </p>
      )}
    </>
  )
}
