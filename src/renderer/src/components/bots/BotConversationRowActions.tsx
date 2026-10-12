import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react"
import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import {
  Copy,
  Eye,
  EyeOff,
  Mail,
  MailOpen,
  MoreHorizontal,
  Pin,
  PinOff,
  Pencil,
  Settings2,
  Star,
  Trash2
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "@/components/ui/context-menu"
import { Dialog, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { botErrorNotice, type BotErrorNotice } from "@/lib/bot-error-notice"
import { BotDialogContent } from "./BotDialog"
import { BotErrorNoticeBody } from "./BotErrorNoticeBody"
import type { CoworkBot } from "../../../../shared/bot-types"
import { BotProfileInlineEditor } from "./BotProfileInlineEditor"
import "./bot-conversation-row-actions.css"

export interface BotConversationRowActionsProps {
  conversationId: string
  dataEpoch: string
  name: string
  pinned?: boolean
  hidden?: boolean
  compact?: boolean
  /** Pinned cards are a different grid geometry, retained by the wrapper. */
  pinnedCard?: boolean
  unread: boolean
  children: ReactElement | ((name: ReactNode, editing: boolean) => ReactElement)
  /** Optional Bot entity enables receipt-backed inline renaming; groups keep their settings. */
  bot?: CoworkBot
  onSettings(): void
  onRead?(): Promise<void>
  onPin?(value: boolean): Promise<void>
  onHidden?(value: boolean): Promise<void>
  onDelete?(): void
  onPrimary?(): void
}
export function BotConversationRowActions(props: BotConversationRowActionsProps) {
  return (
    <RowActionsScope key={JSON.stringify([props.conversationId, props.dataEpoch])} {...props} />
  )
}
function RowActionsScope({
  conversationId,
  dataEpoch,
  name,
  bot,
  pinned,
  hidden,
  compact,
  pinnedCard,
  unread,
  children,
  onSettings,
  onRead,
  onPin,
  onHidden,
  onDelete,
  onPrimary
}: BotConversationRowActionsProps) {
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const renaming = useRef(false)
  const row = useRef<HTMLDivElement>(null)
  const canRename = bot && typeof children === "function" && !compact
  const rename = () => {
    if (!canRename) return
    renaming.current = true
    setEditing(true)
  }
  const exitRename = (focus = false) => {
    renaming.current = false
    setEditing(false)
    if (focus)
      requestAnimationFrame(() => {
        if (lifetime.current.alive && document.activeElement === document.body)
          row.current?.querySelector<HTMLElement>(".bot-list-row")?.focus({ preventScroll: true })
      })
  }
  const renderedName =
    editing && bot ? (
      <BotProfileInlineEditor bot={bot} dataEpoch={dataEpoch} field="name" onExit={exitRename} />
    ) : (
      name
    )
  const renderedRow = typeof children === "function" ? children(renderedName, editing) : children
  const [feedback, setFeedback] = useState<{
    notice: BotErrorNotice
    copyId?: boolean
  } | null>(null)
  const lifetime = useRef({ alive: true, busy: false })
  useEffect(() => {
    const owner = lifetime.current
    owner.alive = true
    return () => {
      owner.alive = false
    }
  }, [])
  const act = async (action: () => void | Promise<void>) => {
    const owner = lifetime.current
    if (owner.busy || !owner.alive) return
    owner.busy = true
    setBusy(true)
    try {
      await action()
    } catch (error) {
      if (owner.alive) setFeedback({ notice: botErrorNotice(error) })
    } finally {
      owner.busy = false
      if (owner.alive) setBusy(false)
    }
  }
  const actions = [
    ...(onPin
      ? [
          {
            id: "pin",
            label: pinned ? "取消置顶" : "置顶",
            Icon: pinned ? PinOff : Pin,
            run: () => onPin(!pinned)
          }
        ]
      : []),

    ...(onRead
      ? [
          {
            id: "read",
            label: unread ? "标为已读" : "标为未读",
            Icon: unread ? MailOpen : Mail,
            run: onRead
          }
        ]
      : []),
    ...(canRename ? [{ id: "rename", label: "重命名", Icon: Pencil, run: rename }] : []),
    { id: "settings", label: "名称与设置", Icon: Settings2, run: onSettings },
    ...(onPrimary ? [{ id: "primary", label: "更换主 Bot…", Icon: Star, run: onPrimary }] : []),
    {
      id: "copy",
      label: "复制会话 ID",
      Icon: Copy,
      run: async () => {
        try {
          await navigator.clipboard.writeText(conversationId)
        } catch (error) {
          if (lifetime.current.alive)
            setFeedback({
              notice: botErrorNotice(error, "复制失败，可以手动复制会话 ID。"),
              copyId: true
            })
        }
      }
    },
    ...(onHidden
      ? [
          {
            id: "hidden",
            label: hidden ? "显示 Bot" : "隐藏 Bot",
            Icon: hidden ? Eye : EyeOff,
            run: () => onHidden(!hidden)
          }
        ]
      : []),
    ...(onDelete ? [{ id: "delete", label: "删除 Bot…", Icon: Trash2, run: onDelete }] : [])
  ]
  return (
    <div
      ref={row}
      onDoubleClickCapture={(event) => {
        if (
          !canRename ||
          editing ||
          busy ||
          !row.current?.querySelector(".bot-list-row")?.contains(event.target as Node)
        )
          return
        event.preventDefault()
        event.stopPropagation()
        rename()
      }}
      className="bot-conversation-row"
      data-pinned={pinnedCard || undefined}
      data-compact={compact || undefined}
    >
      <ContextMenu modal={false}>
        <ContextMenuTrigger
          asChild
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return
            event.preventDefault()
            event.stopPropagation()
            const bounds = event.currentTarget.getBoundingClientRect()
            event.currentTarget.dispatchEvent(
              new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                clientX: bounds.left + Math.min(bounds.width / 2, 80),
                clientY: bounds.top + bounds.height / 2
              })
            )
          }}
        >
          {renderedRow}
        </ContextMenuTrigger>
        <ContextMenuContent
          className="bot-row-menu"
          aria-label={`${name}的会话操作`}
          onCloseAutoFocus={(event) => {
            if (renaming.current) event.preventDefault()
          }}
        >
          {actions.map((action, index) => (
            <div key={action.id}>
              {index > 0 &&
                (["rename", "copy", "hidden"].includes(action.id) ||
                  (action.id === "settings" && !canRename)) && <ContextMenuSeparator />}
              <ContextMenuItem
                disabled={busy}
                variant={action.id === "delete" ? "destructive" : "default"}
                onSelect={() => void act(action.run)}
              >
                <action.Icon size={15} />
                {action.label}
              </ContextMenuItem>
            </div>
          ))}
        </ContextMenuContent>
      </ContextMenu>
      {!compact && (
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="bot-conversation-row-more size-7 rounded-full"
              aria-label={`${name}的更多操作`}
              disabled={busy}
              onClick={(event) => event.stopPropagation()}
            >
              <MoreHorizontal size={16} />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="bot-row-menu"
              align="end"
              sideOffset={5}
              aria-label={`${name}的会话操作`}
              onCloseAutoFocus={(event) => {
                if (renaming.current) event.preventDefault()
              }}
            >
              {actions.map((action, index) => (
                <div key={action.id}>
                  {index > 0 &&
                    (["rename", "copy", "hidden"].includes(action.id) ||
                      (action.id === "settings" && !canRename)) && <DropdownMenu.Separator />}
                  <DropdownMenu.Item
                    disabled={busy}
                    data-destructive={action.id === "delete" || undefined}
                    onSelect={() => void act(action.run)}
                  >
                    <action.Icon size={15} />
                    {action.label}
                  </DropdownMenu.Item>
                </div>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
      <Dialog
        open={!!feedback}
        onOpenChange={(open) => {
          if (!open) setFeedback(null)
        }}
      >
        <BotDialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>会话操作</DialogTitle>
            <DialogDescription>{name}</DialogDescription>
          </DialogHeader>
          {feedback && <BotErrorNoticeBody notice={feedback.notice} />}{" "}
          {feedback?.copyId && (
            <label className="space-y-1.5 text-xs text-muted-foreground">
              <span>会话 ID</span>
              <Input
                aria-label="会话 ID"
                readOnly
                value={conversationId}
                onFocus={(event) => event.currentTarget.select()}
                className="font-mono text-xs"
              />
            </label>
          )}
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => setFeedback(null)}>
              关闭
            </Button>
          </div>
        </BotDialogContent>
      </Dialog>
    </div>
  )
}
