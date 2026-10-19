import { mkdirSync, mkdtempSync, cpSync, writeFileSync, rmSync, renameSync } from "node:fs"
import { ModControlStore } from "../mods/control-store"
import { compileFunctionPlugin } from "../mods/v2/loader"
import { createLegacyModsRuntime } from "../harness-board/project-runtime/legacy-mods-runtime"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { expect, it } from "vitest"
import type { ManagedFeatureStatusSnapshot, ManagedRunSnapshot } from "../../shared/harness-board-types"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { resolveManagedRunDecision } from "../harness-board/managed-run-policy"
import { partitionRequiredBusinessHooks, requiredBusinessCheckFailure } from "../hooks/required-business-checks"
import type { HookConfig } from "../hooks/types"
import { ModPermissionError } from "../mods/errors"
import type { PluginHookMetadata } from "../types"
import {
  currentRuntimePluginSource,
  issueRuntimePluginSourceToken,
  withRuntimePluginSource,
  type RuntimePluginSourceBinding,
  type RuntimePluginSourceToken
} from "../plugins/runtime-source-scope"
import { classifyManagedAgentFailure } from "./managed-agent-failure"

it("does not retry native creator budgets as provider errors, including SDK-wrapped limits", () => {
  for (const code of ["DEVELOPMENT_MODEL_ATTEMPT_BUDGET", "DEVELOPMENT_MODEL_COST_UNSUPPORTED",
    "DEVELOPMENT_BUDGET_UNCONFIRMED", "DEVELOPMENT_MODEL_ACCOUNTING_SCOPE", "DEVELOPMENT_TURN_BUDGET"]) {
    expect(classifyManagedAgentFailure(new Error("Connection error", { cause: Error(code) }))).toBe("unknown")
    expect(classifyManagedAgentFailure(Object.assign(Error(code), { status: 502 }))).toBe("provider_error")
  }
})

const feature: ManagedFeatureStatusSnapshot = {
  featureStatus: "in_progress",
  currentNodeId: "review",
  currentNodeStatus: "in_progress",
  isFinalNode: false,
  nextAction: { slashSkill: "review", userMessage: "Continue" },
  featureStateHash: `v1:sha256:${"a".repeat(64)}`,
  nextActionHash: `v1:sha256:${"b".repeat(64)}`
}
const run: ManagedRunSnapshot = {
  version: 2.5,
  runId: "run",
  projectId: "project",
  featureId: "feature",
  status: "running",
  providerRetryCount: 0,
  startedAt: "2026-10-17 12:00:00",
  updatedAt: "2026-10-17 12:00:00",
  currentSession: { threadId: "thread" },
  decisionBaseline: {
    nodeId: "review", featureStatus: "in_progress", nodeStatus: "in_progress",
    featureStateHash: feature.featureStateHash, nextActionHash: feature.nextActionHash
  }
}
const policy = (error: unknown) => resolveManagedRunDecision({
  run,
  feature,
  terminal: { outcome: "error", endReason: { code: classifyManagedAgentFailure(error) } }
}).policyResult

function missingRequiredCheck(invalid = false): unknown {
  const root = join(tmpdir(), "managed-required-check-fixture")
  const binding: RuntimePluginSourceBinding = {
    mode: "legacy", threadId: "thread", incarnationKey: "incarnation", projectId: "project",
    operationId: "operation", workspace: root, packageDigest: "a".repeat(64), stageId: "review",
    plugin: {
      id: "plugin", name: "plugin", path: root, enabled: true, version: "1.0.0",
      description: "Required business check fixture", author: "test", skillCount: 0,
      mcpServerCount: 0, createdAt: "2026-10-17 12:00:00", updatedAt: "2026-10-17 12:00:00"
    }, requiredHooks: ["gate"]
  }
  const hook: PluginHookMetadata = {
    id: "plugin:plugin/gate", pluginId: "plugin", hookSourceType: "plugin",
    hookSourceRoot: root, event: "Stop", type: "command", command: "check", enabled: true,
    async: true, createdAt: "2026-10-17 12:00:00", updatedAt: "2026-10-17 12:00:00",
    pluginName: "plugin", pluginRoot: root, pluginEnabled: true, hookPath: "hooks/hooks.json"
  }
  try {
    withRuntimePluginSource(issueRuntimePluginSourceToken(binding), () => {
      partitionRequiredBusinessHooks(invalid ? [hook] : [])
    })
  } catch (error) { return error }
  throw Error("Fixture did not exercise the actual required-check refusal")
}

it.each([false, true])("ends the original managed run for actual required-check refusal (invalid=%s)", invalid => {
  const error = missingRequiredCheck(invalid)
  expect(classifyManagedAgentFailure(error)).toBe("hook_halt")
  expect(policy(error)).toMatchObject({ type: "run_termination", proposedAction: "fail_managed_run" })
  const wrapped = new Error("Agent preparation failed", { cause: error })
  expect(classifyManagedAgentFailure(wrapped)).toBe("hook_halt")
  expect(policy(wrapped)).toMatchObject({ type: "run_termination", proposedAction: "fail_managed_run" })
})

it("recognizes a required-check failed exception without treating its ordinary HookResult as authority", () => {
  const result = requiredBusinessCheckFailure({ id: "gate" } as HookConfig, "artifact mismatch")
  expect(classifyManagedAgentFailure(result)).toBe("provider_error")
  const error = new Error(result.reason)
  expect(classifyManagedAgentFailure(error)).toBe("hook_halt")
  expect(policy(error)).toMatchObject({ type: "run_termination", proposedAction: "fail_managed_run" })
})

it.each([
  new ModFunctionError("MODS_USER_CONFIG_INVALID", "请补齐参数"),
  new ModFunctionError("MODS_SECRET_SCHEMA_CHANGED"),
  new ModFunctionError("MODS_CONFIG_SOURCE_CHANGED", "源码已变更"),
  new ModFunctionError("MODS_CONFIG_PLUGIN_MISSING"),
  new ModPermissionError(),
  new Error("BUSINESS_CREATOR_SOURCE_CHANGED"),
  new Error("BUSINESS_TRIAL_CLOSED"),
  new Error("BUSINESS_TRIAL_RECORD_INVALID"),
  new Error("BUSINESS_TRIAL_PROOF_CHANGED"),
  new Error("BUSINESS_TRIAL_SCOPE_CHANGED"),
  new Error("BUSINESS_TRIAL_WORKSPACE_CHANGED"),
  new Error("BUSINESS_TRIAL_RUNTIME_CHANGED"),
  new Error("BUSINESS_TRIAL_CANCEL_REQUESTED"),
  new Error("BUSINESS_TRIAL_STOP_UNCONFIRMED"),
  new Error("BUSINESS_TRIAL_VERSION_CHANGED"),
  new Error("BUSINESS_TRIAL_RECONCILIATION_REQUIRED"),
  new Error("BUSINESS_TRIAL_PHYSICAL_SCOPE_CHANGED"),
  new Error("BUSINESS_TRIAL_PHYSICAL_REQUEST_MISSING"),
  new Error("BUSINESS_TRIAL_OBSERVATION_LIMIT"),
  new Error("MODS_GRANT_REVOKED"),
  new Error("PROJECT_HOST_PACKAGE_CHANGED"),
  new Error("PROJECT_HOST_INPUT_CHANGED"),
  new Error("PROJECT_HOST_LEGACY_RUN_SCOPE_CHANGED"),
  new Error("PROJECT_CAPABILITY_SOURCE_DISABLED")
])("does not schedule provider retry for a concrete local admission error: %s", error => {
  expect(classifyManagedAgentFailure(error)).toBe("unknown")
  expect(policy(error)).toMatchObject({ type: "run_termination", proposedAction: "fail_managed_run" })
})

it("retains the native invalid-source-token classification through a provider wrapper cause", () => {
  let error: unknown
  try {
    withRuntimePluginSource({ kind: "host-plugin-source" } as RuntimePluginSourceToken, () => {})
  } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(Error)
  const wrapped = Object.assign(new Error("Model stream failed", { cause: error }), { status: 503 })
  expect(classifyManagedAgentFailure(wrapped)).toBe("unknown")
  expect(policy(wrapped)).toMatchObject({ type: "run_termination", proposedAction: "fail_managed_run" })
})

it.each([
  new Error("429 Too Many Requests"),
  new Error("503 Service Unavailable"),
  Object.assign(new Error("REQUIRED_BUSINESS_CHECK_MISSING: remote body"), { status: 429 }),
  Object.assign(new Error("MODS_GRANT_REVOKED: remote body"), { statusCode: 503 }),
  Object.assign(new Error("remote body"), { status: 503, code: "MODS_CONFIG_SOURCE_CHANGED" }),
  new Error("fetch failed", { cause: Object.assign(new Error("connection reset"), { code: "ECONNRESET" }) }),
  new Error("Unknown provider failure"),
  new Error("BUSINESS_TRIAL_RUNTIME_CHANGED_SUFFIX"),
  Object.assign(new Error("BUSINESS_TRIAL_RUNTIME_CHANGED"), { status: 503 }),
  Object.assign(new Error("remote body"), { code: "BUSINESS_TRIAL_SCOPE_CHANGED", statusCode: 429 }),
  { message: "BUSINESS_TRIAL_RUNTIME_CHANGED" },
  new Error("Provider returned text: REQUIRED_BUSINESS_CHECK_MISSING: gate"),
  new Error("REQUIRED_BUSINESS_CHECK_MISSING_SUFFIX: gate"),
  "REQUIRED_BUSINESS_CHECK_MISSING: model text",
  { code: "MODS_GRANT_REVOKED", message: "REQUIRED_BUSINESS_CHECK_MISSING: gate", fatal: true },
  new Error("Provider failure", { cause: { code: "MODS_GRANT_REVOKED" } })
])("preserves original provider retry for provider failures and untrusted declarations: %j", error => {
  expect(classifyManagedAgentFailure(error)).toBe("provider_error")
  expect(policy(error)).toMatchObject({ type: "provider_retry", proposedAction: "schedule_provider_retry" })
})

it("bounds native cause traversal without invoking arbitrary getters", () => {
  const error = new Error("provider failure")
  Object.defineProperty(error, "cause", { value: error })
  Object.defineProperty(error, "code", { get() { throw Error("Getter must not run") } })
  expect(classifyManagedAgentFailure(error)).toBe("provider_error")
})


it.each(["LEGACY_MODS_RUNTIME_CHANGED", "LEGACY_MODS_DIGEST_CHANGED", "LEGACY_MODS_GRANT_REQUIRED", "REMOVED_ROOT"] as const)
  ("stops provider retry for the actual native Legacy admission failure %s", async kind => {
    const expected = kind === "REMOVED_ROOT" ? "LEGACY_MODS_RUNTIME_CHANGED" : kind
    const root = mkdtempSync(join(tmpdir(), "managed-legacy-mods-failure-"))
    const installed = join(root, "installed"), pinned = join(root, "pinned")
    const controls = new ModControlStore(join(root, "mods.sqlite"))
    try {
      mkdirSync(join(installed, "hooks"), { recursive: true })
      writeFileSync(join(installed, "plugin.json"), '{"name":"fixed-mod","version":"1.0.0"}')
      writeFileSync(join(installed, "hooks/hooks.json"), '{"modules":["register.ts"]}')
      writeFileSync(join(installed, "hooks/register.ts"), "export function register(){}")
      cpSync(installed, pinned, { recursive: true })
      const plugin = { id: "installed", name: "fixed-mod", version: "1.0.0", path: installed,
        enabled: true, author: "", description: "", createdAt: "", updatedAt: "",
        skillCount: 0, hookCount: 0, mcpServerCount: 0 }
      const compiled = await compileFunctionPlugin(installed)
      if (expected !== "LEGACY_MODS_GRANT_REQUIRED")
        controls.grant(root, "function:fixed-mod", compiled.digest, true)
      if (expected === "LEGACY_MODS_DIGEST_CHANGED")
        writeFileSync(join(pinned, "hooks/register.ts"), "export function register(){ return 1 }")
      const runtime = createLegacyModsRuntime({ store: controls, workspaceKey: value => value,
        isEnabled: () => true, plugins: () => [plugin] })
      let error: unknown
      try {
        const admitted = await runtime.capture(plugin, pinned, root)
        const token = issueRuntimePluginSourceToken({ mode: "legacy", threadId: "thread",
          incarnationKey: "real-incarnation", projectId: "project", operationId: "operation",
          workspace: root, packageDigest: "a".repeat(64), stageId: "review", plugin },
        admitted.assertCurrent, admitted.assertAuthorityCurrent)
        withRuntimePluginSource(token, () => {
          if (kind === "REMOVED_ROOT") renameSync(installed, installed + "-retired")
          else plugin.enabled = false
          currentRuntimePluginSource()
        })
      } catch (caught) { error = caught }
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe(expected)
      if (kind === "REMOVED_ROOT") expect(error).toHaveProperty("cause.code", "ENOENT")
      expect(classifyManagedAgentFailure(error)).toBe("unknown")
      expect(policy(error)).toMatchObject({ type: "run_termination", proposedAction: "fail_managed_run" })
      // Same strings in an SDK HTTP response remain provider failures, not native facts.
      expect(classifyManagedAgentFailure(Object.assign(new Error(expected), { status: 503 })))
        .toBe("provider_error")
    } finally { controls.close(); rmSync(root, { recursive: true, force: true }) }
  })
