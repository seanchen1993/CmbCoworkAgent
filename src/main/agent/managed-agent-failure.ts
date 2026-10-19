import { types } from "node:util"
import { HookProcessCleanupError } from "../hooks/owned-process-error"

const requiredCheckFailures = new Set([
  "REQUIRED_BUSINESS_CHECK_MISSING",
  "REQUIRED_BUSINESS_CHECK_CONFIG_INVALID",
  "REQUIRED_BUSINESS_CHECK_FAILED",
  "PROJECT_REQUIRED_HOOK_MISSING",
  "PROJECT_REQUIRED_HOOK_DECLARATION_INCOMPLETE",
  "PROJECT_CAPABILITY_REQUIRED_HOOK_MISSING"
])
const localAdmissionFailures = new Set([
  "DEVELOPMENT_MODEL_ACCOUNTING_SCOPE",
  "DEVELOPMENT_MODEL_COST_UNSUPPORTED",
  "DEVELOPMENT_MODEL_ATTEMPT_BUDGET",
  "DEVELOPMENT_MODEL_HISTORY_UNCONFIRMED",
  "DEVELOPMENT_BUDGET_UNCONFIRMED",
  "DEVELOPMENT_TURN_BUDGET",
  "BUSINESS_CREATOR_SOURCE_CHANGED",
  "BUSINESS_TRIAL_CLOSED",
  "BUSINESS_TRIAL_RECORD_INVALID",
  "BUSINESS_TRIAL_PROOF_CHANGED",
  "BUSINESS_TRIAL_SCOPE_CHANGED",
  "BUSINESS_TRIAL_WORKSPACE_CHANGED",
  "BUSINESS_TRIAL_RUNTIME_CHANGED",
  "BUSINESS_TRIAL_CANCEL_REQUESTED",
  "BUSINESS_TRIAL_STOP_UNCONFIRMED",
  "BUSINESS_TRIAL_VERSION_CHANGED",
  "BUSINESS_TRIAL_RECONCILIATION_REQUIRED",
  "BUSINESS_TRIAL_PHYSICAL_SCOPE_CHANGED",
  "BUSINESS_TRIAL_PHYSICAL_REQUEST_MISSING",
  "BUSINESS_TRIAL_OBSERVATION_LIMIT",
  "LEGACY_MODS_RUNTIME_CHANGED",
  "LEGACY_MODS_DIGEST_CHANGED",
  "LEGACY_MODS_GRANT_REQUIRED",
  "PROJECT_PLUGIN_SOURCE_TOKEN_INVALID",
  "PROJECT_CAPABILITY_SOURCE_DISABLED",
  "PROJECT_CAPABILITY_SOURCE_CHANGED",
  "PROJECT_CAPABILITY_SNAPSHOT_CHANGED",
  "PROJECT_CAPABILITY_PARENT_SOURCE_CHANGED",
  "PROJECT_CAPABILITY_CONTEXT_CHANGED",
  "PROJECT_MODS_APPROVAL_REQUIRED",
  "PROJECT_MODS_GLOBALLY_DISABLED",
  "PROJECT_HOST_PACKAGE_CHANGED",
  "PROJECT_HOST_PACKAGE_IDENTITY_MISMATCH",
  "PROJECT_HOST_PACKAGE_SNAPSHOT_SCOPE",
  "PROJECT_HOST_PLUGIN_UNAVAILABLE",
  "PROJECT_HOST_INPUT_CHANGED",
  "PROJECT_HOST_INPUT_IDENTITY_UNAVAILABLE",
  "PROJECT_HOST_OPERATION_SCOPE_CHANGED",
  "PROJECT_HOST_LEGACY_RUN_SCOPE_CHANGED",
  "PROJECT_HOST_LEGACY_MODS_BINDING_CHANGED",
  "PROJECT_HOST_LEGACY_CONTEXT_INPUT_CHANGED",
  "PROJECT_HOST_LEGACY_WORKSPACE_CHANGED",
  "PROJECT_HOST_LEGACY_THREAD_CHANGED",
  "LEGACY_CHILD_SCOPE_CHANGED",
  "LEGACY_CHILD_ADMISSION_REVOKED",
  "LEGACY_CHILD_ADMISSION_REQUIRED",
  "COMPOSITION_SOURCE_CHANGED",
  "COMPOSITION_CONTEXT_CHANGED",
  "COMPOSITION_CONTEXT_INPUT_CHANGED",
  "COMPOSITION_INPUTS_CHANGED",
  "MODS_PLUGIN_CHANGED",
  "MODS_GRANT_REVOKED",
  "MODS_CALL_SCOPE_CHANGED",
  "MODS_RUNTIME_SCOPE_CHANGED",
  "MODS_RUNTIME_INSTANCE_EXPIRED",
  "MODS_RUNTIME_CLOSED",
  "MODS_TOOL_PERMISSION_DENIED",
  "MODS_REQUIRED_CONTEXT_CHANGED",
  "MODS_CONFIG_SOURCE_CHANGED",
  "MODS_CONFIG_PLUGIN_MISSING",
  "MODS_CONFIG_SCOPE_CHANGED",
  "MODS_CONFIG_VALUE_CHANGED",
  "MODS_APPROVAL_STALE"
])

function ownValue(error: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(error, key)?.value
}

/** Classify native thrown failures only; Hook output and model text cannot select retry policy. */
export function classifyManagedAgentFailure(
  error: unknown
): "hook_halt" | "unknown" | "provider_error" {
  let current = error
  let localFailure = false
  const seen = new Set<object>()
  for (let depth = 0; depth < 8 && types.isNativeError(current) && !seen.has(current); depth++) {
    seen.add(current)
    if (current instanceof HookProcessCleanupError) return "unknown"
    const code = ownValue(current, "code")
    const message = ownValue(current, "message")
    const status = ownValue(current, "status") ?? ownValue(current, "statusCode")
    // SDK HTTP errors may copy the remote response body into message/code. That body is not
    // a local guard fact; a separately thrown native cause can still identify a local failure.
    const remoteHttpError = typeof status === "number" && Number.isInteger(status) &&
      status >= 400 && status <= 599
    const messageCode = typeof message === "string"
      ? /^([A-Z][A-Z0-9_]+)(?::(?:\s|$)|$)/.exec(message)?.[1] : undefined
    for (const candidate of remoteHttpError ? [] : [code, messageCode]) {
      if (typeof candidate !== "string") continue
      if (requiredCheckFailures.has(candidate)) return "hook_halt"
      if (localAdmissionFailures.has(candidate) ||
          /^MODS_(?:USER_CONFIG|SECRET)_[A-Z_]+$/.test(candidate)) localFailure = true
    }
    current = ownValue(current, "cause")
  }
  return localFailure ? "unknown" : "provider_error"
}
