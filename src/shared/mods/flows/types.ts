import type { FlowFilePublicationApi } from "./file-publication"
import type { FlowFileRecoveryEvidence, FlowFileNamespace } from "./file-recovery"
import type { CompletionCheck } from "../v2/completion-policy-values"
import type { ClawSourceEntry, ClawSourceReference } from "../claw"
import type { ModObject } from "../types"
import type { ClawActionDescriptor, ClawActionIdentity } from "../claw-actions"
import type { FlowRecoveryPlan } from "./recovery"
import type { FlowPromptRecoveryEvidence } from "./prompt-recovery"

export interface FlowMcpToolIdentity {
  provider: ClawSourceReference
  toolName: string
  schemaDigest: string
}
export interface FlowMcpToolDescriptor extends FlowMcpToolIdentity {
  description?: string
  inputSchema?: ModObject
  unavailableReason?: string
}
export type FlowCondition = { stepId: string; outcome: "passed" | "failed" }
export interface FlowStepBase {
  id: string
  name: string
  enabled: boolean
  when?: FlowCondition
  /** Omitted means the next enabled step. Only forward success edges are accepted. */
  onSuccess?: string
  /** A business failure route. Exceptions and cancellation never use it. */
  onFailure?: { stepId: string; maxRetries: number }
}
export type FlowStep = FlowStepBase &
  (
    | { kind: "agent"; prompt: string; agentType?: string; modelId?: string; modelRole?: string }
    | {
        kind: "skill"
        skill: ClawSourceReference
        prompt: string
        agentType?: string
        modelId?: string
        modelRole?: string
      }
    | ({
        kind: "mcp-tool"
        input: ModObject
        inputFrom?: { stepId: string; path?: string }
      } & FlowMcpToolIdentity)
    | ({
        kind: "plugin-action"
        input: ModObject
        inputFrom?: { stepId: string; path?: string }
        config?: ModObject
        /** Host-produced summary of current prior outcomes, inserted as a string in this field. */
        evidenceInput?: { field: string }
      } & ClawActionIdentity)
    | { kind: "check"; check: CompletionCheck }
    | { kind: "approval"; prompt: string }
    | { kind: "autobiz-stage" }
  )
interface FlowDefinitionBase {
  id: string
  name: string
  goal: string
  feature?: string
  stageStart?: string
  timeoutMs: number
  maxExecutions: number
  steps: FlowStep[]
}
export interface LegacyFlowDefinition extends FlowDefinitionBase {
  schemaVersion: 1
  plugin: string
  execution?: never
}
export interface HostFlowDefinition extends FlowDefinitionBase {
  schemaVersion: 2
  execution: { kind: "host"; profile?: "prompt-only-v1" | "workspace-files-v1" }
  plugin?: never
}
export type FlowDefinition = LegacyFlowDefinition | HostFlowDefinition
export interface SavedFlow {
  definition: FlowDefinition
  revision: number
  digest: string
  updatedAt: number
}
export type FlowRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "complete"
  | "failed"
  | "cancelled"
  | "interrupted"
export interface FlowStepResult {
  passed: boolean
  summary: string
  source: "agent" | "native-check" | "approval" | "host" | "plugin-action" | "skill" | "mcp-tool"
  skill?: ClawSourceReference
  mcpTool?: FlowMcpToolIdentity
  output?: ModObject
  provider?: ClawActionIdentity
  modelId?: string
  evidenceIds?: string[]
  /** Written only by the host after a native check, never from Agent output. */
  check?: CompletionCheck
  outputTokens?: number
}
export interface FlowAttempt {
  /** Bounded public observation only; never completion or recovery evidence. */
  progress?: { phase: "model" | "tool"; text?: string; toolName?: string; updatedAt: number }
  /** Host trace correlation only; never recovery or execution authority. */
  telemetry?: { childThreadId: string; traceId: string; rootTraceId: string }
  executionId: string
  stepId: string
  attempt: number
  epoch: number
  status: "running" | "passed" | "failed" | "skipped" | "waiting" | "unknown"
  startedAt: number
  finishedAt?: number
  result?: FlowStepResult
  reason?: string
  inputFingerprint?: string
  outputFingerprint?: string
  invalidated?: boolean
  /** Host-produced prompt-only runtime proof, persisted with this attempt's settled result. */
  recoveryEvidence?: FlowPromptRecoveryEvidence
  fileRecoveryEvidence?: FlowFileRecoveryEvidence
}
export interface FlowApproval {
  nonce: string
  stepId: string
  executionId: string
  inputDigest: string
  fingerprint: string
  summary: string
  definitionDigest: string
}
export interface FlowRun {
  /** Host-owned durable virtual namespace; never a physical publication authorization. */
  fileNamespace?: FlowFileNamespace
  id: string
  threadId: string
  workspace: string
  flow: SavedFlow
  /** Per-run chat input; never edits the saved definition or its revision. */
  taskGoal?: string
  status: FlowRunStatus
  startedAt: number
  finishedAt?: number
  currentStepId?: string
  epoch: number
  attempts: FlowAttempt[]
  failureCounts: Record<string, number>
  pendingApproval?: FlowApproval
  summary?: string
  executionPlan?: FlowExecutionPlan
}
export interface FlowExecutionPlan {
  models: Record<string, { ref: string; fingerprint: string }>
  modelPolicy?: Record<string, string>
  defaultModelRef?: string | null
  skills?: Record<string, ClawSourceReference>
  mcpTools?: Record<string, FlowMcpToolIdentity & { connectionGeneration?: string }>
  /** Host-captured component projections; package identities remain full approval digests. */
  components?: Record<string, { ids: string[]; selectionDigest: string }>
  actions: ClawActionIdentity[]
}
export interface FlowCatalog {
  available: boolean
  /** Host execution is separate from installed Function Mod availability. */
  hostAvailable?: boolean
  workspace?: string
  reason?: string
  plugins: { id: string; name: string; authorized: boolean }[]
  agents: { id: string; name: string; description: string }[]
  models: { id: string; name: string }[]
  actions?: ClawActionDescriptor[]
  skills?: ClawSourceEntry[]
  features: { id: string; checkpoint: string }[]
}
export interface FlowActiveSummary {
  runId: string
  threadId: string
  flowName: string
  status: FlowRun["status"]
}
export interface FlowApi extends FlowFilePublicationApi {
  flowActive(threadId: string): Promise<FlowActiveSummary | null>
  flowMcpTools(threadId: string): Promise<FlowMcpToolDescriptor[]>
  flowCatalog(threadId: string): Promise<FlowCatalog>
  flowList(threadId: string): Promise<SavedFlow[]>
  flowSave(
    threadId: string,
    definition: FlowDefinition,
    expectedRevision: number,
    expectedWorkspace?: string
  ): Promise<SavedFlow>
  flowStart(
    threadId: string,
    flowId: string,
    revision: number,
    task?: FlowChatTask,
    expectedWorkspace?: string
  ): Promise<FlowRun>
  flowRuns(threadId: string): Promise<FlowRun[]>
  flowRun(threadId: string, runId: string): Promise<FlowRun | null>
  flowRecovery(threadId: string, runId: string): Promise<FlowRecoveryPlan>
  flowEvidence(
    threadId: string,
    runId: string
  ): Promise<import("./execution-evidence").FlowExecutionEvidenceView>
  flowResume(threadId: string, runId: string, expectedSourceDigest: string): Promise<FlowRun>
  flowDecide(threadId: string, runId: string, nonce: string, approve: boolean): Promise<FlowRun>
  flowCancel(threadId: string, runId: string): Promise<void>
  onFlowChanged(threadId: string, callback: () => void): () => void
}

export interface FlowChatTask {
  workspace: string
  goal: string
}
