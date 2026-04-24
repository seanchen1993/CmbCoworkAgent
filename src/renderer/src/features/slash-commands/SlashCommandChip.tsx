/**
 * Renders the slash-command selection pill.
 *
 * Used in two places:
 *   1. Inside the composer — with an `onRemove` button, so the user can drop
 *      their selection before sending.
 *   2. On top of a user message bubble — no remove button, purely decorative.
 *
 * Source palette: builtin/user/plugin each get distinct hues so the user can
 * visually tell which kind of skill they're invoking without reading the label.
 */
import { Package2, X } from "lucide-react"
import { cn } from "@/lib/utils"

type Source = "project" | "user" | "plugin"

interface Props {
  name: string
  source?: Source
  onRemove?: () => void
  className?: string
  compact?: boolean
}

const sourceClass: Record<Source, string> = {
  project: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  user: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  plugin: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
}

export function SlashCommandChip({
  name,
  source = "project",
  onRemove,
  className,
  compact
}: Props): React.ReactElement {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full font-medium",
        compact ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
        sourceClass[source],
        className
      )}
      title={name}
    >
      <Package2 className={compact ? "size-3" : "size-3.5"} />
      <span className={cn("truncate", compact ? "max-w-[120px]" : "max-w-[160px]")}>{name}</span>
      {onRemove && (
        <button
          type="button"
          className="ml-0.5 rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/10"
          onClick={onRemove}
          aria-label="移除技能"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  )
}
