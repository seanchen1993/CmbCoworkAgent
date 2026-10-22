import { useRef, useState, useSyncExternalStore } from "react"
import { Archive, ArrowLeft, ChevronRight, CircleUserRound, EyeOff } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import {
  getThemeModePreference,
  setThemeModePreference,
  subscribeThemePreference,
  type ThemeModePreference
} from "@/lib/theme-preference"

export function BotWorkspaceMenu({
  profileName,
  initials,
  accentMode,
  onAccentChange,
  showArchived,
  showHidden,
  onArchive,
  onHidden,
  onProfile,
  onWorkbench
}: {
  profileName: string
  initials: string
  accentMode: "neutral" | "bot"
  onAccentChange(mode: "neutral" | "bot"): void
  showArchived: boolean
  showHidden: boolean
  onArchive(): void
  onHidden(): void
  onProfile(): void
  onWorkbench(): void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const menuTrigger = useRef<HTMLButtonElement>(null)
  const mode = useSyncExternalStore(subscribeThemePreference, getThemeModePreference)
  const actionClass =
    "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={menuTrigger}
          className="bot-icon-button bot-account-button"
          aria-label="Bot 工作区设置"
          title={profileName || "设置"}
        >
          {initials ? (
            <span aria-hidden="true">{initials}</span>
          ) : (
            <CircleUserRound size={22} aria-hidden="true" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        data-bot-popup
        side="top"
        align="start"
        sideOffset={12}
        className="bot-workspace-menu w-72 rounded-2xl p-2"
        aria-label="Bot 工作区设置"
      >
        <button
          className={actionClass}
          aria-label="个人信息"
          onClick={() => {
            setOpen(false)
            // SettingsOverlay must capture the persistent opener, not this menu item.
            if (menuTrigger.current?.isConnected) menuTrigger.current.focus({ preventScroll: true })
            onProfile()
          }}
        >
          <CircleUserRound size={18} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-left">{profileName || "个人信息"}</span>
          <ChevronRight size={15} aria-hidden="true" />
        </button>
        <div className="my-2 border-t" />
        <div className="px-3 pb-2 pt-2 text-xs font-medium text-muted-foreground">外观</div>
        <div className="flex items-center justify-between gap-4 px-3 py-2 text-sm">
          <span id="bot-theme-label">主题</span>
          <Select
            value={mode}
            onValueChange={(value) => setThemeModePreference(value as ThemeModePreference)}
          >
            <SelectTrigger
              aria-labelledby="bot-theme-label"
              className="h-8 w-32 border-0 bg-transparent shadow-none"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent data-bot-popup className="bot-workspace-select rounded-xl">
              <SelectItem value="system">跟随系统</SelectItem>
              <SelectItem value="light">浅色</SelectItem>
              <SelectItem value="dark">深色</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-4 px-3 py-2 text-sm">
          <span id="bot-accent-label">强调色</span>
          <Select
            value={accentMode}
            onValueChange={(value) => onAccentChange(value as "neutral" | "bot")}
          >
            <SelectTrigger
              aria-labelledby="bot-accent-label"
              className="h-8 w-32 border-0 bg-transparent shadow-none"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent data-bot-popup className="bot-workspace-select rounded-xl">
              <SelectItem value="neutral">黑色</SelectItem>
              <SelectItem value="bot">Bot 颜色</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="my-2 border-t" />
        <button
          className={actionClass}
          aria-pressed={showHidden}
          onClick={() => {
            setOpen(false)
            onHidden()
          }}
        >
          <EyeOff size={16} aria-hidden="true" />
          {showHidden ? "返回会话列表" : "显示隐藏的会话"}
        </button>
        <button
          className={actionClass}
          onClick={() => {
            setOpen(false)
            onArchive()
          }}
        >
          <Archive size={16} aria-hidden="true" />
          {showArchived ? "显示活跃 Bot" : "已归档 Bot"}
        </button>
        <button
          className={actionClass}
          onClick={() => {
            setOpen(false)
            onWorkbench()
          }}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          返回 CMBDevClaw 工作台
        </button>
      </PopoverContent>
    </Popover>
  )
}
