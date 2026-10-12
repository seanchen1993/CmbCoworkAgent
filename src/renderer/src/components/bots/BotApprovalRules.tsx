import { botApi } from "@/lib/bot-api"
import { useBotViewVisibility } from "@/lib/use-bot-view-visibility"
import { useEffect, useState } from "react"
import { LoaderCircle, ShieldCheck, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import type { BotApprovalRuleChange } from "../../../../shared/bot-approval-rules"
import { pendingApprovalRuleStore } from "@/lib/bot-approval-pending"
import { useBotSettingsSave } from "@/lib/use-bot-settings-save"
import { matchesApprovalRuleReceipt } from "@/lib/bot-settings-save-receipt"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"
import { BotApprovalContent } from "./BotApprovalContent"
import { BotAutoReviewSettings } from "./BotAutoReviewSettings"

export function BotApprovalRules({
  bot,
  autoReview = false,
  denyRules = false,
  close
}: {
  bot: { id: string; name: string }
  autoReview?: boolean
  denyRules?: boolean
  close(): void
}) {
  const viewVisible = useBotViewVisibility()
  const behaviors: NonNullable<BotApprovalRuleChange["behavior"]>[] = denyRules
    ? ["allow", "ask", "deny"]
    : ["allow", "ask"]
  const session = useBotSettingsSave({
    botId: bot.id,
    pending: pendingApprovalRuleStore,
    read: botApi.approvalRules,
    change: botApi.changeApprovalRule,
    verifies: matchesApprovalRuleReceipt
  })
  const { value, pending, busy, error, load, restored } = session
  const [reload, setReload] = useState(0)
  const [tab, setTab] = useState<"commands" | "review">("commands")
  useEffect(() => {
    if (!viewVisible || busy || restored) return
    let disposed = false,
      timer: ReturnType<typeof setTimeout>
    const read = async () => {
      await load(() => !disposed)
      if (!disposed) timer = setTimeout(() => void read(), 5000)
    }
    void read()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [bot.id, busy, reload, viewVisible, load, restored])
  async function change(ruleId: string, behavior: BotApprovalRuleChange["behavior"]) {
    if (!value) return
    await session.save(() => ({
      botId: bot.id,
      ruleId,
      behavior,
      revision: value.revision,
      dataEpoch: value.dataEpoch,
      nonce: crypto.randomUUID()
    }))
  }
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col" aria-busy={busy}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck size={19} />
            审批规则
          </DialogTitle>
          <DialogDescription>{bot.name} · 管理操作审核与命令授权。</DialogDescription>
        </DialogHeader>
        {autoReview && (
          <div className="flex shrink-0 gap-1 rounded-lg bg-muted p-1">
            <Button
              className="flex-1"
              size="sm"
              variant={tab === "commands" ? "secondary" : "ghost"}
              aria-pressed={tab === "commands"}
              onClick={() => setTab("commands")}
            >
              命令规则
            </Button>
            <Button
              className="flex-1"
              size="sm"
              variant={tab === "review" ? "secondary" : "ghost"}
              aria-pressed={tab === "review"}
              onClick={() => setTab("review")}
            >
              自动审核
            </Button>
          </div>
        )}
        {tab === "review" ? (
          <BotAutoReviewSettings botId={bot.id} />
        ) : (
          <>
            <p className="text-xs leading-relaxed text-muted-foreground">
              规则仅适用于原项目、相同命令与执行参数。Bot
              或执行配置变化后需重新批准；工具权限和沙箱检查始终生效。
            </p>
            {error && (
              <div
                role="alert"
                className="flex items-center justify-between gap-3 text-sm text-destructive"
              >
                {error}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    session.clearError()
                    setReload((n) => n + 1)
                  }}
                >
                  刷新
                </Button>
              </div>
            )}
            {session.restored && (
              <p role="alert" className="text-xs text-destructive">
                工作区数据已恢复，请重新打开审批规则。原操作记录仍保留。
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
            {(pending || session.acknowledged) && !session.blocked && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                <p>
                  {session.acknowledged
                    ? "操作结果已确认，重试只同步当前规则和核对本机记录。"
                    : "上次操作结果尚未确认。确认后才能继续修改规则。"}
                </p>
                <Button
                  className="mt-2"
                  size="sm"
                  disabled={session.saveDisabled}
                  onClick={() => void session.save()}
                >
                  {busy && <LoaderCircle size={14} className="mr-2 animate-spin" />}
                  确认上次操作
                </Button>
              </div>
            )}
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
              {!value && !error && (
                <p className="py-10 text-center text-sm text-muted-foreground">正在读取规则…</p>
              )}
              {value?.rules.length === 0 && (
                <div className="rounded-xl border border-dashed px-6 py-10 text-center">
                  <ShieldCheck className="mx-auto mb-3 text-muted-foreground" size={26} />
                  <p className="text-sm">还没有保存的审批规则</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    为项目命令保存长期规则后，可在这里查看和修改。
                  </p>
                </div>
              )}
              {value?.rules.map((rule) => (
                <section key={rule.id} className="rounded-xl border p-4" aria-label={rule.title}>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <span
                      className={`rounded-full px-2 py-1 text-xs ${rule.behavior === "allow" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : rule.behavior === "deny" ? "bg-red-500/10 text-red-600 dark:text-red-400" : "bg-amber-500/10 text-amber-700 dark:text-amber-400"}`}
                    >
                      {rule.behavior === "allow"
                        ? "始终允许"
                        : rule.behavior === "deny"
                          ? "从不允许"
                          : "每次询问"}
                    </span>
                    <Button
                      aria-label="删除规则"
                      title="删除规则"
                      variant="ghost"
                      size="icon"
                      disabled={session.fieldsDisabled}
                      onClick={() => void change(rule.id, null)}
                    >
                      <Trash2 size={15} />
                    </Button>
                  </div>
                  <BotApprovalContent prompt={rule.prompt} />
                  <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="命令处理方式">
                    {behaviors.map((behavior) => (
                      <Button
                        key={behavior}
                        size="sm"
                        variant={rule.behavior === behavior ? "secondary" : "outline"}
                        aria-pressed={rule.behavior === behavior}
                        disabled={session.fieldsDisabled || rule.behavior === behavior}
                        onClick={() => void change(rule.id, behavior)}
                      >
                        {behavior === "allow"
                          ? "始终允许"
                          : behavior === "deny"
                            ? "从不允许"
                            : "每次询问"}
                      </Button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
