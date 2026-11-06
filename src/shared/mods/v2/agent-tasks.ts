import type { FunctionSessionMessage } from "./session"
import type { ModObject } from "../types"
import { isModObject, ModFunctionError } from "./contracts"

export type AgentTaskState =
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown"
export interface AgentTaskStatus {
  agentId: string
  status: AgentTaskState
  model: string
  description: string
  startedAt: number
  finishedAt?: number
  scope: {
    workspace: string
    readOnly: boolean
    allowedTools?: string[]
    blockedTools: string[]
    maxTurns?: number
  }
  outcome?: { answer: string; reason: string; durationMs: number; isAborted: boolean }
  diagnostic?: string
}
export interface AgentTaskMessages {
  agentId: string
  messages: FunctionSessionMessage[]
  nextCursor?: string
  truncated: boolean
  skippedMessages: number
  history: "retained" | "partial" | "unavailable"
}
export interface AgentViewIntent {
  id: string
  threadId: string
  workspace: string
  agentId: string
  parentIncarnation: string
  sourceDigest: string
  mode?: "readonly" | "interactive"
}
export interface AgentViewApi {
  onAgentViewRequested(callback: (event: { threadId: string }) => void): () => void
  agentViewPending(threadId: string): Promise<AgentViewIntent | null>
  agentViewRead(input: { threadId: string; intentId: string; cursor?: string }): Promise<{ status: AgentTaskStatus; messages: AgentTaskMessages }>
  agentViewStop(input: { threadId: string; intentId: string }): Promise<{ agentId: string; stopRequested: boolean; status: string }>
  agentViewClose(input: { threadId: string; intentId: string }): Promise<void>
  agentViewActivate(input: { threadId: string; intentId: string }): Promise<{ active: boolean }>
  agentViewSend(input: { threadId: string; intentId: string; sequence: number; text: string }):
    Promise<{ isDelivered: boolean; reason?: string }>
}
export function agentTaskInput(method: string, input: unknown): ModObject {
  if (
    !isModObject(input) ||
    typeof input.agentId !== "string" ||
    !input.agentId ||
    input.agentId.length > 256 ||
    Object.keys(input).some(
      (key) => !(method === "agent.messages" ? ["agentId", "cursor", "limit"] :
        method === "ui.view" ? ["agentId", "mode"] : ["agentId"]).includes(key)
    ) ||
    (input.mode !== undefined && !["readonly", "interactive"].includes(String(input.mode))) ||
    (input.cursor !== undefined &&
      (typeof input.cursor !== "string" || input.cursor.length > 512)) ||
    (input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 100))
  )
    throw new ModFunctionError("MODS_AGENT_TASK_ARGUMENTS")
  return input
}
