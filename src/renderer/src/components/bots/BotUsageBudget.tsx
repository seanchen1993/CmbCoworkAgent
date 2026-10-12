import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Gauge, LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Dialog, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { botApi } from "@/lib/bot-api"
import { useBotViewVisibility } from "@/lib/use-bot-view-visibility"
import { pendingBotBudgetStore } from "@/lib/bot-budget-pending"
import { useBotSettingsSave } from "@/lib/use-bot-settings-save"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import type {
  BotUsageBudgetChange,
  BotUsageBudgetPolicy,
  BotUsageBudgetView
} from "../../../../shared/bot-usage-budget"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"
import { BotDialogContent } from "./BotDialog"
import { BotModelUsage } from "./BotModelUsage"

export function BotUsageBudget({
  bots,
  close
}: {
  bots: { id: string; name: string }[]
  close(): void
}) {
  const [scope, setScope] = useState("user")
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <BotDialogContent className="flex max-h-[calc(100dvh-48px)] flex-col sm:max-w-xl">
        <DialogHeader className="shrink-0 text-left">
          <DialogTitle className="flex items-center gap-2">
            <Gauge className="size-5" />
            用量与额度
          </DialogTitle>
          <DialogDescription>
            查看过去 24 小时的模型调用，设置工作区或单个 Bot 的输出上限。
          </DialogDescription>
        </DialogHeader>
        <Select value={scope} onValueChange={setScope}>
          <SelectTrigger aria-label="用量范围">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="user">所有 Bot</SelectItem>
            {bots.map((bot) => (
              <SelectItem key={bot.id} value={bot.id}>
                {bot.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="-mx-1 min-h-0 overflow-y-auto overscroll-contain px-1">
          <BudgetScope key={scope} botId={scope === "user" ? null : scope} />
        </div>
      </BotDialogContent>
    </Dialog>
  )
}

function BudgetScope({ botId }: { botId: string | null }) {
  const visible = useBotViewVisibility()
  const session = useBotSettingsSave<
    BotUsageBudgetChange,
    BotUsageBudgetView,
    BotUsageBudgetPolicy
  >({
    botId,
    pending: pendingBotBudgetStore,
    read: (id) => botApi.usageBudget({ botId: id }),
    change: botApi.changeUsageBudget,
    verifies: (input, receipt) =>
      receipt.botId === input.botId &&
      receipt.revision === input.revision + 1 &&
      receipt.outputLimit === input.outputLimit
  })
  const { value: view, pending, busy, error, saved: notice, load, restored } = session
  const [draft, setDraft] = useState<{
    revision: number
    enabled: boolean
    limit: string
    submitted: boolean
  } | null>(null)
  const alive = useRef(false)
  useLayoutEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    if (!visible || busy || restored) return
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
  }, [busy, load, restored, visible])
  const activeDraft =
    draft &&
    (!draft.submitted ||
      session.record.kind !== "empty" ||
      session.acknowledged ||
      draft.revision === view?.revision)
      ? draft
      : null
  const selected = pending?.outputLimit ?? view?.outputLimit
  const enabled = pending
    ? pending.outputLimit !== null
    : (activeDraft?.enabled ?? selected != null)
  const limit = pending
    ? String(pending.outputLimit ?? 1000000)
    : (activeDraft?.limit ?? String(selected ?? 1000000))
  const edit = (next: { enabled?: boolean; limit?: string }) => {
    if (!view || session.fieldsDisabled) return
    setDraft({
      revision: activeDraft?.revision ?? view.revision,
      enabled,
      limit,
      submitted: false,
      ...next
    })
    session.clearSaved()
    session.clearError()
  }
  const valid = !enabled || (/^\d+$/.test(limit) && Number(limit) <= 1_000_000_000)
  const save = async () => {
    if (!view || (!pending && !session.acknowledged && !valid)) return
    if (activeDraft) setDraft({ ...activeDraft, submitted: true })
    const saved = await session.save(() => ({
      botId,
      nonce: crypto.randomUUID(),
      dataEpoch: session.epoch,
      revision: activeDraft?.revision ?? view.revision,
      outputLimit: enabled ? Number(limit) : null
    }))
    if (
      saved &&
      alive.current &&
      useBotWorkspaceStore.getState().snapshot?.dataEpoch === session.epoch
    )
      setDraft(null)
  }
  const disabled = session.fieldsDisabled
  const feedback = (
    <>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          保存操作已确认。
        </p>
      )}
      {restored && (
        <p role="alert" className="text-xs text-destructive">
          数据已恢复，请重新打开用量设置。原操作记录仍保留。
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
      {(pending || session.acknowledged) && !busy && !session.blocked && (
        <p role="status" className="text-xs text-muted-foreground">
          {session.acknowledged
            ? "操作结果已确认，重试只同步当前额度和核对本机记录。"
            : "上次保存结果待确认。请确认后继续修改。"}
        </p>
      )}
    </>
  )
  return (
    <section aria-label="模型输出额度" className="space-y-4">
      {!view && !error && !restored && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          正在读取用量…
        </p>
      )}
      {view && (
        <>
          <div className="grid grid-cols-3 gap-2">
            {[
              ["已报告输出", view.usage.outputTokens.toLocaleString()],
              ["待确认预留", view.usage.reservedOutputTokens.toLocaleString()],
              ["此范围剩余", view.available === null ? "未设上限" : view.available.toLocaleString()]
            ].map(([label, value]) => (
              <div key={label} className="min-w-0 rounded-xl bg-muted/50 p-3">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-2 break-words text-base font-medium tabular-nums">{value}</p>
              </div>
            ))}
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            单位为输出 token。无完整回执的请求保留预留额度，超过 24
            小时后退出统计窗口；这不是费用账单。
          </p>
          <div className="space-y-3 rounded-xl border p-4">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="bot-budget-enabled" className="text-sm font-medium">
                限制输出用量
              </label>
              <Switch
                id="bot-budget-enabled"
                checked={enabled}
                disabled={disabled}
                onCheckedChange={(next) => {
                  edit({ enabled: next })
                }}
              />
            </div>
            {enabled && (
              <div className="space-y-2">
                <label htmlFor="bot-budget-limit" className="text-xs text-muted-foreground">
                  过去 24 小时输出上限
                </label>
                <Input
                  id="bot-budget-limit"
                  inputMode="numeric"
                  maxLength={10}
                  value={limit}
                  disabled={disabled}
                  onChange={(event) => {
                    edit({ limit: event.target.value })
                  }}
                />
                <p className="text-xs text-muted-foreground">设为 0 将阻止新的模型请求。</p>
              </div>
            )}
            <p className="text-xs leading-5 text-muted-foreground">
              修改从下一次模型请求生效。单个 Bot
              同时受总额度和任务额度约束，已发出的请求继续计入用量。
            </p>
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={
                  session.saveDisabled ||
                  (!pending && !session.acknowledged && (!activeDraft || !valid))
                }
                onClick={() => void save()}
              >
                {busy && <LoaderCircle className="mr-2 size-4 animate-spin" />}
                {busy
                  ? "正在保存…"
                  : session.acknowledged
                    ? "同步已保存额度"
                    : pending
                      ? "确认保存结果"
                      : "保存额度"}
              </Button>
            </div>
          </div>
          {feedback}
          <BotModelUsage value={view.usage} />
        </>
      )}
      {!view && feedback}
    </section>
  )
}
