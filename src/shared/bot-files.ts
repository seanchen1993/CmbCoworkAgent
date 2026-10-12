import type { BotArtifact } from "./bot-types"

export const BOT_FILE_BYTES = 25 * 1024 * 1024
export const BOT_VIDEO_BYTES = 200 * 1024 * 1024
export const BOT_FILE_CHUNK_BYTES = 512 * 1024
export const BOT_ATTACHMENT_COUNT = 6

export function botFileByteLimit(name: string, mime: string): number {
  return /^video\//i.test(mime) && /\.(mp4|m4v|mov|webm|mkv|avi|ogv)$/i.test(name)
    ? BOT_VIDEO_BYTES
    : BOT_FILE_BYTES
}

export interface BotUploadRequest {
  nonce: string
  conversationId: string
  name: string
  mime: string
  size: number
  sha256: string
}
export interface BotUploadProgress {
  id: string
  offset: number
  artifact: BotArtifact | null
}
export interface BotFileChunk {
  artifact: BotArtifact
  offset: number
  base64: string
}
