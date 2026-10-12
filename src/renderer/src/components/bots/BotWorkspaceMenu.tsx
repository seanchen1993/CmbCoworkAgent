import * as Menu from "@radix-ui/react-dropdown-menu"
import {
  Archive,
  ArrowLeft,
  Clock,
  Download,
  EyeOff,
  ListFilter,
  HardDrive,
  Gauge,
  Keyboard,
  MoreHorizontal,
  RotateCcw,
  Store,
  Star,
  Users
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAppStore } from "@/lib/store"

export function BotWorkspaceMenu({
  group,
  canGroup,
  storage,
  backups,
  downloads,
  usage,
  recoveryRecords,
  hidden,
  showHidden,
  keyboard,
  filter,
  filtering = false,
  primary
}: {
  group(): void
  canGroup: boolean
  storage?: () => void
  backups?: () => void
  downloads?: () => void
  usage?: () => void
  recoveryRecords?: () => void
  hidden(): void
  showHidden: boolean
  keyboard(): void
  filter?: () => void
  filtering?: boolean
  primary?: () => void
}) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="size-8 rounded-full"
          aria-label="工作区菜单"
          title="工作区菜单"
        >
          <MoreHorizontal size={18} />
        </Button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="bot-more-menu" align="end" sideOffset={8}>
          {primary && (
            <Menu.Item onSelect={primary}>
              <Star size={15} />主 Bot 与主动跟进
            </Menu.Item>
          )}
          <Menu.Item disabled={!canGroup} onSelect={group}>
            <Users size={15} />
            创建协作群聊
          </Menu.Item>
          {filter && (
            <Menu.Item onSelect={filter}>
              <ListFilter size={15} />
              {filtering ? "关闭列表筛选" : "筛选 Bot 列表"}
            </Menu.Item>
          )}
          <Menu.Item onSelect={hidden}>
            <EyeOff size={15} />
            {showHidden ? "收起隐藏的 Bot" : "显示隐藏的 Bot"}
          </Menu.Item>
          <Menu.Separator />
          {recoveryRecords && (
            <Menu.Item onSelect={recoveryRecords}>
              <RotateCcw size={15} />
              待确认的任务恢复
            </Menu.Item>
          )}
          {downloads && (
            <Menu.Item onSelect={downloads}>
              <Download size={15} />
              下载与保存
            </Menu.Item>
          )}
          {usage && (
            <Menu.Item onSelect={usage}>
              <Gauge size={15} />
              用量与额度
            </Menu.Item>
          )}
          {storage && (
            <Menu.Item onSelect={storage}>
              <HardDrive size={15} />
              磁盘容量
            </Menu.Item>
          )}
          {backups && (
            <Menu.Item onSelect={backups}>
              <Archive size={15} />
              备份与恢复
            </Menu.Item>
          )}
          <Menu.Item onSelect={keyboard}>
            <Keyboard size={15} />
            Bot 快捷键
          </Menu.Item>
          <Menu.Separator />
          <Menu.Item onSelect={() => useAppStore.getState().setMainView("thread")}>
            <ArrowLeft size={15} />
            返回工作台
          </Menu.Item>
          <Menu.Item onSelect={() => useAppStore.getState().setMainView("scheduled")}>
            <Clock size={15} />
            自动化
          </Menu.Item>
          <Menu.Item onSelect={() => useAppStore.getState().setMainView("market")}>
            <Store size={15} />
            应用市场
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
