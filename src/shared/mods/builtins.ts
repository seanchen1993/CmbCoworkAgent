import type { BuiltinInstructionsReadResult } from "./builtin-instructions"

export type DevClawBuiltinId =
  | "devclaw-project-instructions"
  | "devclaw-change-review"
  | "devclaw-policy"
  | "devclaw-observability"
  | "devclaw-extension-authoring"
  | "devclaw-project-advisor"

export interface DevClawBuiltinStatus {
  id: DevClawBuiltinId
  name: string
  state: "available" | "partial" | "unavailable"
  description: string
}

export interface BuiltinRunOverview {
  threadId: string
  workspace: string
  capturedAt: number
  project?: BuiltinProjectFacts
  legacyMetrics?: import("./builtin-policy-metrics").BuiltinLegacyMetrics
  instructions: BuiltinInstructionsReadResult
  policy: {
    required: boolean
    blockedTools: string[]
    recordedBlocks: number
    explanation: string
    decisions?: import("./builtin-policy-metrics").BuiltinPolicyDecisionView
  }
  metrics: {
    scope: "retained-plugin-calls"
    sampled: number
    succeeded: number
    failed: number
    running: number
    unknown: number
    durationMs: number | null
    inputTokens: number | null
    outputTokens: number | null
    cost: null
    limited: boolean
    explanation: string
  }
  suggestions: Array<{ id: string; title: string; detail: string }>
}

export type BuiltinProjectFacts =
  | { state: "unavailable" }
  | {
      state: "observed"
      stageNumber: number
      totalStages: number
      currentStageNumber: number
      projectStatus: "active" | "completed"
      operationStatus: import("../project-runtime/host-types").HostOperationStatus
      approval: "pending" | "approved" | "rejected" | "not-required"
      checks: { passed: number; failed: number; blocked: number; unknown: number }
      declaredArtifacts: number
      receiptsMatchCurrentVersion: boolean
      recordedAttempts: number
      historyMayBeLimited: boolean
    }
