import type { ModObject } from "../types"

/** Public data protocol only. Discovery and preparations confer no execution authority. */
export const PROJECT_STAGE_DEBUG_CAPABILITY_REF = {
  provider: "native.project-stage-debug",
  id: "stages",
  version: "1.0.0"
} as const

export interface StageDebugCandidateView {
  id: string
  name: string
  revision: number
  digest: string
}

export const STAGE_DEBUG_INSPECT_SCHEMA: ModObject = {
  type: "object", additionalProperties: false, required: ["kind"],
  properties: {
    kind: { enum: ["snapshots", "branches", "drafts"] },
    offset: { type: "integer", minimum: 0, maximum: 128 },
    limit: { type: "integer", minimum: 1, maximum: 8 }
  }
}
export const STAGE_DEBUG_PREPARE_SCHEMA: ModObject = {
  type: "object", additionalProperties: false,
  required: ["snapshotId", "draftId", "revision", "expectedDigest", "mode"],
  properties: {
    snapshotId: { type: "string", minLength: 64, maxLength: 64 },
    draftId: { type: "string", minLength: 1, maxLength: 48 },
    revision: { type: "integer", minimum: 1, maximum: 8 },
    expectedDigest: { type: "string", minLength: 64, maxLength: 64 },
    mode: { enum: ["stage", "downstream"] }
  }
}
export const STAGE_DEBUG_REVIEW_SCHEMA: ModObject = {
  type: "object", additionalProperties: false, required: ["planId"],
  properties: { planId: { type: "string", minLength: 36, maxLength: 36 } }
}
export const STAGE_DEBUG_SUMMARY_SCHEMA: ModObject = {
  type: "object", additionalProperties: false,
  required: ["status", "snapshotCount", "branchCount", "draftCount", "reviewAvailable"],
  properties: {
    status: { enum: ["ready", "unavailable"] },
    snapshotCount: { type: "integer", minimum: 0, maximum: 64 },
    branchCount: { type: "integer", minimum: 0, maximum: 64 },
    draftCount: { type: "integer", minimum: 0, maximum: 4 },
    reviewAvailable: { type: "boolean" },
    code: { type: "string", maxLength: 128 }
  }
}
export const STAGE_DEBUG_PAGE_SCHEMA: ModObject = {
  type: "object", additionalProperties: false,
  required: ["kind", "offset", "total", "items"],
  properties: {
    kind: { enum: ["snapshots", "branches", "drafts"] },
    offset: { type: "integer", minimum: 0, maximum: 128 },
    total: { type: "integer", minimum: 0, maximum: 128 },
    nextOffset: { type: "integer", minimum: 0, maximum: 128 },
    items: { type: "array", maxItems: 8, items: { oneOf: [
      { type: "object", additionalProperties: false,
        required: ["id", "name", "revision", "digest"], properties: {
          id: { type: "string", minLength: 1, maxLength: 48 },
          name: { type: "string", maxLength: 100 },
          revision: { type: "integer", minimum: 1, maximum: 8 },
          digest: { type: "string", minLength: 64, maxLength: 64 }
        } },
      { type: "object", additionalProperties: false,
        required: ["id", "projectId", "stageId", "stageTitle", "sourceDigest", "createdAt", "fileCount", "totalBytes"], properties: {
          id: { type: "string", minLength: 64, maxLength: 64 },
          projectId: { type: "string", minLength: 1, maxLength: 256 },
          stageId: { type: "string", minLength: 1, maxLength: 128 },
          stageTitle: { type: "string", maxLength: 100 },
          sourceDigest: { type: "string", minLength: 64, maxLength: 64 },
          createdAt: { type: "integer", minimum: 0 },
          fileCount: { type: "integer", minimum: 0, maximum: 2048 },
          totalBytes: { type: "integer", minimum: 0, maximum: 67108864 }
        } },
      { type: "object", additionalProperties: false,
        required: ["id", "projectId", "sourceProjectId", "snapshotId", "stageId", "mode", "status", "candidateDigest", "currentCandidateMatches", "diagnostics"], properties: {
          id: { type: "string", minLength: 1, maxLength: 256 },
          projectId: { type: "string", minLength: 1, maxLength: 256 },
          sourceProjectId: { type: "string", minLength: 1, maxLength: 256 },
          snapshotId: { type: "string", minLength: 64, maxLength: 64 },
          stageId: { type: "string", minLength: 1, maxLength: 128 },
          mode: { enum: ["stage", "downstream"] },
          status: { enum: ["ready", "running", "passed", "failed", "unknown"] },
          candidateDigest: { type: "string", minLength: 64, maxLength: 64 },
          currentCandidateMatches: { type: "boolean" },
          diagnostics: { type: "array", maxItems: 8, items: { type: "string", maxLength: 256 } }
        } }
    ] } }
  }
}
export const STAGE_DEBUG_PLAN_SCHEMA: ModObject = {
  type: "object", additionalProperties: false,
  required: ["planId", "snapshotId", "stageId", "mode", "candidateDigest", "affectedStageIds", "diagnostics", "canReview", "executionGranted"],
  properties: {
    planId: { type: "string", minLength: 36, maxLength: 36 },
    snapshotId: { type: "string", minLength: 64, maxLength: 64 },
    stageId: { type: "string", maxLength: 128 },
    mode: { enum: ["stage", "downstream"] },
    candidateDigest: { type: "string", minLength: 64, maxLength: 64 },
    affectedStageIds: { type: "array", maxItems: 64, items: { type: "string", maxLength: 128 } },
    diagnostics: { type: "array", maxItems: 8, items: { type: "string", maxLength: 256 } },
    canReview: { type: "boolean" },
    executionGranted: { const: false }
  }
}
export const STAGE_DEBUG_REVIEW_RESULT_SCHEMA: ModObject = {
  type: "object", additionalProperties: false,
  required: ["requested", "queued", "executionGranted"],
  properties: { requested: { type: "boolean" }, queued: { type: "boolean" }, executionGranted: { const: false } }
}
