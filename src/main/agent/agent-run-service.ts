import type { BrowserWindow } from "electron"
import type { SkillUseBlockMetadata } from "../../shared/skill-use-block"
import type { AgentInvokeParams } from "../types"
import type { RuntimeInteractionWaitHooks } from "./runtime"
import type { RemoteTurnPolicy, StandardTurnSource } from "./standard-thread-turn"
import type { LocalThreadRunOwner } from "./thread-run-lease"

export type AgentRunRequest = AgentInvokeParams

export interface AgentRunDelivery {
  window: BrowserWindow
  send(channel: string, payload: unknown): void
  isAvailable(): boolean
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
  localRunLease?: {
    owner: LocalThreadRunOwner
    runId: string
    /** The caller releases the lease only after its own durable settlement. */
    managedExternally?: boolean
  }
  signal?: AbortSignal
  allowForeignOwnerGoalControl?: boolean
  trustedExplicitSkill?: SkillUseBlockMetadata
  allowTrustedTransportSkillMarker?: boolean
  remotePolicy?: RemoteTurnPolicy
  interactionWaitHooks?: RuntimeInteractionWaitHooks
  extraSystemPrompt?: string
  onGoalNotice?: (notice: AgentRunGoalNotice) => void
  onFinalAssistant?: (result: AgentRunFinalAssistant) => void | Promise<void>
  onRunCancelled?: () => void
  onDetachedResultAvailable?: (signal: AgentRunDetachedResultSignal) => void
}

type AgentRunImplementation = (
  request: AgentRunRequest,
  delivery: AgentRunDelivery,
  context: AgentRunExecutionContext
) => Promise<void>

type ActiveAgentRunInspector = (threadId: string) => boolean

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
let agentGoalControlImplementation: AgentGoalControlImplementation | null = null
let activeAgentRunInspector: ActiveAgentRunInspector = () => false

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
  const completion = agentRunImplementation(request, delivery, context)
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
