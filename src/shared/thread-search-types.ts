import type { Thread, ThreadMessagesPage } from "../main/types"
import type { ThreadGoalHydrationEvent } from "../main/thread-metadata-hydration/protocol"
import type { ChatSearchLocation } from "./chat-search-types"
import type { ThreadIncarnationSnapshot } from "./thread-incarnation"

export const THREAD_SEARCH_QUERY_LIMIT = 256
export const THREAD_SEARCH_TARGET_ID_BYTE_LIMIT = 4096

export type ThreadSearchTarget =
  | {
      kind: "durableMessage"
      messageId: string
      ordinalHint: number
      structureEpoch: number
      location: ChatSearchLocation
    }
  | {
      kind: "goalEvent"
      eventId: string
      anchorMessageId: string | null
      ordinalHint: number | null
      structureEpoch: number
      location: ChatSearchLocation
    }

export type ThreadSearchScope =
  | { kind: "ordinary"; workspacePath?: string | null }
  | { kind: "project"; projectId: string }
  | { kind: "projects" }
  | { kind: "all" }

export type ThreadSearchRoute =
  | { kind: "ordinary" }
  | { kind: "projectSession"; projectId: string }
  | { kind: "featureSession"; projectId: string; slug: string }

export type ThreadSearchSummary = Thread & {
  searchRoute?: ThreadSearchRoute
  navigationTicketId?: string
}

export interface ThreadSearchStartRequest {
  scope?: ThreadSearchScope
  query: string
  workspacePath?: string | null
  limit?: number
}

export interface ThreadSearchContinueRequest {
  cursor: string
}

interface ThreadSearchResultSummary {
  threadId: string
  incarnation: ThreadIncarnationSnapshot
  title: string
  workspacePath: string | null
  remoteInbox?: boolean
  route: ThreadSearchRoute
  projectLabel?: string
  featureLabel?: string
  frozenUpdatedAt: number
  snippet: string
  snippetRanges: Array<{ start: number; end: number }>
}

export type ThreadSearchResult = ThreadSearchResultSummary &
  (
    | { matchedBy: "title"; target: null; navigation: "threadOnly" }
    | { matchedBy: "message"; target: ThreadSearchTarget; navigation: "exact" }
    | { matchedBy: "message"; target: ThreadSearchTarget | null; navigation: "threadOnly" }
  )

export type SearchCoverageReason =
  | "legacy-unverified"
  | "legacy-foreground-required"
  | "legacy-pending"
  | "oversized-row"
  | "projection-truncated"
  | "candidate-limit"
  | "scan-budget"
  | "unavailable-source"
  | "changed-during-search"
  | "project-catalog-unavailable"
  | "project-route-unavailable"
  | "project-catalog-changed"

export interface ThreadSearchPage {
  sessionId: string
  results: ThreadSearchResult[]
  nextCursor: string | null
  scanStatus: "running" | "complete" | "cancelled" | "expired" | "failed" | "limited"
  coverage: {
    basis: "durable-visible"
    completeness: "complete" | "partial" | "unknown"
    reasons: SearchCoverageReason[]
    pendingThreads: number
    failedThreads: number
    skippedRows: number
  }
  scannedThreads: number
}

export interface ThreadSearchOpenRequest {
  threadId: string
  incarnation: ThreadIncarnationSnapshot
  target?: ThreadSearchTarget | null
  residentMessageIds?: readonly string[]
  navigationTicketId?: string
}

export type ThreadSearchWindow =
  | {
      status: "resolved"
      page: ThreadMessagesPage
      structureEpoch: number
      goalEvent?: ThreadGoalHydrationEvent
    }
  | { status: "threadOnly" | "notFound" | "staleIdentity" | "changed" | "failed" }
