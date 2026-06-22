import { useId, useState, type JSX } from "react"
import { AlertTriangle, Check, ChevronDown, Route, Sparkles, Workflow, Zap } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type ChatAgentMode = "normal" | "coordinator" | "workflow"

interface AgentModeSwitcherProps {
  mode: ChatAgentMode
  locked?: boolean
  lockedReason?: string
  onChange: (mode: ChatAgentMode) => void
}

const MODES: Array<{
  value: ChatAgentMode
  label: string
  shortLabel: string
  description: string
  detail: string
  badge: string
}> = [
  {
    value: "normal",
    label: "Solo Agent",
    shortLabel: "Solo",
    description: "单主控轻量执行，必要时并行委派。",
    detail: "适合日常问答、明确小改动、快速排查与独立子任务。",
    badge: "轻量"
  },
  {
    value: "coordinator",
    label: "Agent Team",
    shortLabel: "Team",
    description: "多代理并行研究、实现、验证与汇总。",
    detail: "适合复杂开发、深度排查、文档产出和高可信交付。",
    badge: "编排"
  },
  {
    value: "workflow",
    label: "Ultra Workflow",
    shortLabel: "Workflow",
    description: "模型编写编排脚本，批量并行子代理执行与交叉验证。",
    detail: "适合全库审计、批量迁移、大规模调研等可分解的大任务。",
    badge: "动态工作流"
  }
]

const MODE_ICONS: Record<ChatAgentMode, typeof Zap> = {
  normal: Zap,
  coordinator: Workflow,
  workflow: Sparkles
}

interface ModeTheme {
  trigger: string
  triggerIcon: string
  itemSelected: string
  itemIcon: string
  badge: string
}

const NEUTRAL_THEME: ModeTheme = {
  trigger:
    "border-border bg-background/80 text-muted-foreground hover:bg-muted hover:text-foreground",
  triggerIcon: "bg-muted text-muted-foreground",
  itemSelected: "border-border bg-muted/70 text-foreground shadow-sm",
  itemIcon: "bg-muted text-muted-foreground group-hover:text-foreground",
  badge: "border-border bg-background text-muted-foreground"
}

const MODE_THEMES: Record<ChatAgentMode, ModeTheme> = {
  normal: NEUTRAL_THEME,
  coordinator: {
    trigger:
      "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300",
    triggerIcon: "bg-emerald-500 text-white",
    itemSelected:
      "border-emerald-200 bg-emerald-50/80 text-foreground shadow-sm dark:border-emerald-500/30 dark:bg-emerald-500/10",
    itemIcon: "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300",
    badge:
      "border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-300"
  },
  workflow: {
    trigger:
      "border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300",
    triggerIcon: "bg-violet-500 text-white",
    itemSelected:
      "border-violet-200 bg-violet-50/80 text-foreground shadow-sm dark:border-violet-500/30 dark:bg-violet-500/10",
    itemIcon: "bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300",
    badge:
      "border-violet-200 bg-violet-100 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/15 dark:text-violet-300"
  }
}

export function AgentModeSwitcher({
  mode,
  locked,
  lockedReason,
  onChange
}: AgentModeSwitcherProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const lockedReasonId = useId()
  const activeMode = MODES.find((item) => item.value === mode) ?? MODES[0]
  const activeTheme = MODE_THEMES[activeMode.value]
  const ActiveIcon = MODE_ICONS[activeMode.value]

  const handleModeSelect = (nextMode: ChatAgentMode): void => {
    if (nextMode !== mode) {
      onChange(nextMode)
    }
    setOpen(false)
  }

  const modeButton = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={
        locked
          ? `执行模式：${activeMode.shortLabel}。已锁定，可打开查看原因。`
          : `执行模式：${activeMode.shortLabel}。选择执行模式。`
      }
      aria-describedby={lockedReason ? lockedReasonId : undefined}
      className={cn(
        "h-8 gap-1.5 rounded-full border px-2.5 text-xs shadow-sm transition-all",
        mode === "normal" ? NEUTRAL_THEME.trigger : activeTheme.trigger
      )}
    >
      <span
        className={cn(
          "grid size-5 place-items-center rounded-full",
          mode === "normal" ? NEUTRAL_THEME.triggerIcon : activeTheme.triggerIcon
        )}
      >
        <ActiveIcon className="size-3.5" />
      </span>
      <span className="font-medium">{activeMode.shortLabel}</span>
      <ChevronDown className="size-3 opacity-70" />
      {lockedReason && (
        <span id={lockedReasonId} className="sr-only">
          {lockedReason}
        </span>
      )}
    </Button>
  )

  const popoverContent = (
    <PopoverContent
      className="w-[420px] overflow-hidden border-border bg-background p-0 shadow-xl"
      align="start"
      sideOffset={8}
    >
      <div className="border-b border-border bg-gradient-to-br from-muted/80 via-background to-emerald-50/60 px-4 py-3 dark:to-emerald-500/10">
        <div className="flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-xl bg-foreground text-background shadow-sm">
            <Route className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">执行模式</div>
            <div className="text-xs leading-5 text-muted-foreground">
              Solo 快速直达；Team 多代理编排；Workflow 大规模并行。
            </div>
          </div>
        </div>
      </div>

      {locked && lockedReason && (
        <div className="mx-2 mt-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{lockedReason}</span>
        </div>
      )}

      <div className="space-y-2 p-2">
        {MODES.map((item) => {
          const selected = item.value === mode
          const Icon = MODE_ICONS[item.value]
          const theme = MODE_THEMES[item.value]
          return (
            <button
              key={item.value}
              type="button"
              disabled={locked && !selected}
              aria-current={selected ? "true" : undefined}
              onClick={() => {
                if (selected) {
                  setOpen(false)
                  return
                }
                handleModeSelect(item.value)
              }}
              className={cn(
                "group flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-all",
                selected
                  ? theme.itemSelected
                  : locked
                    ? "cursor-not-allowed border-transparent text-muted-foreground opacity-70"
                    : "border-transparent text-muted-foreground hover:border-border hover:bg-muted/50 hover:text-foreground"
              )}
            >
              <span
                className={cn(
                  "mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl transition-colors",
                  theme.itemIcon
                )}
              >
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{item.label}</span>
                  <span
                    className={cn(
                      "rounded-full border px-1.5 py-0.5 text-[10px] leading-none",
                      theme.badge
                    )}
                  >
                    {item.badge}
                  </span>
                </span>
                <span className="mt-1 block text-xs leading-5 text-foreground/80">
                  {item.description}
                </span>
                <span className="block text-[11px] leading-5 text-muted-foreground">
                  {item.detail}
                </span>
              </span>
              {selected && (
                <span className="mt-1 grid size-5 shrink-0 place-items-center rounded-full bg-foreground text-background">
                  <Check className="size-3.5" />
                </span>
              )}
            </button>
          )
        })}
      </div>
    </PopoverContent>
  )

  if (locked) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{modeButton}</PopoverTrigger>
        {popoverContent}
      </Popover>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{modeButton}</PopoverTrigger>
      {popoverContent}
    </Popover>
  )
}
