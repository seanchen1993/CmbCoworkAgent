/** Negotiated Bot-only attachment transport; no binary data in model messages. */
export const BOT_IM_FILE_EXTENSION = "bot-files-v1"
export const BOT_IM_FILE_RECEIPTS_EXTENSION = "bot-files-v2"
export const BOT_IM_FILE_WINDOW = 4
export const BOT_IM_FILE_MAX_BYTES = 50 * 1024 * 1024
export const BOT_IM_FILE_CHUNK_BYTES = 32 * 1024
export type BotImFileCommand =
  | {
      action: "begin"
      deliveryId: string
      conversationKey: string
      name: string
      size: number
      sha256: string
      retryVersion?: number
    }
  | { action: "status"; deliveries: { deliveryId: string; conversationKey: string }[] }
  | { action: "chunk"; uploadId: string; offset: number; data: string }
  | { action: "finish" | "abort"; uploadId: string }
export interface BotImFileResult {
  state: "uploading" | "accepted" | "aborted" | "unknown" | "failed" | "sent" | "receipts"
  receipts?: {
    deliveryId: string
    state: "accepted" | "sent" | "failed" | "unknown" | "missing"
    reasonCode?: string
    version?: number
  }[]
  uploadId?: string
  offset?: number
  version?: number
  reasonCode?: string
}
