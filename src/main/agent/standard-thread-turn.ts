import { resolve } from "node:path"
import type {
  HarnessAgentmdLoadStatusItem,
  HarnessDeployUnitMapping,
  HarnessProjectModeSubagentConfig
} from "../../shared/harness-board-types"
import {
  buildHarnessFeatureAgentContext,
  readHarnessFeatureMetadata,
  resolveHarnessFeatureCurrentStage
} from "../harness-board/service"
import {
  getDisabledSkillDirs,
  getEnabledPluginSkillSourceMetadata,
  getEnabledSkillsSources,
  getGlobalRoutingMode
} from "../storage"
import { runHooksEnriched } from "../hooks/required-skill"
import type { HookContext, HookResultCallback } from "../hooks/runner"
import {
  normalizePathKey,
  resolveEnabledHooksForRun,
  type HookScopeController,
  type ScopeSkipCallback
} from "../hooks/scope"
import type { HookConfig, HookEvent, HookResult } from "../hooks/types"
import {
  applyPromptRewritePreservingGoalMarker,
  buildInternalGoalPromptFromHookResult
} from "./goals/internal-prompt"
import { buildOrderedChain } from "./failover"
import { activateSkillLifecycle, formatSkillHookContext } from "./skill-lifecycle/activation"
import { parseSkillUseBlock, type ParsedSkillUseBlock } from "./skill-lifecycle/marker"
import { SkillLifecycleRegistry, type SkillLifecycleMatch } from "./skill-lifecycle/registry"
import type { SkillUseTracker } from "./skill-lifecycle/tracker"
import { resolveModel, type RoutingContext, type RoutingResult } from "../routing"
import { getAgentModeFromMetadata, type AgentMode } from "./coordinator-mode"
import { TraceCollector, type TraceCollectorOptions } from "./trace/collector"
import { createAgentRuntime, type CreateAgentRuntimeOptions, type DeepAgent } from "./runtime"
import { assertLocalThreadRunLease, type LocalThreadRunOwner } from "./thread-run-lease"
import { primeHarnessStageAttribution } from "../services/harness-stage-attribution"

export type StandardTurnSource = "desktop" | "im" | "scheduler" | "heartbeat"

export interface StandardThreadMetadata {
  metadata: Record<string, unknown>
  workspacePath?: string
  modelId?: string
  agentMode: AgentMode
}

export function parseStandardThreadMetadata(
  value: string | Record<string, unknown> | null | undefined,
  options: { onParseError?: (error: unknown) => void } = {}
): StandardThreadMetadata {
  let metadata: Record<string, unknown> = {}
  try {
    const parsed = typeof value === "string" ? (value.trim() ? JSON.parse(value) : {}) : value
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      metadata = parsed as Record<string, unknown>
    }
  } catch (error) {
    options.onParseError?.(error)
  }

  return {
    metadata,
    workspacePath: typeof metadata.workspacePath === "string" ? metadata.workspacePath : undefined,
    modelId: typeof metadata.model === "string" ? metadata.model : undefined,
    agentMode: getAgentModeFromMetadata(metadata)
  }
}

export interface HarnessAgentContext {
  pluginPromptInject?: string
  enableAgentsPrompt?: boolean
  subagentConfig?: HarnessProjectModeSubagentConfig
  isHarnessProjectSession?: boolean
  harnessAgentsPrompt?: string
  additionalAgentsWorkspacePaths?: string[]
  additionalAgentsWorkspaceMappings?: HarnessDeployUnitMapping[]
  sessionContextInjectWarning?: string
  agentmdLoadStatus?: HarnessAgentmdLoadStatusItem[]
  pluginOutputDir?: string
  systemId?: string
  pluginRoot?: string
  pluginId?: string
  pluginName?: string
  pluginWorkspace?: string
  featureId?: string
  harnessProjectId?: string
  harnessAdapterName?: string
  harnessAdapterVersion?: string
  harnessNodeName?: string
  harnessNodeStatus?: string
  projectCode?: string
  projectDir?: string
}

export interface HarnessFeatureBindingContext {
  projectId: string
  slug: string
  nodeName?: string
  nodeStatus?: string
}

export function getHarnessHookContext(
  context: HarnessAgentContext
): Pick<
  HookContext,
  | "pluginWorkspace"
  | "featureId"
  | "harnessProjectId"
  | "harnessAdapterName"
  | "harnessAdapterVersion"
  | "harnessNodeName"
  | "harnessNodeStatus"
  | "projectCode"
  | "projectDir"
> {
  return {
    pluginWorkspace: context.pluginWorkspace,
    featureId: context.featureId,
    harnessProjectId: context.harnessProjectId,
    harnessAdapterName: context.harnessAdapterName,
    harnessAdapterVersion: context.harnessAdapterVersion,
    harnessNodeName: context.harnessNodeName,
    harnessNodeStatus: context.harnessNodeStatus,
    projectCode: context.projectCode,
    projectDir: context.projectDir
  }
}

async function resolveHarnessCurrentStageForContext(
  projectId?: string,
  slug?: string
): Promise<Pick<HarnessAgentContext, "harnessNodeName" | "harnessNodeStatus">> {
  if (!projectId || !slug) return {}
  const currentStage = await resolveHarnessFeatureCurrentStage(projectId, slug)
  primeHarnessStageAttribution(projectId, slug, currentStage)
  if (!currentStage?.name) return {}
  return {
    harnessNodeName: currentStage.name,
    ...(currentStage.status ? { harnessNodeStatus: currentStage.status } : {})
  }
}

export async function resolveHarnessFeatureBindingContext(
  metadata: unknown
): Promise<HarnessFeatureBindingContext | undefined> {
  try {
    const binding = readHarnessFeatureMetadata(metadata)
    if (!binding) return undefined
    const currentStage = await resolveHarnessFeatureCurrentStage(binding.projectId, binding.slug)
    primeHarnessStageAttribution(binding.projectId, binding.slug, currentStage)
    return {
      ...binding,
      ...(currentStage?.name ? { nodeName: currentStage.name } : {}),
      ...(currentStage?.status ? { nodeStatus: currentStage.status } : {})
    }
  } catch {
    return undefined
  }
}

export async function getHarnessAgentContext(
  metadata: Record<string, unknown>,
  options: { workspacePath?: string; featureBinding?: HarnessFeatureBindingContext } = {}
): Promise<HarnessAgentContext> {
  const harnessProjectSession =
    metadata.harnessProjectSession &&
    typeof metadata.harnessProjectSession === "object" &&
    !Array.isArray(metadata.harnessProjectSession)
      ? (metadata.harnessProjectSession as Record<string, unknown>)
      : undefined
  const isHarnessProjectSession = Boolean(harnessProjectSession)
  const harnessFeature = readHarnessFeatureMetadata(metadata)
  const disableAgentsPrompt = metadata.disableAgentsPrompt === true
  try {
    const featureContext = await buildHarnessFeatureAgentContext(metadata, {
      workspacePath: options.workspacePath
    })
    if (!featureContext) {
      return {
        ...(disableAgentsPrompt ? { enableAgentsPrompt: false } : {}),
        ...(isHarnessProjectSession ? { isHarnessProjectSession: true } : {})
      }
    }
    const currentStage =
      options.featureBinding !== undefined
        ? {
            harnessNodeName: options.featureBinding.nodeName,
            harnessNodeStatus: options.featureBinding.nodeStatus
          }
        : await resolveHarnessCurrentStageForContext(
            featureContext.harnessProjectId,
            featureContext.featureId
          )

    return {
      pluginPromptInject: featureContext.systemPromptInject,
      enableAgentsPrompt: featureContext.enableAgentsPrompt,
      subagentConfig: featureContext.agentConfig?.subagentConfig,
      ...(isHarnessProjectSession ? { isHarnessProjectSession: true } : {}),
      harnessAgentsPrompt: featureContext.harnessAgentsPrompt,
      additionalAgentsWorkspacePaths: featureContext.additionalAgentsWorkspacePaths,
      additionalAgentsWorkspaceMappings: featureContext.additionalAgentsWorkspaceMappings,
      sessionContextInjectWarning: featureContext.sessionContextInjectWarning,
      agentmdLoadStatus: featureContext.agentmdLoadStatus,
      pluginOutputDir: featureContext.pluginOutputDir,
      systemId: featureContext.systemId,
      pluginRoot: featureContext.pluginRoot,
      pluginId: featureContext.pluginId,
      pluginName: featureContext.pluginName,
      pluginWorkspace: featureContext.pluginWorkspace,
      featureId: featureContext.featureId,
      harnessProjectId: featureContext.harnessProjectId,
      harnessAdapterName: featureContext.harnessAdapterName,
      harnessAdapterVersion: featureContext.harnessAdapterVersion,
      ...currentStage,
      projectCode: featureContext.projectCode,
      projectDir: featureContext.projectDir
    }
  } catch (error) {
    console.warn("[HarnessBoard] Failed to build harness agent context:", error)
    return {
      ...(disableAgentsPrompt ? { enableAgentsPrompt: false } : {}),
      ...(harnessFeature
        ? { featureId: harnessFeature.slug, harnessProjectId: harnessFeature.projectId }
        : {}),
      ...(isHarnessProjectSession ? { isHarnessProjectSession: true } : {})
    }
  }
}

export interface PromptPreparationTurnState {
  hookScope: HookScopeController
  skillUseTracker: SkillUseTracker
  skillHookKeys: Set<string>
  turnId?: string
}

interface ExplicitSkillActivation {
  parsed: ParsedSkillUseBlock
  skill?: SkillLifecycleMatch
  hookContext?: string
  blocked: boolean
  reason?: string
}

export type PreparedUserPrompt =
  | {
      accepted: true
      content: string
      explicitSkillHookContext?: string
    }
  | {
      accepted: false
      blockedBy: "explicit_skill"
      reason: string
    }
  | {
      accepted: false
      blockedBy: "user_prompt_submit"
      reason: string
      hookResult: HookResult
    }
  | {
      accepted: false
      blockedBy: "run_not_ready"
      reason: string
    }

function normalizeSkillPathKey(input: string): string {
  return normalizePathKey(resolve(input))
}

function isSameOrChildSkillPath(targetPath: string, parentPath: string): boolean {
  const target = normalizeSkillPathKey(targetPath)
  const parent = normalizeSkillPathKey(parentPath)
  return target === parent || target.startsWith(`${parent}/`)
}

function isDisabledSkillMatch(skill: SkillLifecycleMatch): boolean {
  return getDisabledSkillDirs().some((dir) => isSameOrChildSkillPath(skill.rootDir, dir))
}

async function buildSkillLifecycleRegistryForHooks(): Promise<SkillLifecycleRegistry | null> {
  const rootSources = await getEnabledSkillsSources()
  const pluginSources = getEnabledPluginSkillSourceMetadata()
  const sources = [...rootSources, ...pluginSources]
  return sources.length > 0 ? new SkillLifecycleRegistry(sources) : null
}

export async function validateExplicitSkillReference(input: {
  name: string
  path: string
}): Promise<string | null> {
  const registry = await buildSkillLifecycleRegistryForHooks()
  const skill = registry?.resolveExplicit({ skillName: input.name, skillPath: input.path })
  return !skill || isDisabledSkillMatch(skill)
    ? `显式选择的技能不存在或已禁用：${input.name}`
    : null
}

async function activateExplicitSkillFromMessage({
  message,
  workspacePath,
  pluginOutputDir,
  systemId,
  pluginWorkspace,
  featureId,
  harnessProjectId,
  harnessAdapterName,
  harnessAdapterVersion,
  harnessNodeName,
  harnessNodeStatus,
  projectCode,
  projectDir,
  sessionId,
  turnId,
  hookScope,
  firedSkillKeys,
  skillUseTracker,
  onHookResult,
  onHookSkippedFactory
}: {
  message: string
  workspacePath: string
  pluginOutputDir?: string
  systemId?: string
  pluginWorkspace?: string
  featureId?: string
  harnessProjectId?: string
  harnessAdapterName?: string
  harnessAdapterVersion?: string
  harnessNodeName?: string
  harnessNodeStatus?: string
  projectCode?: string
  projectDir?: string
  sessionId: string
  turnId?: string
  hookScope: HookScopeController
  firedSkillKeys: Set<string>
  skillUseTracker: SkillUseTracker
  onHookResult?: HookResultCallback
  onHookSkippedFactory?: (event: HookEvent) => ScopeSkipCallback | undefined
}): Promise<ExplicitSkillActivation | null> {
  const parsed = parseSkillUseBlock(message)
  if (!parsed) return null

  const registry = await buildSkillLifecycleRegistryForHooks()
  const skill = registry?.resolveExplicit({
    skillName: parsed.skillName,
    skillPath: parsed.skillPath
  })

  if (!skill || isDisabledSkillMatch(skill)) {
    return {
      parsed,
      blocked: true,
      reason: `显式选择的技能不存在或已禁用：${parsed.skillName}`
    }
  }

  const result = await activateSkillLifecycle({
    skill,
    trigger: "explicit",
    toolName: "skill_select",
    toolArgs: {
      skillName: parsed.skillName,
      skillPath: parsed.skillPath
    },
    toolResult: JSON.stringify({
      selected: true,
      trigger: "explicit",
      skillName: skill.name,
      skillPath: skill.path
    }),
    workspacePath,
    pluginOutputDir,
    systemId,
    pluginWorkspace,
    featureId,
    harnessProjectId,
    harnessAdapterName,
    harnessAdapterVersion,
    harnessNodeName,
    harnessNodeStatus,
    projectCode,
    projectDir,
    sessionId,
    turnId,
    hookScope,
    firedSkillKeys,
    skillUseTracker,
    resolveHooks: (event: HookEvent, context: HookContext): HookConfig[] =>
      resolveEnabledHooksForRun(
        workspacePath,
        event,
        context,
        hookScope,
        onHookSkippedFactory?.(event)
      ),
    onHookResult
  })

  return {
    parsed,
    skill,
    hookContext: formatSkillHookContext(skill, result.notes) ?? undefined,
    blocked: result.blocked,
    reason: result.reason
  }
}

export async function prepareStandardUserPrompt({
  rawMessage,
  initialModelInput,
  threadId,
  workspacePath,
  turnState,
  harnessAgentContext,
  onHookResult,
  onHookSkippedFactory,
  onExplicitSkillActivated,
  onSystemMessage,
  isPreparationCurrent
}: {
  rawMessage: string
  initialModelInput: string
  threadId: string
  workspacePath: string
  turnState: PromptPreparationTurnState
  harnessAgentContext: HarnessAgentContext
  onHookResult: HookResultCallback
  onHookSkippedFactory: (event: HookEvent) => ScopeSkipCallback
  onExplicitSkillActivated?: (skill: SkillLifecycleMatch) => void
  onSystemMessage?: (message: string) => void
  isPreparationCurrent?: () => boolean
}): Promise<PreparedUserPrompt> {
  let preparedMessage = initialModelInput
  const explicitSkillActivationMessage = parseSkillUseBlock(rawMessage)
    ? rawMessage
    : initialModelInput
  const explicitSkillActivation = await activateExplicitSkillFromMessage({
    message: explicitSkillActivationMessage,
    workspacePath,
    pluginOutputDir: harnessAgentContext.pluginOutputDir,
    systemId: harnessAgentContext.systemId,
    ...getHarnessHookContext(harnessAgentContext),
    sessionId: threadId,
    turnId: turnState.turnId,
    hookScope: turnState.hookScope,
    firedSkillKeys: turnState.skillHookKeys,
    skillUseTracker: turnState.skillUseTracker,
    onHookResult,
    onHookSkippedFactory
  })
  if (isPreparationCurrent && !isPreparationCurrent()) {
    return {
      accepted: false,
      blockedBy: "run_not_ready",
      reason: "当前运行已结束或被替换"
    }
  }
  if (explicitSkillActivation?.blocked) {
    return {
      accepted: false,
      blockedBy: "explicit_skill",
      reason: explicitSkillActivation.reason || "显式选择的技能被 Hook 拦截"
    }
  }
  const isInternalGoalModelInput =
    initialModelInput.startsWith("[Starting active goal]") ||
    initialModelInput.startsWith("[Continuing active goal]")
  const hookVisibleMessage = isInternalGoalModelInput ? initialModelInput : rawMessage
  const promptSubmitContext: HookContext = {
    toolArgs: { message: hookVisibleMessage, rawMessage },
    userPrompt: hookVisibleMessage,
    workspacePath,
    sessionId: threadId,
    turnId: turnState.turnId,
    pluginOutputDir: harnessAgentContext.pluginOutputDir,
    systemId: harnessAgentContext.systemId,
    ...getHarnessHookContext(harnessAgentContext)
  }
  const promptSubmitResult = await runHooksEnriched(
    resolveEnabledHooksForRun(
      workspacePath,
      "UserPromptSubmit",
      promptSubmitContext,
      turnState.hookScope,
      onHookSkippedFactory("UserPromptSubmit")
    ),
    "UserPromptSubmit",
    promptSubmitContext,
    onHookResult
  )
  if (isPreparationCurrent && !isPreparationCurrent()) {
    return {
      accepted: false,
      blockedBy: "run_not_ready",
      reason: "当前运行已结束或被替换"
    }
  }
  if (promptSubmitResult?.blocked || promptSubmitResult?.continue === false) {
    return {
      accepted: false,
      blockedBy: "user_prompt_submit",
      reason:
        promptSubmitResult.stopReason ||
        promptSubmitResult.reason ||
        promptSubmitResult.stderr ||
        promptSubmitResult.stdout ||
        "消息被 Hook 策略拦截",
      hookResult: promptSubmitResult
    }
  }

  const updatedMessage =
    promptSubmitResult?.updatedInput?.message ??
    promptSubmitResult?.updatedInput?.prompt ??
    promptSubmitResult?.updatedInput?.userPrompt
  if (isInternalGoalModelInput) {
    preparedMessage = buildInternalGoalPromptFromHookResult(initialModelInput, {
      updatedInput: promptSubmitResult?.updatedInput,
      additionalContexts: [
        explicitSkillActivation?.hookContext,
        promptSubmitResult?.additionalContext
      ]
    })
  } else if (typeof updatedMessage === "string" && updatedMessage.length > 0) {
    preparedMessage = applyPromptRewritePreservingGoalMarker(initialModelInput, updatedMessage)
  }
  if (
    !isInternalGoalModelInput &&
    explicitSkillActivation?.parsed &&
    !parseSkillUseBlock(preparedMessage)
  ) {
    preparedMessage = [preparedMessage.trimEnd(), explicitSkillActivation.parsed.block]
      .filter(Boolean)
      .join("\n\n")
  }
  const promptContextBlocks = [
    explicitSkillActivation?.hookContext,
    promptSubmitResult?.additionalContext
  ].filter((item): item is string => Boolean(item?.trim()))
  if (!isInternalGoalModelInput && promptContextBlocks.length > 0) {
    preparedMessage = `${promptContextBlocks.join("\n\n")}\n\n${preparedMessage}`
  }
  if (promptSubmitResult?.systemMessage) {
    onSystemMessage?.(promptSubmitResult.systemMessage)
  }
  if (explicitSkillActivation?.skill) {
    onExplicitSkillActivated?.(explicitSkillActivation.skill)
  }
  return {
    accepted: true,
    content: preparedMessage,
    explicitSkillHookContext: explicitSkillActivation?.hookContext
  }
}

export interface StandardTurnRoutingInput {
  taskSource: RoutingContext["taskSource"]
  message?: string
  threadId: string
  requestedModelId?: string
  continuation?: RoutingContext["continuation"]
  routingMode?: RoutingContext["routingMode"]
}

export interface PreparedStandardTurnRouting {
  result: RoutingResult | null
  effectiveModelId?: string
  primaryTier: "premium" | "economy"
  orderedModelIds: string[]
}

export async function resolveStandardTurnRouting(
  input: StandardTurnRoutingInput
): Promise<PreparedStandardTurnRouting> {
  const result = await resolveModel({
    taskSource: input.taskSource,
    message: input.message,
    threadId: input.threadId,
    requestedModelId: input.requestedModelId,
    continuation: input.continuation,
    routingMode: input.routingMode ?? getGlobalRoutingMode()
  }).catch(() => null)
  const effectiveModelId = result?.resolvedModelId ?? input.requestedModelId
  const primaryTier = result?.resolvedTier ?? "premium"
  return {
    result,
    effectiveModelId,
    primaryTier,
    orderedModelIds: buildOrderedChain(
      effectiveModelId,
      result?.fallbackChain,
      primaryTier,
      result?.layer !== "pinned"
    )
  }
}

export function createStandardTurnTrace(input: {
  threadId: string
  rawMessage: string
  requestedModelId?: string
  options?: TraceCollectorOptions
}): TraceCollector {
  return new TraceCollector(
    input.threadId,
    input.rawMessage,
    input.requestedModelId ?? "unknown",
    input.options
  )
}

export interface RemoteTurnPolicy {
  disableScheduler?: boolean
  disableSkillEvolution?: boolean
  disableRequestUserInput?: boolean
  disableSubagents?: boolean
  disableMemoryInjection?: boolean
  disableAgentsPrompt?: boolean
  disableMcpTools?: boolean
  blockedToolNames?: string[]
  filesystemAccess?: CreateAgentRuntimeOptions["filesystemAccess"]
}

export interface StandardThreadRuntimeFactoryInput {
  source: StandardTurnSource
  runLease: { owner: LocalThreadRunOwner; runId: string }
  baseOptions:
    | Omit<CreateAgentRuntimeOptions, "modelId">
    | (() => Omit<CreateAgentRuntimeOptions, "modelId">)
  harnessContext?: HarnessAgentContext
  remotePolicy?: RemoteTurnPolicy
}

export interface PreparedThreadRuntimeFactory {
  readonly source: StandardTurnSource
  optionsForModel(modelId?: string): CreateAgentRuntimeOptions
  create(modelId?: string): Promise<DeepAgent>
}

function harnessRuntimeOptions(
  context: HarnessAgentContext | undefined
): Partial<CreateAgentRuntimeOptions> {
  if (!context) return {}
  const runtimeOptions = { ...context }
  delete runtimeOptions.sessionContextInjectWarning
  return runtimeOptions
}

function applyRemoteTurnPolicy(
  options: Omit<CreateAgentRuntimeOptions, "modelId">,
  policy: RemoteTurnPolicy | undefined
): Omit<CreateAgentRuntimeOptions, "modelId"> {
  if (!policy) return options
  return {
    ...options,
    ...(policy.disableScheduler ? { noSchedulerTool: true } : {}),
    ...(policy.disableSkillEvolution ? { noSkillEvolutionTool: true } : {}),
    ...(policy.disableRequestUserInput ? { enableRequestUserInput: false } : {}),
    ...(policy.disableSubagents ? { disableSubagents: true } : {}),
    ...(policy.disableMemoryInjection ? { disableMemoryInjection: true } : {}),
    ...(policy.disableAgentsPrompt ? { enableAgentsPrompt: false } : {}),
    ...(policy.disableMcpTools ? { disableMcpTools: true } : {}),
    ...(policy.blockedToolNames ? { blockedToolNames: policy.blockedToolNames } : {}),
    ...(policy.filesystemAccess ? { filesystemAccess: policy.filesystemAccess } : {})
  }
}

export function prepareStandardThreadRuntimeFactory(
  input: StandardThreadRuntimeFactoryInput
): PreparedThreadRuntimeFactory {
  const optionsForModel = (modelId?: string): CreateAgentRuntimeOptions => {
    const callerOptions =
      typeof input.baseOptions === "function" ? input.baseOptions() : input.baseOptions
    return {
      ...applyRemoteTurnPolicy(
        {
          ...callerOptions,
          ...harnessRuntimeOptions(input.harnessContext)
        },
        input.remotePolicy
      ),
      modelId
    }
  }
  return {
    source: input.source,
    optionsForModel,
    create: (modelId?: string) => {
      const options = optionsForModel(modelId)
      assertLocalThreadRunLease(options.threadId, input.runLease.owner, input.runLease.runId)
      return createAgentRuntime(options)
    }
  }
}
