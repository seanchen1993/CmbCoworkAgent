import type { ThreadMessagesPage, ThreadMessagesPageOptions } from "../types"

export const THREAD_MESSAGE_HYDRATION_CANCELLED = "THREAD_MESSAGE_HYDRATION_CANCELLED"

export interface ThreadMessageHydrationWorkerStats {
  durationMs: number
  scannedCandidates: number
  selectedMessages: number
  estimatedBytes: number
}

export interface ThreadMessageHydrationReadRequest {
  type: "read-page"
  requestId: number
  databasePath: string
  threadId: string
  options: Pick<
    ThreadMessagesPageOptions,
    | "beforeOrdinal"
    | "beforeMessageId"
    | "targetMessageId"
    | "anchorMessageId"
    | "limit"
    | "byteBudget"
    | "includeVisibleMessagePresence"
    | "notAfterCreatedAt"
    | "recoveryCheckpointId"
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
  /** Native Worker evidence, stripped by the client before returning a page. */
  canonicalWitnesses?: readonly CanonicalThreadDisplayWitness[]
}

export interface CanonicalThreadDisplayWitness {
  readonly messageId: string
  readonly columnsDigest: string
  readonly presentation?: Readonly<{
    kind: "visible" | "blank" | "plumbing"
    fingerprint: string
  }>
  readonly display?: Readonly<{
    kind: "page" | "checkpoint"
    digest: string
    byteBudget?: number
    rawIndex?: number
  }>
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
