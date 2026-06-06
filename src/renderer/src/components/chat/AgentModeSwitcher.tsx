import { useState, type JSX } from "react"
import { Check, ChevronDown, Route, Sparkles, Workflow, Zap } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type ChatAgentMode = "normal" | "coordinator"

interface AgentModeSwitcherProps {
  mode: ChatAgentMode
  disabled?: boolean
  disabledReason?: string
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
    label: "普通模式",
    shortLabel: "普通",
    description: "单 agent 直接执行，响应更快。",
    detail: "适合日常问答、小范围修改和快速排查。",
    badge: "轻量"
  },
  {
    value: "coordinator",
    label: "协同模式",
    shortLabel: "协同",
    description: "主 agent 编排，子代理实现和验收。",
    detail: "适合完整开发任务、文档产出和需要独立验证的改动。",
    badge: "多代理"
  }
]

export function AgentModeSwitcher({
  mode,
  disabled,
  disabledReason,
  onChange
}: AgentModeSwitcherProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const activeMode = MODES.find((item) => item.value === mode) ?? MODES[0]
  const ActiveIcon = mode === "coordinator" ? Workflow : Sparkles

  const handleModeSelect = (nextMode: ChatAgentMode): void => {
    if (nextMode !== mode) {
      onChange(nextMode)
    }
    setOpen(false)
  }

  const triggerTitle = disabled && disabledReason ? disabledReason : "选择执行模式"
  const triggerButton = (
    <Button
      variant="ghost"
      size="sm"
      disabled={disabled}
      className={cn(
        "h-8 gap-1.5 rounded-full border px-2.5 text-xs shadow-sm transition-all",
        mode === "coordinator"
          ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
          : "border-border bg-background/80 text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
      title={triggerTitle}
    >
      <span
        className={cn(
          "grid size-5 place-items-center rounded-full",
          mode === "coordinator"
            ? "bg-emerald-500 text-white"
            : "bg-muted text-muted-foreground"
        )}
      >
        <ActiveIcon className="size-3.5" />
      </span>
      <span className="font-medium">{activeMode.shortLabel}</span>
      <ChevronDown className="size-3 opacity-70" />
    </Button>
  )

  if (disabled) {
    return (
      <span className="inline-flex cursor-not-allowed" title={triggerTitle}>
        {triggerButton}
      </span>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
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
                选择这次任务是快速直达，还是走多角色协同。
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-2 p-2">
          {MODES.map((item) => {
            const selected = item.value === mode
            const Icon = item.value === "coordinator" ? Workflow : Zap
            return (
              <button
                key={item.value}
                type="button"
                onClick={() => handleModeSelect(item.value)}
                className={cn(
                  "group flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-all",
                  selected
                    ? item.value === "coordinator"
                      ? "border-emerald-200 bg-emerald-50/80 text-foreground shadow-sm dark:border-emerald-500/30 dark:bg-emerald-500/10"
                      : "border-border bg-muted/70 text-foreground shadow-sm"
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
    </Popover>
  )
}
