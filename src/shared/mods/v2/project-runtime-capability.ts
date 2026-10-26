import type { ModObject } from "../types"
import type { PlatformCapabilityDescriptor } from "./platform-capabilities"

/** Optional runtime facade. Discovery and preflight never grant execution authority. */
export const PROJECT_RUNTIME_CAPABILITY_REF = {
  provider: "native.project-runtime",
  id: "project",
  version: "1.0.0"
} as const

export type ProjectRuntimeRequestKind = "continue" | "cancel" | "reconcile"
const text = { type: "string", maxLength: 256 }
const integer = { type: "integer", minimum: 0 }
const empty: ModObject = { type: "object", additionalProperties: false, properties: {} }
const summary: ModObject = {
  type: "object",
  additionalProperties: false,
  required: ["status", "reviewAvailable"],
  properties: {
    status: { enum: ["ready", "unavailable"] },
    reviewAvailable: { type: "boolean" },
    code: text,
    projectId: text,
    version: integer,
    projectStatus: text,
    stageId: text,
    stageNumber: integer,
    totalStages: integer,
    operationId: text,
    operationStatus: text,
    currentVersion: { type: "boolean" },
    executionApprovalRequired: { type: "boolean" },
    resultApprovalRequired: { type: "boolean" },
    recordedExecutionDecision: { enum: ["approved", "rejected", "none"] },
    recordedResultDecision: { enum: ["approved", "rejected", "none"] }
  }
}
const diagnostics: ModObject = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "checks", "historyLimited"],
  properties: {
    summary,
    historyLimited: { type: "boolean" },
    checks: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["checkId", "result", "checkedAt"],
        properties: {
          checkId: text,
          result: { enum: ["passed", "failed", "blocked", "unknown"] },
          checkedAt: integer
        }
      }
    }
  }
}
const plan: ModObject = {
  type: "object",
  additionalProperties: false,
  required: ["planId", "kind", "expectedVersion", "canReview", "executionGranted"],
  properties: {
    planId: { type: "string", minLength: 36, maxLength: 36 },
    kind: { enum: ["continue", "cancel", "reconcile"] },
    expectedVersion: integer,
    canReview: { type: "boolean" },
    executionGranted: { const: false }
  }
}
export const PROJECT_RUNTIME_CAPABILITY_DESCRIPTOR: PlatformCapabilityDescriptor = {
  apiVersion: "devclaw.capability/v1",
  id: PROJECT_RUNTIME_CAPABILITY_REF.id,
  version: PROJECT_RUNTIME_CAPABILITY_REF.version,
  scope: "conversation",
  title: "当前会话的原生项目诊断与操作复核",
  stateSchema: summary,
  actions: [
    {
      id: "inspect-workflow-evidence",
      title: "读取当前项目已结算阶段的原始工作流证据",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["runId", "stageId"],
        properties: {
          runId: { type: "string", minLength: 1, maxLength: 160 },
          stageId: { type: "string", minLength: 1, maxLength: 100 },
          agentOffset: { type: "integer", minimum: 0, maximum: 1000000 },
          worktreeOffset: { type: "integer", minimum: 0, maximum: 1000000 },
          actionOffset: { type: "integer", minimum: 0, maximum: 256 },
          limit: { type: "integer", minimum: 1, maximum: 32 }
        }
      },
      outputSchema: { type: "object", additionalProperties: true },
      requiredPermissions: ["platform.read"], cancellable: true, idempotency: "keyed"
    },
    {
      id: "inspect",
      title: "读取当前项目和检查记录",
      inputSchema: empty,
      outputSchema: diagnostics,
      requiredPermissions: ["platform.read"],
      cancellable: true,
      idempotency: "keyed"
    },
    {
      id: "preflight",
      title: "核对原生操作条件，不批准或执行",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: { kind: { enum: ["continue", "cancel", "reconcile"] } }
      },
      outputSchema: plan,
      requiredPermissions: ["platform.read"],
      cancellable: true,
      idempotency: "keyed"
    },
    {
      id: "request",
      title: "请求原生确认并调用原生操作",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["planId"],
        properties: { planId: { type: "string", minLength: 36, maxLength: 36 } }
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["status", "kind"],
        properties: {
          status: { enum: ["completed", "rejected", "unknown"] },
          kind: { enum: ["continue", "cancel", "reconcile"] },
          projectVersion: integer,
          operationStatus: text,
          stopReason: text
        }
      },
      requiredPermissions: ["platform.read"],
      cancellable: true,
      idempotency: "keyed"
    }
  ]
}
