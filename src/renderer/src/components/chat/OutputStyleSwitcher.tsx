import { memo, useCallback, useMemo, useState, type JSX } from "react"
import {
  AlignLeft,
  BookOpen,
  Check,
  ChevronDown,
  GraduationCap,
  Loader2,
  Minimize2,
  Palette,
  type LucideIcon
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useAppStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import {
  resolveThreadOutputStyle,
  type AgentOutputStyle
} from "../../../../shared/agent-output-style"

interface OutputStyleSwitcherProps {
  threadId: string
  disabled?: boolean
}

interface OutputStyleOption {
  value: AgentOutputStyle
  label: string
  description: string
  icon: LucideIcon
  iconClassName: string
  iconBackgroundClassName: string
  selectedClassName: string
  selectedCheckClassName: string
}

const OUTPUT_STYLE_OPTIONS: OutputStyleOption[] = [
  {
    value: "default",
    label: "标准",
    description: "保持日常回复方式，不额外调整表达。",
    icon: AlignLeft,
    iconClassName: "text-slate-600 dark:text-slate-300",
    iconBackgroundClassName: "bg-slate-500/10",
    selectedClassName:
      "border-slate-300/80 bg-slate-100/70 ring-slate-200/70 dark:border-slate-500/40 dark:bg-slate-500/10 dark:ring-slate-500/20",
    selectedCheckClassName: "bg-slate-600 dark:bg-slate-400"
  },
  {
    value: "concise",
    label: "精简",
    description: "先说结果，省略不必要的过程说明。",
    icon: Minimize2,
    iconClassName: "text-cyan-600 dark:text-cyan-300",
    iconBackgroundClassName: "bg-cyan-500/10",
    selectedClassName:
      "border-cyan-300/80 bg-cyan-50/80 ring-cyan-200/70 dark:border-cyan-500/40 dark:bg-cyan-500/10 dark:ring-cyan-500/20",
    selectedCheckClassName: "bg-cyan-600 dark:bg-cyan-400"
  },
  {
    value: "explanatory",
    label: "解释",
    description: "完成任务时说明为什么这样做和关键注意事项。",
    icon: BookOpen,
    iconClassName: "text-amber-600 dark:text-amber-300",
    iconBackgroundClassName: "bg-amber-500/10",
    selectedClassName:
      "border-amber-300/80 bg-amber-50/80 ring-amber-200/70 dark:border-amber-500/40 dark:bg-amber-500/10 dark:ring-amber-500/20",
    selectedCheckClassName: "bg-amber-600 dark:bg-amber-400"
  },
  {
    value: "learning",
    label: "学习",
    description: "通过小段实践和讲解，帮助你边做边理解。",
    icon: GraduationCap,
    iconClassName: "text-violet-600 dark:text-violet-300",
    iconBackgroundClassName: "bg-violet-500/10",
    selectedClassName:
      "border-violet-300/80 bg-violet-50/80 ring-violet-200/70 dark:border-violet-500/40 dark:bg-violet-500/10 dark:ring-violet-500/20",
    selectedCheckClassName: "bg-violet-600 dark:bg-violet-400"
  }
]

export const OutputStyleSwitcher = memo(OutputStyleSwitcherImpl)

function OutputStyleSwitcherImpl({
  threadId,
  disabled = false
}: OutputStyleSwitcherProps): JSX.Element {
  const threads = useAppStore((state) => state.threads)
  const updateThread = useAppStore((state) => state.updateThread)
  const [open, setOpen] = useState(false)
  const [pendingStyle, setPendingStyle] = useState<AgentOutputStyle | null>(null)

  const currentThread = useMemo(
    () => threads.find((thread) => thread.thread_id === threadId) ?? null,
    [threadId, threads]
  )
  const currentStyle = resolveThreadOutputStyle(currentThread?.metadata)
  const activeOption =
    OUTPUT_STYLE_OPTIONS.find((option) => option.value === currentStyle) ?? OUTPUT_STYLE_OPTIONS[0]
  const ActiveIcon = activeOption.icon

  const selectStyle = useCallback(
    async (nextStyle: AgentOutputStyle) => {
      if (pendingStyle || disabled) return
      if (nextStyle === currentStyle) {
        setOpen(false)
        return
      }

      setPendingStyle(nextStyle)
      try {
        const latestThread = await window.api.threads.get(threadId)
        const latestMetadata = latestThread?.metadata ?? currentThread?.metadata ?? {}
        await updateThread(threadId, {
          metadata: {
            ...(currentThread?.metadata ?? {}),
            ...latestMetadata,
            outputStyle: nextStyle,
            // Preserve compatibility with builds that only understand the old flag.
            conciseModeEnabled: nextStyle === "concise"
          }
        })
        setOpen(false)
        const label =
          OUTPUT_STYLE_OPTIONS.find((option) => option.value === nextStyle)?.label ?? nextStyle
        toast.success(`表达风格已切换为“${label}”，将从下一次发送开始生效`)
      } catch (error) {
        toast.error(`表达风格设置失败：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        setPendingStyle(null)
      }
    },
    [currentStyle, currentThread?.metadata, disabled, pendingStyle, threadId, updateThread]
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || Boolean(pendingStyle)}
          aria-label={`当前会话表达风格：${activeOption.label}`}
          title={`当前会话表达风格：${activeOption.label}（仅 Solo/Multi）`}
          className="h-8 gap-1.5 px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <span className={cn("grid size-5 place-items-center", activeOption.iconClassName)}>
            {pendingStyle ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ActiveIcon className="size-3.5" />
            )}
          </span>
          <span className="font-medium">{activeOption.label}</span>
          <ChevronDown className="size-3 opacity-70" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[380px] max-w-[calc(100vw-24px)] overflow-hidden rounded-2xl border-border/70 bg-popover/95 p-0 shadow-2xl backdrop-blur-xl"
        align="start"
        sideOffset={8}
      >
        <div className="border-b border-border/60 bg-gradient-to-br from-muted/60 to-background px-4 py-3.5">
          <div className="flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground">
            <Palette className="size-4 text-muted-foreground" />
            表达风格
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            只影响当前会话，从下一次发送开始生效
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 p-3">
          {OUTPUT_STYLE_OPTIONS.map((option) => {
            const selected = option.value === currentStyle
            const Icon = option.icon
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                disabled={disabled || Boolean(pendingStyle)}
                onClick={() => void selectStyle(option.value)}
                className={cn(
                  "group relative flex min-h-[108px] w-full flex-col items-start rounded-xl border p-3 text-left transition-all",
                  selected
                    ? cn("shadow-sm ring-1", option.selectedClassName)
                    : "border-border/60 bg-background/60 hover:-translate-y-0.5 hover:border-border hover:bg-muted/45 hover:shadow-sm",
                  (disabled || pendingStyle) && "cursor-not-allowed opacity-60"
                )}
              >
                <span
                  className={cn(
                    "grid size-8 shrink-0 place-items-center rounded-lg transition-transform group-hover:scale-105",
                    option.iconBackgroundClassName,
                    option.iconClassName
                  )}
                >
                  {pendingStyle === option.value ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Icon className="size-4" />
                  )}
                </span>
                <span className="mt-2.5 min-w-0">
                  <span className="text-sm font-semibold text-foreground">{option.label}</span>
                  <span className="mt-1 block text-[11px] leading-[1.55] text-muted-foreground">
                    {option.description}
                  </span>
                </span>
                {selected && (
                  <span
                    className={cn(
                      "absolute right-3 top-3 grid size-5 place-items-center rounded-full text-white shadow-sm",
                      option.selectedCheckClassName
                    )}
                  >
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
