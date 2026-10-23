import { useRef, useState, type ReactElement, type ReactNode } from "react"
import {
  Archive,
  Copy,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  Eye,
  EyeOff,
  Mail,
  MailOpen,
  FolderPlus
} from "lucide-react"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from "@/components/ui/context-menu"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import type { BotSidebarSection } from "./view-store"
import type { BotDefinition } from "../../../../shared/bots/contracts"
import { BotSidebarPreview, type BotPreviewConversation } from "./BotSidebarPreview"

/** The row owns its target; opening a menu must not change the active conversation. */
export function BotRowMenu({
  bot,
  kind = "bot",
  compact = false,
  preview,
  conversation,
  waiting = false,
  avatar,
  pinned,
  children,
  onPin,
  onRename,
  onArchive,
  onDelete,
  onCopy,
  hidden,
  unread,
  onVisibility,
  onReadState,
  sections,
  onMove,
  onNewSection
}: {
  bot: Pick<BotDefinition, "id" | "name" | "deleting"> & { archived?: boolean }
  kind?: "bot" | "group"
  compact?: boolean
  preview?: string
  conversation: BotPreviewConversation
  waiting?: boolean
  avatar?: ReactNode
  pinned: boolean
  children: ReactElement
  hidden: boolean
  unread: boolean
  sections: BotSidebarSection[]
  onVisibility(): void
  onReadState(): void
  onMove(sectionId: string | null): void
  onNewSection(): void
  onPin(): void
  onRename(trigger: HTMLElement | null): void
  onArchive?(): void
  onDelete(trigger: HTMLElement | null): void
  onCopy(): void
}) {
  const inlineFocus = useRef(false)
  const trigger = useRef<HTMLSpanElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <Tooltip
      delayDuration={250}
      open={(compact || (pinned && !bot.archived)) && !menuOpen ? undefined : false}
    >
      <ContextMenu onOpenChange={setMenuOpen}>
        <ContextMenuTrigger asChild ref={trigger}>
          <TooltipTrigger asChild>{children}</TooltipTrigger>
        </ContextMenuTrigger>
        <TooltipContent side="right" sideOffset={8} className="bot-sidebar-tooltip">
          <span className="bot-sidebar-tooltip-heading">
            {avatar}
            <span>{bot.name}</span>
          </span>
          <BotSidebarPreview
            conversation={conversation}
            preview={preview ?? ""}
            waiting={waiting}
          />
        </TooltipContent>
        <ContextMenuContent
          data-bot-popup
          onCloseAutoFocus={(event) => {
            if (inlineFocus.current) {
              event.preventDefault()
              inlineFocus.current = false
            }
          }}
          aria-label={`${bot.name} 的操作`}
          className="bot-row-menu bot-workspace-menu w-52 rounded-xl p-1.5"
        >
          {!bot.archived && !bot.deleting && (
            <ContextMenuItem onSelect={onPin}>
              {pinned ? <PinOff /> : <Pin />}
              {pinned ? "取消置顶" : "置顶"}
            </ContextMenuItem>
          )}
          {!bot.archived && !hidden && !pinned && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <FolderPlus className="mr-2" />
                移至分组
              </ContextMenuSubTrigger>
              <ContextMenuSubContent
                data-bot-popup
                className="bot-workspace-menu max-h-80 overflow-y-auto rounded-xl"
              >
                {sections.map((section) => (
                  <ContextMenuItem key={section.id} onSelect={() => onMove(section.id)}>
                    {section.name}
                  </ContextMenuItem>
                ))}
                {sections.some((section) =>
                  (kind === "bot" ? section.botIds : (section.groupIds ?? [])).includes(bot.id)
                ) && <ContextMenuItem onSelect={() => onMove(null)}>移出分组</ContextMenuItem>}
                <ContextMenuSeparator />
                <ContextMenuItem
                  disabled={sections.length >= 32}
                  onSelect={() => {
                    inlineFocus.current = true
                    onNewSection()
                  }}
                >
                  新建分组
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          <ContextMenuItem onSelect={onReadState}>
            {unread ? <MailOpen /> : <Mail />}
            {unread ? "标为已读" : "标为未读"}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={bot.deleting}
            onSelect={() => {
              inlineFocus.current = true
              onRename(trigger.current)
            }}
          >
            <Pencil />
            {kind === "bot" ? "重命名 Bot" : "重命名聊天"}
          </ContextMenuItem>
          <ContextMenuItem onSelect={onCopy}>
            <Copy />
            复制对话 ID
          </ContextMenuItem>
          <ContextMenuSeparator />
          {!bot.archived && (
            <ContextMenuItem onSelect={onVisibility}>
              {hidden ? <Eye /> : <EyeOff />}
              {hidden ? "显示在侧边栏" : "从侧边栏隐藏"}
            </ContextMenuItem>
          )}
          {onArchive && (
            <ContextMenuItem disabled={bot.deleting} onSelect={onArchive}>
              <Archive />
              {bot.archived ? "恢复 Bot" : "归档 Bot"}
            </ContextMenuItem>
          )}
          <ContextMenuItem
            variant="destructive"
            onSelect={() => {
              inlineFocus.current = true
              onDelete(trigger.current)
            }}
          >
            <Trash2 />
            {bot.deleting ? "继续删除" : kind === "bot" ? "删除 Bot" : "删除群聊"}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </Tooltip>
  )
}
