import assert from "node:assert/strict"
import { ElectronIPCTransport } from "../src/renderer/src/lib/electron-transport"

interface SdkEvent {
  event: string
  data: unknown
}

interface TestableTransport {
  convertToSDKEvents(
    event: unknown,
    threadId: string,
    agentMode?: "normal" | "coordinator" | "workflow"
  ): SdkEvent[]
}

function valuesMessage(
  className: "AIMessage" | "ToolMessage",
  index: number,
  input: {
    id?: string
    content?: string
    toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
    toolCallId?: string
    name?: string
  }
): unknown {
  return {
    id: ["langchain_core", "messages", className],
    kwargs: {
      ...(input.id ? { id: input.id } : {}),
      content: input.content ?? "",
      additional_kwargs: { cmb_worker_snapshot_index: index },
      ...(input.toolCalls ? { tool_calls: input.toolCalls } : {}),
      ...(input.toolCallId ? { tool_call_id: input.toolCallId } : {}),
      ...(input.name ? { name: input.name } : {})
    }
  }
}

function convert(
  transport: ElectronIPCTransport,
  messages: unknown[],
  valuesSnapshotKind: "full" | "append" | "tail"
): SdkEvent[] {
  return (transport as unknown as TestableTransport).convertToSDKEvents(
    {
      type: "stream",
      mode: "values",
      data: { messages },
      valuesSnapshotKind
    },
    "foreground-delta-thread",
    "normal"
  )
}

const transport = new ElectronIPCTransport()
const initialIdless = valuesMessage("AIMessage", 10_000, { content: "a" })
const initialEvents = convert(transport, [initialIdless], "full")
const initialValues = initialEvents.find((event) => event.event === "values")?.data as
  | { messages?: Array<{ id: string; content: string }> }
  | undefined
assert.equal(initialValues?.messages?.length, 1)
const stableFallbackId = initialValues!.messages![0].id

const grownIdless = valuesMessage("AIMessage", 10_000, { content: "answer complete" })
const tailEvents = convert(transport, [grownIdless], "tail")
const tailValues = tailEvents.find((event) => event.event === "values")?.data as
  | { messages?: Array<{ id: string; content: string }> }
  | undefined
assert.equal(tailValues?.messages?.[0]?.id, stableFallbackId)
assert.equal(tailValues?.messages?.[0]?.content, "answer complete")

const repeatedTask = {
  id: "reused-task",
  name: "task",
  args: { subagent_type: "general-purpose", prompt: "inspect" }
}
const firstTaskParent = valuesMessage("AIMessage", 10_001, {
  id: "reused-parent",
  toolCalls: [repeatedTask]
})
const firstTaskResult = valuesMessage("ToolMessage", 10_002, {
  id: "first-result",
  toolCallId: "reused-task",
  name: "task",
  content: "first complete"
})
convert(transport, [firstTaskParent], "append")
convert(transport, [firstTaskResult], "append")

const secondTaskParent = valuesMessage("AIMessage", 10_003, {
  id: "reused-parent",
  toolCalls: [repeatedTask]
})
const secondTaskEvents = convert(transport, [secondTaskParent], "append")
const subagentSnapshots = secondTaskEvents
  .filter((event) => event.event === "custom")
  .map((event) => event.data as { type?: string; subagents?: unknown[] })
  .filter((event) => event.type === "subagents")
const latestSubagents = subagentSnapshots.at(-1)?.subagents
assert.equal(latestSubagents?.length, 2)

console.log("foreground values delta tests passed")
