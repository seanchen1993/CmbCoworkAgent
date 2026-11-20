import React from "react"
import { Globe2 } from "lucide-react"
import { cn } from "@/lib/utils"

interface BuiltinBrowserCommand {
  title: string
  description: string
  command: string
  usage?: string
}

interface Props {
  command: BuiltinBrowserCommand
  selected: boolean
  onHover: () => void
  onSelect: () => void
}

export const BuiltinBrowserCommandItem = React.forwardRef<HTMLButtonElement, Props>(
  ({ command, selected, onHover, onSelect }, ref) => (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={selected}
      onMouseEnter={onHover}
      onClick={onSelect}
      className={cn(
        "w-full text-left px-4 py-2 flex items-center gap-3 transition-colors",
        selected ? "bg-muted" : "hover:bg-muted/60"
      )}
    >
      <Globe2 className="size-4 text-muted-foreground shrink-0" />
      <span className="text-sm font-medium text-foreground shrink-0">{command.title}</span>
      <span className="text-sm text-muted-foreground truncate flex-1">{command.description}</span>
      <span className="text-xs text-muted-foreground/60 shrink-0">
        {command.usage ?? command.command}
      </span>
    </button>
  )
)

BuiltinBrowserCommandItem.displayName = "BuiltinBrowserCommandItem"
