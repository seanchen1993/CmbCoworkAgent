import type { HookContext } from "./runner"

export interface SubagentStartToolCall {
  id?: string
  name?: string
  args?: Record<string, unknown>
}

/** Extract task tool calls from the serialized `messages` stream payload. */
export function extractSubagentStartToolCallsFromStreamPayload(
  payload: unknown
): SubagentStartToolCall[] {
  const msgChunk = Array.isArray(payload)
    ? (payload[0] as
        | { id?: unknown; kwargs?: Record<string, unknown>; content?: unknown }
        | undefined)
    : undefined
  if (!msgChunk) return []

  const kwargs = (msgChunk.kwargs || {}) as Record<string, unknown>
  const classId: string[] = Array.isArray(msgChunk.id) ? msgChunk.id : []
  const className = classId[classId.length - 1] || ""
  if (!className.includes("AI") && kwargs.type !== "ai") return []
  if (!Array.isArray(kwargs.tool_calls)) return []

  return kwargs.tool_calls.filter(
    (toolCall): toolCall is SubagentStartToolCall =>
      Boolean(toolCall) &&
      typeof toolCall === "object" &&
      !Array.isArray(toolCall) &&
      (toolCall as { name?: unknown }).name === "task"
  )
}

export interface SubagentStartHookContextInput {
  workspacePath?: string
  threadId: string
  turnId?: string
  toolCallId: string
  subagentType?: string
  taskDescription?: string
}

export type SubagentStopHarnessContext = Pick<
  HookContext,
  | "workspacePath"
  | "pluginOutputDir"
  | "systemId"
  | "pluginWorkspace"
  | "featureId"
  | "harnessProjectId"
  | "harnessAdapterName"
  | "harnessAdapterVersion"
  | "harnessNodeName"
  | "harnessNodeStatus"
  | "projectCode"
  | "projectDir"
>

export interface SubagentStopHookContextInput extends SubagentStopHarnessContext {
  threadId: string
  turnId?: string
  toolCallId: string
  failed: boolean
}

export function buildSubagentStartHookContext(input: SubagentStartHookContextInput): HookContext {
  return {
    workspacePath: input.workspacePath,
    sessionId: input.threadId,
    agentId: input.toolCallId,
    turnId: input.turnId,
    subagent: {
      id: input.toolCallId,
      name: input.subagentType,
      status: "started"
    },
    toolName: "task",
    toolArgs: {
      agent_id: input.toolCallId,
      agent_type: input.subagentType,
      tool_call_id: input.toolCallId,
      task_description: input.taskDescription
    }
  }
}

export function buildSubagentStopHookContext(input: SubagentStopHookContextInput): HookContext {
  return {
    workspacePath: input.workspacePath,
    agentId: input.toolCallId,
    pluginOutputDir: input.pluginOutputDir,
    systemId: input.systemId,
    pluginWorkspace: input.pluginWorkspace,
    featureId: input.featureId,
    harnessProjectId: input.harnessProjectId,
    harnessAdapterName: input.harnessAdapterName,
    harnessAdapterVersion: input.harnessAdapterVersion,
    harnessNodeName: input.harnessNodeName,
    harnessNodeStatus: input.harnessNodeStatus,
    projectCode: input.projectCode,
    projectDir: input.projectDir,
    sessionId: input.threadId,
    turnId: input.turnId,
    subagent: {
      id: input.toolCallId,
      status: input.failed ? "failed" : "completed"
    }
  }
}
