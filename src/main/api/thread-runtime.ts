import type { ApprovalDecisionType, ApprovalRequest } from "../types"
import { createHash } from "crypto"

export const API_THREAD_STATE_DEFINITIONS = {
  not_started: "会话已经创建，但尚未执行过消息。",
  generating: "会话正在生成回复、调用工具或执行后台任务。",
  awaiting_approval: "会话正在等待审批，批准或拒绝后才能继续。",
  finished: "当前回合已经结束，没有正在运行的任务或待审批操作。"
} as const

export type ApiThreadState = keyof typeof API_THREAD_STATE_DEFINITIONS
export type ApiRemoteApprovalAction = "approve" | "reject"

export interface ApiThreadActivity {
  foreground: boolean
  workflow: boolean
  coordinator: boolean
  background_shell: boolean
  active: boolean
}

export interface ApiPendingApproval {
  approval_id: string
  tool_call_id: string
  tool_name: string
  operation: string
  reason?: string
  command?: string
  file_path?: string
  cwd: string
  runtime_thread_id: string
  allowed_actions: ApprovalDecisionType[]
  remote_allowed_actions: ApiRemoteApprovalAction[]
  remote_action_supported: boolean
  workflow_review?: ApiWorkflowApprovalReview
}

export interface ApiWorkflowApprovalReview {
  name: string
  description: string
  phases: string[]
  args: string
  args_bytes: number
  args_sha256: string
  token_budget: number | null
  script: string
  script_bytes: number
  script_sha256: string
}

export interface ApiThreadRuntime {
  state: ApiThreadState
  is_waiting_approval: boolean
  is_generating: boolean
  is_finished: boolean
  activity: ApiThreadActivity
  pending_approvals: ApiPendingApproval[]
  state_definitions: typeof API_THREAD_STATE_DEFINITIONS
}

export interface ApiApprovalRegistration {
  request: ApprovalRequest
  runtimeThreadId: string
}

const REMOTELY_APPROVABLE_OPERATIONS = new Set(["write_file", "edit_file", "execute", "workflow"])

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

/**
 * Return the complete material needed to make an informed workflow decision.
 * Missing or malformed review fields fail closed: callers may still reject the
 * request, but remoteAllowedApprovalActions will not expose approve.
 */
export function workflowApprovalReview(request: ApprovalRequest): ApiWorkflowApprovalReview | null {
  if (approvalOperation(request) !== "workflow") return null
  const raw = request.tool_call?.args
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const args = raw as Record<string, unknown>

  if (
    !hasOwn(args, "name") ||
    !hasOwn(args, "description") ||
    !hasOwn(args, "phases") ||
    !hasOwn(args, "argsReview") ||
    !hasOwn(args, "tokenBudget") ||
    !hasOwn(args, "scriptPreview")
  ) {
    return null
  }

  const name = args.name
  const description = args.description
  const phases = args.phases
  const argsReview = args.argsReview
  const tokenBudget = args.tokenBudget
  const script = args.scriptPreview
  if (
    typeof name !== "string" ||
    !name.trim() ||
    typeof description !== "string" ||
    !description.trim() ||
    !Array.isArray(phases) ||
    !phases.every((phase) => typeof phase === "string") ||
    typeof argsReview !== "string" ||
    !argsReview ||
    (tokenBudget !== null &&
      (typeof tokenBudget !== "number" || !Number.isFinite(tokenBudget) || tokenBudget < 0)) ||
    typeof script !== "string" ||
    !script.trim()
  ) {
    return null
  }

  return {
    name,
    description,
    phases: [...phases],
    args: argsReview,
    args_bytes: Buffer.byteLength(argsReview, "utf8"),
    args_sha256: createHash("sha256").update(argsReview, "utf8").digest("hex"),
    token_budget: tokenBudget,
    script,
    script_bytes: Buffer.byteLength(script, "utf8"),
    script_sha256: createHash("sha256").update(script, "utf8").digest("hex")
  }
}

function toolCallStringArg(request: ApprovalRequest, key: string): string | undefined {
  const args = request.tool_call?.args
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined
  const value = (args as Record<string, unknown>)[key]
  return typeof value === "string" && value.trim() ? value : undefined
}

export function approvalOperation(request: ApprovalRequest): string {
  if (request.operation) return request.operation
  if (request.command?.trim() || toolCallStringArg(request, "command")) return "execute"
  return request.tool_call?.name?.trim() || "unknown"
}

export function remoteAllowedApprovalActions(request: ApprovalRequest): ApiRemoteApprovalAction[] {
  const allowed = request.allowed_approval_types
  const operation = approvalOperation(request)
  const result: ApiRemoteApprovalAction[] = []
  const reviewableWorkflow = operation !== "workflow" || workflowApprovalReview(request) !== null
  if (
    REMOTELY_APPROVABLE_OPERATIONS.has(operation) &&
    reviewableWorkflow &&
    allowed.includes("approve")
  ) {
    result.push("approve")
  }
  // Rejection never expands privileges, so every approval type may be rejected
  // remotely when the underlying request permits it.
  if (allowed.includes("reject")) result.push("reject")
  return result
}

export function serializePendingApproval(
  registration: ApiApprovalRegistration
): ApiPendingApproval {
  const { request, runtimeThreadId } = registration
  const remoteActions = remoteAllowedApprovalActions(request)
  const command = request.command?.trim() || toolCallStringArg(request, "command")
  const filePath = request.filePath?.trim() || toolCallStringArg(request, "file_path")
  const workflowReview = workflowApprovalReview(request)
  return {
    approval_id: request.id,
    tool_call_id: request.tool_call?.id ?? request.id,
    tool_name: request.tool_call?.name ?? "unknown",
    operation: approvalOperation(request),
    ...(request.reason ? { reason: request.reason } : {}),
    ...(command ? { command } : {}),
    ...(filePath ? { file_path: filePath } : {}),
    cwd: request.cwd,
    runtime_thread_id: runtimeThreadId,
    allowed_actions: [...request.allowed_approval_types],
    remote_allowed_actions: remoteActions,
    remote_action_supported: remoteActions.length > 0,
    ...(workflowReview ? { workflow_review: workflowReview } : {})
  }
}

export function buildApiThreadRuntime(input: {
  activity: ApiThreadActivity
  messageCount: number
  pendingApprovals: ApiPendingApproval[]
}): ApiThreadRuntime {
  const isWaitingApproval = input.pendingApprovals.length > 0
  const state: ApiThreadState = isWaitingApproval
    ? "awaiting_approval"
    : input.activity.active
      ? "generating"
      : input.messageCount === 0
        ? "not_started"
        : "finished"
  return {
    state,
    is_waiting_approval: isWaitingApproval,
    is_generating: state === "generating",
    is_finished: state === "finished",
    activity: input.activity,
    pending_approvals: input.pendingApprovals,
    state_definitions: API_THREAD_STATE_DEFINITIONS
  }
}
