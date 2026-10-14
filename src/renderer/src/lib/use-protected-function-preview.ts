import { useCallback, useEffect, useRef, useState } from "react"
import { functionMarkdownLinkAddressKey } from "../../../shared/mods/v2/markdown-links"
import {
  onProtectedFunctionPreview,
  onProtectedFunctionPreviewOwnerClosed,
  type ProtectedFunctionPreviewRequest
} from "./protected-function-preview"

export function useProtectedFunctionPreview(threadId: string | null, enabled = true,
  onRequest?: () => void) {
  const [request, setRequest] = useState<ProtectedFunctionPreviewRequest | null>(null)
  const latest = useRef(0)
  const current = useRef(request)
  current.current = request
  const onRequestRef = useRef(onRequest)
  onRequestRef.current = onRequest
  const clear = useCallback(() => { current.current = null; setRequest(null) }, [])
  useEffect(() => {
    current.current = null
    setRequest(null)
    if (!enabled || !threadId) return
    const stopOpen = onProtectedFunctionPreview((next) => {
      if (next.threadId !== threadId || next.intentId <= latest.current) return
      latest.current = next.intentId
      current.current = next
      setRequest(next)
      onRequestRef.current?.()
    })
    const stopOwner = onProtectedFunctionPreviewOwnerClosed((closedThread, owner) => {
      const value = current.current
      if (closedThread === threadId && value &&
        functionMarkdownLinkAddressKey(value.address) === owner) clear()
    })
    return () => { stopOpen(); stopOwner() }
  }, [threadId, enabled, clear])
  return { request: enabled && request?.threadId === threadId ? request : null, clear }
}
