import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties
} from "react"
import {
  ArrowLeft,
  ArrowRight,
  ArrowDownLeft,
  ArrowUpRight,
  ArrowLeftRight,
  ChevronRight,
  MessageSquare,
  RefreshCw
} from "lucide-react"
import { FocusScope } from "@radix-ui/react-focus-scope"
import { COLORS, resolvePersonaColor } from "./upstream/grok-persona-geometry"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useBotTrackedWork } from "@/lib/use-bot-tracked-work"
import { botApi } from "@/lib/bot-api"
import { botErrorNotice, type BotErrorNotice } from "@/lib/bot-error-notice"
import { BotViewVisibilityContext, useBotViewVisibility } from "@/lib/use-bot-view-visibility"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { BotAvatar } from "./BotAvatar"
import { BotDialogContent } from "./BotDialog"
import { BotErrorNoticeBody } from "./BotErrorNoticeBody"
import { BotFilePreview } from "./BotFilePreview"
import { BotMessageAttachments } from "./BotMessageAttachments"
import type { BotPeerMessageImage } from "../../../../shared/bot-peer-images"
import { BOT_PEER_FILES_CAPABILITY } from "../../../../shared/bot-peer-files"
import {
  BotPeerExchangeReadQueueContext,
  createBotPeerExchangeReadQueue
} from "@/lib/bot-peer-exchange-read-queue"
import {
  botPeerExchange,
  botPeerExchangeLinks,
  botPeerExchangeKey,
  type BotPeerExchange as Exchange,
  type BotPeerExchangeLink,
  type BotPeerExchangeRequest
} from "../../../../shared/bot-peer-exchange"

const labels: Record<Exchange["status"], string> = {
  queued: "等待执行",
  running: "执行中",
  waiting_input: "等待处理",
  cancelling: "正在停止",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已停止",
  needs_review: "待核对"
}
const finished = (status: Exchange["status"]) =>
  ["succeeded", "failed", "cancelled"].includes(status)

export function BotPeerExchangeLinks({
  links,
  open
}: {
  links: BotPeerExchangeLink[]
  open(link: BotPeerExchangeLink, trigger: HTMLButtonElement): void
}) {
  const parsed = botPeerExchangeLinks.safeParse(links)
  if (!parsed.success || !parsed.data.length) return null
  return (
    <div className="mb-3 flex max-h-32 flex-wrap gap-1.5 overflow-y-auto" aria-label="Bot 协作交流">
      {parsed.data.map((link) => (
        <button
          key={`${link.anchor.runId}:${link.peerRunId}:${link.mergedMessageId ?? ""}`}
          type="button"
          className="inline-flex min-w-0 items-center gap-1.5 rounded-lg border border-border/50 bg-muted/25 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          aria-label={`查看${link.direction === "incoming" ? "来自" : "发给"} ${link.peer.name} 的协作`}
          onClick={(event) => open(link, event.currentTarget)}
        >
          {link.direction === "incoming" ? (
            <ArrowDownLeft size={13} className="shrink-0" />
          ) : (
            <ArrowUpRight size={13} className="shrink-0" />
          )}
          <span className="max-w-48 truncate">
            {link.direction === "incoming" ? "来自" : "发给"} {link.peer.name}
          </span>
          <ChevronRight size={12} className="shrink-0" />
        </button>
      ))}
    </div>
  )
}

/** One immutable dispatch address owns its read, dialog and preview lifetime. */
export function BotPeerExchange({
  link,
  dataEpoch,
  close,
  back,
  presentation = "dialog"
}: {
  link: BotPeerExchangeLink
  dataEpoch: string
  close(): void
  back?(): void
  presentation?: "dialog" | "workspace"
}) {
  const visible = useBotViewVisibility()
  const titleId = useId()
  const closeButton = useRef<HTMLButtonElement>(null)
  const sheet = useRef<HTMLElement>(null)
  const previewTrigger = useRef<{ node: HTMLButtonElement; key: string } | null>(null)
  const focusScope = useRef({ visible, key: "" })
  const bots = useBotWorkspaceStore((state) => state.snapshot?.bots)
  const includeFiles = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes(BOT_PEER_FILES_CAPABILITY) === true
  )
  const tracked = useBotTrackedWork(
    visible ? { kind: "run", botId: link.peer.botId, runId: link.peerRunId } : undefined
  )
  const legacyRevision = useBotWorkspaceStore(
    (state) => state.snapshot?.runs.find((run) => run.id === link.peerRunId)?.revision ?? null
  )
  const liveRevision = tracked.supported ? (tracked.value?.run?.revision ?? null) : legacyRevision
  const previousRevision = useRef(liveRevision)
  const request = {
    anchor: link.anchor,
    peerRunId: link.peerRunId,
    expectedDataEpoch: dataEpoch,
    ...(link.mergedMessageId ? { mergedMessageId: link.mergedMessageId } : {}),
    ...(includeFiles ? { includeFiles: true as const } : {})
  }
  const key = botPeerExchangeKey(request)
  useLayoutEffect(() => {
    focusScope.current = { visible, key }
    return () => {
      focusScope.current.visible = false
    }
  }, [visible, key])
  const [loaded, setLoaded] = useState<{ key: string; value: Exchange } | null>(null)
  const [failure, setFailure] = useState<{
    key: string
    notice: BotErrorNotice
  } | null>(null)
  const [retry, setRetry] = useState(0)
  const [preview, setPreview] = useState<{
    id: string
    conversationId: string
    media?: BotPeerMessageImage
    mediaGroup?: BotPeerMessageImage[]
  } | null>(null)
  const value = loaded?.key === key ? loaded.value : null
  const error = failure?.key === key ? failure.notice : null
  const { conversationId, runId, threadRootId } = link.anchor
  const peerRunId = link.peerRunId
  const mergedMessageId = link.mergedMessageId
  const enabled = visible && !preview
  const selectMedia = (id: string) => {
    if (!preview || !focusScope.current.visible || focusScope.current.key !== key) return
    const media = preview.mediaGroup?.find((image) => image.id === id)
    if (media) setPreview((current) => (current === preview ? { ...current, id, media } : current))
  }
  const owner = useRef({ active: false, key })
  const lastRead = useRef<{ key: string; revision: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const inheritedQueue = useContext(BotPeerExchangeReadQueueContext)
  const [fallbackQueue] = useState(() => inheritedQueue ?? createBotPeerExchangeReadQueue())
  const queue = inheritedQueue ?? fallbackQueue
  const execute = useCallback(
    async (
      scope: { key: string; request: BotPeerExchangeRequest; minimumRevision?: number },
      context: { isCurrent(): boolean }
    ) => {
      const current = () =>
        context.isCurrent() && owner.current.active && owner.current.key === scope.key
      if (!current()) return
      // A tracked status may arrive while the initial read is still pending.
      // Reuse that read if it already includes the advertised revision; a
      // genuinely newer revision still gets its own serialized refresh.
      if (
        scope.minimumRevision !== undefined &&
        lastRead.current?.key === scope.key &&
        lastRead.current.revision >= scope.minimumRevision
      )
        return
      clearTimeout(timer.current)
      timer.current = undefined
      try {
        const data = botPeerExchange.parse(await botApi.peerExchange(scope.request))
        if (!current()) return
        if (
          botPeerExchangeKey({
            anchor: data.anchor,
            peerRunId: data.peerRunId,
            ...(data.mergedMessageId ? { mergedMessageId: data.mergedMessageId } : {}),
            expectedDataEpoch: data.dataEpoch,
            ...(scope.request.includeFiles && data.request.attachments
              ? { includeFiles: true as const }
              : {})
          }) !== scope.key
        )
          throw new Error("交流记录身份已变化，请重新打开")
        lastRead.current = { key: scope.key, revision: data.revision }
        setLoaded({ key: scope.key, value: data })
        setFailure(null)
        if (!finished(data.status))
          timer.current = setTimeout(() => {
            if (current())
              queue.enqueue("read", (context) =>
                execute({ key: scope.key, request: scope.request }, context)
              )
          }, 2000)
      } catch (error) {
        if (current())
          setFailure({ key: scope.key, notice: botErrorNotice(error, "交流记录读取失败") })
      }
    },
    [queue]
  )
  useLayoutEffect(() => {
    owner.current = { active: enabled, key }
    const retire = () => {
      clearTimeout(timer.current)
      timer.current = undefined
      queue.cancelPending()
    }
    return () => {
      owner.current.active = false
      retire()
    }
    // Cleanup advances the generation, not dispose: visibility/StrictMode reuse the queue.
  }, [enabled, key, retry, queue])
  const read = useCallback(
    (minimumRevision?: number) => {
      if (!enabled) return
      if (
        minimumRevision !== undefined &&
        lastRead.current?.key === key &&
        lastRead.current.revision >= minimumRevision
      )
        return
      clearTimeout(timer.current)
      timer.current = undefined
      const scope = {
        key,
        minimumRevision,
        request: {
          anchor: { conversationId, runId, ...(threadRootId ? { threadRootId } : {}) },
          peerRunId,
          ...(mergedMessageId ? { mergedMessageId } : {}),
          expectedDataEpoch: dataEpoch,
          ...(includeFiles ? { includeFiles: true as const } : {})
        }
      }
      queue.enqueue("read", (context) => execute(scope, context))
    },
    [
      enabled,
      key,
      conversationId,
      runId,
      threadRootId,
      peerRunId,
      mergedMessageId,
      includeFiles,
      dataEpoch,
      queue,
      execute
    ]
  )
  useEffect(() => {
    read()
  }, [read, retry])
  useEffect(() => {
    if (previousRevision.current !== liveRevision) {
      previousRevision.current = liveRevision
      read(liveRevision ?? undefined)
    }
  }, [liveRevision, read])
  if (preview && presentation === "dialog")
    return (
      <BotFilePreview
        key={`${dataEpoch}:${preview.conversationId}:${preview.mediaGroup ? JSON.stringify(preview.mediaGroup) : preview.id}`}
        {...preview}
        selectMedia={selectMedia}
        close={() => setPreview(null)}
      />
    )
  const authorStyle = (who: Exchange["sender"]): CSSProperties => {
    const color = resolvePersonaColor(
      who.botId,
      bots?.find((bot) => bot.id === who.botId)?.avatarColor
    )
    return {
      "--bot-author-color": color === "black" ? "var(--foreground)" : COLORS[color].dark
    } as CSSProperties
  }
  const message = (item: Exchange["request"], who: Exchange["sender"], outgoing: boolean) => (
    <li
      key={item.id}
      className={`flex gap-3 ${outgoing && presentation === "dialog" ? "flex-row-reverse" : ""}`}
    >
      <span className="mt-6 shrink-0">
        <BotAvatar agentId={who.botId} name={who.name} size="md" isStatic />
      </span>
      <div
        className={`min-w-0 max-w-[85%] space-y-1.5 ${outgoing && presentation === "dialog" ? "text-right" : ""}`}
      >
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="bot-message-author" data-group-author style={authorStyle(who)}>
            <span className="bot-message-author-name" title={who.name}>
              {who.name}
            </span>
          </span>
          <time dateTime={new Date(item.createdAt).toISOString()}>
            {new Date(item.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit"
            })}
          </time>
        </div>
        <div
          className={`rounded-2xl px-4 py-3 text-left text-sm leading-7 ${outgoing && presentation === "dialog" ? "rounded-tr-md bg-muted/65" : "rounded-tl-md bg-muted/35"}`}
        >
          <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            {item.text}
          </span>
          <BotMessageAttachments
            message={{
              conversationId: item.conversationId,
              attachments: item.attachments ?? item.images.map((image) => image.id),
              attachmentFiles: item.attachmentFiles,
              peerImages: item.images
            }}
            openImage={(id, media, trigger, mediaGroup) => {
              if (item.images.some((image) => image.id === id)) {
                const node = trigger ?? document.activeElement
                previewTrigger.current =
                  node instanceof HTMLButtonElement && sheet.current?.contains(node)
                    ? { node, key }
                    : null
                setPreview({ id, conversationId: item.conversationId, media, mediaGroup })
              }
            }}
            openFile={(id, artifact, trigger) => {
              if (!artifact || !item.attachmentFiles?.some((file) => file.id === id)) return
              previewTrigger.current = sheet.current?.contains(trigger)
                ? { node: trigger, key }
                : null
              setPreview({ id, conversationId: item.conversationId })
            }}
          />
        </div>
      </div>
    </li>
  )
  const content = (
    <BotViewVisibilityContext.Provider value={enabled}>
      <div
        className={
          presentation === "workspace"
            ? "bot-peer-sheet-list"
            : "min-h-32 min-w-0 flex-1 overflow-y-auto p-5"
        }
      >
        {error && (
          <div className="mb-4 rounded-xl border border-border bg-muted/25 p-3">
            <BotErrorNoticeBody notice={error} />
            <Button
              className="mt-2"
              variant="ghost"
              size="sm"
              onClick={() => setRetry((n) => n + 1)}
            >
              <RefreshCw size={13} />
              重新读取
            </Button>
          </div>
        )}
        {!value && !error && (
          <p className="py-8 text-center text-sm text-muted-foreground" role="status">
            正在读取交流记录…
          </p>
        )}
        {value && (
          <ol className="space-y-6">
            {message(value.request, value.sender, true)}
            {value.reply ? (
              message(value.reply, value.recipient, false)
            ) : (
              <li className="py-3 text-center text-xs text-muted-foreground">
                {mergedMessageId
                  ? "回信已进入原任务；其他交流在各自会话中保留"
                  : finished(value.status)
                    ? "没有可核对的回复记录"
                    : "等待 Bot 回复"}
              </li>
            )}
          </ol>
        )}
      </div>
    </BotViewVisibilityContext.Provider>
  )
  if (presentation === "workspace")
    return (
      <>
        <FocusScope
          asChild
          trapped={false}
          loop={false}
          onMountAutoFocus={(event) => {
            event.preventDefault()
            if (visible) closeButton.current?.focus({ preventScroll: true })
          }}
          onUnmountAutoFocus={(event) => event.preventDefault()}
        >
          <section
            ref={sheet}
            className="bot-peer-sheet"
            role="region"
            aria-labelledby={titleId}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !event.defaultPrevented) {
                event.preventDefault()
                close()
              }
            }}
          >
            <header className="bot-peer-sheet-header">
              <h2 id={titleId} className="sr-only">
                交流记录
              </h2>
              <div className="bot-peer-sheet-identities">
                {value ? (
                  <>
                    <span
                      className="bot-peer-sheet-identity"
                      title={value.sender.name}
                      style={authorStyle(value.sender)}
                    >
                      <BotAvatar
                        agentId={value.sender.botId}
                        name={value.sender.name}
                        size="sm"
                        isStatic
                      />
                      <span>{value.sender.name}</span>
                    </span>
                    <ArrowLeftRight
                      size={16}
                      aria-hidden="true"
                      className="shrink-0 text-muted-foreground"
                    />
                    <span
                      className="bot-peer-sheet-identity"
                      title={value.recipient.name}
                      style={authorStyle(value.recipient)}
                    >
                      <BotAvatar
                        agentId={value.recipient.botId}
                        name={value.recipient.name}
                        size="sm"
                        isStatic
                      />
                      <span>{value.recipient.name}</span>
                    </span>
                  </>
                ) : (
                  <span className="text-sm text-muted-foreground">交流记录</span>
                )}
              </div>
              {value && (
                <span className="bot-peer-sheet-status" role="status">
                  {labels[value.status]}
                </span>
              )}
            </header>
            {content}
            <footer className="bot-peer-sheet-footer">
              <Button
                ref={closeButton}
                variant="secondary"
                className="bot-peer-sheet-close"
                onClick={close}
              >
                关闭聊天
              </Button>
            </footer>
          </section>
        </FocusScope>
        {preview && (
          <BotFilePreview
            key={`${dataEpoch}:${preview.conversationId}:${preview.mediaGroup ? JSON.stringify(preview.mediaGroup) : preview.id}`}
            {...preview}
            selectMedia={selectMedia}
            close={() => setPreview(null)}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              const trigger = previewTrigger.current
              if (
                trigger?.key === key &&
                focusScope.current.key === key &&
                focusScope.current.visible &&
                trigger.node.isConnected &&
                sheet.current?.contains(trigger.node)
              )
                trigger.node.focus({ preventScroll: true })
            }}
          />
        )}
      </>
    )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <BotDialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-border/60 px-5 py-4 pr-12">
          <DialogTitle className="flex min-w-0 items-center gap-2 text-base">
            {back && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                aria-label="返回任务记录"
                onClick={back}
              >
                <ArrowLeft size={16} />
              </Button>
            )}
            <MessageSquare size={17} className="shrink-0 text-muted-foreground" />
            交流记录
          </DialogTitle>
          <DialogDescription className="text-xs">
            {mergedMessageId
              ? "发送给原任务的回信；不包括双方其他私聊"
              : "本次协作的交办内容和回复"}
          </DialogDescription>
        </DialogHeader>
        {value && (
          <div className="flex shrink-0 items-center gap-2 border-b border-border/40 px-5 py-3 text-xs">
            <span className="truncate font-medium">{value.sender.name}</span>
            <ArrowRight size={13} className="shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-medium">{value.recipient.name}</span>
            <span
              className={`shrink-0 rounded-md px-2 py-1 ${value.status === "succeeded" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground"}`}
              role="status"
            >
              {labels[value.status]}
            </span>
          </div>
        )}
        {content}
      </BotDialogContent>
    </Dialog>
  )
}
