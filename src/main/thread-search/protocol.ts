import type { LegacySearchBootstrapGuard } from "../checkpointer/runtime-projection-protocol"
import type { ThreadSearchStartRequest, ThreadSearchPage } from "../../shared/thread-search-types"

export type SearchCommand =
  | { type: "shutdown" }
  | {
      type: "start"
      id: string
      request: ThreadSearchStartRequest
      cancellation: SharedArrayBuffer
    }
  | { type: "continue"; id: string; cursor: string }
  | { type: "cancel"; id: string }

export type SearchReply =
  | ThreadSearchPage
  | { error: "SEARCH_CURSOR_INVALID" | "SEARCH_CURSOR_EXPIRED" | "SEARCH_UNAVAILABLE" }

export type SearchBackfillCandidate = LegacySearchBootstrapGuard & {
  threadId: string
  sourceKey: string
}
