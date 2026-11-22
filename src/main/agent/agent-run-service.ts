import type { BotSkillDispatch } from "./bot-skill-dispatch"
import type { BrowserWindow } from "electron"
import { AsyncLocalStorage } from "node:async_hooks"
import { resolveAgentStreamRequestChannel } from "../../shared/agent-stream-channel"
import {
  COORDINATOR_NOTIFICATION_PROMPT_PREFIX,
  type BackgroundNotificationOwner
} from "../../shared/internal-notification-turn"
import type { SkillUseBlockMetadata } from "../../shared/skill-use-block"
import type { AgentInvokeParams } from "../types"
import type { CreateAgentRuntimeOptions, RuntimeInteractionWaitHooks } from "./runtime"
import type { RemoteTurnPolicy, StandardTurnSource } from "./standard-thread-turn"
import type { LocalThreadRunOwner } from "./thread-run-lease"
import {
  withRuntimePluginSource,
  type RuntimePluginSourceToken
} from "../plugins/runtime-source-scope"
import { prepareAgentRunAdmission } from "./agent-run-admission"
import { classifyManagedAgentFailure } from "./managed-agent-failure"
import { createRunCancellationSettlement, recordRunCancellation } from "./run-cancellation-settlement"
import type { CurrentRunQueuedMessage } from "./current-run-message-queue"

/** Model-facing request text from trusted Bot preparation. The visible transcript is separate. */
export const BOT_PREPARED_USER_REQUEST_KEY = "cmb_bot_prepared_user_request"

export interface AgentRunSteerRequest {
  threadId: string
  owner: LocalThreadRunOwner
  runId: string
  message: CurrentRunQueuedMessage
  /** Trusted Bot receipt only; no change to ordinary steering when absent. */
  onUserPromptPrepared?: (body: string) => void
}

export interface AgentRunSteerResult {
  queued: boolean
  reason?: string
  message?: string
}

export type AgentRunRequest = AgentInvokeParams

class FunctionTurnSettlementFailure extends Error {
  constructor(cause: unknown) {
    super("Function turn settlement could not confirm its original authority", { cause })
  }
}

/** Only after this producer releases its physical lease; ordinary observer failures stay optional. */
export async function settleAgentFunctionTurn(
  settlement: Promise<void> | undefined
): Promise<void> {
  try {
    await settlement
  } catch (error) {
    if (classifyManagedAgentFailure(error) !== "provider_error")
      throw new FunctionTurnSettlementFailure(error)
  }
}

export interface AgentRunDelivery {
  /**
   * NOT always a real BrowserWindow.
   *
   * A managed transport (IM, and any future scheduled or cloud caller) has no
   * window and supplies a shim that implements exactly four members: `id`,
   * `isDestroyed()`, `webContents.send()` and `webContents.isDestroyed()` — see
   * createManagedTransportAgentRunDelivery. The shim is cast to BrowserWindow,
   * so reaching for a fifth member compiles cleanly and then throws at runtime,
   * on the managed path only, possibly in a branch nobody exercises for weeks.
   * tests/agent-window-surface.spec.ts fails the build before that can ship.
   *
   * Prefer `send` / `isAvailable` over reaching through this field at all.
   */
  window: BrowserWindow
  send(channel: string, payload: unknown): void
  isAvailable(): boolean
  /** Close a managed renderer stream after runtime cleanup, including aborts and early returns. */
  finish?: (threadId: string) => void
}

const runDeliveryStorage = new AsyncLocalStorage<{
  threadId: string
  channel: string
  delivery: AgentRunDelivery
}>()

/** Runtime boundary events must follow the run's stream, including background Bot runs. */
export function sendCurrentAgentRunStreamEvent(threadId: string, payload: unknown): boolean {
  const current = runDeliveryStorage.getStore()
  if (!current || current.threadId !== threadId) return false
  current.delivery.send(current.channel, payload)
  return true
}

export interface AgentRunHandle {
  threadId: string
  completion: Promise<void>
  /** Main-only original physical producer evidence, read after completion and owned cleanup. */
  cancellationSettlement?: () => { requested: boolean; confirmed: boolean }
  /** Exact observers then original admission settle/transfer, after external lease release.
   * Existing owned background Workflow cleanup may still be deferred to its original owner. */
  sourceSettlement?: Promise<void>
  /** Main-only compare-and-release failure: retire only the captured original logical entry. */
  invalidateSourceSettlement?: () => void
}

export interface AgentRunGoalNotice {
  message: string
  goalId: string | null
  activeWindowId: string | null
  eventId: number | null
  createdAt: number
}

export interface AgentRunFinalAssistant {
  messageId: string
  finalText: string
}

export interface AgentRunDetachedResultSignal {
  kind: "coordinator" | "workflow"
  threadId: string
  runId?: string
}

/**
 * How a run ended, for callers with no stream to read.
 *
 * The desktop run body reports failures by sending them to the renderer and
 * then returning normally, so its completion promise resolves either way. A
 * managed transport that only sees "no final text" cannot tell a provider
 * blip from a hook halt, and would report every failure as equally final.
 * `error` carries the original so the caller keeps its own retry policy.
 */
export interface AgentRunTerminal {
  outcome: "success" | "error" | "unknown"
  /** Terminal classification: hook_halt, failure_fuse, provider_error, … */
  code: string
  message?: string
  error?: unknown
  /** The coordinator notification input was saved; never retry that queue item. */
  coordinatorNotificationDelivered?: boolean
}

export interface AgentGoalControlRequest {
  threadId: string
  message: string
}

export interface AgentGoalControlResult {
  handled: boolean
  terminatedCurrentRun: boolean
  notice?: AgentRunGoalNotice
}

/**
 * Trusted main-process execution metadata. Renderer calls use the desktop
 * defaults; managed transports may reuse the same run body without pretending
 * that their lease or security policy belongs to the desktop.
 */
export interface AgentRunExecutionContext {
  /** Main-resolved managed worktree boundary; never accepted from renderer request fields. */
  worktreeIsolation?: import("./workflow/types").WorkflowWorktreeIsolationBoundary
  /** Exact original Host-owned completed workflow, never renderer input. */
  hostWorkflowNotification?: {
    runId: string
    startedAt: string
    assertCurrent(): void
    /** Main-only complete source check at notification capture; never guest authority. */
    assertSourceCurrent?(): void
  }
  /** Original main-process owner, invoked by ordinary Stop; never a renderer operation id. */
  onStopRequested?: () => void
  /** Main-only checkpoint continuation, admitted by the Host against its durable input request. */
  hostUserInputResume?: {
    requestId: string
    beforeResume: (checkpoint: unknown) => void
  }
  /** Main-only owner contract; never accepted from renderer invoke parameters. */
  deferSourceSettlement?: boolean
  /** Installed by startAgentRun for the exact original producer's logical entry. */
  onFunctionTurnSettlement?: (settlement: Promise<void>, invalidate: () => void) => void
  /** Host-issued opaque retained-package source scope; never accepted from renderer request fields. */
  pluginSourceSnapshot?: RuntimePluginSourceToken
  /** Only a resident native plugin-prompt queue can provide this private receipt. */
  pluginPrompt?: import("./mods-plugin-prompt-entry").NativePluginPromptRun
  /** Only the actual BrowserWindow invoke adapter stamps this user entry. */
  plainComposerSubmission?: import("../../shared/mods/v2/prompt-submission").PlainComposerSubmission
  fileComposerSubmission?: import("../../shared/mods/v2/composer-mentions").ComposerMentionSubmission
  source: StandardTurnSource
  /** Opt-in per-run model pin from a trusted caller; omitted callers keep global routing. */
  modelRoutingMode?: "pinned"
  localRunLease?: {
    owner: LocalThreadRunOwner
    runId: string
    /** The caller releases the lease only after its own durable settlement. */
    managedExternally?: boolean
  }
  /**
   * Who owes the follow-up summary for background work this run launches.
   *
   * Deliberately separate from `localRunLease.managedExternally`, which answers
   * "who releases the lease". Those coincide for a transport-driven run and come
   * apart for the main-process scheduler, whose own summary turn releases its
   * own lease but is desktop-owned throughout — inferring one from the other
   * marked a workflow launched from a scheduler turn as managed, leaving it to a
   * transport that had no callback for it.
   *
   * Defaults to the lease's answer when unset, which is right for every caller
   * that has not had to tell the two apart.
   */
  backgroundNotificationOwner?: BackgroundNotificationOwner
  signal?: AbortSignal
  /**
   * Re-checks the caller's authorization against the thread state the run body
   * actually resolved. Return a reason to refuse the run, or null to proceed.
   *
   * A managed transport validates its target — workspace, grant id and version,
   * feature binding, delivery context — and then does async work (title reads,
   * event bookkeeping, skill preparation) before the run starts, while the run
   * body reads the thread's *current* metadata. Anything that drifts in that
   * window would otherwise execute under an authorization never granted for it.
   *
   * The check is a callback rather than a value because only the caller knows
   * what it authorized; the run body must stay transport-neutral and has no
   * concept of a grant. It runs once, before the runtime is created.
   */
  verifyResolvedThread?: (resolved: {
    workspacePath: string | undefined
    metadata: Record<string, unknown>
  }) => string | null
  /** Main-only proof for a newly created managed session, before its session link is published. */
  legacyManagedWorkspace?: {
    projectId: string
    featureId: string
    runId: string
    threadId: string
    workspace: string
  }
  allowForeignOwnerGoalControl?: boolean
  /** Host-confirmed / selection, routed before activation on the main Bot only. */
  botSkillDispatch?: BotSkillDispatch
  trustedExplicitSkill?: SkillUseBlockMetadata
  allowTrustedTransportSkillMarker?: boolean
  remotePolicy?: RemoteTurnPolicy
  interactionWaitHooks?: RuntimeInteractionWaitHooks
  /** Trusted background callers may wait for the renderer to reopen for user input. */
  allowDeferredUserInputRenderer?: boolean
  /** Trusted host opt-in; never read from renderer input or inherited by leaf agents. */
  workflowEnabled?: boolean
  backgroundCommandLifecycle?: CreateAgentRuntimeOptions["backgroundCommandLifecycle"]
  /** Preserve a managed task's owner when a private message detaches only its foreground wait. */
  foregroundCommandLifecycle?: CreateAgentRuntimeOptions["foregroundCommandLifecycle"]
  /** Only a host-owned durable workflow receipt may invoke the internal summary turn. */
  workflowInternalNotification?: boolean
  /** Identity of the original workflow result owned by a durable local Bot receipt. */
  botWorkflowNotification?: { runId: string; startedAt: string }
  /** Bot-host receipt only; cannot be supplied through a renderer request. */
  commandInternalNotification?: boolean
  /** First conversation cue issued only by the Bot host; never a renderer-authored message. */
  botIntroduction?: boolean
  extraSystemPrompt?: string
  botCommunication?: CreateAgentRuntimeOptions["botCommunication"]
  /** Local Bot event context, appended to the new message rather than the system prefix. */
  botTurnContext?: import("./bot-turn-context").BotTurnContext
  /** Trusted host adapters can add identity-bound tools; never populated from renderer input. */
  additionalTools?: CreateAgentRuntimeOptions["additionalTools"]
  foregroundWorkBudget?: CreateAgentRuntimeOptions["foregroundWorkBudget"]
  /** Trusted Bot delivery check; renderer input cannot supply this callback. */
  checkFinalDelivery?: CreateAgentRuntimeOptions["checkFinalDelivery"]
  /** Bot main-private-chat only; not a renderer setting or a leaf-agent option. */
  openingReplyReminder?: CreateAgentRuntimeOptions["openingReplyReminder"]
  onBotDispatchFeedback?: CreateAgentRuntimeOptions["onBotDispatchFeedback"]
  toolConcurrencyQueueId?: string
  userInputWithoutToolLock?: CreateAgentRuntimeOptions["userInputWithoutToolLock"]
  botBrowserToolsOwnFileLock?: CreateAgentRuntimeOptions["botBrowserToolsOwnFileLock"]
  capabilityService?: CreateAgentRuntimeOptions["capabilityService"]
  onGoalNotice?: (notice: AgentRunGoalNotice) => void
  onFinalAssistant?: (result: AgentRunFinalAssistant) => void | Promise<void>
  /** Trusted Bot-only veto for tray/pet completion notices, evaluated after final delivery. */
  shouldRaiseCompletionAttention?: () => boolean
  onRunCancelled?: () => void
  /** The original user-prompt/steer pipeline is ready; trusted inboxes can offer saved messages. */
  onSteeringReady?: (yieldForegroundCommands?: (stillPending: () => boolean) => number) => void
  /** Bot-only receipt for verified user text and system context after the original input check. */
  onUserPromptPrepared?: (body: string, receipt?: { internalGoalInput: true }) => {
    memoryUserText?: string
    extraSystemPrompt?: string
  } | undefined
  /** Trusted Bot history only. Missing ids stay unchanged; null excludes an unaccepted input. */
  persistedUserInputProjections?: (messageIds: readonly string[]) => ReadonlyMap<string, string | null>
  /** Trusted Bot inbox only: the exact active main-model round can be superseded.
   * Undefined ends that opportunity; tools, compaction and leaf models do not expose it. */
  onModelRequestState?: (interrupt: (() => boolean) | undefined) => void
  /** Trusted local Bot only. Resume its exact yielded model checkpoint without adding a message. */
  resumeCheckpointId?: string
  /** Trusted local Bot continuation. Keep newer completed conversation history instead of restoring its old branch. */
  continueBotTaskCheckpointId?: string
  /**
   * Fires exactly once per run, before its completion promise settles.
   *
   * Most terminal paths classify themselves; the run body reports `unknown` for
   * any that does not, so a caller can always tell "ended without a reply" from
   * "never reported". Do not assume a specific code is reachable — treat an
   * unrecognized one as a plain failure.
   */
  onRunTerminated?: (terminal: AgentRunTerminal) => void
  /** Desktop transport records delivery of the request's terminal stream event. */
  onDesktopStreamDone?: (channel: string) => void
  onDetachedResultAvailable?: (signal: AgentRunDetachedResultSignal) => void
}

type AgentRunImplementation = (
  request: AgentRunRequest,
  delivery: AgentRunDelivery,
  context: AgentRunExecutionContext
) => Promise<void>

type ActiveAgentRunInspector = (threadId: string) => boolean

type ActiveAgentRunCanceller = (threadId: string) => boolean

type AgentGoalControlImplementation = (
  request: AgentGoalControlRequest,
  delivery: AgentRunDelivery,
  context: AgentRunExecutionContext
) => Promise<AgentGoalControlResult>

/**
 * Runtime injection keeps this service independent from the IPC-heavy agent.ts module:
 * agent.ts registers the implementation during Main startup, while IPC and managed-mode
 * callers both depend on startAgentRun. registerAgentRunImplementation must therefore run
 * before the first startAgentRun call. This is an initialization-order dependency, not an
 * ESM import cycle.
 */
let agentRunImplementation: AgentRunImplementation | null = null
let agentResumeImplementation: AgentRunImplementation | null = null

export function registerAgentResumeImplementation(implementation: AgentRunImplementation): void {
  agentResumeImplementation = implementation
}
let agentGoalControlImplementation: AgentGoalControlImplementation | null = null
let activeAgentRunInspector: ActiveAgentRunInspector = () => false
let activeAgentRunCanceller: ActiveAgentRunCanceller = () => false
let agentRunSettlingInspector: ActiveAgentRunInspector = () => false
const settledListeners = new Set<(threadId: string) => void>()

export function registerAgentRunSettlingInspector(inspector: ActiveAgentRunInspector): void {
  agentRunSettlingInspector = inspector
}

export function isAgentRunBusy(threadId: string): boolean {
  return activeAgentRunInspector(threadId) || agentRunSettlingInspector(threadId)
}

export function onAgentRunSettled(listener: (threadId: string) => void): () => void {
  settledListeners.add(listener)
  return () => settledListeners.delete(listener)
}

/** Called only after the actual settlement registration is removed. */
export function notifyAgentRunSettled(threadId: string): void {
  queueMicrotask(() => {
    for (const listener of settledListeners) {
      try {
        listener(threadId)
      } catch (error) {
        console.error("[Agent] Settlement listener failed:", error)
      }
    }
  })
}

let agentRunSteerer: (
  request: AgentRunSteerRequest
) => Promise<AgentRunSteerResult> = async () => ({
  queued: false,
  reason: "run_not_ready"
})

export function registerAgentRunSteerer(
  steer: (request: AgentRunSteerRequest) => Promise<AgentRunSteerResult>
): void {
  agentRunSteerer = steer
}

/** Main-process callers must supply the exact lease they own; never accepts a renderer owner. */
export function steerAgentRun(request: AgentRunSteerRequest): Promise<AgentRunSteerResult> {
  return agentRunSteerer(request)
}

export function registerAgentRunImplementation(implementation: AgentRunImplementation): void {
  agentRunImplementation = implementation
}

export function registerAgentGoalControlImplementation(
  implementation: AgentGoalControlImplementation
): void {
  agentGoalControlImplementation = implementation
}

export function registerActiveAgentRunInspector(inspector: ActiveAgentRunInspector): void {
  activeAgentRunInspector = inspector
}

export function hasActiveTopLevelAgentRun(threadId: string): boolean {
  return activeAgentRunInspector(threadId)
}

export function registerActiveAgentRunCanceller(canceller: ActiveAgentRunCanceller): void {
  activeAgentRunCanceller = canceller
}

/**
 * Aborts the local run on this thread, whatever transport it is streaming to.
 *
 * The renderer can see a background run without owning its stream — the
 * main-process summary scheduler runs on the managed transport, so the page
 * shows it the same way it shows a Zhaohu turn. Stop then went to IM's queue,
 * which does not know this run, and quietly did nothing. Cancelling has to be
 * dispatched on who actually owns the run, and that answer lives here.
 *
 * Returns whether a run was actually aborted.
 */
export function cancelActiveAgentRun(threadId: string): boolean {
  return activeAgentRunCanceller(threadId)
}

export function createBrowserWindowAgentRunDelivery(window: BrowserWindow): AgentRunDelivery {
  return {
    window,
    send(channel, payload) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return
      window.webContents.send(channel, payload)
    },
    isAvailable() {
      return !window.isDestroyed() && !window.webContents.isDestroyed()
    }
  }
}

export async function startAgentRun(
  request: AgentRunRequest,
  delivery: AgentRunDelivery,
  context: AgentRunExecutionContext = { source: "desktop" }
): Promise<AgentRunHandle> {
  if (!agentRunImplementation) {
    throw new Error("Agent run service is not initialized")
  }
  if (!delivery.isAvailable()) {
    throw new Error("Agent run delivery is unavailable")
  }
  const implementation = context.hostUserInputResume ? agentResumeImplementation : agentRunImplementation
  if (!implementation) throw Error("Agent checkpoint resume service is not initialized")
  const admission = await prepareAgentRunAdmission(request, context)
  if (admission) context = admission.context
  const cancellation = createRunCancellationSettlement()
  const onRunCancelled = context.onRunCancelled
  context = { ...context, onRunCancelled: () => {
    recordRunCancellation()
    onRunCancelled?.()
  } }
  const deferred =
    context.deferSourceSettlement === true && context.localRunLease?.managedExternally === true
  const logicalSettlements = new Map<Promise<void>, () => void>()
  let sourceOwnerLost = false
  if (deferred)
    context = {
      ...context,
      onFunctionTurnSettlement: (settlement, invalidate) => {
        logicalSettlements.set(settlement, invalidate)
        if (sourceOwnerLost) invalidate()
      }
    }
  const reportSettlementFailure = (error: unknown) => {
    if (error instanceof FunctionTurnSettlementFailure)
      context.onRunTerminated?.({
        outcome: "unknown",
        code: "function_turn_settlement_unconfirmed",
        error
      })
  }
  const coordinatorInternal = context.remotePolicy?.disableMessageControls !== true &&
    request.coordinatorInternalNotification === true &&
    request.message.trimStart().startsWith(COORDINATOR_NOTIFICATION_PROMPT_PREFIX)
  const ambientChannel = `agent:stream:${request.threadId}${coordinatorInternal ? ":coordinator-internal" : ""}`
  const physical = Promise.resolve()
    .then(() =>
      withRuntimePluginSource(context.pluginSourceSnapshot, () =>
        cancellation.run(() => runDeliveryStorage.run({
          threadId: request.threadId,
          channel: resolveAgentStreamRequestChannel(ambientChannel, request.streamRequestId),
          delivery
        }, () => implementation(request, delivery, context)))
      )
    )
    .catch((error) => {
      reportSettlementFailure(error)
      throw error
    })
  if (deferred) {
    const sourceSettlement = physical
      .catch(() => {})
      .then(async () => {
        try {
          // Every captured entry is the original run, not a later same-thread run.
          // Drain all entries before cleanup even when one authority has failed.
          const results = await Promise.allSettled(
            [...logicalSettlements.keys()].map(settleAgentFunctionTurn)
          )
          const failure = results.find((result) => result.status === "rejected")
          const error =
            failure?.status === "rejected"
              ? failure.reason
              : sourceOwnerLost
                ? new FunctionTurnSettlementFailure(new Error("MODS_CALL_SCOPE_CHANGED"))
                : undefined
          if (error) {
            reportSettlementFailure(error)
            throw error
          }
        } finally {
          await admission?.settle()
        }
      })
    // The original owner receives this promise before awaiting physical completion.
    // Its durable delivery may fail first; rejection must still remain observed.
    void sourceSettlement.catch(() => {})
    return {
      threadId: request.threadId,
      cancellationSettlement: cancellation.read,
      completion: physical.finally(() => delivery.finish?.(request.threadId)),
      sourceSettlement,
      invalidateSourceSettlement: () => {
        sourceOwnerLost = true
        for (const invalidate of logicalSettlements.values()) invalidate()
      }
    }
  }
  const completion = physical.finally(async () => {
    try {
      await admission?.settle()
    } finally {
      delivery.finish?.(request.threadId)
    }
  })
  return {
    threadId: request.threadId,
    cancellationSettlement: cancellation.read,
    completion
  }
}

export async function controlAgentGoal(
  request: AgentGoalControlRequest,
  delivery: AgentRunDelivery,
  context: AgentRunExecutionContext = { source: "desktop" }
): Promise<AgentGoalControlResult> {
  if (!agentGoalControlImplementation) {
    throw new Error("Agent goal control service is not initialized")
  }
  if (!delivery.isAvailable()) {
    throw new Error("Agent run delivery is unavailable")
  }
  return agentGoalControlImplementation(request, delivery, context)
}
