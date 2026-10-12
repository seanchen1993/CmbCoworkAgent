import type { ReactNode } from "react"
import * as Menu from "@radix-ui/react-dropdown-menu"
import {
  Brain,
  BookOpen,
  Clock,
  ListTodo,
  Copy,
  Mail,
  MailOpen,
  EyeOff,
  Files,
  History,
  ImagePlus,
  KeyRound,
  Monitor,
  MoreHorizontal,
  Pin,
  Settings2,
  ShieldCheck,
  Star,
  Trash2
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { CoworkBot } from "../../../../shared/bot-types"

export function BotActionButton({
  label,
  active,
  children,
  onClick
}: {
  label: string
  active?: boolean
  children: ReactNode
  onClick(): void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          data-active={active || undefined}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function BotActions({
  bot,
  computerOpen,
  onFiles,
  onComputer,
  onResource,
  onSettings,
  onImportContext,
  onAsyncTasks,
  onAvatar,
  onSecrets,
  onApprovalRules,
  onUpdate,
  onDelete,
  unread,
  onRead,
  onClone,
  cloning,
  cloneUnavailableReason,
  notificationAction,
  onPrimary
}: {
  bot?: CoworkBot
  computerOpen: boolean
  onFiles(): void
  onComputer(): void
  onResource(tab: "memory" | "skills" | "routines"): void
  onSettings(): void
  onImportContext?(): void
  onAsyncTasks?(): void
  onAvatar?(): void
  onSecrets(): void
  onApprovalRules?(): void
  onUpdate(patch: { hidden?: boolean; pinned?: boolean }): void
  onDelete(): void
  unread: boolean
  onRead(): void
  onClone(): void
  cloning: boolean
  cloneUnavailableReason?: string
  notificationAction?: ReactNode
  onPrimary?: () => void
}) {
  return (
    <TooltipProvider delayDuration={350}>
      <div className="bot-header-actions">
        <BotActionButton label="文件与成果" onClick={onFiles}>
          <Files size={17} />
        </BotActionButton>
        {!bot && (
          <>
            <BotActionButton label={unread ? "标为已读" : "标为未读"} onClick={onRead}>
              {unread ? <MailOpen size={17} /> : <Mail size={17} />}
            </BotActionButton>
            <BotActionButton label="群聊设置" onClick={onSettings}>
              <Settings2 size={17} />
            </BotActionButton>
          </>
        )}
        {bot && (
          <>
            <BotActionButton label="例程" onClick={() => onResource("routines")}>
              <Clock size={17} />
            </BotActionButton>
            <BotActionButton label="查看 Bot 浏览器" active={computerOpen} onClick={onComputer}>
              <Monitor size={17} />
            </BotActionButton>
            <Menu.Root>
              <Menu.Trigger asChild>
                <Button size="icon" variant="ghost" aria-label="更多 Bot 操作">
                  <MoreHorizontal size={19} />
                </Button>
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Content className="bot-more-menu" align="end" sideOffset={8}>
                  <Menu.Item onSelect={onSettings}>
                    <Settings2 size={15} />
                    Bot 设置
                  </Menu.Item>
                  {onPrimary && (
                    <Menu.Item onSelect={onPrimary}>
                      <Star size={15} />主 Bot 与主动跟进
                    </Menu.Item>
                  )}
                  <Menu.Item onSelect={onRead}>
                    {unread ? <MailOpen size={15} /> : <Mail size={15} />}
                    {unread ? "标为已读" : "标为未读"}
                  </Menu.Item>
                  {onAsyncTasks && (
                    <Menu.Item onSelect={onAsyncTasks}>
                      <ListTodo size={15} />
                      后台任务
                    </Menu.Item>
                  )}
                  {onAvatar && (
                    <Menu.Item onSelect={onAvatar}>
                      <ImagePlus size={15} />
                      头像图片
                    </Menu.Item>
                  )}
                  {onImportContext && (
                    <Menu.Item onSelect={onImportContext}>
                      <History size={15} /> 导入任务记录
                    </Menu.Item>
                  )}
                  <Menu.Item
                    onSelect={onClone}
                    disabled={cloning || !!cloneUnavailableReason}
                    aria-description={cloneUnavailableReason}
                    title={cloneUnavailableReason}
                  >
                    <Copy size={15} />
                    {cloning ? "正在复制…" : "复制 Bot"}
                    {cloneUnavailableReason && (
                      <span aria-hidden className="ml-auto text-xs">
                        需更新后台
                      </span>
                    )}
                  </Menu.Item>
                  <Menu.Item onSelect={() => onResource("memory")}>
                    <Brain size={15} />
                    记忆
                  </Menu.Item>
                  <Menu.Item onSelect={() => onResource("skills")}>
                    <BookOpen size={15} />
                    技能
                  </Menu.Item>
                  <Menu.Item onSelect={onSecrets}>
                    <KeyRound size={15} />
                    凭据管理
                  </Menu.Item>
                  {onApprovalRules && (
                    <Menu.Item onSelect={onApprovalRules}>
                      <ShieldCheck size={15} />
                      审批规则
                    </Menu.Item>
                  )}
                  <Menu.Separator />
                  {notificationAction}
                  <Menu.Item onSelect={() => onUpdate({ pinned: !bot.pinned })}>
                    <Pin size={15} />
                    {bot.pinned ? "取消置顶" : "置顶"}
                  </Menu.Item>
                  <Menu.Item onSelect={() => onUpdate({ hidden: !bot.hidden })}>
                    <EyeOff size={15} />
                    {bot.hidden ? "显示" : "隐藏"}
                  </Menu.Item>
                  <Menu.Separator />
                  <Menu.Item className="text-destructive" onSelect={onDelete}>
                    <Trash2 size={15} />
                    删除 Bot
                  </Menu.Item>
                </Menu.Content>
              </Menu.Portal>
            </Menu.Root>
          </>
        )}
      </div>
    </TooltipProvider>
  )
}
