import type {
  HarnessFeatureSummary,
  HarnessProjectMetadata,
  HarnessRunDetailViewModel,
  HarnessWatchRef,
  HarnessWorkflow
} from "../../shared/harness-board-types"

export const HARNESS_ADAPTER_DETAIL_MAX_INPUT_BYTES = 10 * 1024 * 1024
export const HARNESS_ADAPTER_DETAIL_MAX_IPC_BYTES = 2 * 1024 * 1024
export const HARNESS_ADAPTER_DETAIL_SYNC_FALLBACK_BYTES = 256 * 1024
export const HARNESS_ADAPTER_DETAIL_MAX_PROJECTS_PER_BATCH = 8
export const HARNESS_ADAPTER_RUN_MAX_HOOK_LOG_BYTES = 2 * 1024 * 1024
export const HARNESS_ADAPTER_RUN_MAX_HOOK_ENTRIES = 512

export interface HarnessAdapterDetailProjectInput {
  project: HarnessProjectMetadata
  projectDir: string
  fallbackWatchRefs: HarnessWatchRef[]
}

export interface HarnessAdapterDetailProjectResult {
  runs: HarnessFeatureSummary[]
  watchRefs: HarnessWatchRef[]
}

export interface HarnessAdapterDetailBatchResult {
  workflow: HarnessWorkflow
  projects: Record<string, HarnessAdapterDetailProjectResult | null>
}

export interface HarnessAdapterDetailWorkerStats {
  durationMs: number
  inputBytes: number
  outputBytes: number
  projectCount: number
}

export interface HarnessAdapterDetailParseRequest {
  type: "parse"
  requestId: number
  bytes: ArrayBuffer
  byteOffset: number
  byteLength: number
  projects: HarnessAdapterDetailProjectInput[]
  maxOutputBytes: number
  cancelBuffer: SharedArrayBuffer
}

export interface HarnessAdapterRunProjection {
  workflow: HarnessWorkflow
  run: Omit<
    HarnessRunDetailViewModel["run"],
    "skipNodeAvailable" | "selectedDeployUnits" | "source"
  >
}

export interface HarnessAdapterRunWorkerStats extends HarnessAdapterDetailWorkerStats {
  hookLogBytesRead: number
  hookLogEntries: number
  hookLogsTruncated: boolean
  cancelled: boolean
}

export interface HarnessAdapterRunParseRequest {
  type: "parse-run"
  requestId: number
  bytes: ArrayBuffer
  byteOffset: number
  byteLength: number
  project: HarnessProjectMetadata
  fallbackSlug: string
  maxOutputBytes: number
  maxHookLogBytes: number
  maxHookEntries: number
  cancelBuffer: SharedArrayBuffer
}

export interface HarnessAdapterDetailShutdownRequest {
  type: "shutdown"
}

export type HarnessAdapterDetailWorkerRequest =
  | HarnessAdapterDetailParseRequest
  | HarnessAdapterRunParseRequest
  | HarnessAdapterDetailShutdownRequest

export interface HarnessAdapterDetailParseSuccess {
  type: "parse-result"
  requestId: number
  ok: true
  result: HarnessAdapterDetailBatchResult
  stats: HarnessAdapterDetailWorkerStats
}

export interface HarnessAdapterDetailParseFailure {
  type: "parse-result"
  requestId: number
  ok: false
  error: {
    code: string
    message: string
    preview?: string
    stack?: string
  }
}

export interface HarnessAdapterRunParseSuccess {
  type: "parse-run-result"
  requestId: number
  ok: true
  result: HarnessAdapterRunProjection
  stats: HarnessAdapterRunWorkerStats
}

export interface HarnessAdapterRunParseFailure {
  type: "parse-run-result"
  requestId: number
  ok: false
  error: {
    code: string
    message: string
    preview?: string
    stack?: string
  }
}

export interface HarnessAdapterDetailShutdownComplete {
  type: "shutdown-complete"
}

export type HarnessAdapterDetailWorkerResponse =
  | HarnessAdapterDetailParseSuccess
  | HarnessAdapterDetailParseFailure
  | HarnessAdapterRunParseSuccess
  | HarnessAdapterRunParseFailure
  | HarnessAdapterDetailShutdownComplete
