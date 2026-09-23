import { useEffect, useState } from "react"
import type { FunctionLogEntry } from "../../../../shared/mods/v2/ui-log"

export function FunctionLogsContent({
  entries
}: {
  entries: FunctionLogEntry[]
}): React.JSX.Element | null {
  if (!entries.length) return null
  return (
    <div
      data-function-logs
      className="max-h-48 space-y-1 overflow-y-auto overscroll-contain text-xs text-muted-foreground"
      tabIndex={0}
      aria-label="插件日志"
    >
      <p className="opacity-60">插件日志</p>
      {entries.map((entry) => (
        <p key={entry.id} data-function-log={entry.id} className="whitespace-pre-wrap break-words">
          <span className="mr-2 opacity-60">{entry.plugin}</span>
          {entry.text}
        </p>
      ))}
    </div>
  )
}

/** A separate conversation display channel. It never modifies the message transcript. */
export function FunctionLogs({ threadId }: { threadId: string }): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<{ threadId: string; entries: FunctionLogEntry[] }>()
  useEffect(() => {
    let live = true
    let sequence = 0
    const refresh = () => {
      const request = ++sequence
      void window.api.mods.logs(threadId).then(
        (entries) => {
          if (live && sequence === request) setSnapshot({ threadId, entries })
        },
        () => {
          if (live && sequence === request) setSnapshot({ threadId, entries: [] })
        }
      )
    }
    const stop = window.api.mods.onCardsChanged((event) => {
      if (event.threadId === threadId) refresh()
    })
    window.addEventListener("mods:configuration-changed", refresh)
    refresh()
    return () => {
      live = false
      stop()
      window.removeEventListener("mods:configuration-changed", refresh)
    }
  }, [threadId])
  return <FunctionLogsContent entries={snapshot?.threadId === threadId ? snapshot.entries : []} />
}
