import React, { useEffect, useRef } from "react"
import { FileText } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AtFilePopoverMode, AtFileSuggestion } from "./useAtFileMentions"

interface Props {
  mode: AtFilePopoverMode
  selectedIdx: number
  onHoverIdx: (idx: number) => void
  onSelectFile: (file: AtFileSuggestion) => void
}

export function AtFileMentionPopover({
  mode,
  selectedIdx,
  onHoverIdx,
  onSelectFile
}: Props): React.ReactElement | null {
  const selectedRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" })
  }, [selectedIdx, mode.kind])

  if (mode.kind === "closed") return null

  return (
    <div
      role="listbox"
      className={cn(
        "absolute left-0 right-0 bottom-full mb-2 z-20",
        "rounded-2xl border border-border bg-popover shadow-lg",
        "max-h-80 flex flex-col"
      )}
    >
      <div className="px-4 pt-3 pb-1 text-xs text-muted-foreground/70">工作区文件</div>
      <div  className={cn(
        "flex-1 overflow-y-auto"
      )}>
        {mode.suggestions.length === 0 ? (
          <div className="px-4 py-4 text-sm text-muted-foreground">没有匹配的文件</div>
        ) : (
          <div className="py-1">
            {mode.suggestions.map((file, idx) => {
              const isSelected = idx === selectedIdx
              return (
                <button
                  key={file.id}
                  ref={isSelected ? selectedRef : null}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => onHoverIdx(idx)}
                  onClick={() => onSelectFile(file)}
                  className={cn(
                    "w-full text-left px-4 py-1 flex items-center gap-2 transition-colors",
                    isSelected ? "bg-muted" : "hover:bg-muted/60"
                  )}
                >
                  <FileText className="size-3 text-muted-foreground shrink-0" />
                  <span className="text-sm text-foreground truncate ">{file.filename}</span>
                  <span className="text-xs text-muted-foreground/60 shrink-0 truncate flex-1">
                  {file.workspaceFilePath}
                </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
