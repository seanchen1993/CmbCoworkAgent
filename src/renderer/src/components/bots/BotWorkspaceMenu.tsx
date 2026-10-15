import { useState, useSyncExternalStore } from "react"
import { Archive, ArrowLeft, Settings2 } from "lucide-react"
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
  accentMode,
  onAccentChange,
  showArchived,
  onArchive,
  onWorkbench
}: {
  accentMode: "neutral" | "bot"
  onAccentChange(mode: "neutral" | "bot"): void
  showArchived: boolean
  onArchive(): void
  onWorkbench(): void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const mode = useSyncExternalStore(subscribeThemePreference, getThemeModePreference)
  const actionClass =
    "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="bot-icon-button" aria-label="Bot 工作区设置" title="设置">
          <Settings2 size={18} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={12}
        className="w-72 rounded-2xl p-2"
        aria-label="Bot 工作区设置"
      >
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
            <SelectContent>
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
            <SelectContent>
              <SelectItem value="neutral">黑色</SelectItem>
              <SelectItem value="bot">Bot 颜色</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="my-2 border-t" />
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
