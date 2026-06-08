import { useId, useState, type JSX } from "react"
import { AlertTriangle, Check, ChevronDown, Route, Workflow, Zap } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type ChatAgentMode = "normal" | "coordinator"

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
    description: "单 agent 串行执行，低开销、响应快。",
    detail: "适合日常问答、明确小改动、快速排查与验证。",
    badge: "轻量"
  },
  {
    value: "coordinator",
    label: "Agent Team",
    shortLabel: "Team",
    description: "多代理并行研究、实现、验证与汇总。",
    detail: "适合复杂开发、深度排查、文档产出和高可信交付。",
    badge: "编排"
  }
]

export function AgentModeSwitcher({
  mode,
  locked,
  lockedReason,
  onChange
}: AgentModeSwitcherProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const lockedReasonId = useId()
  const activeMode = MODES.find((item) => item.value === mode) ?? MODES[0]
  const ActiveIcon = mode === "coordinator" ? Workflow : Zap

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
        mode === "coordinator"
          ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
          : "border-border bg-background/80 text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      <span
        className={cn(
          "grid size-5 place-items-center rounded-full",
          mode === "coordinator" ? "bg-emerald-500 text-white" : "bg-muted text-muted-foreground"
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
      className="w-[360px] overflow-hidden border-border bg-background p-0 shadow-xl"
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
              Solo Agent 快速直达；Agent Team 多代理编排。
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
          const Icon = item.value === "coordinator" ? Workflow : Zap
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
                  ? item.value === "coordinator"
                    ? "border-emerald-200 bg-emerald-50/80 text-foreground shadow-sm dark:border-emerald-500/30 dark:bg-emerald-500/10"
                    : "border-border bg-muted/70 text-foreground shadow-sm"
                  : locked
                    ? "cursor-not-allowed border-transparent text-muted-foreground opacity-70"
                    : "border-transparent text-muted-foreground hover:border-border hover:bg-muted/50 hover:text-foreground"
              )}
            >
              <span
                className={cn(
                  "mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl transition-colors",
                  item.value === "coordinator"
                    ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300"
                    : "bg-muted text-muted-foreground group-hover:text-foreground"
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
                      item.value === "coordinator"
                        ? "border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-300"
                        : "border-border bg-background text-muted-foreground"
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
