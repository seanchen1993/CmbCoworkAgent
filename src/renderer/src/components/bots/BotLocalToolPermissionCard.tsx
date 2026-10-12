import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Clock3, LoaderCircle, Monitor, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { botApi } from "@/lib/bot-api"
import { useBotSettingsSave } from "@/lib/use-bot-settings-save"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import {
  localToolAnswerPending,
  type LocalToolAnswerSave
} from "@/lib/bot-local-tool-permission-pending"
import type { BotInteraction, BotRun } from "../../../../shared/bot-types"
import type { BotLocalToolCard } from "../../../../shared/bot-local-tool-permission"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"

type CardValue = {
  botId: null
  dataEpoch: string
  revision: number
  interaction: BotInteraction
  card: BotLocalToolCard
}
const resolutions = [
  { value: "allow-once", label: "本次允许", primary: true },
  { value: "deny", label: "拒绝本次", primary: false },
  { value: "always", label: "始终允许", primary: false },
  { value: "never", label: "禁止本机项目访问", primary: false }
] as const
const kindLabel = {
  "run-command": "运行命令",
  "read-file": "读取项目",
  "list-directory": "列出目录",
  "write-file": "修改文件"
}

/** Render only Host-issued metadata, never a model-authored JSON prompt. */
export function BotLocalToolPermissionCard({
  item,
  run,
  refresh
}: {
  item: BotInteraction
  run?: BotRun
  refresh(): Promise<void>
}) {
  return <LocalToolPermissionCardScope key={item.id} item={item} run={run} refresh={refresh} />
}
function LocalToolPermissionCardScope({
  item,
  run,
  refresh
}: {
  item: BotInteraction
  run?: BotRun
  refresh(): Promise<void>
}) {
  const supported = useBotWorkspaceStore((state) =>
    ["local-tool-permission", "mutation-data-epoch-v2"].every((cap) =>
      state.host?.capabilities?.includes(cap)
    )
  )
  const pending = useMemo(() => localToolAnswerPending(item.id), [item.id])
  const life = useRef({ mounted: true })
  useLayoutEffect(() => {
    const owner = life.current
    owner.mounted = true
    return () => {
      owner.mounted = false
    }
  }, [])
  const session = useBotSettingsSave<LocalToolAnswerSave, CardValue, BotInteraction>({
    botId: null,
    pending,
    read: async () => {
      if (!run) throw new Error("任务信息尚未加载，请重新打开许可卡片。")
      const detail = await botApi.interactionDetail({
        conversationId: run.conversationId,
        runId: run.id,
        ...(run.threadRootId ? { threadRootId: run.threadRootId } : {}),
        interactionId: item.id
      })
      const next = detail.interaction
      if (!next.localProjectAccess || next.revision === undefined)
        throw new Error("此请求已不是本机项目访问许可。")
      return {
        botId: null,
        dataEpoch: next.localProjectAccess.dataEpoch,
        revision: next.revision,
        interaction: { ...item, ...next, revision: next.revision },
        card: next.localProjectAccess
      }
    },
    change: ({ botId, ...input }) => {
      void botId
      return botApi.resolveLocalToolPermission(input)
    },
    verifies: (input, receipt) =>
      receipt.id === input.id &&
      receipt.localProjectAccess?.target.id === input.targetId &&
      receipt.localProjectAccess?.dataEpoch === input.dataEpoch &&
      receipt.revision === input.revision + 1 &&
      receipt.status === "answered" &&
      receipt.answer ===
        (input.resolution === "allow-once" || input.resolution === "always" ? "approve" : "reject"),
    rejectedCodes: ["stale_interaction", "local_permission_missing", "local_permission_denied"],
    retiredCodes: ["local_computer_changed"]
  })
  const { load } = session
  useEffect(() => {
    if (supported) void load()
  }, [item.id, item.revision, load, supported])
  const [expiryTick, setExpiryTick] = useState(() => Date.now())
  const expired = item.expiresAt <= expiryTick
  useEffect(() => {
    const remaining = item.expiresAt - Date.now()
    if (item.status !== "pending") return
    const timer = setTimeout(
      () => setExpiryTick(Date.now()),
      Math.max(0, Math.min(remaining, 2_147_483_647))
    )
    return () => clearTimeout(timer)
  }, [item.id, item.status, item.expiresAt])
  const authoritative = session.value?.interaction ?? item,
    card = session.value?.card ?? item.localProjectAccess!
  const actionable = supported && authoritative.status === "pending" && !expired
  const answer = async (resolution: LocalToolAnswerSave["resolution"]) => {
    const succeeded = await session.save(() => ({
      botId: null,
      nonce: crypto.randomUUID(),
      targetId: card.target.id,
      dataEpoch: card.dataEpoch,
      id: authoritative.id,
      revision: authoritative.revision,
      resolution
    }))
    if (
      succeeded &&
      life.current.mounted &&
      useBotWorkspaceStore.getState().snapshot?.dataEpoch === card.dataEpoch
    )
      await refresh().catch(() => {
        /* The authoritative receipt is already displayed; parent refresh may retry. */
      })
  }
  return (
    <section
      aria-label="本机项目访问许可"
      className="space-y-3 rounded-xl border border-border/80 bg-muted/20 p-4"
      aria-busy={session.busy}
    >
      <div className="flex items-start gap-2.5">
        <ShieldCheck size={17} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-sm font-medium">允许 Bot 访问本机项目？</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{card.action.description}</p>
        </div>
      </div>
      <div className="space-y-2 rounded-lg border bg-background/60 px-3 py-2.5 text-xs">
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <Monitor size={13} />
          <span className="break-words">{card.target.label}</span>
        </p>
        <p className="break-all font-mono text-[11px] leading-5">{card.action.workspace}</p>
        <div className="border-t pt-2">
          <p className="mb-1 text-muted-foreground">{kindLabel[card.action.kind]}</p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-5">
            {card.action.target}
          </pre>
        </div>
      </div>
      {actionable ? (
        <p className="flex items-start gap-1.5 text-xs leading-5 text-muted-foreground">
          <Clock3 size={13} className="mt-0.5 shrink-0" />
          本次允许仅覆盖所列操作，最长 10 分钟。命令和文件修改仍需原动作审批。
        </p>
      ) : (
        <p role="status" className="text-xs text-muted-foreground">
          {authoritative.status === "answered"
            ? authoritative.answer === "approve"
              ? "已允许此操作"
              : "已拒绝此操作"
            : !supported
              ? "当前后台不支持本机项目许可。"
              : "此许可已过期或撤销，不能继续执行。"}
        </p>
      )}
      {!supported && (
        <p role="alert" className="text-xs text-muted-foreground">
          请更新 Bot 后台后再确认本机许可。
        </p>
      )}
      {session.error && (
        <p role="alert" className="text-xs leading-5 text-destructive">
          {session.error}
        </p>
      )}
      {session.restored && (
        <p role="alert" className="text-xs leading-5 text-destructive">
          电脑或工作区已变化，请重新打开。原回答记录仍保留。
        </p>
      )}
      {session.blocked && (
        <BotPendingSaveRecovery
          operationLabel="本机许可回答"
          record={session.record}
          dataEpoch={session.epoch}
          discard={session.discard}
          onRepaired={session.refreshRecord}
        />
      )}
      {(session.pending || session.acknowledged) && !session.blocked ? (
        <div className="space-y-2 text-xs">
          <p className="text-muted-foreground">
            {session.acknowledged
              ? "回答已确认，重试只核对记录并读取结果。"
              : "上次回答尚未确认。核对会使用同一次请求，不会创建新许可。"}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={session.saveDisabled}
            onClick={() => void session.save()}
          >
            {session.busy && (
              <LoaderCircle size={13} className="mr-1.5 animate-spin motion-reduce:animate-none" />
            )}
            核对上次回答
          </Button>
        </div>
      ) : (
        actionable && (
          <>
            <div className="flex flex-wrap gap-2">
              {resolutions.map(({ value, label, primary }) => (
                <Button
                  key={value}
                  size="sm"
                  variant={primary ? "default" : "outline"}
                  disabled={session.fieldsDisabled}
                  onClick={() => void answer(value)}
                >
                  {session.busy && primary && (
                    <LoaderCircle
                      size={13}
                      className="mr-1.5 animate-spin motion-reduce:animate-none"
                    />
                  )}
                  {label}
                </Button>
              ))}
            </div>
            <p className="text-[11px] leading-5 text-muted-foreground">
              “始终允许”与“禁止访问”适用于这台电脑上的本工作区 Bot，可在“本机项目访问”设置中更改。
            </p>
          </>
        )
      )}
    </section>
  )
}
