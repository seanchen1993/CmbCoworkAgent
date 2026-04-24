/**
 * Slash-command picker popover.
 *
 * Absolutely positioned above the composer by the caller. We render only the
 * list + empty-state; caller owns visibility (mode) and keyboard wiring.
 */
import { Package2, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import type { PopoverMode } from "./useSlashCommands"
import type { SlashCommandListItem } from "./types"

interface Props {
  mode: PopoverMode
  items: SlashCommandListItem[]
  loading: boolean
  selectedIdx: number
  onHoverIdx: (idx: number) => void
  onPick: (item: SlashCommandListItem) => void
}

export function SlashCommandPopover({
  mode,
  items,
  loading,
  selectedIdx,
  onHoverIdx,
  onPick
}: Props): React.ReactElement | null {
  if (mode.kind !== "open") return null

  return (
    <div
      className={cn(
        "absolute bottom-full left-0 mb-2 w-[min(420px,100%)] overflow-hidden rounded-lg border bg-popover shadow-lg",
        "max-h-[280px] overflow-y-auto text-sm"
      )}
      // Don't steal focus from the textarea when clicking entries — keyboard
      // nav stays on the composer.
      onMouseDown={(e) => e.preventDefault()}
    >
      {loading ? (
        <div className="flex items-center gap-2 px-3 py-3 text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          <span>加载技能列表...</span>
        </div>
      ) : items.length === 0 ? (
        <div className="px-3 py-3 text-muted-foreground">未找到匹配的技能</div>
      ) : (
        <ul className="py-1">
          {items.map((item, idx) => {
            const active = idx === selectedIdx
            return (
              <li
                key={item.id}
                className={cn(
                  "flex items-start gap-2 px-3 py-2 cursor-pointer",
                  active ? "bg-accent text-accent-foreground" : "hover:bg-muted"
                )}
                onMouseEnter={() => onHoverIdx(idx)}
                onClick={() => onPick(item)}
              >
                <Package2 className="size-4 mt-0.5 shrink-0 text-violet-600 dark:text-violet-400" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{item.name}</span>
                    <span className="text-[10px] uppercase text-muted-foreground">
                      {item.source}
                    </span>
                  </div>
                  {item.description && (
                    <div className="text-xs text-muted-foreground truncate">{item.description}</div>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
