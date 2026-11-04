/** Negotiated Bot-only attachment transport; no binary data in model messages. */
export const BOT_IM_FILE_EXTENSION = "bot-files-v1"
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
    }
  | { action: "chunk"; uploadId: string; offset: number; data: string }
  | { action: "finish" | "abort"; uploadId: string }
export interface BotImFileResult {
  state: "uploading" | "accepted" | "aborted" | "unknown" | "failed"
  uploadId?: string
  offset?: number
  reasonCode?: string
}
