import { useCallback, useEffect, useRef, useState } from "react"
import {
  beginOpenResourcePreviewIntent,
  isCurrentOpenResourcePreviewIntent,
  onOpenResourcePreview,
  type OpenResourcePreviewDetail
} from "@/lib/resource-preview-events"

export function useResourcePreviewRequest(
  threadId: string | null,
  enabled = true,
  onRequest?: (request: OpenResourcePreviewDetail) => void
): {
  request: OpenResourcePreviewDetail | null
  clear: () => void
} {
  const [request, setRequest] = useState<OpenResourcePreviewDetail | null>(null)
  const latestAcceptedIntentIdRef = useRef(0)
  const previousThreadIdRef = useRef<string | null>(null)

  useEffect(() => {
    const previousThreadId = previousThreadIdRef.current
    if (previousThreadId && previousThreadId !== threadId) {
      beginOpenResourcePreviewIntent(previousThreadId)
    }
    previousThreadIdRef.current = threadId
  }, [threadId])

  useEffect(() => {
    if (!enabled || !threadId) return
    return onOpenResourcePreview((detail) => {
      if (
        detail.threadId !== threadId ||
        !isCurrentOpenResourcePreviewIntent(
          threadId,
          detail.intentId,
          latestAcceptedIntentIdRef.current
        )
      ) {
        return
      }
      latestAcceptedIntentIdRef.current = detail.intentId
      onRequest?.(detail)
      setRequest(detail)
    })
  }, [enabled, onRequest, threadId])

  const clear = useCallback(() => setRequest(null), [])
  return {
    request: enabled && request?.threadId === threadId ? request : null,
    clear
  }
}
