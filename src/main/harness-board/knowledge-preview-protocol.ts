import type { HarnessKnowledgePreviewResult } from "../../shared/harness-board-types"

export const HARNESS_KNOWLEDGE_PREVIEW_MAX_RESPONSE_BYTES = 512 * 1024
export const HARNESS_KNOWLEDGE_PREVIEW_MAX_FILES = 2_000
export const HARNESS_KNOWLEDGE_PREVIEW_MAX_DIRECTORIES = 1_000
export const HARNESS_KNOWLEDGE_PREVIEW_MAX_DEPTH = 64
export const HARNESS_KNOWLEDGE_PREVIEW_MAX_DIRECTORY_ENTRIES = 2_000
export const HARNESS_KNOWLEDGE_PREVIEW_MAX_DIRENTS = 10_000

export interface HarnessKnowledgePreviewSource {
  openworkDir: string
  pluginStorePath: string
  leanTokenStorePath: string
}

export interface HarnessKnowledgePreviewReadRequest {
  type: "read"
  requestId: number
  adapterId: string
  source: HarnessKnowledgePreviewSource
  maxResponseBytes: number
  cancelBuffer: SharedArrayBuffer
}

export interface HarnessKnowledgePreviewReadSuccess {
  type: "read-result"
  requestId: number
  ok: true
  result: HarnessKnowledgePreviewResult
}

export interface HarnessKnowledgePreviewReadFailure {
  type: "read-result"
  requestId: number
  ok: false
  error: { message: string; stack?: string }
}

export type HarnessKnowledgePreviewWorkerRequest = HarnessKnowledgePreviewReadRequest
export type HarnessKnowledgePreviewWorkerResponse =
  | HarnessKnowledgePreviewReadSuccess
  | HarnessKnowledgePreviewReadFailure
