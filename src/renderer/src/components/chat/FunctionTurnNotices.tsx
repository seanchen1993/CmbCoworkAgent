import { useEffect, useState } from "react"
import type { FunctionTurnNotice } from "../../../../shared/mods/v2/turn"

export function FunctionTurnNotices({ threadId }: { threadId: string }): React.JSX.Element | null {
  const [notices, setNotices] = useState<FunctionTurnNotice[]>([])
  useEffect(() => {
    let live = true
    let sequence = 0
    const refresh = () => {
      const request = ++sequence
      void window.api.mods.turnNotices(threadId).then(
        (values) => {
          if (live && sequence === request) setNotices(values)
        },
        () => {
          if (live && sequence === request) setNotices([])
        }
      )
    }
    setNotices([])
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
  if (!notices.length) return null
  return (
    <div className="mx-auto my-2 max-w-3xl space-y-2" data-function-turn-notices>
      {notices.map((notice) => (
        <p
          key={notice.id}
          data-turn-id={notice.turnId}
          className="whitespace-pre-wrap break-words text-sm text-muted-foreground"
        >
          {notice.text}
        </p>
      ))}
    </div>
  )
}
