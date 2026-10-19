import { randomUUID, createHash } from "node:crypto"
import { HumanMessage } from "@langchain/core/messages"
import type { ModsManager } from "../manager"
import type { ModObject } from "../../../shared/mods/types"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { FunctionTurnComplete } from "../../../shared/mods/v2/turn"
import type { AgentProfile } from "../../agent/agent-registry"
import { withFunctionAgentExecution } from "./host-call"
import { ModelRefusalError, readModelRefusal, type ModelRefusal } from "../../agent/model-refusal"
import { withTaskModelOutcome } from "../../agent/task-model-outcome"
import { captureThreadIncarnation } from "../../services/thread-incarnation"
import {
  assertCreatorModelAccounting,
  type CreatorModelAccounting
} from "../devtools/creator-model-accounting"
import type { FunctionConversationChildParent } from "./conversation-child-family"
import type { TraceCollector } from "../../agent/trace/collector"
import type { TraceContext } from "../../agent/trace/types"
import {
  functionAgentSpec,
  functionAgentToolName,
  type RegisteredFunctionAgent
} from "./agent-registry"

export interface FunctionAgentPlan {
  prompt: string
  description: string
  model: string
  type: string
  workspace: string
  role?: AgentProfile
  modelFingerprint: string
  blockedToolNames?: string[]
  readOnly?: boolean
  registered?: RegisteredFunctionAgent
  allowedToolNames?: string[]
  maxTurns?: number
  omitClaudeMd?: boolean
}

export function functionAgentModelFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export async function prepareFunctionAgentPlan(
  input: ModObject,
  workspace: string,
  inheritedModel?: string,
  registered?: RegisteredFunctionAgent
): Promise<FunctionAgentPlan> {
  if (
    typeof input.prompt !== "string" ||
    !input.prompt.trim() ||
    Buffer.byteLength(input.prompt) > 64 * 1024 ||
    typeof input.description !== "string" ||
    input.description.length > 4000 ||
    typeof input.subagentType !== "string" ||
    !input.subagentType ||
    input.subagentType.length > 256
  )
    throw new ModFunctionError("MODS_AGENT_SPAWN_ARGUMENTS")
  if (input.background !== true || input.fork === true)
    throw new ModFunctionError("MODS_AGENT_SPAWN_MODE_UNSUPPORTED")
  if (input.cwd !== undefined && input.cwd !== workspace)
    throw new ModFunctionError("MODS_AGENT_SPAWN_CWD_UNSUPPORTED")
  const { loadAgentProfilesAsync, resolveProfileFromList } =
    await import("../../agent/agent-registry")
  const { getModelConfigByRef } = await import("../../models/registry")
  const profiles = await loadAgentProfilesAsync(workspace)
  const spec = registered && functionAgentSpec(registered.spec)
  if (registered && registered.name !== input.subagentType)
    throw new ModFunctionError("MODS_AGENT_SPAWN_TYPE_UNAVAILABLE")
  const role: AgentProfile | null | undefined =
    spec && registered
      ? {
          name: registered.name,
          description: String(spec.description),
          systemPrompt: String(spec.prompt),
          model: spec.model === "inherit" ? undefined : (spec.model as string | undefined),
          source: "user",
          disallowedTools: ((spec.disallowedTools ?? []) as string[]).map(functionAgentToolName),
          shellAccess: spec.permissionMode === "plan" ? "read_only" : "full"
        }
      : input.subagentType === "general-purpose"
        ? undefined
        : resolveProfileFromList(profiles, input.subagentType)
  if (role === null) throw new ModFunctionError("MODS_AGENT_SPAWN_TYPE_UNAVAILABLE")
  const requested =
    input.model === undefined || input.model === "inherit"
      ? (role?.model ?? inheritedModel)
      : input.model
  if (typeof requested !== "string")
    throw new ModFunctionError("MODS_AGENT_SPAWN_MODEL_UNAVAILABLE")
  const model = getModelConfigByRef(requested)
  if (!model?.apiKey) throw new ModFunctionError("MODS_AGENT_SPAWN_MODEL_UNAVAILABLE")
  return Object.freeze({
    prompt: input.prompt,
    description: input.description,
    type: input.subagentType,
    model: model.ref,
    workspace,
    ...(role ? { role: structuredClone(role) } : {}),
    ...(registered
      ? {
          registered: structuredClone(registered),
          maxTurns: spec!.maxTurns as number | undefined,
          omitClaudeMd: spec!.omitClaudeMd === true
        }
      : {}),
    modelFingerprint: functionAgentModelFingerprint(model)
  })
}

/** A separate native thread, sandbox and lease. No parent runtime tool closure is retained. */
export async function runFunctionAgentChild(
  manager: ModsManager,
  plan: FunctionAgentPlan,
  context: {
    parentThreadId: string
    agentId: string
    creator?: import("./dispatcher").FunctionHookSource
    creatorAccounting?: CreatorModelAccounting
    parentTrace?: Readonly<TraceContext>
    conversationParent?: FunctionConversationChildParent
    signal: AbortSignal
    assertLive(): void
    started(physicalThreadId: string): void
  }
): Promise<FunctionTurnComplete> {
  if (context.creatorAccounting)
    assertCreatorModelAccounting(context.creatorAccounting, {
      workspace: plan.workspace,
      threadId: context.parentThreadId
    })
  const { createThread, deleteThread, getThreadCore } = await import("../../db")
  const { captureLocalThreadRunLease, claimLocalThreadRunLease, releaseLocalThreadRunLease } =
    await import("../../agent/thread-run-lease")
  const { getModelConfigByRef } = await import("../../models/registry")
  const { createAgentRuntime, closeCheckpointer } = await import("../../agent/runtime")
  const { createTraceCollectorSafely, finishTraceInBackground, runTraceSideEffect } =
    await import("../../agent/trace/collector")
  const { TurnTraceRecorder } = await import("../../agent/trace/turn-trace-recorder")
  const { LocalSandbox } = await import("../../agent/local-sandbox")
  const { deleteThreadCheckpoint } = await import("../../storage")
  const { clearActionStationarityTurn } = await import("../../agent/action-stationarity")
  const { getAgentGraphRecursionLimit } = await import("../../../shared/agent-runtime-limits")
  context.assertLive()
  if (functionAgentModelFingerprint(getModelConfigByRef(plan.model)) !== plan.modelFingerprint)
    throw new ModFunctionError("MODS_AGENT_SPAWN_MODEL_CHANGED")
  const threadId = `${context.parentThreadId}__mods_agent_${randomUUID()}`
  const runId = randomUUID()
  if (!claimLocalThreadRunLease({ threadId, owner: "mods", runId }).acquired)
    throw new ModFunctionError("MODS_AGENT_LEASE_CONFLICT")
  const currentLease = captureLocalThreadRunLease(threadId)!
  const startedAt = Date.now()
  let incarnation: unknown
  let created = false
  let answer = ""
  let reason: "answer" | "aborted" | "error" | "refusal" = "error"
  let refusal: ModelRefusal | undefined
  let cleanupFailure: AggregateError | undefined
  let closePeer: (() => void) | undefined
  let closeConversation: (() => void) | undefined
  let tracer: TraceCollector | undefined
  const assertChild = () => {
    if (!currentLease()) throw new ModFunctionError("MODS_AGENT_LEASE_CHANGED")
    const row = getThreadCore(threadId)
    const metadata = row && JSON.parse(row.metadata ?? "{}")
    if (
      !metadata ||
      metadata.cmb_thread_incarnation !== incarnation ||
      metadata.modsAgentRunId !== runId
    )
      throw new ModFunctionError("MODS_AGENT_ID_CHANGED")
  }
  try {
    context.assertLive()
    const row = createThread(threadId, {
      workspacePath: plan.workspace,
      parentThreadId: context.parentThreadId,
      isInternalFlowRuntime: true,
      modsAgentRunId: runId,
      agentMode: "normal",
      title: plan.description,
      model: plan.model
    })
    incarnation = JSON.parse(row.metadata ?? "{}").cmb_thread_incarnation
    created = true
    const parentTrace = context.parentTrace
    tracer = createTraceCollectorSafely(
      threadId,
      plan.prompt,
      plan.model,
      {
        traceKind: "subagent",
        executionMode: "normal",
        includeSkillEval: false,
        subagentRunId: runId,
        subagentThreadId: threadId,
        handoffTargetAgent: plan.type,
        ...(parentTrace
          ? {
              rootTraceId: parentTrace.rootTraceId,
              rootThreadId: parentTrace.rootThreadId,
              parentTraceId: parentTrace.traceId,
              parentThreadId: parentTrace.threadId,
              parentSpanId: parentTrace.rootNodeId,
              linkType: "async_span_link",
              harnessFeature: parentTrace.harnessFeature
            }
          : {})
      },
      "Mods SDK agent"
    )
    let traceContext: TraceContext | undefined
    runTraceSideEffect("Mods SDK agent context", () => {
      traceContext = tracer?.getTraceContext()
    })
    const promptMessage = new HumanMessage({ content: plan.prompt, id: randomUUID() })
    const traceRecorder = tracer
      ? new TurnTraceRecorder({
          tracer,
          userMessageId: promptMessage.id,
          requireUserMessageAnchor: true
        })
      : undefined
    if (context.conversationParent) {
      closeConversation = manager.registerFunctionConversationChild(context.conversationParent, {
        invocation: {},
        physicalThreadId: threadId,
        agentId: context.agentId,
        runId,
        checkpointIncarnation: captureThreadIncarnation(row),
        signal: context.signal,
        assertCurrent: () => {
          context.assertLive()
          assertChild()
        }
      })
    }
    const restricted =
      plan.readOnly || plan.role?.shellAccess === "read_only" || plan.role?.shellAccess === "none"
    const execution = {
      workspace: plan.workspace,
      threadId,
      agentId: context.agentId,
      turnId: runId,
      userInitiated: false,
      leased: true,
      immediate: false
    }
    const runtime = await withFunctionAgentExecution(execution, () =>
      createAgentRuntime({
        creatorAccounting: context.creatorAccounting?.forChild(
          context.parentThreadId,
          threadId,
          plan.workspace,
          traceContext?.traceId,
          context.signal
        ),
        traceContext,
        threadId,
        agentId: context.agentId,
        hookTurnId: runId,
        actionStationarityTurnId: runId,
        approvalThreadId: context.parentThreadId,
        workspacePath: plan.workspace,
        modelId: plan.model,
        abortSignal: context.signal,
        extraSystemPrompt: plan.registered ? undefined : plan.role?.systemPrompt,
        modAgentSystemPrompt: plan.registered ? plan.role?.systemPrompt : undefined,
        modAgentMaxTurns: plan.maxTurns,
        allowedToolNames: plan.allowedToolNames,
        noSchedulerTool: true,
        noSkillEvolutionTool: true,
        disableSubagents: true,
        blockedToolNames: plan.blockedToolNames,
        enableAgentsPrompt: !restricted && !plan.omitClaudeMd,
        disableMemoryInjection: restricted || plan.omitClaudeMd,
        managedExecution: true,
        autoApproveFileEdits: false,
        toolConcurrencyQueueId: context.parentThreadId,
        filesystemAccess: {
          disallowedTools: plan.role?.disallowedTools ?? [],
          shellAccess:
            plan.role?.shellAccess === "none"
              ? "none"
              : plan.readOnly
                ? "read_only"
                : (plan.role?.shellAccess ?? "full"),
          workspacePath: plan.workspace
        },
        onModAgentStarted: () => {
          context.assertLive()
          assertChild()
          if (context.creator)
            manager.bindFunctionCreator(
              manager.functionAgentRuntimeAuthority(plan.workspace, threadId, context.agentId),
              context.creator
            )
          const peer = manager.bindFunctionPeerEndpoint(
            manager.functionAgentRuntimeAuthority(plan.workspace, threadId, context.agentId)
          )
          closePeer = () => peer.close()
          context.started(threadId)
        }
      })
    )
    context.assertLive()
    assertChild()
    const authority = manager.functionAgentRuntimeAuthority(
      plan.workspace,
      threadId,
      context.agentId
    )
    await withTaskModelOutcome(
      () =>
        withFunctionAgentExecution({ ...execution, runtimeAuthority: authority }, async () => {
          const stream = await runtime.stream(
            { messages: [promptMessage] },
            {
              configurable: { thread_id: threadId },
              signal: context.signal,
              streamMode: ["values", "messages"],
              recursionLimit: getAgentGraphRecursionLimit()
            }
          )
          for await (const item of stream) {
            context.assertLive()
            assertChild()
            if (!Array.isArray(item) || item[0] !== "values") continue
            traceRecorder?.onRawValues(item[1])
            const state = item[1] as {
              messages?: { content?: unknown; _getType?: () => string; tool_calls?: unknown[] }[]
            }
            const last = state.messages?.at(-1)
            if (last?._getType?.() === "ai") refusal ??= readModelRefusal(last)
            if (last?._getType?.() === "ai" && !last.tool_calls?.length) {
              if (typeof last.content === "string") answer = last.content.slice(0, 64 * 1024)
              else if (Array.isArray(last.content))
                answer = last.content
                  .filter((part) => part?.type === "text")
                  .map((part) => part.text)
                  .join("\n")
                  .slice(0, 64 * 1024)
            }
          }
        }),
      context.signal
    )
    reason = refusal ? "refusal" : "answer"
  } catch (error) {
    reason = context.signal.aborted
      ? "aborted"
      : error instanceof ModelRefusalError || refusal
        ? "refusal"
        : "error"
    if (reason === "refusal") refusal ??= { category: null, explanation: null }
    if (!created) throw error
    const code =
      error instanceof Error && /^MODS_[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : error instanceof Error && /^[A-Za-z]{1,64}$/.test(error.name)
          ? error.name
          : "UnknownError"
    console.warn("[Mods agent] Child execution ended", { agentId: context.agentId, code })
    if (!answer)
      answer =
        reason === "aborted"
          ? "Agent cancelled"
          : reason === "refusal"
            ? "Agent request refused"
            : "Agent execution failed"
  } finally {
    if (!created) releaseLocalThreadRunLease(threadId, "mods", runId)
    else {
      const errors: unknown[] = []
      // Retire conversation selection before releasing any native runtime, row or physical lease.
      try {
        closeConversation?.()
      } catch (error) {
        errors.push(error)
      }
      try {
        closePeer?.()
      } catch (error) {
        errors.push(error)
      }
      for (const cleanup of [
        () => manager.closeFunctionThread(threadId),
        () => clearActionStationarityTurn(threadId, runId),
        () => LocalSandbox.cancelBackgroundTasksAndWait(threadId),
        () => LocalSandbox.revokeGrantedAclsForRun(threadId),
        () => closeCheckpointer(threadId)
      ]) {
        try {
          assertChild()
          await cleanup()
        } catch (error) {
          errors.push(error)
        }
      }
      if (!errors.length) {
        try {
          assertChild()
          deleteThreadCheckpoint(threadId)
          assertChild()
          deleteThread(threadId)
        } catch (error) {
          errors.push(error)
        }
      }
      // Retain failed cleanup's internal identity for recovery, but never keep a dead write lease.
      if (currentLease()) releaseLocalThreadRunLease(threadId, "mods", runId)
      if (errors.length) cleanupFailure = new AggregateError(errors, "MODS_AGENT_CLEANUP_FAILED")
    }
    if (tracer)
      finishTraceInBackground(
        tracer,
        cleanupFailure
          ? "unknown"
          : reason === "answer"
            ? "success"
            : reason === "aborted"
              ? "cancelled"
              : "error",
        cleanupFailure
          ? "MODS_AGENT_CLEANUP_FAILED"
          : reason === "error"
            ? "MODS_AGENT_EXECUTION_FAILED"
            : undefined,
        "Mods SDK agent"
      )
  }
  if (cleanupFailure) throw cleanupFailure
  const completion = {
    answer,
    isAborted: reason === "aborted",
    durationMs: Date.now() - startedAt,
    turnId: runId,
    agentId: context.agentId
  }
  return reason === "refusal"
    ? { ...completion, reason, refusal: refusal ?? { category: null, explanation: null } }
    : { ...completion, reason }
}
