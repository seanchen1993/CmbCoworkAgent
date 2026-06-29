import React from "react"
import { FileText, X } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

interface Props {
  label: string
  popoverText?: string
  onRemove?: () => void
  className?: string
}

function stripMentionPrefix(label: string): string {
  if (label.startsWith('@"')) {
    return label.slice(2).replace(/"$/, "")
  }
  if (label.startsWith("@")) {
    return label.slice(1)
  }
  return label
}

export function MentionFileChip({
  label,
  popoverText,
  onRemove,
  className
}: Props): React.ReactElement {
  const displayLabel = stripMentionPrefix(label)
  const [open, setOpen] = React.useState(false)
  const showPopover = Boolean(popoverText?.trim())

  const chipLabel = (
    <>
      <FileText className="size-3.5 shrink-0" />
      <span className="max-w-[220px] truncate">{displayLabel}</span>
    </>
  )

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded align-middle cursor-default",
        "bg-blue-200/40 text-blue-600 dark:bg-sky-500/20 dark:text-sky-300",
        "px-2 py-1 text-xs font-medium",
        className
      )}
    >
      {showPopover ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="inline-flex min-w-0 items-center gap-1 text-left outline-none transition-opacity hover:opacity-90"
              aria-label={`查看文件路径 ${displayLabel}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setOpen(true)}
              onMouseLeave={() => setOpen(false)}
              onFocus={() => setOpen(true)}
              onBlur={() => setOpen(false)}
              title={popoverText}
            >
              {chipLabel}
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            className="max-w-sm break-all px-3 py-2 text-xs"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
          >
           引入的文件路径： {popoverText}
          </PopoverContent>
        </Popover>
      ) : (
        chipLabel
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="ml-0.5 opacity-70 transition-opacity hover:opacity-100"
          aria-label="移除文件标签"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  )
}
