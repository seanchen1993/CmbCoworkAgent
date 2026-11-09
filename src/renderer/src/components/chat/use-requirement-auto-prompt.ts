import { useEffect, useRef } from "react"
import { REQUIREMENT_DEVELOPMENT_AUTO_SEND_KEY } from "@/lib/requirement-development"
type SubmitPrompt = (
  event: React.FormEvent,
  overrideInput?: string,
  onCommitted?: () => void | Promise<void>
) => Promise<void>

export function useRequirementAutoPrompt(input: {
  threadId: string
  prompt: string
  metadata: Record<string, unknown> | null
  ready: boolean
  submit: SubmitPrompt
  patchMetadata: (
    threadId: string,
    patch: { set: { requirementDevelopment: Record<string, unknown> } }
  ) => Promise<void>
}): void {
  const startedThreadRef = useRef<string | null>(null)
  const { metadata, patchMetadata, prompt, ready, submit, threadId } = input

  useEffect(() => {
    if (!prompt || !ready || startedThreadRef.current === threadId) return
    if (window.sessionStorage.getItem(REQUIREMENT_DEVELOPMENT_AUTO_SEND_KEY) !== threadId) return
    startedThreadRef.current = threadId
    const nextMetadata = { ...(metadata ?? {}) }
    delete nextMetadata.autoSendPrompt
    nextMetadata.autoSendPromptConsumed = true

    void (async () => {
      let committed = false
      try {
        await submit(
          { preventDefault: () => undefined } as React.FormEvent,
          prompt,
          async () => {
            // stream.submit 已接受本轮消息，此后即使暂停导致流 Promise 被拒绝，也不能再次自动发送。
            window.sessionStorage.removeItem(REQUIREMENT_DEVELOPMENT_AUTO_SEND_KEY)
            committed = true
            await patchMetadata(threadId, {
              set: { requirementDevelopment: nextMetadata }
            })
          }
        )
      } catch (error) {
        if (committed) {
          // Pausing or stopping the accepted turn rejects stream.submit. The prompt has already
          // been persisted as consumed, so this must not surface as an initialization failure.
          console.info("[RequirementDevelopment] Initial turn ended after commit:", error)
        } else {
          startedThreadRef.current = null
          console.error("[RequirementDevelopment] Initial prompt was not committed:", error)
        }
      } finally {
        if (!committed) startedThreadRef.current = null
      }
    })()
  }, [metadata, patchMetadata, prompt, ready, submit, threadId])
}
