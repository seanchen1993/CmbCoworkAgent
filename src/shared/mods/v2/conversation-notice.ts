import type { Message } from "../../../main/types"

/** Renderer-only notification about an already committed native row. Never an SDK capability. */
export interface FunctionConversationNoticeEvent {
  readonly threadId: string
  readonly incarnation: { readonly token: string | null; readonly legacyCreatedAt: number }
  readonly message: Message
}
