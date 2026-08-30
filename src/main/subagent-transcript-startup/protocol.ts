export const SUBAGENT_TRANSCRIPT_STARTUP_CANCELLED =
  "SUBAGENT_TRANSCRIPT_STARTUP_CANCELLED"

export interface SubagentTranscriptStartupRequest {
  type: "read"
  requestId: number
  databasePath: string
  threadId: string
  cancellationBuffer: SharedArrayBuffer
}

export interface SubagentTranscriptStartupStats {
  sourceRows: number
  sourceBytes: number
  responseBytes: number
}

export interface SubagentTranscriptStartupSuccessResponse {
  type: "result"
  requestId: number
  ok: true
  manifests: Record<string, unknown>
  stats: SubagentTranscriptStartupStats
}

export interface SubagentTranscriptStartupFailureResponse {
  type: "result"
  requestId: number
  ok: false
  error: {
    code: string
    message: string
    stack?: string
  }
}

export type SubagentTranscriptStartupWorkerResponse =
  | SubagentTranscriptStartupSuccessResponse
  | SubagentTranscriptStartupFailureResponse
