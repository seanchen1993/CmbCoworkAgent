import type { BotArtifact } from "./bot-types"

export interface BotFilePreviewRequest {
  id: string
  conversationId: string
  requestId: string
  offset: number
  /** Table previews use row offsets and an optional sheet/column window. */
  sheet?: number
  columnOffset?: number
}
export interface BotFilePreviewPage {
  offset: number
  totalCharacters: number
  text: string
  nextOffset: number | null
  hasMore: boolean
}
export type BotFilePreview = { artifact: BotArtifact } & (
  | { kind: "text" | "markdown" | "html" | "document"; page: BotFilePreviewPage }
  | {
      kind: "image"
      image: {
        base64: string
        width: number
        height: number
        originalWidth: number
        originalHeight: number
      }
    }
  | { kind: "video" | "audio" | "pdf"; mime: string }
  | { kind: "table"; table: import("./bot-table-preview").BotTablePage }
  | {
      kind: "presentation"
      presentation: { page: number; pageCount: number; base64: string; width: 960; height: 540 }
    }
  | { kind: "unsupported" }
)
