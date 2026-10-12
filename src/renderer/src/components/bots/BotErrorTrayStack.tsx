import { useLayoutEffect, useRef, useState } from "react"
import { AlertCircle, ExternalLink, LoaderCircle, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  botErrorNotice,
  botErrorTrayReceiptFeedback,
  botErrorTrayScopeKey,
  compactBotErrorSummary,
  type BotErrorTrayFeedback,
  type BotErrorTrayOperation
} from "@/lib/bot-error-notice"
import type { BotErrorTray, BotErrorTraySnapshot } from "../../../../shared/bot-error-trays"
import { BotErrorNoticeBody } from "./BotErrorNoticeBody"

export interface BotErrorTrayStackProps {
  snapshot: BotErrorTraySnapshot
  bots?: ReadonlyArray<{ id: string; name: string }>
  activeConversationId?: string
  activeThreadRootId?: string
  /** Return the authoritative acknowledgement after projecting it in the store. */
  onDismiss(id: string, revision: number): Promise<BotErrorTraySnapshot>
  onClear(throughRevision: number): Promise<BotErrorTraySnapshot>
  onOpenRun?(tray: BotErrorTray): void
  /** Usually the workspace composer; used only when removing the focused last notice. */
  onRestoreFocus?(): void
  className?: string
}

/** One bounded Host projection across conversations. No poller, timer or local tray cache. */
export function BotErrorTrayStack(props: BotErrorTrayStackProps) {
  return <ErrorTrayScope key={botErrorTrayScopeKey(props.snapshot)} {...props} />
}

function ErrorTrayScope({
  snapshot,
  bots = [],
  activeConversationId,
  activeThreadRootId,
  onDismiss,
  onClear,
  onOpenRun,
  onRestoreFocus,
  className
}: BotErrorTrayStackProps) {
  const [expanded, setExpanded] = useState(false)
  const toggle = useRef<HTMLButtonElement>(null)
  const latestTray = snapshot.items.reduce<BotErrorTray | undefined>(
    (previous, tray) => (!previous || tray.revision > previous.revision ? tray : previous),
    undefined
  )
  const summary = latestTray ? compactBotErrorSummary(latestTray) : undefined
  const [pending, setPending] = useState<BotErrorTrayOperation | null>(null)
  const [feedback, setFeedback] = useState<BotErrorTrayFeedback | null>(null)
  const root = useRef<HTMLElement>(null)
  const latest = useRef(snapshot)
  const lifetime = useRef({ active: false, generation: 0 })
  const pendingOperation = useRef<BotErrorTrayOperation | null>(null)
  const focus = useRef<{
    owned: boolean
    frame: number
    restore: { operation: BotErrorTrayOperation; index: number; generation: number } | null
  }>({ owned: false, frame: 0, restore: null })
  useLayoutEffect(() => {
    latest.current = snapshot
  }, [snapshot])
  useLayoutEffect(() => {
    const instance = lifetime.current
    const restoration = focus.current
    const releaseOutside = (event: Event) => {
      // Removing the focused button can leave focus on body without user input.
      if (event.type === "focusin" && event.target === document.body) return
      if (event.target instanceof Node && !root.current?.contains(event.target))
        restoration.owned = false
    }
    const releaseOnBlur = () => {
      restoration.owned = false
    }
    instance.active = true
    document.addEventListener("pointerdown", releaseOutside, true)
    document.addEventListener("focusin", releaseOutside, true)
    window.addEventListener("blur", releaseOnBlur)
    return () => {
      instance.active = false
      instance.generation++
      if (restoration.frame) cancelAnimationFrame(restoration.frame)
      document.removeEventListener("pointerdown", releaseOutside, true)
      document.removeEventListener("focusin", releaseOutside, true)
      window.removeEventListener("blur", releaseOnBlur)
    }
  }, [])

  useLayoutEffect(() => {
    const restoration = focus.current
    const request = restoration.restore
    if (!request || pending !== null) return
    if (!restoration.owned || lifetime.current.generation !== request.generation) {
      restoration.restore = null
      return
    }
    // An ACK can arrive before React commits the projected snapshot. Wait for
    // the actual focused row to be removed and the remaining buttons enabled;
    // a single RAF scheduled at ACK time can otherwise run against the old DOM.
    const operation = request.operation
    if (
      operation.kind === "dismiss"
        ? snapshot.items.some((item) => item.id === operation.id)
        : snapshot.items.some((item) => item.revision <= operation.throughRevision)
    )
      return
    restoration.restore = null
    if (restoration.frame) cancelAnimationFrame(restoration.frame)
    restoration.frame = requestAnimationFrame(() => {
      restoration.frame = 0
      if (
        !lifetime.current.active ||
        !restoration.owned ||
        lifetime.current.generation !== request.generation
      )
        return
      // A user may have moved to another live control while waiting for the ACK.
      if (document.activeElement !== document.body && document.activeElement?.isConnected) return
      const buttons = [
        ...(root.current?.querySelectorAll<HTMLButtonElement>("[data-error-dismiss]") ?? [])
      ].filter((button) => !button.closest("[hidden]"))
      const next = buttons[Math.min(request.index, buttons.length - 1)]
      if (next && !next.disabled) next.focus({ preventScroll: true })
      else if (onRestoreFocus) onRestoreFocus()
      else root.current?.focus({ preventScroll: true })
    })
  }, [snapshot, pending, onRestoreFocus])

  const mutate = async (operation: BotErrorTrayOperation, trigger: HTMLButtonElement) => {
    const instance = lifetime.current
    if (!instance.active || pendingOperation.current) return
    const current = latest.current
    const item =
      operation.kind === "dismiss"
        ? current.items.find((tray) => tray.id === operation.id)
        : undefined
    if (operation.kind === "dismiss" && item?.revision !== operation.revision) {
      setFeedback({
        tone: "info",
        notice: { message: "通知已更新，请查看后再关闭" }
      })
      return
    }
    const index =
      operation.kind === "dismiss" ? current.items.findIndex((tray) => tray.id === operation.id) : 0
    const token = ++instance.generation
    pendingOperation.current = operation
    focus.current.restore = null
    focus.current.owned = document.activeElement === trigger
    setPending(operation)
    setFeedback(null)
    const isCurrent = () =>
      instance.active && instance.generation === token && pendingOperation.current === operation
    let removed = false
    try {
      const receipt =
        operation.kind === "dismiss"
          ? await onDismiss(operation.id, operation.revision)
          : await onClear(operation.throughRevision)
      if (!isCurrent()) return
      const authoritative =
        receipt.hostId === current.hostId &&
        receipt.dataEpoch === current.dataEpoch &&
        latest.current.revision > receipt.revision
          ? latest.current
          : receipt
      const result = botErrorTrayReceiptFeedback(current, authoritative, operation)
      setFeedback(result)
      removed = result === null
    } catch (error) {
      if (isCurrent())
        setFeedback({
          tone: "error",
          notice: botErrorNotice(error, "通知操作失败，请重试")
        })
    } finally {
      if (isCurrent()) {
        pendingOperation.current = null
        if (removed)
          focus.current.restore = { operation, index: Math.max(0, index), generation: token }
        setPending(null)
      }
    }
  }

  // An empty authoritative projection retires the open disclosure. A later
  // failure must remain discoverable without reopening a popup or moving focus.
  if (!snapshot.items.length && expanded) setExpanded(false)
  if (!snapshot.items.length && !pending && !feedback) return null
  const ownerLabel = (tray: BotErrorTray) =>
    tray.botId ? (bots.find((bot) => bot.id === tray.botId)?.name ?? "Bot") : "Bot 后台"
  const occurrenceTime = (at: number) => {
    const date = new Date(at)
    return Number.isFinite(date.getTime())
      ? date.toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        })
      : "时间不可用"
  }
  const close = () => {
    setExpanded(false)
    toggle.current?.focus({ preventScroll: true })
  }
  return (
    <Popover
      open={expanded}
      onOpenChange={(open) => {
        if (!pendingOperation.current) setExpanded(open)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          ref={toggle}
          size="icon"
          variant="ghost"
          className={cn("relative size-8 shrink-0 rounded-full", className)}
          aria-label="查看全部错误通知"
          title={`错误通知 · ${snapshot.items.length}`}
          disabled={pending !== null}
          data-error-tray-trigger
        >
          <AlertCircle className="size-4 text-destructive" aria-hidden />
          {!!snapshot.items.length && (
            <span
              className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-4 text-white tabular-nums"
              aria-hidden
              data-error-tray-count
            >
              {snapshot.items.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <span
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-error-tray-announcement
      >
        <span key={latestTray?.revision ?? snapshot.revision}>
          {latestTray && summary
            ? `${ownerLabel(latestTray)}：${summary.title}，${occurrenceTime(latestTray.updatedAt)}，发生 ${latestTray.count} 次。共 ${snapshot.items.length} 条错误通知。`
            : (feedback?.notice.message ?? "错误通知已清除")}
        </span>
      </span>
      <PopoverContent
        aria-label="错误通知"
        side="top"
        align="start"
        sideOffset={10}
        collisionPadding={12}
        className="w-[24rem] max-w-[calc(100vw-24px)] rounded-2xl p-2"
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (pendingOperation.current) event.preventDefault()
          else close()
        }}
        onInteractOutside={(event) => {
          if (pendingOperation.current) event.preventDefault()
        }}
      >
        <section
          ref={root}
          tabIndex={-1}
          aria-label="Bot 错误通知"
          data-error-tray-scope={botErrorTrayScopeKey(snapshot)}
          data-error-tray-expanded={expanded}
          className="flex flex-col gap-1 outline-none"
        >
          <header className="flex min-h-7 shrink-0 items-center gap-1.5 px-1">
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
              错误通知 · {snapshot.items.length}
            </span>
            {snapshot.items.length > 1 && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 rounded-lg px-2 text-[11px]"
                disabled={pending !== null}
                onClick={(event) =>
                  void mutate(
                    { kind: "clear", throughRevision: snapshot.revision },
                    event.currentTarget
                  )
                }
              >
                {pending?.kind === "clear" && (
                  <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
                )}
                {pending?.kind === "clear" ? "正在清除…" : "全部清除"}
              </Button>
            )}
            <Button
              size="icon-sm"
              variant="ghost"
              className="size-7 shrink-0 rounded-lg"
              aria-label="收起错误通知"
              title="收起错误通知"
              disabled={pending !== null}
              onClick={close}
            >
              <X className="size-3.5" />
            </Button>
          </header>
          <div className="min-h-0 max-h-[min(24vh,15rem)] overflow-y-auto overscroll-contain px-0.5 pb-0.5">
            <ol className="space-y-1.5" aria-label="错误通知列表">
              {snapshot.items.map((tray) => (
                <li
                  key={tray.id}
                  role="alert"
                  data-error-tray-id={tray.id}
                  className="flex items-start gap-2.5 rounded-[14px] border border-destructive/25 bg-destructive/5 px-3 py-2.5 shadow-sm animate-in fade-in slide-in-from-bottom-1 zoom-in-95 duration-[180ms] motion-reduce:animate-none"
                >
                  <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-baseline gap-1.5">
                      <p className="min-w-0 break-words text-[13px] font-medium leading-5">
                        {tray.title}
                      </p>
                      {tray.count > 1 && (
                        <span
                          className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
                          aria-label={`发生 ${tray.count} 次`}
                        >
                          ×{tray.count}
                        </span>
                      )}
                    </div>
                    <p className="mb-1.5 flex flex-wrap items-center gap-x-1.5 text-[11px] leading-4 text-muted-foreground">
                      <span className="max-w-40 truncate">{ownerLabel(tray)}</span>
                      <span aria-hidden>·</span>
                      <time
                        dateTime={
                          Number.isFinite(new Date(tray.updatedAt).getTime())
                            ? new Date(tray.updatedAt).toISOString()
                            : undefined
                        }
                      >
                        {occurrenceTime(tray.updatedAt)}
                      </time>
                      {tray.conversationId &&
                        activeConversationId === tray.conversationId &&
                        (activeThreadRootId ?? null) === (tray.threadRootId ?? null) && (
                          <span className="rounded bg-muted px-1">当前对话</span>
                        )}
                    </p>
                    <BotErrorNoticeBody
                      notice={{ message: tray.detail, diagnostic: tray.diagnostic }}
                      hint={tray.hint}
                      summary={compactBotErrorSummary(tray).message}
                    >
                      {onOpenRun && tray.runId && tray.conversationId && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="-ml-1 h-7 rounded-md px-1.5 text-[11px]"
                          disabled={pending !== null}
                          onClick={() => onOpenRun(tray)}
                        >
                          <ExternalLink className="size-3" />
                          查看任务记录
                        </Button>
                      )}
                    </BotErrorNoticeBody>
                  </div>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="-mr-1 -mt-1 size-7 shrink-0 rounded-lg"
                    aria-label={`关闭通知：${tray.title}`}
                    title="关闭通知"
                    data-error-dismiss={tray.id}
                    disabled={pending !== null}
                    onClick={(event) =>
                      void mutate(
                        { kind: "dismiss", id: tray.id, revision: tray.revision },
                        event.currentTarget
                      )
                    }
                  >
                    {pending?.kind === "dismiss" && pending.id === tray.id ? (
                      <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
                    ) : (
                      <X className="size-3.5" />
                    )}
                  </Button>
                </li>
              ))}
            </ol>
          </div>
          {feedback && (
            <div
              className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2"
              role={feedback.tone === "error" ? "alert" : "status"}
            >
              <BotErrorNoticeBody
                notice={feedback.notice}
                summary={feedback.tone === "error" ? "通知操作失败，请重试" : undefined}
              />
            </div>
          )}
        </section>
      </PopoverContent>
    </Popover>
  )
}
