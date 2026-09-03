import type { Thread, ThreadGroupSelectionEntry, ThreadGroupSelector } from "../types"

export const THREAD_METADATA_HYDRATION_CANCELLED = "THREAD_METADATA_HYDRATION_CANCELLED"
export const THREAD_METADATA_HYDRATION_MAX_THREAD_RESPONSE_BYTES = 16 * 1024 * 1024

export interface ThreadMetadataHydrationStats {
  durationMs: number
  rowCount: number
  sourceBytes: number
}

export interface ThreadGoalHydrationEvent {
  event_id: number
  thread_id: string
  goal_id: string | null
  active_window_id: string | null
  message: string
  created_at: number
  transcript_ordinal?: number | null
  transcript_message_id?: string | null
}

export interface ThreadGitMetadataProjection {
  /** Small compatibility-shaped object consumed by the existing Git context helpers. */
  metadata: Record<string, unknown>
  trackedFilesTruncated: boolean
}

interface ThreadMetadataHydrationRequestBase {
  requestId: number
  databasePath: string
  cancellationBuffer: SharedArrayBuffer
}

export interface ThreadMetadataHydrationReadThreadRequest extends ThreadMetadataHydrationRequestBase {
  type: "read-thread"
  threadId: string
}

export interface ThreadMetadataHydrationReadListPageRequest extends ThreadMetadataHydrationRequestBase {
  type: "read-list-page"
  beforeUpdatedAt?: number
  beforeThreadId?: string
  limit: number
  byteBudget: number
}

export interface ThreadMetadataHydrationReadGroupIdsRequest extends ThreadMetadataHydrationRequestBase {
  type: "read-group-ids"
  selector: ThreadGroupSelector
}

export interface ThreadMetadataHydrationReadGoalEventsRequest extends ThreadMetadataHydrationRequestBase {
  type: "read-goal-events"
  threadId: string
  restore: boolean
  recentLimit: number
  scanLimit: number
  byteBudget: number
}

export interface ThreadMetadataHydrationReadWorkspacePathRequest extends ThreadMetadataHydrationRequestBase {
  type: "read-workspace-path"
  threadId: string
}

export interface ThreadMetadataHydrationReadGitContextRequest extends ThreadMetadataHydrationRequestBase {
  type: "read-git-context"
  threadId: string
}

export interface ThreadMetadataHydrationShutdownRequest {
  type: "shutdown"
}

export type ThreadMetadataHydrationWorkerRequest =
  | ThreadMetadataHydrationReadThreadRequest
  | ThreadMetadataHydrationReadListPageRequest
  | ThreadMetadataHydrationReadGroupIdsRequest
  | ThreadMetadataHydrationReadGoalEventsRequest
  | ThreadMetadataHydrationReadWorkspacePathRequest
  | ThreadMetadataHydrationReadGitContextRequest
  | ThreadMetadataHydrationShutdownRequest

export interface ThreadMetadataHydrationReadThreadSuccess {
  type: "read-thread-result"
  requestId: number
  ok: true
  thread: Thread | null
  stats: ThreadMetadataHydrationStats
}

export interface ThreadMetadataHydrationReadListPageSuccess {
  type: "read-list-page-result"
  requestId: number
  ok: true
  threads: Thread[]
  beforeUpdatedAt: number | null
  beforeThreadId: string | null
  hasMore: boolean
  stats: ThreadMetadataHydrationStats
}

export interface ThreadMetadataHydrationReadGroupIdsSuccess {
  type: "read-group-ids-result"
  requestId: number
  ok: true
  entries: ThreadGroupSelectionEntry[]
  stats: ThreadMetadataHydrationStats
}

export interface ThreadMetadataHydrationReadGoalEventsSuccess {
  type: "read-goal-events-result"
  requestId: number
  ok: true
  events: ThreadGoalHydrationEvent[]
  truncated: boolean
  stats: ThreadMetadataHydrationStats
}

export interface ThreadMetadataHydrationReadWorkspacePathSuccess {
  type: "read-workspace-path-result"
  requestId: number
  ok: true
  workspacePath: string | null
  stats: ThreadMetadataHydrationStats
}

export interface ThreadMetadataHydrationReadGitContextSuccess {
  type: "read-git-context-result"
  requestId: number
  ok: true
  projection: ThreadGitMetadataProjection
  stats: ThreadMetadataHydrationStats
}

export interface ThreadMetadataHydrationReadFailure {
  type:
    | "read-thread-result"
    | "read-list-page-result"
    | "read-group-ids-result"
    | "read-goal-events-result"
    | "read-workspace-path-result"
    | "read-git-context-result"
  requestId: number
  ok: false
  error: { code: string; message: string; stack?: string }
}

export interface ThreadMetadataHydrationShutdownComplete {
  type: "shutdown-complete"
}

export type ThreadMetadataHydrationWorkerResponse =
  | ThreadMetadataHydrationReadThreadSuccess
  | ThreadMetadataHydrationReadListPageSuccess
  | ThreadMetadataHydrationReadGroupIdsSuccess
  | ThreadMetadataHydrationReadGoalEventsSuccess
  | ThreadMetadataHydrationReadWorkspacePathSuccess
  | ThreadMetadataHydrationReadGitContextSuccess
  | ThreadMetadataHydrationReadFailure
  | ThreadMetadataHydrationShutdownComplete
