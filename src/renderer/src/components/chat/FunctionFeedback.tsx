import { useEffect, useState } from "react"
import type { FunctionFeedbackEntry } from "../../../../shared/mods/v2/ui-feedback"

/** A session-local prompt rail; never inserts messages or acknowledges a tool/approval. */
export function FunctionFeedback({ threadId }: { threadId: string }): React.JSX.Element | null {
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
  const entries = snapshot?.threadId === threadId ? snapshot.entries : []
  if (!entries.length) return null
  return (
    <div
      className="mx-auto max-w-3xl space-y-1 px-3 py-1 text-xs text-muted-foreground"
      data-function-feedback
      role="status"
      aria-live="polite"
    >
      {entries.map((entry) => (
        <p
          key={entry.id}
          data-feedback-kind={entry.kind}
          data-feedback-plugin={entry.plugin}
          className="whitespace-pre-wrap break-words"
        >
          <span className="mr-2 opacity-60">{entry.plugin}</span>
          {entry.text}
        </p>
      ))}
    </div>
  )
}
