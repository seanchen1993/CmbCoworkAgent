import type {
  HarnessEnterpriseProjectDetailResult,
  HarnessProjectReviewResult
} from "../../shared/harness-board-types"

export const HARNESS_ENTERPRISE_DETAIL_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const HARNESS_ENTERPRISE_REVIEW_SUMMARY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const HARNESS_ENTERPRISE_REVIEW_TYPES_MAX_RESPONSE_BYTES = 1024 * 1024
export const HARNESS_ENTERPRISE_PROJECTION_MAX_OUTPUT_BYTES = 512 * 1024
export const HARNESS_ENTERPRISE_DETAIL_MAX_PROJECTS = 64
export const HARNESS_ENTERPRISE_REVIEW_PAGE_SIZE = 50
export const HARNESS_ENTERPRISE_REVIEW_MAX_ITEMS = 50
export const HARNESS_ENTERPRISE_REVIEW_MAX_TYPE_NODES = 512

export interface HarnessEnterpriseProjectionStats {
  durationMs: number
  inputBytes: number
  outputBytes: number
  itemCount: number
}

interface HarnessEnterpriseProjectionRequestBase {
  requestId: number
  maxOutputBytes: number
  cancelBuffer: SharedArrayBuffer
}

export interface HarnessEnterpriseDetailProjectionRequest
  extends HarnessEnterpriseProjectionRequestBase {
  type: "project-details"
  bytes: ArrayBuffer
  byteOffset: number
  byteLength: number
  maxProjects: number
}

export interface HarnessEnterpriseReviewProjectionRequest
  extends HarnessEnterpriseProjectionRequestBase {
  type: "project-reviews"
  summaryBytes: ArrayBuffer
  summaryByteOffset: number
  summaryByteLength: number
  typeBytes: ArrayBuffer
  typeByteOffset: number
  typeByteLength: number
  maxReviews: number
  maxTypeNodes: number
}

export interface HarnessEnterpriseProjectionShutdownRequest {
  type: "shutdown"
}

export type HarnessEnterpriseProjectionWorkerRequest =
  | HarnessEnterpriseDetailProjectionRequest
  | HarnessEnterpriseReviewProjectionRequest
  | HarnessEnterpriseProjectionShutdownRequest

export interface HarnessEnterpriseDetailProjectionSuccess {
  type: "project-details-result"
  requestId: number
  ok: true
  result: HarnessEnterpriseProjectDetailResult
  stats: HarnessEnterpriseProjectionStats
}

export interface HarnessEnterpriseReviewProjectionSuccess {
  type: "project-reviews-result"
  requestId: number
  ok: true
  result: HarnessProjectReviewResult
  stats: HarnessEnterpriseProjectionStats
}

interface HarnessEnterpriseProjectionFailureBody {
  code: string
  message: string
  preview?: string
  stack?: string
}

export interface HarnessEnterpriseDetailProjectionFailure {
  type: "project-details-result"
  requestId: number
  ok: false
  error: HarnessEnterpriseProjectionFailureBody
}

export interface HarnessEnterpriseReviewProjectionFailure {
  type: "project-reviews-result"
  requestId: number
  ok: false
  error: HarnessEnterpriseProjectionFailureBody
}

export interface HarnessEnterpriseProjectionShutdownComplete {
  type: "shutdown-complete"
}

export type HarnessEnterpriseProjectionWorkerResponse =
  | HarnessEnterpriseDetailProjectionSuccess
  | HarnessEnterpriseReviewProjectionSuccess
  | HarnessEnterpriseDetailProjectionFailure
  | HarnessEnterpriseReviewProjectionFailure
  | HarnessEnterpriseProjectionShutdownComplete
