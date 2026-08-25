import React from "react"
import { Globe2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { BuiltinBrowserScreenshotToggle } from "./BuiltinBrowserScreenshotToggle"

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

export const BuiltinBrowserCommandItem = React.forwardRef<HTMLDivElement, Props>(
  ({ command, selected, onHover, onSelect }, ref) => (
    <div
      ref={ref}
      role="option"
      aria-selected={selected}
      onMouseEnter={onHover}
      className={cn(
        "w-full px-4 py-2 flex items-center gap-3 transition-colors",
        selected ? "bg-muted" : "hover:bg-muted/60"
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="min-w-0 flex-1 text-left flex items-center gap-3"
      >
        <Globe2 className="size-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-medium text-foreground shrink-0">{command.title}</span>
        <span className="text-sm text-muted-foreground truncate flex-1">{command.description}</span>
        <span className="text-xs text-muted-foreground/60 shrink-0">
          {command.usage ?? command.command}
        </span>
      </button>
      <BuiltinBrowserScreenshotToggle />
    </div>
  )
)

BuiltinBrowserCommandItem.displayName = "BuiltinBrowserCommandItem"
