import React from "react"
import { cn } from "@/lib/utils"
import { Package2, X } from "lucide-react"

interface Props {
  label: string
  onRemove?: () => void
  /**
   * When true, the × button is shown but disabled (greyed out + tooltip explaining why).
   * Use this instead of omitting onRemove during transient states (e.g. a send is in flight)
   * so the control doesn't vanish from the user's eye and come back a moment later.
   */
  removeDisabled?: boolean
  removeDisabledTitle?: string
  className?: string
  compact?: boolean
}

export function SkillChip({
  label,
  onRemove,
  removeDisabled,
  removeDisabledTitle,
  className,
  compact
}: Props): React.ReactElement {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md align-middle",
        "bg-violet-100 text-violet-700",
        "dark:bg-violet-500/20 dark:text-violet-300",
        compact ? "px-1.5 py-0.5 text-xs" : "px-2 py-1 text-sm",
        "font-medium",
        className
      )}
    >
      <Package2 className={compact ? "size-3" : "size-3.5"} />
      <span className="max-w-[160px] truncate">{label}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={removeDisabled}
          title={removeDisabled ? removeDisabledTitle : undefined}
          className="ml-0.5 opacity-60 hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:opacity-30"
          aria-label="移除技能"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  )
}
