import { useEffect, useRef, useState } from "react"
import { Bot, Eye, Loader2, User } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { MarkdownPreview } from "@/components/ui/MarkdownPreview"
import { cn } from "@/lib/utils"
import {
  buildManagedSessionPreview,
  MANAGED_SESSION_PREVIEW_PAGE_OPTIONS,
  type ManagedSessionPreviewMessage
} from "@/lib/managed-session-preview"

function PreviewContent({ threadId }: { threadId: string }): React.JSX.Element {
  const [messages, setMessages] = useState<ManagedSessionPreviewMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let cancelled = false
    void window.api.threads
      .getMessagesPage(threadId, MANAGED_SESSION_PREVIEW_PAGE_OPTIONS)
      .then((page) => {
        if (!cancelled) setMessages(buildManagedSessionPreview(page.messages))
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [threadId])

  useEffect(() => {
    if (loading || !messages.length) return
    const frame = requestAnimationFrame(() => {
      const viewport = scrollAreaRef.current?.querySelector<HTMLDivElement>(
        "[data-radix-scroll-area-viewport]"
      )
      if (viewport) viewport.scrollTop = viewport.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [loading, messages])

  if (loading)
    return (
      <div role="status" className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        正在读取历史对话
      </div>
    )
  if (failed)
    return (
      <p role="alert" className="p-4 text-sm text-muted-foreground">
        读取失败，请关闭预览后重新打开。
      </p>
    )
  if (!messages.length)
    return <p className="p-4 text-sm text-muted-foreground">最近消息中暂无可预览的对话文字。</p>
  return (
    <ScrollArea ref={scrollAreaRef} className="h-[400px] min-h-0">
      <div className="space-y-4 p-3">
        {messages.map((message) => {
          const isUser = message.role === "user"
          return (
            <div
              key={message.id}
              className={cn("flex gap-2", isUser ? "justify-end" : "justify-start")}
            >
              {!isUser && (
                <span className="mt-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Bot className="size-3.5" aria-hidden="true" />
                </span>
              )}
              <div
                className={cn(
                  "min-w-0 max-w-[82%] rounded-lg px-3 py-2 text-xs leading-5",
                  isUser
                    ? "bg-primary text-primary-foreground"
                    : "border border-border bg-background text-foreground"
                )}
              >
                <div
                  className={cn(
                    "mb-1 text-[10px] font-medium",
                    isUser ? "text-primary-foreground/70" : "text-muted-foreground"
                  )}
                >
                  {isUser ? "用户" : "助手"}
                </div>
                {isUser ? (
                  <div className="whitespace-pre-wrap break-words">{message.content}</div>
                ) : (
                  <MarkdownPreview
                    content={message.content}
                    showHeader={false}
                    showModeToggle={false}
                    className="[&_.markdown-preview]:p-0 [&_.streaming-markdown]:text-xs"
                  />
                )}
              </div>
              {isUser && (
                <span className="mt-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                  <User className="size-3.5" aria-hidden="true" />
                </span>
              )}
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}

export function ManagedSessionPreview({
  threadId,
  title,
  portalContainer,
  disabled,
  open,
  onOpenChange
}: {
  threadId: string
  title: string
  portalContainer: HTMLElement | null
  disabled: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const anchorRef = useRef({ getBoundingClientRect: () => new DOMRect() })
  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen && triggerRef.current) {
          const rect = triggerRef.current.getBoundingClientRect()
          // Keep the opening position when the session list scrolls.
          anchorRef.current = { getBoundingClientRect: () => rect }
        }
        onOpenChange(nextOpen)
      }}
    >
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="ghost"
          size="icon"
          disabled={disabled}
          aria-label={`预览会话：${title}`}
          title="预览会话"
          className="shrink-0"
        >
          <Eye className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        portalContainer={portalContainer}
        side="right"
        align="start"
        sideOffset={12}
        aria-label={title}
        className="z-[80] flex max-h-[var(--radix-popover-content-available-height)] w-[min(35rem,calc(100vw-2rem))] flex-col border-border-emphasis p-0 shadow-2xl ring-1 ring-black/10 dark:ring-white/10"
      >
        <div
          className="shrink-0 truncate rounded-t-md border-b bg-muted/50 px-3 py-2 text-sm font-medium"
          title={title}
        >
          {title}
        </div>
        <PreviewContent threadId={threadId} />
      </PopoverContent>
    </Popover>
  )
}
