import { useCallback, useEffect, useState } from "react"
import {
  onOpenResourcePreview,
  type OpenResourcePreviewDetail
} from "@/lib/resource-preview-events"

export function useResourcePreviewRequest(
  threadId: string | null,
  enabled = true
): {
  request: OpenResourcePreviewDetail | null
  clear: () => void
} {
  const [request, setRequest] = useState<OpenResourcePreviewDetail | null>(null)

  useEffect(() => {
    setRequest(null)
    if (!enabled || !threadId) return
    return onOpenResourcePreview((detail) => {
      if (detail.threadId === threadId) setRequest(detail)
    })
  }, [enabled, threadId])

  const clear = useCallback(() => setRequest(null), [])
  return { request, clear }
}
