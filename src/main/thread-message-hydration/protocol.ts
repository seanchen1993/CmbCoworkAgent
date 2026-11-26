import type { ThreadMessagesPage, ThreadMessagesPageOptions } from "../types"

export const THREAD_MESSAGE_HYDRATION_CANCELLED = "THREAD_MESSAGE_HYDRATION_CANCELLED"

export interface ThreadMessageHydrationWorkerStats {
  durationMs: number
  scannedCandidates: number
  selectedMessages: number
  estimatedBytes: number
}

export interface ThreadMessageHydrationPageOptions extends ThreadMessagesPageOptions {
  /** Only inspect user rows strictly above this ordinal when paging backward. */
  userOrdinalFloor?: number
  /** Project the visible text suffix needed by a side conversation. */
  sideContextTextByteBudget?: number
}

export interface ThreadMessageHydrationReadRequest {
  type: "read-page"
  requestId: number
  databasePath: string
  checkpointDirectory?: string
  threadId: string
  options: Pick<
    ThreadMessageHydrationPageOptions,
    | "beforeOrdinal"
    | "beforeMessageId"
    | "targetMessageId"
    | "residentMessageIds"
    | "anchorMessageId"
    | "limit"
    | "byteBudget"
    | "includeVisibleMessagePresence"
    | "notAfterCreatedAt"
    | "recoveryCheckpointId"
    | "recoveryTranscriptRevision"
    | "userOrdinalFloor"
    | "sideContextTextByteBudget"
  >
  cancellationBuffer: SharedArrayBuffer
}

export interface ThreadMessageHydrationShutdownRequest {
  type: "shutdown"
}

export type ThreadMessageHydrationWorkerRequest =
  | ThreadMessageHydrationReadRequest
  | ThreadMessageHydrationShutdownRequest

export interface ThreadMessageHydrationReadSuccess {
  type: "read-page-result"
  requestId: number
  ok: true
  page: ThreadMessagesPage
  stats: ThreadMessageHydrationWorkerStats
}

export interface ThreadMessageHydrationReadFailure {
  type: "read-page-result"
  requestId: number
  ok: false
  error: {
    code: string
    message: string
    stack?: string
  }
}

export interface ThreadMessageHydrationShutdownComplete {
  type: "shutdown-complete"
}

export type ThreadMessageHydrationWorkerResponse =
  | ThreadMessageHydrationReadSuccess
  | ThreadMessageHydrationReadFailure
  | ThreadMessageHydrationShutdownComplete
