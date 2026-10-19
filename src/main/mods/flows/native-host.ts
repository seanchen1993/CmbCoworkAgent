import { assertEvaluationSnapshotRun } from "../evaluation/snapshot-lease"
import type { FlowFileReview, FlowFilePublicationOutcome, FlowFilePublicationRequest } from "../../../shared/mods/flows/file-publication"
import type { FlowFileDependencies, FlowFileRuntimeSettledCapture, FlowFileNamespace } from "../../../shared/mods/flows/file-recovery"
import type { VirtualTreeStore } from "./virtual-tree"
import { projectFileOnlyPrior } from "../../../shared/mods/flows/file-only-prior"
import { verifyCurrentFlowFileReceipt } from "./file-recovery-current"
import type { FlowAttempt } from "../../../shared/mods/flows/types"
import type {
  FlowPromptDependencies,
  FlowPromptRuntimeSettledCapture
} from "../../../shared/mods/flows/prompt-recovery"
import { projectPromptOnlyPrior } from "../../../shared/mods/flows/prompt-only-prior"
import {
  describeFlowPromptRuntime,
  flowPromptDigest,
  flowPromptResultSchema,
  type FlowPromptRuntimeFacts
} from "../../agent/flow-prompt-runtime-contract"
import { verifyCurrentFlowPromptReceipt } from "./prompt-recovery-current"
import {
  flowPromptTaskGoalDigest,
  flowPromptStructuredOutputDigest
} from "./prompt-recovery-receipt"
import type { RecoveryHistoryRun } from "./recovery-history"
import { app } from "electron"
import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { LocalSandbox } from "../../agent/local-sandbox"
import { ensureCodexExe } from "../../agent/codex-sandbox-binary"
import {
  captureLocalThreadRunLease,
  claimLocalThreadRunLease,
  getLocalThreadRunLease,
  releaseLocalThreadRunLease
} from "../../agent/thread-run-lease"
import { createThread, deleteThread, getThreadCore } from "../../db"
import {
  loadAgentProfilesAsync,
  resolveProfileFromList,
  type AgentProfile
} from "../../agent/agent-registry"
import { runWorkflowSubagent, type WorkflowSubagentDeps } from "../../agent/workflow/subagent"
import { publicFlowProgress } from "./progress"
import { getModelConfigByRef, getDefaultModelConfig } from "../../models/registry"
import { deleteThreadCheckpoint, getEnabledHooks, getWindowsSandboxMode } from "../../storage"
import { clearActionStationarityTurn } from "../../agent/action-stationarity"
import { parseCompletionGateDecision } from "../../agent/skill-lifecycle/completion-gate"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import type { FlowRun, FlowStep, FlowStepResult } from "../../../shared/mods/flows/types"
import { DEFAULT_COMPLETION_POLICY } from "../../../shared/mods/v2/completion-policy"
import type { ModsManager } from "../manager"
import type { HostFlowAuthority } from "../flow-authority"
import type { FunctionModsManager, HostCompletionOptions } from "../v2/manager"
import {
  sameCompletionBinding,
  type BoundCompletionEvidenceRecord
} from "../v2/completion-evidence"
import { functionUserInputInvoker } from "../v2/native-user-input"
import { withFunctionExecution } from "../v2/execution-context"
import type { FlowExecution, FlowHost, FlowStepContext } from "./contracts"
import { resolveClawActionInput } from "../../../shared/mods/claw-actions"
import { flowEvidenceInput } from "./evidence-input"
import { clawModelFingerprint } from "./model-fingerprint"
import { observeLegacyFlowRecovery } from "./recovery-observation"
import { FlowStore } from "./store"
import { publishOriginalFlowActionResult } from "./action-execution-facts"
import { readOriginalActionText } from "../v2/action-result-text"
import { captureProjectActionContentGuard } from "../../harness-board/project-action-scope"
import { captureNativeChildWorkflows } from "./native-child-workflows"
import type { FlowRecoveryObservation } from "./recovery"
import { validateRegisteredToolInput } from "../v2/tool-schema"
import { validateClawActionConfig } from "../v2/action-config"
import {
  createClawSkillPolicy,
  createFlowSkillSourceResolver,
  type ResolvedFlowSkillSource
} from "../claw-skills"
import { prepareNativeMcpStep } from "./native-mcp"
import { SkillLifecycleRegistry } from "../../agent/skill-lifecycle/registry"
import {
  createHookScope,
  mergeHookScopeSnapshot,
  resolveEnabledHooksForRun
} from "../../hooks/scope"
import { prepareFlowHarnessContext, constrainFlowHarnessContext } from "./harness-context"
import { registerRuntimePluginSourceChild } from "../../plugins/runtime-source-scope"
import {
  prepareStandardThreadRuntimeFactory,
  getHarnessHookContext
} from "../../agent/standard-thread-turn"
import { runCompletionHooksWithRevision } from "../../agent/skill-lifecycle/completion-hooks"
import { createTraceCollectorSafely, finishTraceInBackground } from "../../agent/trace/collector"
import { runHooksEnriched } from "../../hooks/required-skill"

interface NativeFlowHostOptions {
  /** Reads the current trusted ordinary-local thread; rejects all other contexts. */
  scope(threadId: string): string
  changed(threadId: string): void
}
type Stage = { plugin: string; feature: string; start: string }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

async function attemptCleanup(errors: unknown[], cleanup: () => void | Promise<void>) {
  try {
    await cleanup()
  } catch (error) {
    errors.push(error)
  }
}

function throwCleanupErrors(errors: unknown[]): void {
  if (errors.length) throw new AggregateError(errors, "FLOW_CLEANUP_FAILED")
}

/** Only native adapters can supply this host. Neither a plugin nor a model chooses the next step. */
export class NativeFlowHost implements FlowHost {
  constructor(
    private readonly manager: ModsManager,
    private readonly functions: FunctionModsManager,
    private readonly options: NativeFlowHostOptions
  ) {}

  assertScope(workspace: string, threadId: string): void {
    if (this.options.scope(threadId) !== workspace) throw Error("FLOW_SCOPE_CHANGED")
    if (!this.manager.isEnabled(workspace)) throw Error("MODS_DISABLED")
  }

  changed(threadId: string): void {
    this.options.changed(threadId)
  }

  async observeRecovery(run: FlowRun): Promise<FlowRecoveryObservation> {
    this.assertRecoveryScope(run.workspace, run.threadId)
    if (!this.manager.isEnabled(run.workspace))
      return {
        authority: "unavailable",
        reasons: [{ code: "mods-disabled", message: "Mods 已关闭；查看记录不会重新开启执行能力。" }]
      }
    if (
      run.flow?.definition?.schemaVersion === 2 &&
      run.flow.definition.execution?.profile === "workspace-files-v1"
    ) {
      let fileStore: VirtualTreeStore | undefined
      try {
        const { VirtualTreeStore } = await import("./virtual-tree")
        fileStore = new VirtualTreeStore(this.fileStorePath(), undefined, true)
        const context = await this.fileRecoveryContext(run)
        const store = new FlowStore(this.manager.store)
        const selection = this.functions.clawSelection(run.workspace, run.threadId)?.flow
        const definitionDigest =
          selection?.definition.id === run.flow.definition.id
            ? selection.digest
            : store.get(run.workspace, run.flow.definition.id)?.digest
        if (definitionDigest !== run.flow.digest) throw Error("FLOW_REVISION_CHANGED")
        const history = store.runs(run.workspace, run.threadId)
        const verifiedExecutionIds: string[] = []
        for (const attempt of run.attempts) {
          if (
            run.flow.definition.steps.find((step) => step.id === attempt.stepId)?.kind !==
              "agent" ||
            attempt.status !== "passed"
          )
            continue
          verifyCurrentFlowFileReceipt({
            run,
            attempt,
            history,
            parentThreadIncarnation: context.parentThreadIncarnation,
            currentDependencies: context.dependenciesFor,
            verifyVirtualTree: (_original, receipt, evidence) => {
              const actual = fileStore!.verifyReceipt({
                treeId: evidence.virtualTree.treeId, inputRoot: evidence.virtualTree.inputRoot,
                finalRoot: evidence.virtualTree.finalRoot, originDigest: evidence.virtualTree.originDigest,
                effectIds: evidence.virtualTree.effectIds,
                binding: { executionId: receipt.executionId, parentIncarnation: evidence.binding.parentThreadIncarnation },
                assertCurrent: context.assertCurrent
              })
              if (actual.effectLedgerDigest !== evidence.virtualTree.effectLedgerDigest)
                throw Error("FLOW_FILE_EFFECT_CHANGED")
            },
            assertCurrent: context.assertCurrent
          })
          verifiedExecutionIds.push(attempt.executionId)
        }
        context.assertCurrent()
        return { authority: "current", definitionDigest, fileReceipts: { verifiedExecutionIds } }
      } catch (error) {
        this.assertRecoveryScope(run.workspace, run.threadId)
        const code = error instanceof Error ? error.message : "FLOW_PROMPT_RECEIPT_NOT_CURRENT"
        const reasons: Record<string, string> = {
          FLOW_PROMPT_DYNAMIC_POLICY_UNVERIFIED:
            "当前有动态 Mods 组件，文本模式尚不能证明其模型或步骤策略。",
          FLOW_PROMPT_HARNESS_POLICY_UNVERIFIED: "当前项目适配器的模型指令尚未纳入恢复证明。",
          FLOW_PROMPT_LEGACY_POLICY_UNVERIFIED:
            "当前存在模型或步骤 Hook，文本模式尚不能验证这些依赖。",
          FLOW_REVISION_CHANGED: "保存的流程版本已变化，请核对后重新运行。",
          FLOW_PROMPT_POLICY_CHANGED: "当前权限、组件或 Hook 配置已改变。",
          FLOW_PROMPT_MODEL_CHANGED: "本次历史使用的模型配置已改变。"
        }
        return {
          authority: "unverified",
          reasons: [
            {
              code: "prompt-receipt-unverified",
              message: reasons[code] ?? "文本执行证据或当前依赖未通过核对，不能复用历史结果。"
            }
          ]
        }
      } finally { fileStore?.close() }
    }
    if (
      run.flow?.definition?.schemaVersion === 2 &&
      run.flow.definition.execution?.profile === "prompt-only-v1"
    ) {
      try {
        const context = await this.promptRecoveryContext(run)
        const store = new FlowStore(this.manager.store)
        const selection = this.functions.clawSelection(run.workspace, run.threadId)?.flow
        const definitionDigest =
          selection?.definition.id === run.flow.definition.id
            ? selection.digest
            : store.get(run.workspace, run.flow.definition.id)?.digest
        if (definitionDigest !== run.flow.digest) throw Error("FLOW_REVISION_CHANGED")
        const history = store.runs(run.workspace, run.threadId)
        const verifiedExecutionIds: string[] = []
        for (const attempt of run.attempts) {
          if (
            run.flow.definition.steps.find((step) => step.id === attempt.stepId)?.kind !==
              "agent" ||
            attempt.status !== "passed"
          )
            continue
          verifyCurrentFlowPromptReceipt({
            run,
            attempt,
            history,
            parentThreadIncarnation: context.parentThreadIncarnation,
            currentDependencies: context.dependenciesFor,
            assertCurrent: context.assertCurrent
          })
          verifiedExecutionIds.push(attempt.executionId)
        }
        context.assertCurrent()
        return { authority: "current", definitionDigest, promptReceipts: { verifiedExecutionIds } }
      } catch (error) {
        this.assertRecoveryScope(run.workspace, run.threadId)
        const code = error instanceof Error ? error.message : "FLOW_PROMPT_RECEIPT_NOT_CURRENT"
        const reasons: Record<string, string> = {
          FLOW_PROMPT_DYNAMIC_POLICY_UNVERIFIED:
            "当前有动态 Mods 组件，文本模式尚不能证明其模型或步骤策略。",
          FLOW_PROMPT_HARNESS_POLICY_UNVERIFIED: "当前项目适配器的模型指令尚未纳入恢复证明。",
          FLOW_PROMPT_LEGACY_POLICY_UNVERIFIED:
            "当前存在模型或步骤 Hook，文本模式尚不能验证这些依赖。",
          FLOW_REVISION_CHANGED: "保存的流程版本已变化，请核对后重新运行。",
          FLOW_PROMPT_POLICY_CHANGED: "当前权限、组件或 Hook 配置已改变。",
          FLOW_PROMPT_MODEL_CHANGED: "本次历史使用的模型配置已改变。"
        }
        return {
          authority: "unverified",
          reasons: [
            {
              code: "prompt-receipt-unverified",
              message: reasons[code] ?? "文本执行证据或当前依赖未通过核对，不能复用历史结果。"
            }
          ]
        }
      }
    }
    let plugins: ReturnType<FunctionModsManager["status"]> | undefined
    const result = await observeLegacyFlowRecovery(run, {
      readDefinitionDigest: () => {
        const selected = this.functions.clawSelection?.(run.workspace, run.threadId)?.flow
        if (selected?.definition.id === run.flow.definition.id) return selected.digest
        return new FlowStore(this.manager.store).get(run.workspace, run.flow.definition.id)?.digest
      },
      readModel: (ref) => {
        const model = getModelConfigByRef(ref)
        return model
          ? { fingerprint: clawModelFingerprint(model), available: !!model.apiKey }
          : undefined
      },
      readDefaultModelRef: () => getDefaultModelConfig()?.ref ?? null,
      readPlugin: async (pluginId) => {
        plugins ??= this.functions.status(run.workspace)
        const plugin = (await plugins).find((row) => row.pluginId === pluginId)
        return plugin
          ? {
              state: plugin.state,
              digest: plugin.digest,
              actionIds: (plugin.actions ?? []).map((action) => action.id)
            }
          : undefined
      }
    })
    this.assertRecoveryScope(run.workspace, run.threadId)
    if (!this.manager.isEnabled(run.workspace))
      return {
        authority: "unavailable",
        reasons: [{ code: "mods-disabled", message: "核对期间 Mods 已关闭，请刷新诊断。" }]
      }
    return result
  }

  /** Reads configuration only. No plugin startup, runtime, model or connection is prepared. */
  private async promptRecoveryContext(run: FlowRun) {
    const { workspace, threadId } = run
    this.assertScope(workspace, threadId)
    const boundary = this.functions.capturePromptOnlyBoundary(workspace, threadId)
    const readParent = () => {
      const row = getThreadCore(threadId)
      const metadata = JSON.parse(row?.metadata ?? "null")
      if (
        !metadata ||
        typeof metadata.cmb_thread_incarnation !== "string" ||
        !metadata.cmb_thread_incarnation ||
        typeof metadata.workspacePath !== "string" ||
        this.manager.workspaceKey(metadata.workspacePath) !== workspace
      )
        throw Error("FLOW_PROMPT_PARENT_IDENTITY_REQUIRED")
      // Bound project adapters may inject mandatory model instructions. Until their actual
      // dependencies are covered, rejecting this profile is safer than omitting that policy.
      if (metadata.harnessFeature || metadata.harnessProjectSession)
        throw Error("FLOW_PROMPT_HARNESS_POLICY_UNVERIFIED")
      return metadata.cmb_thread_incarnation as string
    }
    const parentThreadIncarnation = readParent()
    const readHooks = () => {
      const hooks = getEnabledHooks(workspace)
      if (hooks.some((hook) => hook.event !== "Stop" && hook.event !== "Notification"))
        throw Error("FLOW_PROMPT_LEGACY_POLICY_UNVERIFIED")
      return hash(hooks)
    }
    const hookDigest = readHooks()
    const policyDigest = hash({
      protocol: "flow-prompt-policy-v1",
      functions: boundary.policyDigest,
      legacyHooks: hookDigest,
      finalChecks: "native-flow-v1"
    })
    const assertCurrent = () => {
      this.assertScope(workspace, threadId)
      boundary.assertCurrent()
      const selectedFlow = this.functions.clawSelection(workspace, threadId)?.flow
      const currentFlow =
        selectedFlow?.definition.id === run.flow.definition.id
          ? selectedFlow
          : new FlowStore(this.manager.store).get(workspace, run.flow.definition.id)
      const evaluationSnapshot = assertEvaluationSnapshotRun(run)
      if (currentFlow?.digest !== run.flow.digest && !evaluationSnapshot) throw Error("FLOW_REVISION_CHANGED")
      if (readParent() !== parentThreadIncarnation || readHooks() !== hookDigest)
        throw Error("FLOW_PROMPT_POLICY_CHANGED")
    }
    assertCurrent()
    const profiles = await loadAgentProfilesAsync(workspace)
    assertCurrent()
    const selected = this.functions.clawSelection(workspace, threadId)
    const models = new Map<string, ReturnType<typeof getDefaultModelConfig>>()
    const roles = new Map<string, string>()
    const resolve = (available: AgentProfile[]) => {
      const result = new Map<
        string,
        { modelRef: string; modelDigest: string; rolePrompt: string }
      >()
      for (const step of run.flow.definition.steps) {
        if (!step.enabled || step.kind !== "agent") continue
        const role = step.agentType ? resolveProfileFromList(available, step.agentType) : undefined
        if (step.agentType && !role) throw Error("FLOW_AGENT_UNKNOWN")
        const roleModel = step.modelRole ? selected?.models?.roles[step.modelRole] : undefined
        if (step.modelRole && !step.modelId && !roleModel)
          throw Error("FLOW_MODEL_ROLE_UNAVAILABLE")
        const requested = step.modelId ?? roleModel ?? role?.model ?? selected?.models?.default
        const model = requested ? getModelConfigByRef(requested) : getDefaultModelConfig()
        if (!model?.apiKey) throw Error("FLOW_MODEL_UNAVAILABLE")
        result.set(step.id, {
          modelRef: model.ref,
          modelDigest: clawModelFingerprint(model),
          rolePrompt: role?.systemPrompt ?? ""
        })
      }
      return result
    }
    const resolved = resolve(profiles)
    for (const [id, value] of resolved) {
      models.set(id, getModelConfigByRef(value.modelRef))
      roles.set(id, value.rolePrompt)
    }
    const assertModels = () => {
      assertCurrent()
      const now = resolve(profiles)
      if (hash([...now]) !== hash([...resolved])) throw Error("FLOW_PROMPT_MODEL_CHANGED")
    }
    const dependenciesFor = (original: FlowRun, attempt: FlowAttempt): FlowPromptDependencies => {
      assertModels()
      const step = original.flow.definition.steps.find((value) => value.id === attempt.stepId)
      const model = models.get(attempt.stepId)
      if (step?.kind !== "agent" || !model) throw Error("FLOW_PROMPT_STEP_INVALID")
      const previousIds = original.flow.definition.steps
        .slice(0, original.flow.definition.steps.indexOf(step))
        .filter((value) => value.enabled && value.kind === "agent")
        .map((value) => value.id)
      const projection = projectPromptOnlyPrior(
        original.flow.definition,
        step.id,
        original.attempts.filter((value) => previousIds.includes(value.stepId))
      )
      const businessPrompt = `${original.taskGoal ?? original.flow.definition.goal}\n\n本步骤：${step.prompt}\n\n此前步骤结果（仅作上下文）：\n${projection.text}`
      const descriptor = describeFlowPromptRuntime({
        model,
        rolePrompt: roles.get(step.id) ?? "",
        mandatoryPolicyDigest: policyDigest
      })
      return {
        schemaVersion: 1,
        coverage: "prompt-and-prior-receipts",
        profile: "prompt-only-v1",
        runtimeProtocol: descriptor.runtimeProtocol,
        definitionDigest: original.flow.digest,
        taskGoalDigest: flowPromptTaskGoalDigest(original),
        stepId: step.id,
        modelRef: descriptor.modelRef,
        modelConfigurationDigest: descriptor.modelConfigurationDigest,
        mandatoryPolicyDigest: descriptor.mandatoryPolicyDigest,
        systemPromptDigest: descriptor.systemPromptDigest,
        rolePromptDigest: descriptor.rolePromptDigest,
        stableInput: { version: 1, digest: flowPromptDigest(businessPrompt) },
        context: { version: 1, digest: flowPromptDigest(projection.text) },
        priorProjection: "prompt-only-prior-v1",
        resultTool: descriptor.resultTool
      }
    }
    return {
      parentThreadIncarnation,
      policyDigest,
      dependenciesFor,
      assertCurrent: assertModels,
      async refresh() {
        assertModels()
        const currentProfiles = await loadAgentProfilesAsync(workspace)
        assertModels()
        if (hash([...resolve(currentProfiles)]) !== hash([...resolved]))
          throw Error("FLOW_PROMPT_ROLE_CHANGED")
      }
    }
  }

  private fileStorePath(): string {
    return join(dirname(this.manager.store.evidenceExcludedPaths[0]), "mods-flow-virtual.sqlite")
  }

  /** Reads configuration only. No plugin startup, runtime, model or connection is prepared. */
  private async fileRecoveryContext(run: FlowRun) {
    const { describeFlowFileRuntime } = await import("../../agent/flow-file-runtime-contract")
    const { workspace, threadId } = run
    this.assertScope(workspace, threadId)
    const boundary = this.functions.capturePromptOnlyBoundary(workspace, threadId)
    const readParent = () => {
      const row = getThreadCore(threadId)
      const metadata = JSON.parse(row?.metadata ?? "null")
      if (
        !metadata ||
        typeof metadata.cmb_thread_incarnation !== "string" ||
        !metadata.cmb_thread_incarnation ||
        typeof metadata.workspacePath !== "string" ||
        this.manager.workspaceKey(metadata.workspacePath) !== workspace
      )
        throw Error("FLOW_PROMPT_PARENT_IDENTITY_REQUIRED")
      // Bound project adapters may inject mandatory model instructions. Until their actual
      // dependencies are covered, rejecting this profile is safer than omitting that policy.
      if (metadata.harnessFeature || metadata.harnessProjectSession)
        throw Error("FLOW_PROMPT_HARNESS_POLICY_UNVERIFIED")
      return metadata.cmb_thread_incarnation as string
    }
    const parentThreadIncarnation = readParent()
    const readHooks = () => {
      const hooks = getEnabledHooks(workspace)
      if (hooks.some((hook) => hook.event !== "Stop" && hook.event !== "Notification"))
        throw Error("FLOW_PROMPT_LEGACY_POLICY_UNVERIFIED")
      return hash(hooks)
    }
    const hookDigest = readHooks()
    const policyDigest = hash({
      protocol: "flow-files-policy-v1",
      functions: boundary.policyDigest,
      legacyHooks: hookDigest,
      finalChecks: "native-flow-virtual-materialization-v1"
    })
    const assertCurrent = () => {
      this.assertScope(workspace, threadId)
      boundary.assertCurrent()
      const selectedFlow = this.functions.clawSelection(workspace, threadId)?.flow
      const currentFlow =
        selectedFlow?.definition.id === run.flow.definition.id
          ? selectedFlow
          : new FlowStore(this.manager.store).get(workspace, run.flow.definition.id)
      const evaluationSnapshot = assertEvaluationSnapshotRun(run)
      if (currentFlow?.digest !== run.flow.digest && !evaluationSnapshot) throw Error("FLOW_REVISION_CHANGED")
      if (readParent() !== parentThreadIncarnation || readHooks() !== hookDigest)
        throw Error("FLOW_PROMPT_POLICY_CHANGED")
    }
    assertCurrent()
    const profiles = await loadAgentProfilesAsync(workspace)
    assertCurrent()
    const selected = this.functions.clawSelection(workspace, threadId)
    const models = new Map<string, ReturnType<typeof getDefaultModelConfig>>()
    const roles = new Map<string, string>()
    const resolve = (available: AgentProfile[]) => {
      const result = new Map<
        string,
        { modelRef: string; modelDigest: string; rolePrompt: string }
      >()
      for (const step of run.flow.definition.steps) {
        if (!step.enabled || step.kind !== "agent") continue
        const role = step.agentType ? resolveProfileFromList(available, step.agentType) : undefined
        if (step.agentType && !role) throw Error("FLOW_AGENT_UNKNOWN")
        const roleModel = step.modelRole ? selected?.models?.roles[step.modelRole] : undefined
        if (step.modelRole && !step.modelId && !roleModel)
          throw Error("FLOW_MODEL_ROLE_UNAVAILABLE")
        const requested = step.modelId ?? roleModel ?? role?.model ?? selected?.models?.default
        const model = requested ? getModelConfigByRef(requested) : getDefaultModelConfig()
        if (!model?.apiKey) throw Error("FLOW_MODEL_UNAVAILABLE")
        result.set(step.id, {
          modelRef: model.ref,
          modelDigest: clawModelFingerprint(model),
          rolePrompt: role?.systemPrompt ?? ""
        })
      }
      return result
    }
    const resolved = resolve(profiles)
    for (const [id, value] of resolved) {
      models.set(id, getModelConfigByRef(value.modelRef))
      roles.set(id, value.rolePrompt)
    }
    const assertModels = () => {
      assertCurrent()
      const now = resolve(profiles)
      if (hash([...now]) !== hash([...resolved])) throw Error("FLOW_PROMPT_MODEL_CHANGED")
    }
    const dependenciesFor = (original: FlowRun, attempt: FlowAttempt): FlowFileDependencies => {
      assertModels()
      const step = original.flow.definition.steps.find((value) => value.id === attempt.stepId)
      const model = models.get(attempt.stepId)
      if (step?.kind !== "agent" || !model) throw Error("FLOW_PROMPT_STEP_INVALID")
      const previousIds = original.flow.definition.steps
        .slice(0, original.flow.definition.steps.indexOf(step))
        .filter((value) => value.enabled && value.kind === "agent")
        .map((value) => value.id)
      const projection = projectFileOnlyPrior(
        original.flow.definition,
        step.id,
        original.attempts.filter((value) => previousIds.includes(value.stepId))
      )
      const businessPrompt = `${original.taskGoal ?? original.flow.definition.goal}\n\n本步骤：${step.prompt}\n\n此前步骤结果（仅作上下文）：\n${projection.text}`
      const descriptor = describeFlowFileRuntime({
        model,
        rolePrompt: roles.get(step.id) ?? "",
        mandatoryPolicyDigest: policyDigest
      })
      return {
        schemaVersion: 1,
        coverage: "prompt-prior-and-virtual-root",
        profile: "workspace-files-v1",
        runtimeProtocol: descriptor.runtimeProtocol,
        definitionDigest: original.flow.digest,
        taskGoalDigest: flowPromptTaskGoalDigest(original),
        stepId: step.id,
        modelRef: descriptor.modelRef,
        modelConfigurationDigest: descriptor.modelConfigurationDigest,
        mandatoryPolicyDigest: descriptor.mandatoryPolicyDigest,
        systemPromptDigest: descriptor.systemPromptDigest,
        rolePromptDigest: descriptor.rolePromptDigest,
        stableInput: { version: 1, digest: flowPromptDigest(businessPrompt) },
        context: { version: 1, digest: flowPromptDigest(projection.text) },
        priorProjection: "files-prior-v1",
        virtualInput: { version: 1, root: attempt.inputFingerprint!, originDigest: original.fileNamespace!.originDigest },
        resultTool: descriptor.resultTool
      }
    }
    return {
      parentThreadIncarnation,
      policyDigest,
      dependenciesFor,
      assertCurrent: assertModels,
      async refresh() {
        assertModels()
        const currentProfiles = await loadAgentProfilesAsync(workspace)
        assertModels()
        if (hash([...resolve(currentProfiles)]) !== hash([...resolved]))
          throw Error("FLOW_PROMPT_ROLE_CHANGED")
      }
    }
  }

  async filePublication(run: FlowRun, request: FlowFilePublicationRequest, signal: AbortSignal,
    assertRunCurrent: () => void): Promise<Omit<FlowFileReview, "runDigest"> | FlowFilePublicationOutcome> {
    if (run.status !== "complete" || !run.fileNamespace || run.flow.definition.schemaVersion !== 2 ||
      run.flow.definition.execution.profile !== "workspace-files-v1") throw Error("FLOW_FILE_PUBLICATION_UNAVAILABLE")
    const context = await this.fileRecoveryContext(run)
    const guard = () => {
      signal.throwIfAborted()
      this.assertScope(run.workspace, run.threadId)
      assertRunCurrent()
      context.assertCurrent()
      signal.throwIfAborted()
    }
    guard()
    const { VirtualTreeStore } = await import("./virtual-tree")
    const { prepareVirtualTreeReview, readVirtualTreeReview, VirtualPublicationJournal,
      exportReviewedVirtualTree } = await import("./virtual-tree-publication")
    const store = new VirtualTreeStore(this.fileStorePath(), undefined, true)
    try {
      await context.refresh()
      guard()
      const history = new FlowStore(this.manager.store).runs(run.workspace, run.threadId)
      const attempts = run.attempts.filter((attempt) => run.flow.definition.steps.some((step) =>
        step.id === attempt.stepId && step.enabled && step.kind === "agent"))
      for (const attempt of attempts) verifyCurrentFlowFileReceipt({
        run, attempt, history, parentThreadIncarnation: context.parentThreadIncarnation,
        currentDependencies: context.dependenciesFor, assertCurrent: guard,
        verifyVirtualTree: (original, receipt) => {
          const proof = receipt.fileRecoveryEvidence!
          const actual = store.verifyReceipt({ treeId: proof.virtualTree.treeId,
            inputRoot: proof.virtualTree.inputRoot, finalRoot: proof.virtualTree.finalRoot,
            originDigest: proof.virtualTree.originDigest, effectIds: proof.virtualTree.effectIds,
            binding: { executionId: proof.binding.executionId, parentIncarnation: proof.binding.parentThreadIncarnation },
            assertCurrent: guard })
          if (actual.effectLedgerDigest !== proof.virtualTree.effectLedgerDigest || !original.fileNamespace)
            throw Error("FLOW_FILE_RECEIPT_INVALID")
        }
      })
      const finalRoot = attempts.at(-1)?.fileRecoveryEvidence?.virtualTree.finalRoot
      if (!finalRoot) throw Error("FLOW_FILE_RECEIPT_REQUIRED")
      const token = prepareVirtualTreeReview({ store, treeId: run.fileNamespace.treeId, finalRoot, assertCurrent: guard })
      const review = readVirtualTreeReview(token)!
      const journal = new VirtualPublicationJournal(this.manager.store)
      const operations = journal.list().filter((item) => item.reviewDigest === review.digest)
      if (request.kind === "review") return {
        runId: run.id, reviewDigest: review.digest,
        state: operations.some((item) => ["intent", "unknown"].includes(item.state)) ? "unknown" :
          operations.some((item) => item.kind === "workspace-writeback" && item.state === "settled") ? "published" : "unpublished",
        canPublish: process.platform === "win32", changeCount: review.changes.length,
        limited: review.changes.length > 64,
        changes: review.changes.slice(0, 64).map((change) => ({ path: change.path, kind: change.kind,
          bytes: change.bytes, preview: change.encoding === "utf8" ? change.content.slice(0, 1000) : "[二进制内容；请导出完整补丁审阅]" })),
        operations: operations.map((item) => ({ id: item.operationId, kind: item.kind, state: item.state,
          ...(item.backupDirectory ? { recoveryDirectory: item.backupDirectory } : {}) }))
      }
      if (request.reviewDigest !== review.digest) throw Error("FLOW_FILE_REVIEW_CHANGED")
      if (operations.some((item) => ["intent", "unknown"].includes(item.state) || (item.kind === "workspace-writeback" && item.state === "settled")))
        throw Error("VIRTUAL_PUBLICATION_RECONCILE_REQUIRED")
      const operation = { token, approvedDigest: review.digest, journal, signal, assertCurrent: guard }
      const result = request.kind === "export" ? await exportReviewedVirtualTree({ ...operation, destination: request.destination }) :
        await (await import("./virtual-tree-writeback")).publishReviewedVirtualTree(operation)
      guard()
      return { state: result.state, operationId: result.operationId, reviewDigest: review.digest }
    } finally { store.close() }
  }

  assertRecoveryScope(workspace: string, threadId: string): void {
    if (this.options.scope(threadId) !== workspace) throw Error("FLOW_SCOPE_CHANGED")
  }

  async prepare(
    workspace: string,
    threadId: string,
    run: FlowRun,
    signal: AbortSignal
  ): Promise<FlowExecution> {
    this.assertScope(workspace, threadId)
    const assertProjectContent = captureProjectActionContentGuard(threadId)
    const withProjectContent = async <T>(run: () => Promise<T>): Promise<T> => {
      assertProjectContent?.()
      try { return await run() }
      finally { assertProjectContent?.() }
    }
    const lease = getLocalThreadRunLease(threadId)
    const leaseCurrent = captureLocalThreadRunLease(threadId)
    if (lease?.owner !== "mods" || lease.runId !== run.id || !leaseCurrent)
      throw Error("FLOW_LEASE_REQUIRED")
    const definition = {
      ...run.flow.definition,
      goal: run.taskGoal ?? run.flow.definition.goal
    }
    const executionDigest =
      run.taskGoal === undefined
        ? run.flow.digest
        : hash({ definition: run.flow.digest, taskGoal: run.taskGoal })
    const promptOnly =
      definition.schemaVersion === 2 && definition.execution.profile === "prompt-only-v1"
    const promptContext = promptOnly ? await this.promptRecoveryContext(run) : undefined
    const filesOnly = definition.schemaVersion === 2 && definition.execution.profile === "workspace-files-v1"
    const fileContext = filesOnly ? await this.fileRecoveryContext(run) : undefined
    const closedContext = promptContext ?? fileContext
    let fileStore: VirtualTreeStore | undefined
    let fileNamespace: FlowFileNamespace | undefined
    const fileCaptures = new Map<string, FlowFileRuntimeSettledCapture>()
    const fileMaterializations = new Set<{ dispose(): Promise<void> }>()
    promptContext?.assertCurrent()
    const promptCaptures = new Map<string, FlowPromptRuntimeSettledCapture>()
    const harness = await prepareFlowHarnessContext(threadId, workspace)
    if (harness.bound && definition.schemaVersion !== 2) throw Error("FLOW_HARNESS_HOST_REQUIRED")
    const parentHookScope = createHookScope()
    parentHookScope.activatePlugin(harness.context.pluginId)
    let stopCompleted = false
    let stopPassed = false
    const scope = closedContext
      ? this.functions.preparePromptOnlyFlowScope(
          workspace,
          threadId,
          run.id,
          executionDigest,
          signal
        )
      : await this.functions.prepareFlowScope(
          workspace,
          threadId,
          definition.schemaVersion === 1 ? definition.plugin : undefined,
          run.id,
          executionDigest,
          signal
        )
    const controller = new AbortController()
    const lifetime = AbortSignal.any([signal, scope.signal, controller.signal])
    let releaseBinding = () => {}
    let authority: ReturnType<ModsManager["createRuntimeAuthority"]> | undefined
    let hostAuthority: HostFlowAuthority | undefined
    const requireHostAuthority = () => {
      if (!hostAuthority) throw Error("FLOW_HOST_AUTHORITY_REQUIRED")
      return hostAuthority
    }
    const children = new Map<string, () => Promise<void>>()
    let flowTracer: ReturnType<typeof createTraceCollectorSafely>
    let traceFinished = false
    let preparedReturned = false
    const finishTelemetry = (status: FlowRun["status"]) => {
      if (!flowTracer || traceFinished) return
      traceFinished = true
      finishTraceInBackground(flowTracer, status === "complete" ? "success" :
        status === "failed" ? "error" : status === "cancelled" ? "cancelled" : "unknown", undefined, "Flow")
    }
    const executionTelemetry = new Map<string, NonNullable<FlowAttempt["telemetry"]>>()
    const modelPins = new Map<string, string>()
    const requiredModels = new Set<string>()
    let implicitDefaultRef: string | null | undefined
    const aclOwnerId = `flow:${randomUUID()}`
    const assertLive = () => {
      lifetime.throwIfAborted()
      this.assertScope(workspace, threadId)
      harness.assertCurrent()
      closedContext?.assertCurrent()
      scope.assertLive()
      if (!leaseCurrent()) throw Error("FLOW_LEASE_CHANGED")
      authority?.authority.assertLive()
      if (
        implicitDefaultRef !== undefined &&
        (getDefaultModelConfig()?.ref ?? null) !== implicitDefaultRef
      )
        throw Error("FLOW_DEFAULT_MODEL_CHANGED")
      for (const [ref, fingerprint] of modelPins) {
        const model = getModelConfigByRef(ref)
        if (!model || (requiredModels.has(ref) && !model.apiKey))
          throw Error(`FLOW_MODEL_UNAVAILABLE: ${ref}`)
        if (clawModelFingerprint(model) !== fingerprint) throw Error(`FLOW_MODEL_CHANGED: ${ref}`)
      }
    }
    const pendingWorkflowChildren = new Set<string>()
    const dispose = async () => {
      const errors: unknown[] = []
      await attemptCleanup(errors, () => controller.abort(Error("FLOW_EXECUTION_DISPOSED")))
      for (const cleanup of [...children.values()]) await attemptCleanup(errors, cleanup)
      // A still-running original workflow retains its parent source/authority for retryable
      // physical cleanup. Other child cleanup failures keep their existing aggregation policy.
      if (pendingWorkflowChildren.size) {
        throwCleanupErrors(errors)
        throw Error("FLOW_CHILD_WORKFLOW_CLEANUP_UNCONFIRMED")
      }
      await attemptCleanup(errors, releaseBinding)
      await attemptCleanup(errors, () => authority?.release())
      await attemptCleanup(errors, scope.dispose)
      await attemptCleanup(errors, () => {
        if (!leaseCurrent()) throw Error("FLOW_LEASE_CHANGED")
        return LocalSandbox.cancelBackgroundTasksAndWait(threadId)
      })
      // The ACL owner is a unique physical id, so a replacement thread cannot own these ACLs.
      await attemptCleanup(errors, () => LocalSandbox.revokeGrantedAclsForRun(aclOwnerId))
      for (const materialized of fileMaterializations) await attemptCleanup(errors, () => materialized.dispose())
      await attemptCleanup(errors, () => fileStore?.close())
      if (!preparedReturned) finishTelemetry(errors.length ? "failed" : "interrupted")
      throwCleanupErrors(errors)
    }
    try {
      flowTracer = createTraceCollectorSafely(threadId, definition.goal, "host-flow", {
        traceKind: "workflow_run", executionMode: "workflow", workflowRunId: run.id
      }, "Flow")
      if (fileContext) {
        const { VirtualTreeStore, readVirtualTreeSnapshot } = await import("./virtual-tree")
        fileStore = new VirtualTreeStore(this.fileStorePath())
        if (run.fileNamespace) fileNamespace = structuredClone(run.fileNamespace)
        else {
          const { importVirtualTreeSource } = await import("./virtual-tree-import")
          const imported = await importVirtualTreeSource({ sourceDirectory: workspace, signal: lifetime, assertCurrent: assertLive })
          const created = fileStore.createImported(imported)
          const snapshot = readVirtualTreeSnapshot(fileStore.captureSnapshot(created.treeId, created.root, assertLive))!
          fileNamespace = { schemaVersion: 1, treeId: created.treeId, initialRoot: created.root, originDigest: snapshot.originDigest }
          run.fileNamespace = structuredClone(fileNamespace)
        }
      }
      const profiles = await loadAgentProfilesAsync(workspace)
      assertLive()
      const roles = new Map<string, AgentProfile>()
      const models = new Map<string, string>()
      const clawSelection = this.functions.clawSelection?.(workspace, threadId)
      const clawModels = clawSelection?.models
      const clawSkillPolicy = await createClawSkillPolicy(clawSelection?.skills)
      assertLive()
      const hookScope = parentHookScope
      if (clawModels) {
        if (!clawModels.default) {
          const defaults = getDefaultModelConfig()
          implicitDefaultRef = defaults?.ref ?? null
          if (defaults) modelPins.set(defaults.ref, clawModelFingerprint(defaults))
        }
        for (const ref of new Set(
          [clawModels.default, ...Object.values(clawModels.roles)].filter(
            (ref): ref is string => !!ref
          )
        )) {
          const model = getModelConfigByRef(ref)
          if (!model?.apiKey) throw Error(`FLOW_MODEL_UNAVAILABLE: ${ref}`)
          modelPins.set(model.ref, clawModelFingerprint(model))
          requiredModels.add(model.ref)
        }
      }
      const actions = new Map<string, Awaited<ReturnType<FunctionModsManager["prepareAction"]>>>()
      const skills = new Map<string, ResolvedFlowSkillSource>()
      const mcpTools = new Map<string, Awaited<ReturnType<typeof prepareNativeMcpStep>>>()
      const invokedMcpSteps = new Set<string>()
      const assertPrepared = () => {
        assertLive()
        for (const source of skills.values()) source.assertCurrent()
        for (const tool of mcpTools.values()) tool.assertCurrent()
      }
      const resolveSkill = definition.steps.some((step) => step.enabled && step.kind === "skill")
        ? await createFlowSkillSourceResolver(
            () => this.functions.clawSelection?.(workspace, threadId)?.skills
          )
        : undefined
      assertLive()
      for (const step of definition.steps) {
        if (!step.enabled) continue
        if (step.kind === "skill") {
          skills.set(step.id, resolveSkill!(step.skill))
        }
        if (step.kind === "mcp-tool") {
          mcpTools.set(
            step.id,
            await prepareNativeMcpStep({
              manager: this.manager,
              workspace,
              threadId,
              turnId: run.id,
              selection: clawSelection?.mcp,
              provider: step.provider,
              toolName: step.toolName,
              schemaDigest: step.schemaDigest,
              signal: lifetime,
              assertLive,
              ...(definition.schemaVersion === 1
                ? { withOwnerGrant: scope.withOwnerGrant }
                : { hostAuthority: requireHostAuthority })
            })
          )
        }
        assertLive()
      }
      for (const step of definition.steps) {
        if (!step.enabled || step.kind !== "plugin-action") continue
        const action = await this.functions.prepareAction(workspace, threadId, step, lifetime)
        validateClawActionConfig(step.config ?? {}, action.action.configSchema)
        if (!step.inputFrom && !step.evidenceInput)
          validateRegisteredToolInput(action.action.inputSchema, step.input)
        actions.set(step.id, action)
        assertLive()
      }
      for (const step of definition.steps) {
        if (!step.enabled || (step.kind !== "agent" && step.kind !== "skill")) continue
        const role = step.agentType ? resolveProfileFromList(profiles, step.agentType) : undefined
        if (step.agentType && !role) throw Error(`FLOW_AGENT_UNKNOWN: ${step.agentType}`)
        if (role) roles.set(step.id, structuredClone(role))
        const roleModel = step.modelRole ? clawModels?.roles[step.modelRole] : undefined
        if (step.modelRole && !step.modelId && !roleModel)
          throw Error(`FLOW_MODEL_ROLE_UNAVAILABLE: ${step.modelRole}`)
        const requested = step.modelId ?? roleModel ?? role?.model ?? clawModels?.default
        const model = requested ? getModelConfigByRef(requested) : getDefaultModelConfig()
        if (!model?.apiKey) throw Error(`FLOW_MODEL_UNAVAILABLE: ${requested ?? "default"}`)
        models.set(step.id, model.ref)
        modelPins.set(model.ref, clawModelFingerprint(model))
        requiredModels.add(model.ref)
      }
      const stages: Stage[] = [...scope.stages]
      if (definition.steps.some((step) => step.enabled && step.kind === "autobiz-stage")) {
        if (definition.schemaVersion !== 1 || !definition.feature || !definition.stageStart)
          throw Error("FLOW_STAGE_REQUIRED")
        stages.push({
          plugin: definition.plugin,
          feature: definition.feature,
          start: definition.stageStart
        })
      }
      if (new Set(stages.map((stage) => JSON.stringify([stage.feature, stage.start]))).size > 1)
        throw Error("MODS_AUTOBIZ_STAGE_CONFLICT")
      const stage = stages[0]
      const windowsSandbox = process.platform === "win32" ? getWindowsSandboxMode() : "none"
      const codexExePath = join(
        app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources"),
        "bin",
        process.platform,
        "codex.exe"
      )
      if (windowsSandbox !== "none") await ensureCodexExe(codexExePath)
      assertLive()
      if (windowsSandbox !== "none" && !existsSync(codexExePath))
        throw Error("MODS_SANDBOX_NOT_READY")
      authority = this.manager.createRuntimeAuthority({
        workspace,
        threadId,
        turnId: run.id,
        signal: lifetime
      })
      if (definition.schemaVersion === 2)
        hostAuthority = this.manager.createHostFlowAuthority({
          workspace,
          threadId,
          runId: run.id,
          definitionDigest: executionDigest,
          signal: lifetime,
          assertLive: assertPrepared,
          runtimeAuthority: authority.authority
        })
      const bindSandbox = (executionWorkspace: string) => {
        releaseBinding()
        new LocalSandbox({
        rootDir: executionWorkspace,
        ...(fileContext ? { modWorkspace: workspace } : {}),
        pluginRoot: harness.context.pluginRoot,
        pluginId: harness.context.pluginId,
        pluginName: harness.context.pluginName,
        pluginOutputDir: harness.context.pluginOutputDir,
        systemId: harness.context.systemId,
        ...getHarnessHookContext(harness.context),
        runId: threadId,
        hookTurnId: run.id,
        aclOwnerId,
        modCommandOnly: true,
        clawSkillPolicy,
        hookScope,
        hookResolver: (event, context) =>
          resolveEnabledHooksForRun(workspace, event, context, hookScope),
        ...(clawSkillPolicy
          ? {
              skillLifecycleRegistry: new SkillLifecycleRegistry(clawSkillPolicy.lifecycleSources)
            }
          : {}),
        modManagedExecution: true,
        modRuntimeAuthority: authority!.authority,
        modUserInput: functionUserInputInvoker({
          threadId,
          onRejected: () => controller.abort(Error("FLOW_USER_INPUT_REJECTED"))
        }),
        onModBinding: (release) => {
          releaseBinding = release
        },
        virtualMode: false,
        windowsSandbox,
        codexExePath,
        hooks: () => getEnabledHooks(workspace),
        abortSignal: lifetime,
        timeout: definition.timeoutMs,
        maxOutputBytes: 48_000
      })
      }
      bindSandbox(workspace)
      assertLive()
      const inScope = <T>(operation: () => Promise<T>): Promise<T> => {
        assertLive()
        return withFunctionExecution(
          {
            workspace,
            threadId,
            turnId: run.id,
            runtimeAuthority: authority!.authority,
            leased: true,
            immediate: false,
            userInitiated: true
          },
          async () => {
            const value = await operation()
            assertLive()
            return value
          }
        )
      }
      let verifyFileCheck: (() => Promise<void>) | undefined
      const drainAndVerifyFileCheck = async () => {
        if (!fileContext) return
        if (!verifyFileCheck) throw Error("FLOW_FILE_CHECK_MATERIALIZATION_REQUIRED")
        await LocalSandbox.cancelBackgroundTasksAndWait(threadId)
        await verifyFileCheck()
        assertPrepared()
      }
      const withFileCheckWorkspace = async <T>(operation: (directory: string) => Promise<T>): Promise<T> => {
        if (!fileContext) return operation(workspace)
        const { materializeVirtualTree, assertVirtualTreeMaterializationCurrent } = await import("./virtual-tree-materialization")
        const root = fileStore!.currentRoot(fileNamespace!.treeId, assertPrepared)
        const materialized = await materializeVirtualTree({ store: fileStore!, treeId: fileNamespace!.treeId, root, signal: lifetime, assertCurrent: assertPrepared })
        fileMaterializations.add(materialized)
        try {
          bindSandbox(materialized.directory)
          verifyFileCheck = () => assertVirtualTreeMaterializationCurrent(materialized)
          const result = await operation(materialized.directory)
          await drainAndVerifyFileCheck()
          assertPrepared()
          if (fileStore!.currentRoot(fileNamespace!.treeId, assertPrepared) !== root) throw Error("FLOW_FILE_CHECK_ROOT_CHANGED")
          return result
        } finally {
          await LocalSandbox.cancelBackgroundTasksAndWait(threadId)
          releaseBinding()
          verifyFileCheck = undefined
          await materialized.dispose()
          fileMaterializations.delete(materialized)
          bindSandbox(workspace)
        }
      }
      const captureCheckBinding = async (operationSignal: AbortSignal) => {
        if (!fileContext) return scope.captureBinding(operationSignal)
        operationSignal.throwIfAborted()
        await drainAndVerifyFileCheck()
        await fileContext.refresh()
        assertPrepared()
        const root = fileStore!.currentRoot(fileNamespace!.treeId, assertPrepared)
        return {
          workspace, threadId, turnId: run.id, runId: run.id, pluginDigests: {},
          runtimeGeneration: 0, diffFingerprint: root, stateFingerprint: root,
          requirementVersion: fileNamespace!.originDigest,
          configFingerprint: hash({ policy: fileContext.policyDigest, executionDigest }), files: []
        }
      }
      const fingerprint = async (operationSignal: AbortSignal) => {
        await closedContext?.refresh()
        assertPrepared()
        if (fileContext) {
          operationSignal.throwIfAborted()
          return fileStore!.currentRoot(fileNamespace!.treeId, assertPrepared)
        }
        const value = await scope.fingerprint(AbortSignal.any([lifetime, operationSignal]))
        assertPrepared()
        return value
      }
      const publish = async (
        value: FlowStepResult,
        operationSignal: AbortSignal
      ): Promise<FlowStepResult> => {
        const result = await this.manager.publish(
          workspace,
          value as unknown as ModJson,
          undefined,
          operationSignal
        )
        assertPrepared()
        return result as unknown as FlowStepResult
      }
      const checkInternal = async (
        context: FlowStepContext,
        selected?: Extract<FlowStep, { kind: "check" }>,
        terminalStage?: Stage
      ) => {
        const records: BoundCompletionEvidenceRecord[] = []
        const checkSignal = AbortSignal.any([lifetime, context.signal])
        const nativeContext: ModObject = {
          runId: run.id,
          turnId: run.id,
          flowDigest: executionDigest,
          stepId: selected?.id ?? "$application",
          executionId: context.executionId,
          goal: definition.goal,
          feature: definition.feature ?? ""
        }
        if (selected && definition.schemaVersion === 2 && !terminalStage) {
          if (selected.check !== "unit-test" && selected.check !== "e2e")
            throw Error("FLOW_HOST_CHECK_UNSUPPORTED")
          const binding = await captureCheckBinding(checkSignal)
          assertPrepared()
          const attempt = randomUUID()
          const record = (
            phase: BoundCompletionEvidenceRecord["phase"],
            status: BoundCompletionEvidenceRecord["status"],
            detail: ModObject
          ) => {
            const evidence: BoundCompletionEvidenceRecord = {
              id: randomUUID(),
              idempotencyKey: `${attempt}:${phase}:${status}`,
              workspace,
              threadId,
              turnId: run.id,
              runId: run.id,
              binding,
              phase,
              status,
              detail: { ...detail, attempt, stepId: selected.id, source: fileContext ? "host-virtual-tree-check" : "host-project-check", ...(fileContext ? { virtualRoot: fileStore!.currentRoot(fileNamespace!.treeId, assertPrepared), originDigest: fileNamespace!.originDigest } : {}) },
              at: Date.now()
            }
            this.manager.store.saveCompletionEvidence(evidence)
            records.push(evidence)
            this.options.changed(threadId)
          }
          record("check.started", "running", { kind: selected.check })
          try {
            const result = await inScope(() =>
              this.manager.runHostFlowProjectCheck(
                requireHostAuthority(),
                selected.check as "unit-test" | "e2e",
                checkSignal,
                definition.timeoutMs
              )
            )
            await drainAndVerifyFileCheck()
            assertPrepared()
            if (!result.executionId || typeof result.exitCode !== "number")
              throw Error("MODS_PROJECT_CHECK_RECEIPT_REQUIRED")
            record("validator.result", result.passed ? "pass" : "block", {
              kind: selected.check,
              executionId: result.executionId,
              exitCode: result.exitCode,
              outputFingerprint: result.outputFingerprint
            })
            if (!sameCompletionBinding(binding, await captureCheckBinding(checkSignal))) {
              record("invalidated", "stale", { reason: "input-changed" })
              throw Error("COMPLETION_EVIDENCE_STALE")
            }
            assertPrepared()
            record("check.result", result.passed ? "pass" : "block", {
              kind: selected.check,
              executionId: result.executionId,
              passed: result.passed
            })
            return {
              result: await publish(
                {
                  passed: result.passed,
                  summary: result.passed
                    ? `${selected.name}通过`
                    : (result.reason ?? `${selected.name}未通过`),
                  source: "native-check",
                  check: selected.check,
                  evidenceIds: records
                    .filter((record) => record.phase === "check.result")
                    .map((record) => record.id)
                },
                checkSignal
              ),
              records
            }
          } catch (error) {
            record("check.result", checkSignal.aborted ? "cancelled" : "error", {
              kind: selected.check,
              reason: "FLOW_HOST_CHECK_FAILED",
              businessAccepted: false
            })
            throw error
          }
        }
        const policyOwner =
          terminalStage?.plugin ?? (definition.schemaVersion === 1 ? definition.plugin : undefined)
        if (selected && !policyOwner) throw Error("FLOW_PLUGIN_OWNER_REQUIRED")
        const options: HostCompletionOptions = {
          checkOnly: true,
          strictErrors: true,
          stage: terminalStage,
          evidence: (record) => {
            records.push(record)
          },
          ...(selected
            ? {
                temporaryPolicy: {
                  plugin: policyOwner!,
                  policy: {
                    ...DEFAULT_COMPLETION_POLICY,
                    mode: "check",
                    scope: "diff",
                    checks: [selected.check],
                    feature: terminalStage?.feature ?? definition.feature,
                    timeoutMs: Math.max(1000, Math.min(definition.timeoutMs, 3_600_000)),
                    maxRepairs: 0
                  },
                  context: nativeContext
                }
              }
            : {})
        }
        const gate = await inScope(() =>
          this.functions.completionGate(workspace, threadId, () => nativeContext, options)
        )
        if (!gate) {
          if (selected) throw Error("FLOW_CHECK_UNAVAILABLE")
          return {
            result: { passed: true, summary: "没有额外应用完成规则", source: "host" as const },
            records
          }
        }
        const result = parseCompletionGateDecision(
          await inScope(() =>
            gate({
              signal: checkSignal,
              revisionAttempts: 0,
              maxRevisionAttempts: 0
            })
          )
        )
        const answer: FlowStepResult = {
          passed: result.decision === "pass",
          summary:
            result.decision === "pass" ? `${selected?.name ?? "应用完成规则"}通过` : result.reason,
          source: "native-check",
          ...(selected ? { check: selected.check } : {}),
          evidenceIds: records.filter((r) => r.phase === "check.result").map((r) => r.id)
        }
        return { result: await publish(answer, checkSignal), records }
      }
      const check: typeof checkInternal = (context, selected, terminalStage) =>
        withFileCheckWorkspace(() => checkInternal(context, selected, terminalStage))
      const execute = async (step: FlowStep, context: FlowStepContext): Promise<FlowStepResult> => {
        await closedContext?.refresh()
        assertPrepared()
        if (harness.bound) await harness.refresh()
        assertPrepared()
        if (!step.enabled) throw Error("FLOW_DISABLED_STEP")
        if (step.kind === "plugin-action" || step.kind === "mcp-tool") {
          let input = step.input
          if (step.kind === "plugin-action" && step.evidenceInput) {
            if (step.inputFrom) throw Error("FLOW_EVIDENCE_INPUT_CONFLICT")
            input = {
              ...input,
              [step.evidenceInput.field]: flowEvidenceInput(context.run, step.id)
            }
          }
          if (step.inputFrom) {
            const prior = [...context.run.attempts]
              .reverse()
              .find((attempt) => attempt.stepId === step.inputFrom!.stepId && !attempt.invalidated)
            if (!prior || prior.status !== "passed" || !prior.result?.output)
              throw Error("CLAW_ACTION_OUTPUT_MISSING")
            input = resolveClawActionInput(input, prior.result.output, step.inputFrom.path)
          }
          const actionSignal = AbortSignal.any([lifetime, context.signal])
          if (step.kind === "mcp-tool") {
            const prepared = mcpTools.get(step.id)
            if (!prepared) throw Error("FLOW_MCP_NOT_PREPARED")
            if (invokedMcpSteps.has(step.id)) throw Error("FLOW_MCP_REPLAY_FORBIDDEN")
            invokedMcpSteps.add(step.id)
            return withProjectContent(async () => {
            const result = await inScope(() => prepared.invoke(input, actionSignal))
            return publish(
              {
                passed: result.isError !== true,
                summary:
                  typeof result.text === "string" && result.text
                    ? result.text.slice(0, 8000)
                    : `${step.provider.name} · ${step.toolName}${result.isError === true ? "失败" : "完成"}`,
                source: "mcp-tool",
                mcpTool: {
                  provider: step.provider,
                  toolName: step.toolName,
                  schemaDigest: step.schemaDigest
                },
                output: result
              },
              actionSignal
            )
            })
          }
          const prepared = actions.get(step.id)
          if (!prepared) throw Error("CLAW_ACTION_NOT_PREPARED")
          return withProjectContent(async () => {
          const result = await inScope(() =>
            this.functions.runAction(
              workspace,
              threadId,
              prepared,
              {
                version: 1,
                input,
                config: step.config ?? {},
                task: definition.goal,
                runId: run.id,
                stepId: step.id,
                executionId: context.executionId
              },
              actionSignal
            )
          )
          assertLive()
          return publishOriginalFlowActionResult(
            {
              passed: result.passed ?? true,
              summary: result.text,
              source: "plugin-action",
              provider: {
                pluginId: step.pluginId,
                plugin: step.plugin,
                digest: step.digest,
                actionId: step.actionId
              },
              ...(result.output === undefined ? {} : { output: result.output })
            },
            (original) => publish(original, actionSignal),
            readOriginalActionText(result)
          )
          })
        }
        if (step.kind === "check") return (await check(context, step)).result
        if (step.kind === "autobiz-stage")
          return {
            passed: true,
            summary: "阶段推进将在最终规则与人工确认通过后提交",
            source: "host"
          }
        if (step.kind !== "agent" && step.kind !== "skill") throw Error("FLOW_STEP_HOST_REQUIRED")
        const skillSource = skills.get(step.id)
        if (step.kind === "skill" && !skillSource) throw Error("FLOW_SKILL_NOT_PREPARED")
        skillSource?.assertCurrent()
        const modelId = models.get(step.id)
        if (!modelId || !getModelConfigByRef(modelId)?.apiKey) throw Error("FLOW_MODEL_UNAVAILABLE")
        const role = roles.get(step.id)
        const { closeCheckpointer } = await import("../../agent/runtime")
        assertLive()
        let promptCapture: FlowPromptRuntimeSettledCapture | undefined
        let fileCapture: FlowFileRuntimeSettledCapture | undefined
        const deps: WorkflowSubagentDeps = {
          parentThreadId: threadId,
          ...(flowTracer ? { traceContext: flowTracer.getTraceContext() } : {}),
          defaultModelId: modelId,
          isRetryableApiError: () => false,
          createRuntime: async (options) => {
            assertLive()
            const childId = options.threadId
            if (options.traceContext?.threadId === childId) executionTelemetry.set(context.executionId, {
              childThreadId: childId, traceId: options.traceContext.traceId,
              rootTraceId: options.traceContext.rootTraceId
            })
            const childRunId = `${run.id}:${context.executionId}`
            if (getThreadCore(childId)) throw Error("FLOW_CHILD_ID_EXISTS")
            if (
              !claimLocalThreadRunLease({ threadId: childId, owner: "mods", runId: childRunId })
                .acquired
            )
              throw Error("FLOW_CHILD_LEASE_CONFLICT")
            const childLeaseCurrent = captureLocalThreadRunLease(childId)!
            let incarnation: unknown
            try {
              const row = createThread(childId, {
                ...harness.childMetadata,
                workspacePath: workspace,
                parentThreadId: threadId,
                workflowRunId: run.id,
                isInternalFlowRuntime: true,
                agentMode: "normal",
                title: step.name,
                model: options.modelId
              })
              incarnation = JSON.parse(row.metadata ?? "{}").cmb_thread_incarnation
            } catch (error) {
              releaseLocalThreadRunLease(childId, "mods", childRunId)
              throw error
            }
            let disposePromptRuntime = () => {}
            const assertChildIdentity = () => {
              if (!childLeaseCurrent()) throw Error("FLOW_CHILD_LEASE_CHANGED")
              const current = getThreadCore(childId)
              if (!current) throw Error("FLOW_CHILD_ID_CHANGED")
              const metadata = JSON.parse(current.metadata ?? "{}")
              if (
                metadata.cmb_thread_incarnation !== incarnation ||
                metadata.workflowRunId !== run.id ||
                metadata.parentThreadId !== threadId ||
                metadata.isInternalFlowRuntime !== true
              )
                throw Error("FLOW_CHILD_ID_CHANGED")
            }
            let releaseSourceChild = () => {}
            const childWorkflows = {
              current: undefined as Awaited<ReturnType<typeof captureNativeChildWorkflows>> | undefined
            }
            children.set(childId, async () => {
              // Every operation below accepts only a string id. Fence it before first use,
              // after each await, and immediately before deleting durable state.
              assertChildIdentity()
              try {
                await childWorkflows.current?.settle(true)
              } catch (error) {
                pendingWorkflowChildren.add(childId)
                throw error
              }
              pendingWorkflowChildren.delete(childId)
              assertChildIdentity()
              disposePromptRuntime()
              const errors: unknown[] = []
              const ownedCleanup = (cleanup: () => void | Promise<void>) =>
                attemptCleanup(errors, () => {
                  assertChildIdentity()
                  return cleanup()
                })
              await ownedCleanup(() => this.manager.closeFunctionThread(childId))
              await ownedCleanup(() => clearActionStationarityTurn(childId, childId))
              await ownedCleanup(() => LocalSandbox.cancelBackgroundTasksAndWait(childId))
              await ownedCleanup(() => LocalSandbox.revokeGrantedAclsForRun(childId))
              await ownedCleanup(() => closeCheckpointer(childId))
              // Preserve durable identity after incomplete cleanup so disposal can retry,
              // and the next process can show the interrupted run without recreating effects.
              throwCleanupErrors(errors)
              assertChildIdentity()
              deleteThreadCheckpoint(childId)
              assertChildIdentity()
              deleteThread(childId)
              releaseSourceChild()
              releaseLocalThreadRunLease(childId, "mods", childRunId)
              children.delete(childId)
            })
            releaseSourceChild = registerRuntimePluginSourceChild(threadId, childId, () => {
              assertLive()
              assertChildIdentity()
            })
            childWorkflows.current = await captureNativeChildWorkflows(
              workspace, childId, assertChildIdentity, options.abortSignal
            )
            if (fileContext) {
              if (!options.flowPromptOnly || typeof incarnation !== "string") throw Error("FLOW_FILE_INVOCATION_REQUIRED")
              const { readFlowFileRuntimeProof } = await import("../../agent/flow-file-runtime")
              const { sealNativeFlowFileCapture } = await import("./native-file-capture")
              const assertChildCurrent = () => { assertPrepared(); assertChildIdentity() }
              const root = fileStore!.currentRoot(fileNamespace!.treeId, assertChildCurrent)
              const factory = prepareStandardThreadRuntimeFactory({
                source: "desktop", runLease: { owner: "mods", runId: childRunId },
                baseOptions: {
                  threadId: childId, agentId: options.agentId, workspacePath: workspace,
                  abortSignal: AbortSignal.any([lifetime, options.abortSignal]), additionalTools: options.additionalTools,
                  flowFiles: { ...options.flowPromptOnly, profile: "workspace-files-v1",
                    store: fileStore!, treeId: fileNamespace!.treeId, root,
                    binding: { executionId: context.executionId, parentIncarnation: fileContext.parentThreadIncarnation },
                    assertCurrent: assertChildCurrent }
                }
              })
              const runtime = await factory.create(options.modelId)
              assertChildCurrent()
              const proof = readFlowFileRuntimeProof(runtime, options.flowPromptOnly.invocation)
              if (!proof) throw Error("FLOW_FILE_RUNTIME_PROOF_REQUIRED")
              disposePromptRuntime = () => proof.dispose()
              return { stream: runtime.stream.bind(runtime), completeTurn: async (result: import("../../agent/workflow/types").WorkflowSubagentResult) => {
                await childWorkflows.current!.settle()
                const attempt = context.run.attempts.find((item) => item.executionId === context.executionId)
                if (!attempt) throw Error("FLOW_FILE_EXECUTION_REQUIRED")
                fileCapture = await sealNativeFlowFileCapture({
                  runtime, invocation: options.flowPromptOnly!.invocation, store: fileStore!,
                  dependencies: fileContext.dependenciesFor(context.run, attempt),
                  structured: result.structured as { passed: boolean; summary: string },
                  binding: { workspace, parentThreadId: threadId, parentThreadIncarnation: fileContext.parentThreadIncarnation,
                    runId: run.id, executionId: context.executionId, childThreadId: childId,
                    childThreadIncarnation: incarnation as string, leaseGeneration: childRunId },
                  assertCurrent: assertChildCurrent
                })
              } } as Awaited<ReturnType<WorkflowSubagentDeps["createRuntime"]>>
            }
            if (promptContext) {
              const { readFlowPromptRuntimeProof } = await import("../../agent/flow-prompt-runtime")
              if (!options.flowPromptOnly || typeof incarnation !== "string")
                throw Error("FLOW_PROMPT_INVOCATION_REQUIRED")
              const assertChildCurrent = () => {
                assertPrepared()
                assertChildIdentity()
              }
              const factory = prepareStandardThreadRuntimeFactory({
                source: "desktop",
                runLease: { owner: "mods", runId: childRunId },
                baseOptions: {
                  threadId: childId,
                  agentId: options.agentId,
                  workspacePath: workspace,
                  abortSignal: AbortSignal.any([lifetime, options.abortSignal]),
                  additionalTools: options.additionalTools,
                  flowPromptOnly: { ...options.flowPromptOnly, assertCurrent: assertChildCurrent }
                }
              })
              const runtime = await factory.create(options.modelId)
              assertChildCurrent()
              const proof = readFlowPromptRuntimeProof(runtime, options.flowPromptOnly.invocation)
              if (!proof) throw Error("FLOW_PROMPT_RUNTIME_PROOF_REQUIRED")
              disposePromptRuntime = () => proof.dispose()
              return {
                stream: runtime.stream.bind(runtime),
                completeTurn: async (
                  result: import("../../agent/workflow/types").WorkflowSubagentResult
                ) => {
                  await childWorkflows.current!.settle()
                  const facts = await proof.seal()
                  assertChildCurrent()
                  const structured = result.structured as
                    | { passed: boolean; summary: string }
                    | undefined
                  if (
                    !structured ||
                    facts.structuredOutputDigest !== flowPromptStructuredOutputDigest(structured)
                  )
                    throw Error("FLOW_PROMPT_STRUCTURED_OUTPUT_CHANGED")
                  const attempt = context.run.attempts.find(
                    (item) => item.executionId === context.executionId
                  )
                  if (!attempt) throw Error("FLOW_PROMPT_EXECUTION_REQUIRED")
                  const dependencies = promptContext.dependenciesFor(context.run, attempt)
                  const expectedFacts = {
                    runtimeProtocol: dependencies.runtimeProtocol,
                    modelRef: dependencies.modelRef,
                    modelConfigurationDigest: dependencies.modelConfigurationDigest,
                    mandatoryPolicyDigest: dependencies.mandatoryPolicyDigest,
                    systemPromptDigest: dependencies.systemPromptDigest,
                    rolePromptDigest: dependencies.rolePromptDigest,
                    resultTool: dependencies.resultTool,
                    businessInputDigest: dependencies.stableInput.digest
                  }
                  if (
                    Object.entries(expectedFacts).some(
                      ([key, value]) =>
                        hash(value) !== hash(facts[key as keyof FlowPromptRuntimeFacts])
                    )
                  )
                    throw Error("FLOW_PROMPT_RUNTIME_DEPENDENCIES_CHANGED")
                  promptCapture = {
                    schemaVersion: 1,
                    binding: {
                      workspace,
                      parentThreadId: threadId,
                      parentThreadIncarnation: promptContext.parentThreadIncarnation,
                      runId: run.id,
                      executionId: context.executionId,
                      childThreadId: childId,
                      childThreadIncarnation: incarnation as string,
                      leaseGeneration: childRunId
                    },
                    dependencies,
                    actualCapabilitiesDigest: facts.actualCapabilitiesDigest,
                    modelRequestLedgerDigest: facts.modelRequestLedgerDigest,
                    invocationLedgerDigest: facts.invocationLedgerDigest,
                    structuredOutputDigest: facts.structuredOutputDigest,
                    modelCalls: facts.modelCalls,
                    providerUsageEvidenceIds: facts.providerUsageEvidenceIds
                  }
                }
              } as Awaited<ReturnType<WorkflowSubagentDeps["createRuntime"]>>
            }
            const restricted = options.shellAccess === "read_only" || options.shellAccess === "none"
            const { createFlowSkillTurn } = await import("./skill-turn")
            const skillTurn = createFlowSkillTurn({
              source: skillSource,
              harnessContext: constrainFlowHarnessContext(harness.context, restricted),
              threadId: childId,
              agentId: options.agentId,
              workspacePath: workspace,
              signal: AbortSignal.any([lifetime, options.abortSignal]),
              assertLive
            })
            skillTurn.turnState.hookScope.activatePlugin(harness.context.pluginId)
            let runHostLifecycle:
              | import("../../agent/runtime-host-lifecycle").HostRuntimeLifecycle
              | undefined
            const factory = prepareStandardThreadRuntimeFactory({
              source: "desktop",
              runLease: { owner: "mods", runId: childRunId },
              harnessContext: constrainFlowHarnessContext(harness.context, restricted),
              baseOptions: {
                threadId: options.threadId,
                agentId: options.agentId,
                actionStationarityTurnId: options.threadId,
                hookTurnId: options.threadId,
                approvalThreadId: threadId,
                workspacePath: workspace,
                extraSystemPrompt: options.extraSystemPrompt,
                hookScope: skillTurn.turnState.hookScope,
                skillHookKeys: skillTurn.turnState.skillHookKeys,
                skillUseTracker: skillTurn.turnState.skillUseTracker,
                onModelBoundary: skillTurn.assertCurrent,
                onHostLifecycleReady: (run) => {
                  runHostLifecycle = run
                },
                abortSignal: options.abortSignal,
                additionalTools: options.additionalTools,
                noSchedulerTool: true,
                noSkillEvolutionTool: true,
                enableAgentsPrompt: !restricted,
                disableMemoryInjection: restricted,
                agentMode: "normal",
                disableSubagents: true,
                managedExecution: true,
                autoApproveFileEdits: false,
                toolConcurrencyQueueId: threadId,
                onToolRejected: () => controller.abort(Error("FLOW_TOOL_REJECTED")),
                filesystemAccess: {
                  disallowedTools: options.disallowedTools ?? [],
                  shellAccess: options.shellAccess ?? "full",
                  workspacePath: workspace
                }
              }
            })
            const runtime = await factory.create(options.modelId)
            assertLive()
            if (!runHostLifecycle) throw Error("FLOW_CHILD_RUNTIME_CONTEXT_REQUIRED")
            return {
              stream: runtime.stream.bind(runtime),
              preparePrompt: (prompt: string) =>
                runHostLifecycle!(() => skillTurn.preparePrompt(prompt)),
              completeTurn: (result: import("../../agent/workflow/types").WorkflowSubagentResult) =>
                runHostLifecycle!(async () => {
                  await childWorkflows.current!.settle()
                  await skillTurn.completeTurn(result)
                  mergeHookScopeSnapshot(parentHookScope, skillTurn.turnState.hookScope.snapshot())
                })
            } as unknown as Awaited<ReturnType<WorkflowSubagentDeps["createRuntime"]>>
          },
          cleanupThread: async (childId) => {
            await children.get(childId)?.()
          }
        }
        const prior = closedContext
          ? (fileContext ? projectFileOnlyPrior : projectPromptOnlyPrior)(
              context.run.flow.definition,
              step.id,
              context.run.attempts.filter((attempt) =>
                context.run.flow.definition.steps
                  .slice(
                    0,
                    context.run.flow.definition.steps.findIndex((item) => item.id === step.id)
                  )
                  .some(
                    (item) => item.enabled && item.kind === "agent" && item.id === attempt.stepId
                  )
              )
            ).text
          : context.run.attempts
              .filter((attempt) => !attempt.invalidated && attempt.result)
              .slice(-12)
              .map((attempt) => `${attempt.stepId}: ${attempt.result!.summary.slice(0, 2000)}`)
              .join("\n")
        const outcome = await runWorkflowSubagent(deps, {
          prompt: `${definition.goal}\n\n本步骤：${step.prompt}\n\n此前步骤结果（仅作上下文）：\n${prior}`,
          schema: closedContext
            ? flowPromptResultSchema()
            : {
                type: "object",
                additionalProperties: false,
                required: ["passed", "summary"],
                properties: {
                  passed: { type: "boolean" },
                  summary: { type: "string", minLength: 1, maxLength: 8000 }
                }
              },
          model: modelId,
          agentIndex: 0,
          label: step.name,
          runId: `${run.id}_${context.executionId}`,
          signal: AbortSignal.any([lifetime, context.signal]),
          roleSystemPrompt: role?.systemPrompt,
          disallowedTools: role?.disallowedTools,
          shellAccess: role?.shellAccess,
          singleAttempt: true,
          strictModel: true,
          onValues: (snapshot) => {
            const progress = publicFlowProgress(snapshot)
            if (progress) context.onProgress?.(progress)
          },
          ...(closedContext
            ? {
                flowPromptOnly: {
                  profile: "prompt-only-v1" as const,
                  expectedModelDigest: modelPins.get(modelId)!,
                  mandatoryPolicyDigest: closedContext.policyDigest,
                  deadline:
                    (run as RecoveryHistoryRun).recovery?.rootDeadline ??
                    run.startedAt + run.flow.definition.timeoutMs
                }
              }
            : {})
        })
        assertLive()
        skillSource?.assertCurrent()
        const value = outcome.structured as { passed?: unknown; summary?: unknown } | undefined
        if (!value || typeof value.passed !== "boolean" || typeof value.summary !== "string")
          throw Error("FLOW_AGENT_RESULT_INVALID")
        if (promptContext) {
          if (!promptCapture || children.size) throw Error("FLOW_PROMPT_CLEANUP_UNSETTLED")
          promptCaptures.set(context.executionId, structuredClone(promptCapture))
        }
        if (fileContext) {
          if (!fileCapture || children.size) throw Error("FLOW_FILE_CLEANUP_UNSETTLED")
          fileCaptures.set(context.executionId, structuredClone(fileCapture))
        }
        return publish(
          {
            passed: value.passed,
            summary: value.summary,
            source: step.kind,
            ...(step.kind === "skill" ? { skill: step.skill } : {}),
            modelId,
            outputTokens: outcome.outputTokens
          },
          lifetime
        )
      }
      const finalize = async (
        context: FlowStepContext,
        confirm: () => Promise<void>,
        recordCheck: (label: string, result: FlowStepResult, fingerprint: string) => void
      ): Promise<FlowStepResult> => {
        assertLive()
        if (harness.bound) await harness.refresh()
        if (stopCompleted && !stopPassed) throw Error("FLOW_STOP_COMPLETION_BLOCKED")
        if (!stopCompleted) {
          // Legacy Stop belongs to the parent task, not each model/Skill step. Native
          // completion checks and checkpoint commits remain below and execute once.
          stopCompleted = true
          const outcome = await withFileCheckWorkspace((checkDirectory) => inScope(() =>
            runCompletionHooksWithRevision({
              threadId,
              workspacePath: checkDirectory,
              turnId: run.id,
              runId: run.id,
              pluginOutputDir: harness.context.pluginOutputDir,
              systemId: harness.context.systemId,
              ...getHarnessHookContext(harness.context),
              abortSignal: lifetime,
              hookScope: parentHookScope,
              ...(fileContext ? {
                runStopHooks: async () => {
                  assertLive()
                  // Resolve mandatory policy from the original project, but run workspace
                  // commands against this fresh private materialization, as linked checkouts do.
                  const stopContext = {
                    signal: lifetime,
                    workspacePath: workspace,
                    workspaceHookCwd: checkDirectory,
                    pluginOutputDir: harness.context.pluginOutputDir,
                    systemId: harness.context.systemId,
                    ...getHarnessHookContext(harness.context),
                    sessionId: threadId,
                    turnId: run.id,
                    stopHookActive: false,
                    stopContext: {
                      userMessage: definition.goal,
                      assistantResponse: context.run.attempts
                        .filter((attempt) => !attempt.invalidated)
                        .map((attempt) => attempt.result?.summary ?? "").join("\n")
                    }
                  }
                  const result = await runHooksEnriched(
                    resolveEnabledHooksForRun(workspace, "Stop", stopContext, parentHookScope),
                    "Stop", stopContext
                  )
                  assertLive()
                  return result
                }
              } : {}),
              getStopContext: () => ({
                userMessage: definition.goal,
                assistantResponse: context.run.attempts
                  .filter((attempt) => !attempt.invalidated)
                  .map((attempt) => attempt.result?.summary ?? "")
                  .join("\n")
              }),
              runPostSkillUseHooks: async () => null,
              enableModsCompletionGate: false,
              maxRevisionAttempts: 0,
              revisionPromptPrefix: "",
              runRevision: async () => {
                throw Error("FLOW_IMPLICIT_REVISION_FORBIDDEN")
              },
              sendNotice: () => {},
              sendError: () => {}
            })
          ))
          if (outcome !== "passed") throw Error("FLOW_STOP_COMPLETION_BLOCKED")
          stopPassed = true
        }
        const selected = definition.steps.filter(
          (step): step is Extract<FlowStep, { kind: "check" }> =>
            step.kind === "check" &&
            step.enabled &&
            context.run.attempts.some(
              (attempt) =>
                attempt.stepId === step.id && ["passed", "failed"].includes(attempt.status)
            )
        )
        // Human decisions are bound to outcomes. A changed artifact needs fresh checks,
        // new recorded results and another confirmation, never merely a new fingerprint.
        for (let finalRound = 0; finalRound < 3; finalRound++) {
          const evidenceIds: string[] = []
          const base = await fingerprint(context.signal)
          for (const step of selected) {
            const checked = await check(context, step)
            recordCheck(step.name, checked.result, base)
            evidenceIds.push(...(checked.result.evidenceIds ?? []))
            if (!checked.result.passed) return checked.result
          }
          const mandatory = await check(context)
          if (mandatory.records.length) recordCheck("应用完成规则", mandatory.result, base)
          evidenceIds.push(...(mandatory.result.evidenceIds ?? []))
          if (!mandatory.result.passed) return mandatory.result
          let stageProof: BoundCompletionEvidenceRecord | undefined
          if (stage) {
            const checked = await check(
              context,
              {
                id: "$stage",
                name: "最终阶段验收",
                kind: "check",
                check: "autobiz-validator",
                enabled: true
              },
              stage
            )
            recordCheck("最终阶段验收", checked.result, base)
            evidenceIds.push(...(checked.result.evidenceIds ?? []))
            if (!checked.result.passed) return checked.result
            stageProof = checked.records.find(
              (record) =>
                record.phase === "validator.result" &&
                record.status === "pass" &&
                (record.detail as ModObject | undefined)?.feature === stage.feature
            )
            if (!stageProof) throw Error("MODS_AUTOBIZ_STAGE_EVIDENCE_REQUIRED")
          }
          if ((await fingerprint(context.signal)) !== base) throw Error("FLOW_FINAL_EVIDENCE_STALE")
          await confirm()
          assertLive()
          if ((await fingerprint(context.signal)) !== base) continue
          if (stage && stageProof) {
            const detail = stageProof.detail as ModObject
            const receipt = detail.stage as ModObject | undefined
            if (!receipt || receipt.start !== stage.start || typeof receipt.end !== "string")
              throw Error("MODS_AUTOBIZ_STAGE_EVIDENCE_REQUIRED")
            if (receipt.alreadyAtTarget !== true) {
              const transition = await inScope(() =>
                this.functions.advanceAutobizCheckpoint(
                  workspace,
                  threadId,
                  {
                    evidenceId: detail.attempt!,
                    feature: stage.feature,
                    from: stage.start,
                    to: receipt.end!,
                    stateFingerprint: stageProof!.binding.stateFingerprint,
                    idempotencyKey: hash([run.id, run.flow.digest, stageProof!.binding, stage])
                  },
                  lifetime
                )
              )
              if (!transition.applied && !transition.duplicate)
                throw Error("FLOW_STAGE_NOT_COMMITTED")
            }
          }
          return publish(
            {
              passed: true,
              source: "host",
              evidenceIds,
              summary: stage
                ? "所选检查、应用规则和成果确认通过，阶段已提交"
                : fileContext ? "虚拟文件流程已完成；成果尚未发布到项目，需另行审阅并确认发布" : "流程已完成；检查结果以各步骤的实际执行记录为准"
            },
            lifetime
          )
        }
        throw Error("FLOW_FINAL_EVIDENCE_STALE")
      }
      const assertFileReceipt = (source: FlowRun, attempt: FlowAttempt, history?: readonly FlowRun[]) => {
        if (!fileContext) throw Error("FLOW_FILE_PROFILE_REQUIRED")
        assertPrepared()
        verifyCurrentFlowFileReceipt({
          run: source, attempt, history: history ?? new FlowStore(this.manager.store).runs(workspace, threadId),
          parentThreadIncarnation: fileContext.parentThreadIncarnation, currentDependencies: fileContext.dependenciesFor,
          verifyVirtualTree: (_original, receipt, evidence) => {
            const actual = fileStore!.verifyReceipt({ treeId: evidence.virtualTree.treeId,
              inputRoot: evidence.virtualTree.inputRoot, finalRoot: evidence.virtualTree.finalRoot,
              originDigest: evidence.virtualTree.originDigest, effectIds: evidence.virtualTree.effectIds,
              binding: { executionId: receipt.executionId, parentIncarnation: evidence.binding.parentThreadIncarnation },
              assertCurrent: assertPrepared })
            if (actual.effectLedgerDigest !== evidence.virtualTree.effectLedgerDigest) throw Error("FLOW_FILE_EFFECT_CHANGED")
          }, assertCurrent: assertPrepared
        })
      }
      const assertPromptReceipt = (
        source: FlowRun,
        attempt: FlowAttempt,
        history?: readonly FlowRun[]
      ) => {
        if (!promptContext) throw Error("FLOW_PROMPT_PROFILE_REQUIRED")
        assertPrepared()
        verifyCurrentFlowPromptReceipt({
          run: source,
          attempt,
          history: history ?? new FlowStore(this.manager.store).runs(workspace, threadId),
          parentThreadIncarnation: promptContext.parentThreadIncarnation,
          currentDependencies: promptContext.dependenciesFor,
          assertCurrent: assertPrepared
        })
      }
      preparedReturned = true
      return {
        finishTelemetry,
        ...(fileContext ? { fileRecovery: {
          parentThreadIncarnation: fileContext.parentThreadIncarnation,
          namespace: () => { assertPrepared(); return structuredClone(fileNamespace!) },
          async validateSource(source: FlowRun, history: readonly FlowRun[], sourceSignal: AbortSignal) {
            sourceSignal.throwIfAborted()
            await fileContext.refresh()
            assertPrepared()
            const prefix = source.attempts.filter((attempt) => source.flow.definition.steps.find((step) => step.id === attempt.stepId)?.kind === "agent" && attempt.status === "passed")
            for (const attempt of prefix) assertFileReceipt(source, attempt, history)
            const root = prefix.at(-1)?.fileRecoveryEvidence?.virtualTree.finalRoot
            if (!root || !source.fileNamespace) throw Error("FLOW_FILE_NAMESPACE_REQUIRED")
            sourceSignal.throwIfAborted()
            const forked = fileStore!.fork({ treeId: source.fileNamespace.treeId,
              expectedHead: fileStore!.currentRoot(source.fileNamespace.treeId, assertPrepared), root, assertCurrent: assertPrepared })
            fileNamespace = { schemaVersion: 1, treeId: forked.treeId, initialRoot: forked.root, originDigest: source.fileNamespace.originDigest }
            run.fileNamespace = structuredClone(fileNamespace)
          },
          assertReceiptCurrent: assertFileReceipt,
          settledCapture: (executionId: string) => { assertPrepared(); const capture = fileCaptures.get(executionId); return capture ? structuredClone(capture) : undefined }
        } } : {}),
        ...(promptContext
          ? {
              promptRecovery: {
                parentThreadIncarnation: promptContext.parentThreadIncarnation,
                async validateSource(
                  source: FlowRun,
                  history: readonly FlowRun[],
                  sourceSignal: AbortSignal
                ) {
                  sourceSignal.throwIfAborted()
                  await promptContext.refresh()
                  assertPrepared()
                  for (const attempt of source.attempts) {
                    if (
                      source.flow.definition.steps.find((step) => step.id === attempt.stepId)
                        ?.kind === "agent" &&
                      attempt.status === "passed"
                    )
                      assertPromptReceipt(source, attempt, history)
                  }
                  sourceSignal.throwIfAborted()
                },
                assertReceiptCurrent: assertPromptReceipt,
                settledCapture: (executionId: string) => {
                  assertPrepared()
                  const captured = promptCaptures.get(executionId)
                  return captured ? structuredClone(captured) : undefined
                }
              }
            }
          : {}),
        signal: lifetime,
        assertLive: () => {
          assertLive()
          // The watchdog runs every 250 ms. Hash Skill documents at operation/model boundaries,
          // not on its idle timer; MCP connection/config checks are metadata-only.
          for (const tool of mcpTools.values()) tool.assertCurrent()
        },
        fingerprint,
        executionTelemetry: (executionId) => {
          const observed = executionTelemetry.get(executionId)
          return observed ? { ...observed } : undefined
        },
        execute,
        finalize,
        dispose,
        plan: {
          ...(scope.components && Object.keys(scope.components).length
            ? { components: structuredClone(scope.components) }
            : {}),
          ...(implicitDefaultRef === undefined ? {} : { defaultModelRef: implicitDefaultRef }),
          ...(clawModels ? { modelPolicy: Object.fromEntries(modelPins) } : {}),
          models: Object.fromEntries(
            [...models].map(([id, ref]) => [id, { ref, fingerprint: modelPins.get(ref)! }])
          ),
          actions: [...actions.values()].map(({ action }) => ({
            pluginId: action.pluginId,
            plugin: action.plugin,
            digest: action.digest,
            actionId: action.actionId
          })),
          ...(skills.size
            ? {
                skills: Object.fromEntries(
                  [...skills].map(([id, source]) => [id, source.reference])
                )
              }
            : {}),
          ...(mcpTools.size
            ? {
                mcpTools: Object.fromEntries(
                  [...mcpTools].map(([id, prepared]) => [id, prepared.plan])
                )
              }
            : {})
        }
      }
    } catch (error) {
      await dispose()
      throw error
    }
  }
}
