import { useEffect, useRef, useState } from "react"
import { Hand, Monitor, ArrowUpRight, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useBotTrackedWork } from "@/lib/use-bot-tracked-work"
import { botApi } from "@/lib/bot-api"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { BotComputer } from "./BotComputer"
import { BotNativeComputer } from "./BotNativeComputer"
import { BotInspectorPanel } from "./BotInspectorPanel"
import type { BotInteraction } from "../../../../shared/bot-types"
import {
  botComputerHelpReturn,
  type BotComputerHelpCard,
  type BotComputerHelpReturn
} from "../../../../shared/bot-computer-help"

export interface BotComputerHelpView {
  item: BotInteraction
  card: BotComputerHelpCard
}
function useHelpView(item: BotInteraction, card: BotComputerHelpCard) {
  const host = useBotWorkspaceStore((state) => state.host)
  const dataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch)
  const name = useBotWorkspaceStore(
    (state) => state.snapshot?.bots.find((bot) => bot.id === card.botId)?.name ?? "Bot"
  )
  const tracked = useBotTrackedWork({
    kind: "interaction",
    conversationId: card.conversationId,
    ...(card.threadRootId ? { threadRootId: card.threadRootId } : {}),
    runId: item.runId,
    interactionId: item.id
  })
  const legacyLive = useBotWorkspaceStore((state) =>
    state.snapshot?.interactions.find((interaction) => interaction.id === item.id)
  )
  const live = tracked.supported ? tracked.value?.interaction : legacyLive
  const current = live ? { ...item, status: live.status, expiresAt: live.expiresAt } : item
  const [expiryTick, setExpiryTick] = useState(() => Date.now())
  useEffect(() => {
    if (current.status !== "pending") return
    const timer = setTimeout(
      () => setExpiryTick(Date.now()),
      Math.max(0, Math.min(current.expiresAt - Date.now(), 2_147_483_647))
    )
    return () => clearTimeout(timer)
  }, [current.id, current.status, current.expiresAt])
  const currentScope = host?.hostId === card.hostId && dataEpoch === card.dataEpoch
  const pending = current.status === "pending" && current.expiresAt > expiryTick
  const valid = currentScope && pending && Boolean(live) && live?.revision === item.revision
  // A newly mounted viewer has its own tracked subscription. Its first read
  // has not proved absence: keep the view mounted, with input disabled, until
  // that read resolves. Only an observed invalidation retires the viewer.
  const observed = !tracked.supported || tracked.value !== undefined
  const invalid = !currentScope || !pending || (observed && !valid)
  return { name, current, valid, invalid, loading: tracked.loading, error: tracked.error }
}

/** Manual auth stays in the actual computer. No password/OTP/free-text answer
 * field and no unproven Done button exist on this card. */
export function BotComputerHelp({
  item,
  card,
  refresh,
  open
}: BotComputerHelpView & { refresh(): Promise<void>; open(view: BotComputerHelpView): void }) {
  const { current, valid, name } = useHelpView(item, card)
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState<string | null>(null)
  const pending = useRef(false)
  const cancel = async () => {
    if (pending.current || !valid) return
    pending.current = true
    setBusy(true)
    setFailure(null)
    try {
      await botApi.answer({ id: current.id, revision: current.revision, answer: "cancel" })
      await refresh().catch(() => setFailure("取消已提交，列表状态暂未刷新。"))
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "取消未提交，请重试")
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const label = card.backend === "browser" ? "浏览器" : "工作应用"
  const disabled = !valid || busy || !open
  return (
    <section
      aria-label="电脑人工帮助"
      className="overflow-hidden rounded-2xl border border-border/70 bg-background/70"
    >
      <div className="space-y-2 px-4 pt-4">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-sm font-medium">
            <Hand size={15} className="text-muted-foreground" />
            需要你在{label}中操作
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {valid
              ? "等待人工处理"
              : current.answer === "done"
                ? "已归还"
                : current.answer === "cancel"
                  ? "已取消"
                  : "已结束"}
          </span>
        </div>
        <p className="break-words text-sm leading-6">{card.instruction}</p>
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => open?.({ item: current, card })}
        className="m-4 flex h-24 w-[calc(100%-2rem)] items-center justify-center gap-2 rounded-xl border border-border/60 bg-muted/30 text-sm text-muted-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
      >
        <Monitor size={22} strokeWidth={1.5} />
        打开{name}的{label}
        <ArrowUpRight size={15} />
      </button>
      <div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-3">
        <Button size="sm" variant="ghost" disabled={!valid || busy} onClick={() => void cancel()}>
          取消帮助
        </Button>
        <Button
          size="sm"
          className="rounded-full"
          disabled={disabled}
          onClick={() => open?.({ item: current, card })}
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Monitor size={14} />}打开电脑
        </Button>
      </div>
      {failure && (
        <p role="alert" className="px-4 pb-3 text-sm text-destructive">
          {failure}
        </p>
      )}
    </section>
  )
}

/** Same fullscreen/focus/geometry shell as the existing Inspector. Workspace
 * keeps its ordinary Inspector DOM mounted and pauses it while this view owns
 * presentation; only this viewer publishes human input tickets. */
export function BotComputerHelpViewer({
  item,
  card,
  refresh,
  close
}: BotComputerHelpView & { refresh(): Promise<void>; close(): void }) {
  const { name, current, valid, invalid, loading, error } = useHelpView(item, card)
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState<string | null>(null)
  const alive = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const pending = useRef(false),
    pendingReturn = useRef<BotComputerHelpReturn | null>(null)
  useEffect(() => {
    if (invalid) close()
  }, [invalid, close])
  const submit = async (target: BotComputerHelpReturn) => {
    if (pending.current || !valid) throw new Error("此帮助请求已停止或后台已变化")
    // A displayed frame structurally contains a target, but its image, tabs and
    // UIA controls must stay out of the answer payload and retry proof.
    const returning = botComputerHelpReturn.parse(target)
    pending.current = true
    pendingReturn.current = returning
    setBusy(true)
    setFailure(null)
    try {
      await botApi.answer({
        id: current.id,
        revision: current.revision,
        answer: "done",
        computerHelpTarget: returning
      })
      pendingReturn.current = null
      if (alive.current) {
        close()
        await refresh().catch(() => {})
      } // A known accepted answer is never relabelled as an input failure.
    } catch (error) {
      if (alive.current)
        setFailure(error instanceof Error ? error.message : "人工帮助未提交，请重试")
      throw error
    } finally {
      pending.current = false
      if (alive.current) setBusy(false)
    }
  }
  return (
    <BotInspectorPanel name={name} tab="computer" close={close} initialExpanded>
      {(expanded, expand) => (
        <>
          <div className="shrink-0 space-y-1 border-b px-5 py-3">
            <p className="text-sm leading-6">{card.instruction}</p>
            <p className="text-xs leading-5 text-muted-foreground">
              完成后点击“归还并继续”。关闭电脑会保留等待。
            </p>
            {loading && (
              <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 size={12} className="animate-spin" />
                正在确认帮助请求…
              </p>
            )}
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
          {card.backend === "windows-native" ? (
            <BotNativeComputer
              botId={card.botId}
              name={name}
              conversationId={card.conversationId}
              threadRootId={card.threadRootId}
              expanded={expanded}
              active={valid}
              onExpand={expand}
              onReturnControl={(target) => submit({ backend: "windows-native", target })}
            />
          ) : (
            <BotComputer
              botId={card.botId}
              name={name}
              conversationId={card.conversationId}
              threadRootId={card.threadRootId}
              expanded={expanded}
              active={valid}
              onExpand={expand}
              browserOnly
              taskAddress={
                card.taskRunId
                  ? {
                      conversationId: card.conversationId,
                      runId: card.taskRunId,
                      ...(card.threadRootId ? { threadRootId: card.threadRootId } : {})
                    }
                  : undefined
              }
              onReturnControl={(target) => submit({ backend: "browser", target })}
            />
          )}
          {failure && (
            <div className="shrink-0 space-y-2 border-t px-5 py-3">
              <p role="alert" className="text-sm text-destructive">
                {failure}
              </p>
              {pendingReturn.current && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    const original = pendingReturn.current
                    if (original) void submit(original).catch(() => {})
                  }}
                >
                  重试提交
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </BotInspectorPanel>
  )
}
