import type {
  AgentTrace,
  TraceChatMessage,
  TraceNode,
  TraceNodeStatus,
  TraceToolCall
} from "./types"

function outcomeToStatus(outcome: AgentTrace["outcome"]): TraceNodeStatus {
  if (outcome === "error") return "error"
  if (outcome === "cancelled") return "cancelled"
  if (outcome === "unknown") return "unknown"
  return "success"
}

function hasUserMessageNode(trace: AgentTrace, nodes: TraceNode[]): boolean {
  return nodes.some((node) => {
    if (node.type !== "message") return false
    if (node.name === "User Message") return true
    if (typeof node.output === "string" && node.output === trace.userMessage) return true
    if (node.input && typeof node.input === "object" && "userMessage" in node.input) return true
    return false
  })
}

function createUserMessageNode(trace: AgentTrace, parentId: string): TraceNode {
  return {
    id: `legacy:user:${trace.traceId}`,
    type: "message",
    parentId,
    name: "User Message",
    status: "success",
    startedAt: trace.startedAt,
    endedAt: trace.startedAt,
    output: trace.userMessage
  }
}

function ensureRootNode(trace: AgentTrace, nodes: TraceNode[]): TraceNode[] {
  const rootId = `trace:${trace.traceId}`
  const root = nodes.find((node) => node.parentId === null || node.type === "trace")
  if (root) {
    const normalized = nodes.map((node) => {
      if (node !== root) {
        return node.parentId ? node : { ...node, parentId: root.id }
      }
      return {
        ...node,
        parentId: null,
        input: node.input ?? { userMessage: trace.userMessage }
      }
    })
    const rootNode = normalized.find((node) => node.id === root.id) ?? normalized[0]
    const rest = normalized.filter((node) => node !== rootNode)
    return hasUserMessageNode(trace, normalized)
      ? normalized
      : [rootNode, createUserMessageNode(trace, root.id), ...rest]
  }

  return [
    {
      id: rootId,
      type: "trace",
      parentId: null,
      name: "Agent Trace",
      status: outcomeToStatus(trace.outcome),
      startedAt: trace.startedAt,
      endedAt: trace.endedAt,
      input: { userMessage: trace.userMessage },
      output: {
        outcome: trace.outcome,
        totalToolCalls: trace.totalToolCalls
      },
      metadata: {
        traceId: trace.traceId,
        threadId: trace.threadId,
        modelId: trace.modelId
      }
    },
    createUserMessageNode(trace, rootId),
    ...nodes.map((node) => ({
      ...node,
      parentId: node.parentId ?? rootId
    }))
  ]
}

function pickToolCalls(
  modelToolCalls: TraceToolCall[] | undefined,
  stepToolCalls: TraceToolCall[]
): TraceToolCall[] {
  if (Array.isArray(modelToolCalls) && modelToolCalls.length > 0) return modelToolCalls
  return stepToolCalls
}

function isChatMessageArray(value: unknown): value is TraceChatMessage[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        typeof (item as TraceChatMessage).role === "string"
    )
  )
}

/**
 * The collector stores each chat message once per trace and records later
 * occurrences as `{ role, ref }`. Rebuild the full windows here — this is the
 * single entry point every display path goes through, so nothing downstream
 * ever sees a ref.
 */
function rehydrateChatMessages(trace: AgentTrace, nodes: TraceNode[]): TraceNode[] {
  const byId = new Map<string, TraceChatMessage>()
  const collect = (messages: readonly TraceChatMessage[]): void => {
    for (const message of messages) {
      if (typeof message.mid === "string" && !byId.has(message.mid)) byId.set(message.mid, message)
    }
  }
  for (const node of nodes) if (isChatMessageArray(node.input)) collect(node.input)
  for (const call of trace.modelCalls ?? []) collect(call.inputMessages ?? [])
  if (byId.size === 0) return nodes

  const resolve = (messages: readonly TraceChatMessage[]): TraceChatMessage[] =>
    messages.map((message) => {
      if (typeof message.ref !== "string") return message
      const source = byId.get(message.ref)
      // A dangling ref means the occurrence holding the content was dropped by
      // a cap or the byte budget. Keep the placeholder shape rather than
      // inventing content.
      if (!source) return { ...message, content: "" }
      return { ...source, ...(message.name ? { name: message.name } : {}) }
    })

  return nodes.map((node) =>
    isChatMessageArray(node.input) ? { ...node, input: resolve(node.input) } : node
  )
}

export function buildTraceTree(trace: AgentTrace): TraceNode[] {
  if (Array.isArray(trace.nodes) && trace.nodes.length > 0) {
    return rehydrateChatMessages(trace, ensureRootNode(trace, trace.nodes))
  }

  const rootId = `trace:${trace.traceId}`
  const nodes: TraceNode[] = [
    {
      id: rootId,
      type: "trace",
      parentId: null,
      name: "Agent Trace",
      status: outcomeToStatus(trace.outcome),
      startedAt: trace.startedAt,
      endedAt: trace.endedAt,
      input: { userMessage: trace.userMessage },
      output: {
        outcome: trace.outcome,
        totalToolCalls: trace.totalToolCalls
      },
      metadata: {
        traceId: trace.traceId,
        threadId: trace.threadId,
        modelId: trace.modelId
      }
    },
    {
      id: `legacy:user:${trace.traceId}`,
      type: "message",
      parentId: rootId,
      name: "User Message",
      status: "success",
      startedAt: trace.startedAt,
      endedAt: trace.startedAt,
      output: trace.userMessage
    }
  ]

  const modelCalls = Array.isArray(trace.modelCalls) ? trace.modelCalls : []
  const maxRuns = Math.max(modelCalls.length, trace.steps.length)

  for (let i = 0; i < maxRuns; i++) {
    const modelCall = modelCalls[i]
    const step = trace.steps[i]
    const llmId = `legacy:llm:${trace.traceId}:${i}`
    const llmStartedAt = modelCall?.startedAt ?? step?.startedAt ?? trace.startedAt
    const llmOutput = modelCall?.outputMessage?.content ?? step?.assistantText ?? ""
    const isLast = i === maxRuns - 1
    const llmStatus: TraceNodeStatus =
      trace.outcome === "error" && isLast
        ? "error"
        : trace.outcome === "unknown" && isLast
          ? "unknown"
          : "success"

    nodes.push({
      id: llmId,
      type: "llm",
      parentId: rootId,
      name: `LLM Call #${i + 1}`,
      status: llmStatus,
      startedAt: llmStartedAt,
      endedAt: llmStartedAt,
      input: modelCall?.inputMessages ?? [],
      output: llmOutput,
      metadata: {
        messageId: modelCall?.messageId,
        tokenUsage: modelCall?.tokenUsage,
        ...(modelCall?.outputMessage?.reasoning
          ? { reasoning: modelCall.outputMessage.reasoning }
          : {})
      }
    })

    const toolCalls = pickToolCalls(modelCall?.toolCalls, step?.toolCalls ?? [])
    for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex++) {
      const toolCall = toolCalls[toolIndex]
      const toolId = `legacy:tool:${trace.traceId}:${i}:${toolIndex}`
      nodes.push({
        id: toolId,
        type: "tool",
        parentId: llmId,
        name: toolCall.name,
        status: "success",
        startedAt: llmStartedAt,
        endedAt: llmStartedAt,
        input: toolCall.args
      })

      if (toolCall.result !== undefined) {
        nodes.push({
          id: `legacy:tool_result:${trace.traceId}:${i}:${toolIndex}`,
          type: "tool_result",
          parentId: toolId,
          name: `${toolCall.name} result`,
          status: "success",
          startedAt: llmStartedAt,
          endedAt: llmStartedAt,
          output: toolCall.result
        })
      }
    }
  }

  if (trace.outcome === "error") {
    nodes.push({
      id: `legacy:error:${trace.traceId}`,
      type: "error",
      parentId: rootId,
      name: "Run Error",
      status: "error",
      startedAt: trace.endedAt,
      endedAt: trace.endedAt,
      output: trace.errorMessage ?? "Unknown error"
    })
  } else if (trace.outcome === "cancelled") {
    nodes.push({
      id: `legacy:cancel:${trace.traceId}`,
      type: "cancel",
      parentId: rootId,
      name: "Run Cancelled",
      status: "cancelled",
      startedAt: trace.endedAt,
      endedAt: trace.endedAt,
      output: "Cancelled"
    })
  } else if (trace.outcome === "unknown") {
    nodes.push({
      id: `legacy:unknown:${trace.traceId}`,
      type: "message",
      parentId: rootId,
      name: "Run Ended",
      status: "unknown",
      startedAt: trace.endedAt,
      endedAt: trace.endedAt,
      output: trace.errorMessage ?? "Run ended without a final success signal"
    })
  } else {
    nodes.push({
      id: `legacy:done:${trace.traceId}`,
      type: "message",
      parentId: rootId,
      name: "Run Completed",
      status: "success",
      startedAt: trace.endedAt,
      endedAt: trace.endedAt,
      output: "Completed"
    })
  }

  // Legacy traces with no persisted nodes: the windows come from modelCalls,
  // which carry the same refs, so they need the same rehydration.
  return rehydrateChatMessages(trace, nodes)
}
