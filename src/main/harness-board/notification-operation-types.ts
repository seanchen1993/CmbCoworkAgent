import type { AgentRunDelivery } from "../agent/agent-run-service"
import type { ManagedRunEvent, ManagedRunPolicyResult } from "../../shared/harness-board-types"
import type { ManagedBizRetryChoice } from "../../shared/harness-notifications"

export interface ManagedBizRetryDecisionInput {
  decisionId: string
  projectId: string
  featureId: string
  runId: string
  originThreadId: string
  policyResult: Extract<ManagedRunPolicyResult, { type: "biz_retry" }>
  route?: { principalId: string; conversationKey: string }
  channel: "desktop" | "im"
  sourceEvent: Pick<ManagedRunEvent, "eventId" | "type">
  summary: string
  delivery: AgentRunDelivery
  choice: ManagedBizRetryChoice
  message?: string
}

export interface ManagedHumanGateDecisionInput {
  gateId: string
  projectId: string
  featureId: string
  runId: string
  threadId: string
  decision: "approve" | "reject"
  channel: "desktop" | "im" | "system"
  reasonCode?: string
}

export interface ManagedHumanGateConflictInput {
  gateId: string
  projectId: string
  featureId: string
  runId: string
  threadId: string
}
