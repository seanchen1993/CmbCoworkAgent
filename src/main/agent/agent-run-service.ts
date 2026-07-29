import type { BrowserWindow } from "electron"
import type { AgentInvokeParams } from "../types"

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

type AgentRunImplementation = (
  request: AgentRunRequest,
  delivery: AgentRunDelivery
) => Promise<void>

/**
 * Runtime injection keeps this service independent from the IPC-heavy agent.ts module:
 * agent.ts registers the implementation during Main startup, while IPC and managed-mode
 * callers both depend on startAgentRun. registerAgentRunImplementation must therefore run
 * before the first startAgentRun call. This is an initialization-order dependency, not an
 * ESM import cycle.
 */
let agentRunImplementation: AgentRunImplementation | null = null

export function registerAgentRunImplementation(implementation: AgentRunImplementation): void {
  agentRunImplementation = implementation
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
  delivery: AgentRunDelivery
): Promise<AgentRunHandle> {
  if (!agentRunImplementation) {
    throw new Error("Agent run service is not initialized")
  }
  if (!delivery.isAvailable()) {
    throw new Error("Agent run delivery is unavailable")
  }
  const completion = agentRunImplementation(request, delivery)
  return {
    threadId: request.threadId,
    completion
  }
}
