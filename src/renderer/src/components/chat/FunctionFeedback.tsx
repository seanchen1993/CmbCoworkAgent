import { withModsChatScope } from "../../lib/mods-chat-scope"
import { modUiChangeAffects } from "../../../../shared/mods/types"
import { createLatestDisplayRead } from "../../lib/latest-display-read"
import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { X } from "lucide-react"
import {
  readFunctionPresentation,
  subscribeFunctionPresentation,
  dismissFunctionToast
} from "../../lib/function-presentation"
import type { FunctionFeedbackEntry } from "../../../../shared/mods/v2/ui-feedback"
import { functionUiTextProjection } from "../../../../shared/mods/v2/ui-text"

/** A session-local prompt rail; never inserts messages or acknowledges a tool/approval. */
export const FunctionFeedback = withModsChatScope(FunctionFeedbackSurface)

function FunctionFeedbackSurface({
  threadId,
  requestId
}: {
  threadId: string
  requestId?: string
}): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<{ threadId: string; entries: FunctionFeedbackEntry[] }>()
  const presentation = useSyncExternalStore(
    useCallback((listener) => subscribeFunctionPresentation(threadId, listener), [threadId]),
    useCallback(() => readFunctionPresentation(threadId), [threadId])
  )
  const nativeApi = typeof window.api.mods.desktopFeedback === "function"
  const nativePresentation = !requestId && nativeApi && Boolean(presentation.owner)
  useEffect(() => {
    if (nativePresentation) return
    const reader = createLatestDisplayRead({
      read: () => window.api.mods.feedback(threadId),
      publish: (entries) => setSnapshot({ threadId, entries }),
      failed: () => setSnapshot({ threadId, entries: [] })
    })
    const refresh = reader.refresh
    const invalidate = () => {
      reader.invalidate()
      setSnapshot(undefined)
      refresh()
    }
    const unsubscribe = window.api.mods.onCardsChanged((event) => {
      if (event.threadId === threadId && modUiChangeAffects(event.scope, "feedback")) {
        if (event.scope === "feedback") refresh()
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
      unsubscribe()
      stopConfiguration()
      window.removeEventListener("mods:configuration-changed", invalidate)
    }
  }, [threadId, nativePresentation])
  const entries = (
    nativePresentation
      ? presentation.entries
      : snapshot?.threadId === threadId
        ? snapshot.entries
        : []
  )
    .filter((entry) =>
      requestId ? entry.kind === "notice" && entry.requestId === requestId : entry.kind !== "notice"
    )
    .filter(
      (entry) =>
        (!presentation.held && (!nativeApi || nativePresentation)) || entry.kind !== "toast"
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
      {entries.map((entry) =>
        entry.kind === "toast" && nativePresentation ? (
          <button
            key={entry.id}
            type="button"
            aria-label="关闭提示"
            data-feedback-kind="toast"
            data-feedback-plugin={entry.plugin}
            data-feedback-id={entry.id}
            className="flex w-full items-start gap-2 rounded px-1 py-0.5 text-left whitespace-pre-wrap break-words hover:bg-muted hover:text-foreground"
            onClick={() => dismissFunctionToast(threadId, entry.id)}
          >
            <span className="shrink-0 opacity-60">{entry.plugin}</span>
            <span className="min-w-0 flex-1">{functionUiTextProjection(entry.text, 2000)}</span>
            <X className="size-3.5 shrink-0" />
          </button>
        ) : (
          <p
            key={entry.id}
            data-feedback-kind={entry.kind}
            data-feedback-plugin={entry.plugin}
            data-feedback-id={entry.kind === "toast" ? entry.id : undefined}
            className={
              requestId ? "truncate" : "flex items-start gap-2 whitespace-pre-wrap break-words"
            }
            title={requestId ? entry.text : undefined}
          >
            <span className="shrink-0 opacity-60">{entry.plugin}</span>
            <span className="min-w-0 flex-1">
              {entry.kind === "notice" ? entry.text : functionUiTextProjection(entry.text, 2000)}
            </span>
          </p>
        )
      )}
    </div>
  )
}
