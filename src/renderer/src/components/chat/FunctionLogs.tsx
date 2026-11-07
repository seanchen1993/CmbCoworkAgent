import { withModsChatScope } from "../../lib/mods-chat-scope"
import { modUiChangeAffects } from "../../../../shared/mods/types"
import { createLatestDisplayRead } from "../../lib/latest-display-read"
import { useEffect, useState } from "react"
import type { FunctionLogEntry } from "../../../../shared/mods/v2/ui-log"
import { functionUiTextProjection } from "../../../../shared/mods/v2/ui-text"

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
          {functionUiTextProjection(entry.text, 2000)}
        </p>
      ))}
    </div>
  )
}

/** A separate conversation display channel. It never modifies the message transcript. */
export const FunctionLogs = withModsChatScope(FunctionLogsSurface)

function FunctionLogsSurface({
  threadId,
  showEmpty = false
}: {
  threadId: string
  showEmpty?: boolean
}): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<{
    threadId: string
    entries: FunctionLogEntry[]
    failed?: boolean
  }>()
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const reader = createLatestDisplayRead({
      read: () => window.api.mods.logs(threadId),
      publish: (entries) => setSnapshot({ threadId, entries }),
      failed: () => setSnapshot({ threadId, entries: [], failed: true })
    })
    const refresh = reader.refresh
    const invalidate = () => {
      reader.invalidate()
      setSnapshot(undefined)
      refresh()
    }
    const stop = window.api.mods.onCardsChanged((event) => {
      if (event.threadId === threadId && modUiChangeAffects(event.scope, "records")) {
        if (event.scope === "records") refresh()
        else invalidate()
      }
    })
    const stopConfiguration = window.api.mods.onConfigurationChanged((event) => {
      if (event?.scope === "schema") refresh()
      else invalidate()
    })
    window.addEventListener("mods:configuration-changed", invalidate)
    refresh()
    return () => {
      reader.close()
      stop()
      stopConfiguration()
      window.removeEventListener("mods:configuration-changed", invalidate)
    }
  }, [threadId, retry])
  const current = snapshot?.threadId === threadId ? snapshot : undefined
  if (current?.failed)
    return (
      <div className="mt-2 space-y-2">
        <p role="alert">灵件日志暂时读取失败，不代表任务没有执行。</p>
        <button
          type="button"
          className="underline"
          onClick={() => {
            setSnapshot(undefined)
            setRetry((value) => value + 1)
          }}
        >
          重新读取日志
        </button>
      </div>
    )
  if (showEmpty && !current?.entries.length)
    return (
      <p className="mt-2 text-muted-foreground">
        {current ? "尚无灵件主动提供的日志；这不表示任务没有执行。" : "正在读取灵件日志…"}
      </p>
    )
  return <FunctionLogsContent entries={current?.entries ?? []} />
}
