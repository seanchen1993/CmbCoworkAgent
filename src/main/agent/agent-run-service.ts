import type { BrowserWindow } from "electron"
import type { BackgroundNotificationOwner } from "../../shared/internal-notification-turn"
import type { SkillUseBlockMetadata } from "../../shared/skill-use-block"
import type { AgentInvokeParams } from "../types"
import type { CreateAgentRuntimeOptions, RuntimeInteractionWaitHooks } from "./runtime"
import type { RemoteTurnPolicy, StandardTurnSource } from "./standard-thread-turn"
import type { LocalThreadRunOwner } from "./thread-run-lease"
import type { CurrentRunQueuedMessage } from "./current-run-message-queue"

export interface AgentRunSteerRequest {
  threadId: string
  owner: LocalThreadRunOwner
  runId: string
  message: CurrentRunQueuedMessage
}

export interface AgentRunSteerResult {
  queued: boolean
  reason?: string
  message?: string
}

export type AgentRunRequest = AgentInvokeParams

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

export interface AgentRunHandle {
  threadId: string
  completion: Promise<void>
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
  source: StandardTurnSource
  /** Trusted main-process profile. Never read from AgentInvokeParams/renderer/IM. */
  partnerInputOnly?: {
    systemPrompt: string
    modelRef: string
    modelConfigHash?: string
  }
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
  allowForeignOwnerGoalControl?: boolean
  trustedExplicitSkill?: SkillUseBlockMetadata
  allowTrustedTransportSkillMarker?: boolean
  remotePolicy?: RemoteTurnPolicy
  interactionWaitHooks?: RuntimeInteractionWaitHooks
  /** Trusted background callers may wait for the renderer to reopen for user input. */
  allowDeferredUserInputRenderer?: boolean
  /** Trusted host opt-in; never read from renderer input or inherited by leaf agents. */
  workflowEnabled?: boolean
  backgroundCommandLifecycle?: CreateAgentRuntimeOptions["backgroundCommandLifecycle"]
  /** Only a host-owned durable workflow receipt may invoke the internal summary turn. */
  workflowInternalNotification?: boolean
  /** Bot-host receipt only; cannot be supplied through a renderer request. */
  commandInternalNotification?: boolean
  /** First conversation cue issued only by the Bot host; never a renderer-authored message. */
  botIntroduction?: boolean
  extraSystemPrompt?: string
  /** Trusted host adapters can add identity-bound tools; never populated from renderer input. */
  additionalTools?: CreateAgentRuntimeOptions["additionalTools"]
  toolConcurrencyQueueId?: string
  userInputWithoutToolLock?: CreateAgentRuntimeOptions["userInputWithoutToolLock"]
  botBrowserToolsOwnFileLock?: CreateAgentRuntimeOptions["botBrowserToolsOwnFileLock"]
  capabilityService?: CreateAgentRuntimeOptions["capabilityService"]
  onGoalNotice?: (notice: AgentRunGoalNotice) => void
  onFinalAssistant?: (result: AgentRunFinalAssistant) => void | Promise<void>
  onRunCancelled?: () => void
  /** The original user-prompt/steer pipeline is ready; trusted inboxes can offer saved messages. */
  onSteeringReady?: () => void
  /** Trusted Bot inbox only: the exact active main-model round can be superseded.
   * Undefined ends that opportunity; tools, compaction and leaf models do not expose it. */
  onModelRequestState?: (interrupt: (() => boolean) | undefined) => void
  /**
   * Fires exactly once per run, before its completion promise settles.
   *
   * Most terminal paths classify themselves; the run body reports `unknown` for
   * any that does not, so a caller can always tell "ended without a reply" from
   * "never reported". Do not assume a specific code is reachable — treat an
   * unrecognized one as a plain failure.
   */
  onRunTerminated?: (terminal: AgentRunTerminal) => void
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
let partnerInputOnlyImplementation: AgentRunImplementation | null = null
let agentGoalControlImplementation: AgentGoalControlImplementation | null = null
let activeAgentRunInspector: ActiveAgentRunInspector = () => false
let activeAgentRunCanceller: ActiveAgentRunCanceller = () => false
let agentRunSteerer: (request: AgentRunSteerRequest) => Promise<AgentRunSteerResult> = async () => ({
  queued: false, reason: "run_not_ready"
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

export function registerPartnerInputOnlyImplementation(
  implementation: AgentRunImplementation
): void {
  partnerInputOnlyImplementation = implementation
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
  // An uninitialized restricted profile MUST NOT fall through to the personal
  // desktop body (skills/Hooks/history/default model). Old callers are unchanged.
  const implementation = context.partnerInputOnly
    ? partnerInputOnlyImplementation
    : agentRunImplementation
  if (!implementation) {
    throw new Error("Agent run service is not initialized")
  }
  if (!delivery.isAvailable()) {
    throw new Error("Agent run delivery is unavailable")
  }
  const completion = implementation(request, delivery, context).finally(() => {
    delivery.finish?.(request.threadId)
  })
  return {
    threadId: request.threadId,
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
