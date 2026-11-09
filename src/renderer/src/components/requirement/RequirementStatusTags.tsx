import { useEffect, useRef, useState } from "react"
import { Code2, FileCheck2, PanelsTopLeft, Send, type LucideIcon } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

type RequirementStatusTagProps = {
  active: boolean
  inactiveLabel: string
  activeLabel: string
  icon: LucideIcon
  activeDescription: string
  inactiveDescription: string
}

function RequirementStatusTag({
  active,
  inactiveLabel,
  activeLabel,
  icon: Icon,
  activeDescription,
  inactiveDescription
}: RequirementStatusTagProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearCloseTimer = (): void => {
    if (!closeTimerRef.current) return
    clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }
  const show = (): void => {
    clearCloseTimer()
    setOpen(true)
  }
  const hide = (): void => {
    clearCloseTimer()
    closeTimerRef.current = setTimeout(() => setOpen(false), 100)
  }

  useEffect(() => clearCloseTimer, [])

  const label = active ? activeLabel : inactiveLabel
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onPointerEnter={show}
          onPointerLeave={hide}
          onFocus={show}
          onBlur={hide}
          aria-label={`${label}：${active ? activeDescription : inactiveDescription}`}
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            active ? "bg-[#f8ede4] text-[#b97843]" : "bg-muted text-muted-foreground/60"
          )}
        >
          <Icon className="size-3" strokeWidth={1.8} />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={6}
        className="z-[80] w-64 p-3"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={show}
        onPointerLeave={hide}
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-full",
              active ? "bg-[#f8ede4] text-[#b97843]" : "bg-muted text-muted-foreground"
            )}
          >
            <Icon className="size-3.5" strokeWidth={1.8} />
          </span>
          <span className="text-xs font-semibold text-foreground">{label}</span>
        </div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {active ? activeDescription : inactiveDescription}
        </p>
      </PopoverContent>
    </Popover>
  )
}

export function RequirementStatusTags({
  standardized,
  hasPrototype,
  published,
  developmentStatus = "not-started"
}: {
  standardized: boolean
  hasPrototype: boolean
  published: boolean
  developmentStatus?: "not-started" | "in-progress"
}): React.JSX.Element {
  const tags: RequirementStatusTagProps[] = [
    {
      active: standardized,
      inactiveLabel: "未规范",
      activeLabel: "已规范",
      icon: FileCheck2,
      activeDescription:
        "这个需求特性已经生成了规范的 PRD 文件，可以查看完整的需求说明和功能清单。",
      inactiveDescription:
        "这个需求特性还没有生成规范的 PRD 文件。完成需求沟通和专家分析后，就会变为“已规范”。"
    },
    {
      active: hasPrototype,
      inactiveLabel: "无原型",
      activeLabel: "有原型",
      icon: PanelsTopLeft,
      activeDescription: "这个需求特性已经有可查看的页面原型，可以用来确认页面样式和操作流程。",
      inactiveDescription:
        "这个需求特性还没有页面原型。完成原型设计后，就可以在这里查看并确认效果。"
    },
    {
      active: published,
      inactiveLabel: "未发布",
      activeLabel: "已发布",
      icon: Send,
      activeDescription: "这个需求特性已经发布到需求空间 3.0，相关成员可以进入需求详情查看。",
      inactiveDescription:
        "这个需求特性还没有发布到需求空间 3.0。确认内容无误后，可以在需求详情中完成发布。"
    },
    {
      active: developmentStatus !== "not-started",
      inactiveLabel: "未开发",
      activeLabel: "开发中",
      icon: Code2,
      activeDescription: "这个需求已经创建开发会话，可以继续进入项目模式推进实现。",
      inactiveDescription: "这个需求尚未创建开发会话。点击“去开发”可以选择代码目录并开始开发。"
    }
  ]

  return (
    <div className="flex shrink-0 items-center gap-1.5" aria-label="需求状态">
      {tags.map((tag) => (
        <RequirementStatusTag key={tag.inactiveLabel} {...tag} />
      ))}
    </div>
  )
}
