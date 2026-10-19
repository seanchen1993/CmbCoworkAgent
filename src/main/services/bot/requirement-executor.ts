import { parseDeliveryInput } from "./text-delivery-validation"
import {
  parseExpertInput,
  parseCoordination,
  summarizeCoordinationOutput,
  EXPERT_MAIN_TEXT_PROMPT,
  EXPERT_TASK_TEXT_PROMPT
} from "./expert-conversation-validation"
import { createHash } from "node:crypto"
import {
  startAgentRun,
  type AgentRunDelivery,
  type AgentRunTerminal
} from "../../agent/agent-run-service"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import { assemblePartnerPrompt } from "./prompt-assembly"
import { REQUIREMENT_INPUT_ONLY_PROMPT } from "./input-only-requirement-run"
import { PartnerRequirementAttemptStore } from "./requirement-attempt-store"
import { PartnerTaskThreadStore, type PartnerTaskThreadContext } from "./task-thread-store"
import { parseRunMemorySnapshot } from "./expert-memory-validation"
import { groupMemorySourceRef } from "../../../shared/bot/group-memory"
import {
  samePartnerAttempt,
  validatePartnerRun,
  type PartnerRequirementControl,
  type PartnerRequirementInput,
  type PartnerRequirementResult,
  type PartnerRequirementRun,
  type RequirementOutcome
} from "./requirement-execution-types"

export interface PartnerLocalExecutionConfig {
  spaceId: string
  nodeId: string
  ownerPrincipalId: string
  modelRef: string
  modelConfigHash?: string
  /** Explicit local owner mappings only; no most-recent/default workspace lookup. */
  workspaces: ReadonlyMap<string, string>
}
export interface PartnerRequirementExecutorDependencies {
  config: PartnerLocalExecutionConfig
  control: PartnerRequirementControl
  threads: PartnerTaskThreadStore
  attempts: PartnerRequirementAttemptStore
  delivery: AgentRunDelivery
  startRun?: typeof startAgentRun
  /** Trusted local test clock cadence only, never a remote request parameter. */
  onProtocolFailure?: (run: PartnerRequirementRun) => void
  refusalCode?: "MODEL_CHANGED" | "MODEL_UNAVAILABLE"
  cancelBeforeStart?: (run: PartnerRequirementRun) => boolean
  renewalIntervalMs?: number
}

function prepared(run: PartnerRequirementRun, raw: PartnerRequirementInput) {
  const input = structuredClone(raw)
  const { bot, botVersion, group, task } = input
  if (
    task.id !== run.taskId ||
    task.version !== run.taskVersion ||
    task.currentStageId !== run.stageId ||
    task.status !== "active" ||
    !task.stages.some(
      (s) => s.id === run.stageId && s.kind === "requirement" && s.status === "active"
    ) ||
    group.id !== run.groupId ||
    group.version !== run.groupVersion ||
    bot.id !== run.botId ||
    botVersion.id !== run.botVersionId ||
    !botVersion.config.capabilityCeiling.includes("requirements.analyze")
  )
    throw new Error("PARTNER_EXECUTION_INPUT_CHANGED")
  const messageIds = new Set<string>()
  let previousVersion = 1
  if (!Array.isArray(input.messages) || input.messages.length > 50)
    throw new Error("PARTNER_EXECUTION_INPUT_CHANGED")
  for (const entry of input.messages) {
    const value = entry.message
    if (
      !value ||
      value.spaceId !== run.spaceId ||
      value.taskId !== run.taskId ||
      !Number.isSafeInteger(entry.taskVersion) ||
      entry.taskVersion <= previousVersion ||
      entry.taskVersion > run.taskVersion ||
      ![value.id, value.authorPrincipalId].every(
        (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v)
      ) ||
      messageIds.has(value.id) ||
      typeof value.text !== "string" ||
      !value.text.trim() ||
      !Array.isArray(value.artifactVersions) ||
      value.artifactVersions.length
    )
      throw new Error("PARTNER_EXECUTION_INPUT_CHANGED")
    messageIds.add(value.id)
    previousVersion = entry.taskVersion
  }
  const snapshot = parseRunMemorySnapshot(
    input.memorySnapshot,
    run.spaceId,
    run.groupId,
    run.botId,
    run.memoryScope
  )
  if ((botVersion.config.memoryPolicy === "disabled") !== (snapshot === null))
    throw new Error("PARTNER_EXECUTION_INPUT_CHANGED")
  const conversation = parseExpertInput(input.conversationInput, run.taskId, run.taskVersion)
  if (
    (run.executionProfile ?? null) !== (conversation?.profile ?? null) ||
    (run.contextDigest ?? null) !== (conversation?.digest ?? null)
  )
    throw new Error("PARTNER_EXECUTION_INPUT_CHANGED")
  const prompt = assemblePartnerPrompt({
    ...input,
    baseSystemPrompt: conversation
      ? "你是当前用户配置的领域专家，只使用明确提供的会话材料，不执行工具或扩大权限。"
      : "你是DevClaw编程伙伴。只使用本次明确提供的材料，不执行工具或扩大权限。",
    ...(conversation
      ? {
          conversationPurpose:
            conversation.profile === "expert_main_v1" ? ("main" as const) : ("task" as const)
        }
      : {}),
    modeSystemPrompt: conversation
      ? conversation.profile === "expert_main_v1"
        ? EXPERT_MAIN_TEXT_PROMPT
        : EXPERT_TASK_TEXT_PROMPT
      : REQUIREMENT_INPUT_ONLY_PROMPT,
    mode: { id: "requirement", version: 1 },
    delivery: "app",
    memories:
      snapshot?.memories.map((memory) => ({
        spaceId: memory.spaceId,
        scope: "botId" in memory ? ("bot" as const) : ("group" as const),
        ownerId: "botId" in memory ? memory.botId : memory.groupId,
        sourceRef: groupMemorySourceRef(memory),
        origin: "explicit" as const,
        text: memory.text
      })) ?? []
  })
  const deliveryInput = parseDeliveryInput(
    input.deliveryInput,
    run.spaceId,
    run.taskId,
    run.id,
    run.taskVersion
  )
  if ((run.deliveryVersionId ?? null) !== (deliveryInput?.versionId ?? null))
    throw new Error("PARTNER_EXECUTION_INPUT_CHANGED")
  if (
    deliveryInput &&
    !input.messages.some(
      ({ message, taskVersion }) =>
        message.id === deliveryInput.feedbackMessageId &&
        message.text === deliveryInput.feedbackText &&
        taskVersion === deliveryInput.feedbackTaskVersion
    )
  )
    throw new Error("PARTNER_EXECUTION_INPUT_CHANGED")
  const message = conversation
    ? JSON.stringify(conversation)
    : JSON.stringify({
        ...(deliveryInput
          ? {
              revision: {
                ...deliveryInput,
                instruction:
                  "基于明确给出的上一版全文和修改意见，输出完整的新版本草稿。保留符合原要求的内容，应用本次意见。"
              }
            }
          : {}),
        taskNumber: task.taskNumber,
        title: task.title,
        goal: task.goal,
        clarifications: input.messages.map(({ message, taskVersion }) => ({
          authorPrincipalId: message.authorPrincipalId,
          text: message.text,
          taskVersion
        }))
      })
  if (message.length > 60_000) throw new Error("PARTNER_EXECUTION_INPUT_TOO_LARGE")
  return {
    systemPrompt: prompt.systemPrompt,
    message,
    memoryRevision: snapshot?.revision ?? null,
    ...(conversation ? { conversation } : {})
  }
}

/** Manually supplied authenticated control seam. Not polling, IPC registration
 * or a production WSS client. All durable admissions precede a model call. */
export class PartnerRequirementExecutor {
  private readonly config: PartnerLocalExecutionConfig
  private readonly inFlight = new Map<
    string,
    { run: PartnerRequirementRun; completion: Promise<PartnerRequirementResult> }
  >()
  private readonly controllers = new Map<string, AbortController>()
  constructor(private readonly deps: PartnerRequirementExecutorDependencies) {
    this.config = { ...deps.config, workspaces: new Map(deps.config.workspaces) }
    if (
      (this.config.modelConfigHash !== undefined &&
        !/^[a-f0-9]{64}$/.test(this.config.modelConfigHash)) ||
      typeof this.config.modelRef !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(this.config.modelRef) ||
      (deps.renewalIntervalMs !== undefined &&
        (!Number.isInteger(deps.renewalIntervalMs) ||
          deps.renewalIntervalMs < 10 ||
          deps.renewalIntervalMs > 5000))
    )
      throw new Error("PARTNER_EXECUTOR_CONFIG_INVALID")
  }
  execute(raw: PartnerRequirementRun): Promise<PartnerRequirementResult> {
    const run = validatePartnerRun(raw)
    if (
      run.spaceId !== this.config.spaceId ||
      run.nodeId !== this.config.nodeId ||
      run.ownerPrincipalId !== this.config.ownerPrincipalId
    )
      return Promise.reject(new Error("PARTNER_EXECUTOR_NODE_MISMATCH"))
    const key = JSON.stringify([run.spaceId, run.id, run.attemptId])
    const active = this.inFlight.get(key)
    if (active)
      return samePartnerAttempt(active.run, run)
        ? active.completion
        : Promise.reject(new Error("PARTNER_EXECUTION_INPUT_CHANGED"))
    const controller = new AbortController()
    this.controllers.set(key, controller)
    const completion = this.perform(run, controller).finally(() => {
      this.inFlight.delete(key)
      this.controllers.delete(key)
    })
    this.inFlight.set(key, { run, completion })
    return completion
  }
  /** Stop only this executor's attempt; never a personal/other node Thread. */
  cancel(run: PartnerRequirementRun): boolean {
    const key = JSON.stringify([run.spaceId, run.id, run.attemptId])
    const active = this.inFlight.get(key)
    if (!active || !samePartnerAttempt(active.run, validatePartnerRun(run))) return false
    const controller = this.controllers.get(key)
    if (!controller) return false
    controller.abort()
    return true
  }
  private async settle(run: PartnerRequirementRun, outcome: RequirementOutcome, text: string) {
    let result: PartnerRequirementResult
    try {
      result = await this.deps.control.settle(run, outcome, text)
    } catch (error) {
      if (
        error instanceof Error &&
        ["INPUT_CHANGED", "COMMAND_CONFLICT"].includes(error.message) &&
        (await this.deps.control.memoryChanged?.(run))
      )
        throw new Error("PARTNER_MEMORY_CHANGED")
      throw error
    }
    if (
      result.runId !== run.id ||
      result.attemptId !== run.attemptId ||
      result.outcome !== outcome ||
      result.text !== text
    )
      throw new Error("PARTNER_RESULT_CHANGED")
    this.deps.attempts.markSettled(run)
    return result
  }
  private async perform(
    ticket: PartnerRequirementRun,
    controller: AbortController
  ): Promise<PartnerRequirementResult> {
    const { attempts, threads, control } = this.deps
    const previous = attempts.get(ticket)
    if (previous) {
      if (previous.state === "result_ready" || previous.state === "settled")
        return this.settle(ticket, previous.outcome!, previous.text!) // Current server auth, never model replay.
      throw new Error("PARTNER_EXECUTION_OUTCOME_UNKNOWN")
    }
    if (ticket.status !== "starting") throw new Error("PARTNER_EXECUTION_OUTCOME_UNKNOWN")
    const started = await control.start(ticket)
    let run = validatePartnerRun(started.run)
    if (!samePartnerAttempt(ticket, run) || run.status !== "running")
      throw new Error("PARTNER_EXECUTION_INPUT_CHANGED")
    const prompt = prepared(run, started.input)
    const workspacePath = this.config.workspaces.get(run.workspaceRef)
    if (!workspacePath) throw new Error("PARTNER_WORKSPACE_NOT_AUTHORIZED")
    const scope: PartnerTaskThreadContext = {
      spaceId: run.spaceId,
      taskId: run.taskId,
      stageId: run.stageId,
      runtimeNodeId: run.nodeId,
      groupId: run.groupId,
      ownerPrincipalId: run.ownerPrincipalId,
      workspaceRef: run.workspaceRef,
      workspacePath
    }
    const binding = threads.ensure(scope)
    const inputHash = createHash("sha256")
      .update(JSON.stringify([prompt, this.config.modelRef, workspacePath]))
      .digest("hex")
    if (!attempts.reserve(run, binding.localThreadId, inputHash))
      throw new Error("PARTNER_EXECUTION_OUTCOME_UNKNOWN")
    const localLease = claimLocalThreadRunLease({
      threadId: binding.localThreadId,
      owner: "im",
      runId: run.attemptId
    })
    if (!localLease.acquired || localLease.disposition !== "new")
      throw new Error("PARTNER_THREAD_BUSY")
    let alive = true,
      leaseLost = false,
      memoryChanged = false,
      expiryTimer: ReturnType<typeof setTimeout> | undefined
    let renewTimer: ReturnType<typeof setTimeout> | undefined
    const loseLease = () => {
      leaseLost = true
      controller.abort()
    }
    const armExpiry = () => {
      if (expiryTimer) clearTimeout(expiryTimer)
      const left = Math.min(Date.parse(run.leaseExpiresAt), Date.parse(run.deadline)) - Date.now()
      if (left <= 0) loseLease()
      else expiryTimer = setTimeout(loseLease, left)
    }
    const renew = async () => {
      try {
        if (!alive || controller.signal.aborted) return
        const updated = validatePartnerRun(await control.renew(run))
        if (!alive || controller.signal.aborted) return
        if (
          !samePartnerAttempt(run, updated) ||
          updated.status !== "running" ||
          Date.parse(updated.leaseExpiresAt) < Date.parse(run.leaseExpiresAt)
        )
          throw Error()
        run = updated
        armExpiry()
        renewTimer = setTimeout(() => {
          void renew()
        }, this.deps.renewalIntervalMs ?? 5000)
      } catch (error) {
        if (
          alive &&
          error instanceof Error &&
          ["INPUT_CHANGED", "COMMAND_CONFLICT"].includes(error.message)
        ) {
          try {
            memoryChanged = (await control.memoryChanged?.(run)) ?? false
          } catch {
            /* never guess from the error alone */
          }
        }
        if (alive) loseLease()
      }
    }
    let finalText: string | undefined
    let terminal: AgentRunTerminal | undefined
    try {
      attempts.markRunning(run)
      if (this.deps.cancelBeforeStart?.(run)) controller.abort()
      armExpiry()
      renewTimer = setTimeout(() => {
        void renew()
      }, this.deps.renewalIntervalMs ?? 5000)
      threads.verify(scope, binding.localThreadId)
      if (this.deps.refusalCode) terminal = { outcome: "error", code: this.deps.refusalCode }
      else {
        const handle = await (this.deps.startRun ?? startAgentRun)(
          { threadId: binding.localThreadId, message: prompt.message },
          this.deps.delivery,
          {
            source: "im",
            signal: controller.signal,
            partnerInputOnly: {
              systemPrompt: prompt.systemPrompt,
              modelRef: this.config.modelRef,
              ...(this.config.modelConfigHash !== undefined
                ? { modelConfigHash: this.config.modelConfigHash }
                : {})
            },
            localRunLease: { owner: "im", runId: run.attemptId, managedExternally: true },
            allowTrustedTransportSkillMarker: false,
            verifyResolvedThread: (resolved) => {
              try {
                threads.verify(scope, binding.localThreadId, resolved)
                return null
              } catch {
                return "PARTNER_THREAD_CONTEXT_CHANGED"
              }
            },
            onFinalAssistant: (result) => {
              if (finalText !== undefined) throw Error("PARTNER_DUPLICATE_FINAL")
              if (prompt.conversation?.profile === "expert_main_v1") {
                try {
                  parseCoordination(result.finalText, prompt.conversation)
                } catch (error) {
                  console.warn("[Partner][CoordinationOutputInvalid]", {
                    runId: run.id,
                    ...summarizeCoordinationOutput(result.finalText)
                  })
                  this.deps.onProtocolFailure?.(run)
                  throw error
                }
              }
              finalText = result.finalText
            },
            onRunTerminated: (value) => {
              terminal = value
            }
          }
        )
        await handle.completion
      }
    } catch {
      terminal = { outcome: "error", code: "EXECUTION_FAILED" }
    } finally {
      alive = false
      if (expiryTimer) clearTimeout(expiryTimer)
      if (renewTimer) clearTimeout(renewTimer)
      // Release after graph completion, never just on a timer callback. Provider
      // cancellation still depends on its AbortSignal support; this profile has
      // no tools, and its durable attempt can never launch a second model turn.
      releaseLocalThreadRunLease(binding.localThreadId, "im", run.attemptId)
    }
    if (memoryChanged) throw new Error("PARTNER_MEMORY_CHANGED")
    if (leaseLost || Date.now() >= Date.parse(run.leaseExpiresAt))
      throw new Error("PARTNER_EXECUTION_LEASE_LOST")
    const outcome: RequirementOutcome =
      terminal?.outcome === "success" &&
      !controller.signal.aborted &&
      !!finalText?.trim() &&
      finalText.length <= 16_384
        ? "succeeded"
        : "failed"
    const failure = controller.signal.aborted
      ? "CANCELLED"
      : ["EMPTY_OUTPUT", "TOOL_CALL_REJECTED", "EXECUTION_FAILED"].includes(terminal?.code ?? "")
        ? terminal!.code
        : "EXECUTION_FAILED"
    const text = outcome === "succeeded" ? finalText! : failure
    attempts.saveResult(run, outcome, text) // Commit locally BEFORE sending settlement.
    return this.settle(run, outcome, text)
  }
}
