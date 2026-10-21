import type {
  HostProjectOperation,
  HostProjectState,
  HostValidationReceipt,
  HostContextProviderRequest,
  HostContextProviderApproval
} from "../../../shared/project-runtime/host-types"
import { parseProjectRuntimeManifest } from "../../../shared/project-runtime"

export function hostStateError(code: string): never {
  throw new Error(`PROJECT_HOST_${code}`)
}

export function hostRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return hostStateError("SCHEMA_INVALID")
  return value as Record<string, unknown>
}

export function hostText(value: unknown, max = 256): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    // eslint-disable-next-line no-control-regex -- Persistent identities cannot hide controls.
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  )
    return hostStateError("SCHEMA_INVALID")
  return value
}

export function hostInteger(value: unknown, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min)
    return hostStateError("SCHEMA_INVALID")
  return value as number
}

export function hostDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    return hostStateError("SCHEMA_INVALID")
  return value
}

export function hostGoal(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 8000 ||
    // eslint-disable-next-line no-control-regex -- Goals allow ordinary whitespace only.
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
  )
    hostStateError("GOAL_INVALID")
  return value
}

export function parseHostProjectState(value: unknown): HostProjectState {
  const raw = hostRecord(value, [
    "schemaVersion",
    "stateOwner",
    "version",
    "stageIndex",
    "status",
    "createdAt",
    "updatedAt",
    "projectId",
    "name",
    "goal",
    "workspace",
    "installedPluginId",
    "packageId",
    "packageVersion",
    "pluginDigest",
    "manifest"
  ])
  if (
    raw.schemaVersion !== 1 ||
    raw.stateOwner !== "host" ||
    (raw.status !== "active" && raw.status !== "completed")
  )
    return hostStateError("SCHEMA_INVALID")
  const manifest = parseProjectRuntimeManifest(raw.manifest)
  const installedPluginId = hostText(raw.installedPluginId)
  const packageId = hostText(raw.packageId)
  const packageVersion = hostText(raw.packageVersion)
  if (
    manifest.mode !== "host" ||
    manifest.stateOwner !== "host" ||
    manifest.plugin.id !== packageId ||
    manifest.plugin.version !== packageVersion
  )
    return hostStateError("OWNER_MISMATCH")
  const stageIndex = hostInteger(raw.stageIndex)
  if (
    stageIndex > manifest.stages.length ||
    (raw.status === "completed") !== (stageIndex === manifest.stages.length)
  )
    return hostStateError("SCHEMA_INVALID")
  for (const stage of manifest.stages) {
    if (
      !stage.checkIds.length ||
      stage.artifactIds.some(
        (artifactId) =>
          manifest.artifacts.find((artifact) => artifact.id === artifactId)?.required &&
          !stage.checkIds.some(
            (checkId) =>
              manifest.checks.find((check) => check.id === checkId)?.artifactId === artifactId
          )
      )
    )
      return hostStateError("VALIDATION_REQUIRED")
  }
  return {
    schemaVersion: 1,
    stateOwner: "host",
    version: hostInteger(raw.version, 1),
    stageIndex,
    status: raw.status,
    createdAt: hostInteger(raw.createdAt),
    updatedAt: hostInteger(raw.updatedAt),
    projectId: hostText(raw.projectId),
    name: hostText(raw.name),
    goal: hostGoal(raw.goal),
    workspace: hostText(raw.workspace, 4096),
    installedPluginId,
    packageId,
    packageVersion,
    pluginDigest: hostDigest(raw.pluginDigest),
    manifest
  }
}

export function parseHostReceipt(value: unknown): HostValidationReceipt {
  const raw = hostRecord(value, [
    "schemaVersion",
    "operationId",
    "projectId",
    "stageId",
    "pluginDigest",
    "inputFingerprint",
    "checkId",
    "artifactFingerprint",
    "result",
    "validatorVersion",
    "checkedAt"
  ])
  if (
    raw.schemaVersion !== 1 ||
    !["passed", "failed", "blocked", "unknown"].includes(String(raw.result))
  )
    return hostStateError("SCHEMA_INVALID")
  return {
    schemaVersion: 1,
    operationId: hostText(raw.operationId),
    projectId: hostText(raw.projectId),
    stageId: hostText(raw.stageId),
    pluginDigest: hostDigest(raw.pluginDigest),
    inputFingerprint: hostDigest(raw.inputFingerprint),
    checkId: hostText(raw.checkId),
    artifactFingerprint: hostDigest(raw.artifactFingerprint),
    result: raw.result as HostValidationReceipt["result"],
    validatorVersion: hostText(raw.validatorVersion),
    checkedAt: hostInteger(raw.checkedAt)
  }
}

export function parseHostOperation(value: unknown): HostProjectOperation {
  const raw = hostRecord(value, [
    "schemaVersion",
    "operationId",
    "pluginDigest",
    "status",
    "createdAt",
    "updatedAt",
    "approval",
    "cancelRequestedAt",
    "startedAt",
    "execution",
    "receipts",
    "projectId",
    "expectedVersion",
    "stageId",
    "idempotencyKey",
    "inputFingerprint",
    ...(value && typeof value === "object" && Object.hasOwn(value, "contextProvider")
      ? ["contextProvider"]
      : [])
  ])
  if (
    raw.schemaVersion !== 1 ||
    ![
      "prepared",
      "started",
      "cancel_requested",
      "succeeded",
      "failed",
      "cancelled",
      "unknown",
      "transitioned"
    ].includes(String(raw.status)) ||
    !Array.isArray(raw.receipts) ||
    raw.receipts.length > 64
  )
    return hostStateError("SCHEMA_INVALID")
  const operation: HostProjectOperation = {
    schemaVersion: 1,
    operationId: hostText(raw.operationId),
    pluginDigest: hostDigest(raw.pluginDigest),
    status: raw.status as HostProjectOperation["status"],
    createdAt: hostInteger(raw.createdAt),
    updatedAt: hostInteger(raw.updatedAt),
    approval: null,
    execution: null,
    startedAt: raw.startedAt === null ? null : hostInteger(raw.startedAt),
    cancelRequestedAt: raw.cancelRequestedAt === null ? null : hostInteger(raw.cancelRequestedAt),
    receipts: raw.receipts.map(parseHostReceipt),
    projectId: hostText(raw.projectId),
    expectedVersion: hostInteger(raw.expectedVersion, 1),
    stageId: hostText(raw.stageId),
    idempotencyKey: hostText(raw.idempotencyKey),
    inputFingerprint: hostDigest(raw.inputFingerprint)
  }
  if (Object.hasOwn(raw, "contextProvider"))
    operation.contextProvider = parseHostContextProvider(raw.contextProvider)
  if (raw.execution !== null) {
    const execution = hostRecord(raw.execution, ["threadId", "terminal"])
    operation.execution = { threadId: hostText(execution.threadId), terminal: null }
    if (execution.terminal !== null) {
      const terminal = hostRecord(execution.terminal, ["outcome", "code", "settledAt"])
      if (!["success", "error", "unknown", "cancelled"].includes(String(terminal.outcome)))
        hostStateError("SCHEMA_INVALID")
      operation.execution.terminal = {
        outcome: terminal.outcome as "success" | "error" | "unknown" | "cancelled",
        code: hostText(terminal.code),
        settledAt: hostInteger(terminal.settledAt)
      }
    }
  }
  if (raw.approval !== null) {
    const approval = hostRecord(raw.approval, [
      "decision",
      "actorId",
      "decidedAt",
      "operationId",
      "expectedVersion",
      "inputFingerprint",
      ...(raw.approval &&
      typeof raw.approval === "object" &&
      Object.hasOwn(raw.approval, "contextProviderApproval")
        ? ["contextProviderApproval"]
        : [])
    ])
    if (
      (approval.decision !== "approved" && approval.decision !== "rejected") ||
      approval.operationId !== operation.operationId ||
      approval.expectedVersion !== operation.expectedVersion ||
      approval.inputFingerprint !== operation.inputFingerprint
    )
      return hostStateError("APPROVAL_MISMATCH")
    operation.approval = {
      decision: approval.decision,
      actorId: hostText(approval.actorId),
      decidedAt: hostInteger(approval.decidedAt),
      operationId: operation.operationId,
      expectedVersion: operation.expectedVersion,
      inputFingerprint: operation.inputFingerprint
    }
    if (Object.hasOwn(approval, "contextProviderApproval"))
      operation.approval.contextProviderApproval = parseHostContextProviderApproval(
        approval.contextProviderApproval,
        operation.contextProvider?.policyDigest
      )
    if (
      operation.contextProvider &&
      approval.decision === "approved" &&
      !operation.approval.contextProviderApproval
    )
      hostStateError("CONTEXT_PROVIDER_APPROVAL_REQUIRED")
  }
  if (
    new Set(operation.receipts.map((receipt) => receipt.checkId)).size !==
      operation.receipts.length ||
    operation.receipts.some(
      (receipt) =>
        receipt.operationId !== operation.operationId ||
        receipt.projectId !== operation.projectId ||
        receipt.stageId !== operation.stageId ||
        receipt.inputFingerprint !== operation.inputFingerprint ||
        receipt.pluginDigest !== operation.pluginDigest ||
        receipt.checkedAt < operation.createdAt
    )
  )
    return hostStateError("RECEIPT_MISMATCH")
  return operation
}

export function parseHostContextProvider(value: unknown): HostContextProviderRequest {
  const raw = hostRecord(value, ["protocol", "policyDigest", "notice"])
  if (raw.protocol !== "devclaw.context-text/v1") hostStateError("SCHEMA_INVALID")
  return {
    protocol: raw.protocol,
    policyDigest: hostDigest(raw.policyDigest),
    notice: hostText(raw.notice, 2048)
  }
}
export function parseHostContextProviderApproval(
  value: unknown,
  expectedDigest: string | undefined
): HostContextProviderApproval {
  const raw = hostRecord(value, ["policyDigest", "allowNetworkSideEffects"])
  if (
    !expectedDigest ||
    raw.policyDigest !== expectedDigest ||
    raw.allowNetworkSideEffects !== true
  )
    hostStateError("CONTEXT_PROVIDER_APPROVAL_REQUIRED")
  return { policyDigest: hostDigest(raw.policyDigest), allowNetworkSideEffects: true }
}
