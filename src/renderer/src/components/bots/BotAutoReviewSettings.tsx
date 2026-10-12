import { botApi } from "@/lib/bot-api"
import { useEffect, useState } from "react"
import { LoaderCircle, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { botAutoReviewChange, type BotAutoReviewChange } from "../../../../shared/bot-auto-review"
import { pendingAutoReviewStore } from "@/lib/bot-auto-review-pending"
import { useBotSettingsSave } from "@/lib/use-bot-settings-save"
import { matchesAutoReviewReceipt } from "@/lib/bot-settings-save-receipt"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"

export function BotAutoReviewSettings({ botId }: { botId: string }) {
  const session = useBotSettingsSave<
    BotAutoReviewChange,
    Awaited<ReturnType<typeof botApi.autoReviewSettings>>
  >({
    botId,
    pending: pendingAutoReviewStore,
    read: botApi.autoReviewSettings,
    change: botApi.changeAutoReview,
    verifies: matchesAutoReviewReceipt
  })
  const { value, pending, busy, error, saved, load, restored } = session
  const [reload, setReload] = useState(0)
  const [draft, setDraft] = useState<{
    source: typeof value
    enabled: boolean
    allow: string
    block: string
  } | null>(null)
  const enabled = draft?.source === value ? draft.enabled : (value?.isEnabled ?? false)
  const allow = draft?.source === value ? draft.allow : (value?.allowInstructions.join("\n") ?? "")
  const block = draft?.source === value ? draft.block : (value?.blockInstructions.join("\n") ?? "")
  useEffect(() => {
    let active = true
    if (!restored) void load(() => active)
    return () => {
      active = false
    }
  }, [botId, reload, load, restored])
  async function save() {
    if (!value) return
    await session.save(() => {
      const lines = (text: string) =>
        text
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      const parsed = botAutoReviewChange.safeParse({
        botId,
        revision: value.revision,
        dataEpoch: value.dataEpoch,
        nonce: crypto.randomUUID(),
        isEnabled: enabled,
        allowInstructions: lines(allow),
        blockInstructions: lines(block)
      })
      if (!parsed.success) throw new Error("每组最多 20 条规则，每条不超过 1000 字。请调整后保存。")
      return parsed.data
    })
  }
  const disabled = session.fieldsDisabled
  return (
    <div
      className="min-h-0 space-y-5 overflow-y-auto pb-1"
      aria-label="自动审核设置"
      aria-busy={busy}
    >
      <section className="rounded-xl border bg-muted/20 p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck size={17} />
            独立操作审核
          </div>
          <Switch
            aria-label="启用自动审核"
            checked={enabled}
            disabled={disabled}
            onCheckedChange={(next) => {
              setDraft({ source: value, enabled: next, allow, block })
              session.clearSaved()
            }}
          />
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          使用此 Bot
          配置的模型，单独审核命令、连接器调用、文件修改、浏览器操作、例程变更和协作派发。结论明确时自动批准；无法判断、审核失败或需要你决定时，仍显示审批卡。
        </p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          审核会增加模型调用。敏感输入、坐标操作和授权变更仍需人工确认；工具权限、项目范围与沙箱限制始终生效。
        </p>
      </section>
      <label className="block space-y-2">
        <span className="text-sm font-medium">允许的操作</span>
        <textarea
          className="w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          aria-label="自动审核允许规则"
          value={allow}
          disabled={disabled}
          onChange={(event) => {
            setDraft({ source: value, enabled, allow: event.target.value, block })
            session.clearSaved()
          }}
          rows={3}
          placeholder="例如：允许在项目内修改测试文件并运行测试。"
        />
        <span className="block text-xs text-muted-foreground">
          每行一条，仅在当前任务范围内生效。
        </span>
      </label>
      <label className="block space-y-2">
        <span className="text-sm font-medium">始终先问我</span>
        <textarea
          className="w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          aria-label="自动审核询问规则"
          value={block}
          disabled={disabled}
          onChange={(event) => {
            setDraft({ source: value, enabled, allow, block: event.target.value })
            session.clearSaved()
          }}
          rows={3}
          placeholder="例如：发布、推送代码或修改生产配置前，必须先确认。"
        />
        <span className="block text-xs text-muted-foreground">
          优先于允许规则及已保存的命令授权。每组最多 20 条。
        </span>
      </label>
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 text-sm text-destructive"
        >
          <span>{error}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => setReload((n) => n + 1)}
          >
            重新读取
          </Button>
        </div>
      )}
      {session.restored && (
        <p role="alert" className="text-xs text-destructive">
          工作区数据已恢复，请重新打开自动审核设置。原操作记录仍保留。
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
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
          {session.acknowledged
            ? "操作结果已确认，重试只读取当前设置和核对本机记录。"
            : "上次保存结果尚未确认。请确认原操作后再修改。"}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button disabled={session.saveDisabled} onClick={() => void save()}>
          {busy && <LoaderCircle size={14} className="mr-2 animate-spin" />}
          {session.acknowledged ? "同步已保存设置" : pending ? "确认上次保存" : "保存审核设置"}
        </Button>
        {saved && (
          <span role="status" className="text-xs text-muted-foreground">
            已保存，后续操作按新设置审核。
          </span>
        )}
      </div>
    </div>
  )
}
