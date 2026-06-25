import type { AppAttentionPayload } from "../shared/app-attention"

type AppAttentionHandler = (payload: AppAttentionPayload) => void

let attentionHandler: AppAttentionHandler | null = null

export function setAppAttentionHandler(handler: AppAttentionHandler | null): void {
  attentionHandler = handler
}

export function emitAppAttention(payload: AppAttentionPayload): void {
  try {
    attentionHandler?.(payload)
  } catch (error) {
    console.warn("[Attention] Failed to handle attention event:", error)
  }
}
