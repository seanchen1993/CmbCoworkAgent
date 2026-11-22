import type { LegacySearchBootstrapGuard } from "../checkpointer/runtime-projection-protocol"
import type { ThreadSearchStartRequest, ThreadSearchPage, ThreadSearchRoute } from "../../shared/thread-search-types"

export interface ProjectSearchCatalog {
  generation: string
  projects: ReadonlyMap<string, { label: string; features?: ReadonlySet<string> }>
}

export type SearchCommand =
  | { type: "shutdown" }
  | {
      type: "start"
      id: string
      request: ThreadSearchStartRequest
      cancellation: SharedArrayBuffer
      catalog?: ProjectSearchCatalog
      catalogInvalidation?: SharedArrayBuffer
    }
  | { type: "continue"; id: string; cursor: string }
  | { type: "cancel"; id: string }

export type SearchReply =
  | ThreadSearchPage
  | { error: "SEARCH_CURSOR_INVALID" | "SEARCH_CURSOR_EXPIRED" | "SEARCH_UNAVAILABLE" }

export type SearchBackfillCandidate = LegacySearchBootstrapGuard & {
  threadId: string
  sourceKey: string
  route?: ThreadSearchRoute
  catalogGeneration?: string
  catalogInvalidation?: SharedArrayBuffer
}
