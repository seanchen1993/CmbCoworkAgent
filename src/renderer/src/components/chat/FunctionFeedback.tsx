import { useEffect, useState } from "react"
import type { FunctionFeedbackEntry } from "../../../../shared/mods/v2/ui-feedback"

/** A session-local prompt rail; never inserts messages or acknowledges a tool/approval. */
export function FunctionFeedback({
  threadId,
  requestId
}: {
  threadId: string
  requestId?: string
}): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<{ threadId: string; entries: FunctionFeedbackEntry[] }>()
  useEffect(() => {
    let live = true
    let sequence = 0
    const refresh = () => {
      const request = ++sequence
      void window.api.mods.feedback(threadId).then(
        (entries) => {
          if (live && request === sequence) setSnapshot({ threadId, entries })
        },
        () => {
          if (live && request === sequence) setSnapshot({ threadId, entries: [] })
        }
      )
    }
    const unsubscribe = window.api.mods.onCardsChanged((event) => {
      if (event.threadId === threadId) refresh()
    })
    window.addEventListener("mods:configuration-changed", refresh)
    refresh()
    return () => {
      live = false
      unsubscribe()
      window.removeEventListener("mods:configuration-changed", refresh)
    }
  }, [threadId])
  const entries = (snapshot?.threadId === threadId ? snapshot.entries : []).filter((entry) =>
    requestId ? entry.kind === "notice" && entry.requestId === requestId : entry.kind !== "notice"
  )
  if (!entries.length) return null
  return (
    <div
      className="mx-auto max-h-32 max-w-3xl space-y-1 overflow-y-auto overscroll-contain px-3 py-1 text-xs text-muted-foreground"
      data-function-feedback
      data-function-dialog-notices={requestId}
      tabIndex={0}
      aria-label={requestId ? "插件问题说明" : "插件状态与提示"}
      role="status"
      aria-live="polite"
    >
      {entries.map((entry) => (
        <p
          key={entry.id}
          data-feedback-kind={entry.kind}
          data-feedback-plugin={entry.plugin}
          className={requestId ? "truncate" : "whitespace-pre-wrap break-words"}
          title={requestId ? entry.text : undefined}
        >
          <span className="mr-2 opacity-60">{entry.plugin}</span>
          {entry.text}
        </p>
      ))}
    </div>
  )
}
