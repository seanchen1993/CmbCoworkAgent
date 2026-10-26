import { ListTree } from "lucide-react"
import { useBotViewStore } from "./view-store"

/** Both entrances share the presentation preference; messages and execution stay unchanged. */
export function BotExecutionDetailsToggle({
  hostId,
  compact = false
}: {
  hostId: string
  compact?: boolean
}) {
  const shown = useBotViewStore((state) => Boolean(state.hosts[hostId]?.showExecutionDetails))
  const label = shown ? "收起执行过程" : "查看执行过程"
  return (
    <button
      type="button"
      className={
        compact
          ? "bot-icon-button bot-execution-toggle"
          : "inline-flex shrink-0 items-center gap-1.5 rounded border px-2 py-1 hover:bg-muted aria-pressed:bg-muted aria-pressed:text-foreground"
      }
      aria-label={label}
      title={label}
      aria-pressed={shown}
      onClick={() => useBotViewStore.getState().update(hostId, { showExecutionDetails: !shown })}
    >
      <ListTree size={compact ? 18 : 14} aria-hidden="true" />
      {!compact && <span>{shown ? "收起明细" : "执行明细"}</span>}
    </button>
  )
}
