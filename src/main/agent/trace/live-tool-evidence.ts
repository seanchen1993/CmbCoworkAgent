import { randomUUID } from "node:crypto"
import type { McpCapabilityService, McpInvocationResult } from "../../mcp/capability-types"
import type { TraceContext, TraceNodeStatus } from "./types"
import type { TraceCollector } from "./collector"

interface Binding {
  context: Readonly<TraceContext>
  collector: Pick<TraceCollector, "addToolNode" | "addToolResultNode">
  active(): boolean
}
const bindings = new WeakMap<TraceContext, Binding>()

/** Only a live native collector binds this identity. Serialized trace IDs cannot append evidence. */
export function bindLiveToolEvidence<T extends TraceContext>(
  context: T,
  collector: Binding["collector"],
  active: () => boolean
): T {
  bindings.set(context, { context: Object.freeze({ ...context }), collector, active })
  return context
}

function quietly<T>(run: () => T): T | undefined {
  try {
    return run()
  } catch {
    return undefined
  }
}

/** Actual transport outcomes only; no tool arguments, credentials, results or guest claims. */
export function traceCodeExecCalls(
  service: McpCapabilityService,
  context?: TraceContext,
  toolCallId?: string
): McpCapabilityService {
  const binding = context && bindings.get(context)
  if (!binding || !quietly(binding.active)) return service
  const callId =
    typeof toolCallId === "string" && toolCallId.length > 0 && toolCallId.length <= 200
      ? toolCallId
      : randomUUID()
  const parentId = quietly(() =>
    binding.collector.addToolNode({
      name: "code_exec",
      toolCallId: callId,
      parentId: binding.context.rootNodeId,
      metadata: { executionOrigin: "code-exec", evidenceCoverage: "host-call-observation" }
    })
  )
  if (!parentId) return service
  const invoke: McpCapabilityService["invoke"] = async (name, args, assertCurrent) => {
    let nodeId: string | undefined
    const nestedCallId = randomUUID()
    if (quietly(binding.active))
      nodeId = quietly(() =>
        binding.collector.addToolNode({
          name: /^[A-Za-z0-9_.:-]{1,200}$/.test(name) ? name : "MCP call",
          parentId,
          toolCallId: nestedCallId,
          metadata: {
            executionOrigin: "code-exec-mcp",
            evidenceCoverage: "host-call-observation",
            parentToolCallId: callId,
            argumentsRecorded: false,
            resultRecorded: false
          }
        })
      )
    const started = performance.now()
    const finish = (status: TraceNodeStatus) => {
      if (!nodeId || !quietly(binding.active)) return
      quietly(() =>
        binding.collector.addToolResultNode({
          parentId: nodeId,
          status,
          metadata: {
            evidenceCoverage: "host-call-observation",
            durationMs: Math.max(0, performance.now() - started),
            argumentsRecorded: false,
            resultRecorded: false
          }
        })
      )
    }
    try {
      // Preserve the exact original admission, fallback and retry behavior and third argument.
      const result: McpInvocationResult = await service.invoke(name, args, assertCurrent)
      finish(result.isError ? "error" : "success")
      return result
    } catch (error) {
      finish("error")
      throw error
    }
  }
  // Bind borrowed class methods to the original receiver; do not change connection ownership.
  return {
    listTools: service.listTools.bind(service),
    getTool: service.getTool.bind(service),
    invoke,
    invalidate: service.invalidate.bind(service),
    close: service.close.bind(service),
    ...(service.configuredServerNames
      ? { configuredServerNames: service.configuredServerNames.bind(service) }
      : {}),
    ...(service.peekTools ? { peekTools: service.peekTools.bind(service) } : {}),
    ...(service.getSnapshot ? { getSnapshot: service.getSnapshot.bind(service) } : {}),
    ...(service.connectPluginServer
      ? { connectPluginServer: service.connectPluginServer.bind(service) }
      : {})
  }
}
