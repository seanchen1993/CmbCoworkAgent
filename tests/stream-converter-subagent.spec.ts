/**
 * Focused tests for scheduler StreamConverter subagent transcript routing.
 *
 * Run:
 *   npx -y tsx tests/stream-converter-subagent.spec.ts
 */

import { StreamConverter } from "../src/main/agent/stream-converter"

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

function aiMessage(id: string, toolCalls?: unknown[]): unknown {
  return [
    {
      id: ["langchain_core", "messages", "AIMessage"],
      kwargs: {
        id,
        content: "",
        ...(toolCalls ? { tool_calls: toolCalls } : {})
      }
    },
    { langgraph_checkpoint_ns: "agent" }
  ]
}

function aiMessageChunk(input: {
  id: string
  toolCallChunks?: Array<{ id?: string; name?: string; args?: string }>
}): unknown {
  return [
    {
      id: ["langchain_core", "messages", "AIMessageChunk"],
      kwargs: {
        id: input.id,
        content: "",
        ...(input.toolCallChunks ? { tool_call_chunks: input.toolCallChunks } : {})
      }
    },
    { langgraph_checkpoint_ns: "agent" }
  ]
}

function toolMessage(input: {
  id: string
  toolCallId: string
  name: string
  content: string
  status?: string
  checkpointNs: string
}): unknown {
  return [
    {
      id: ["langchain_core", "messages", "ToolMessage"],
      kwargs: {
        id: input.id,
        type: "tool",
        content: input.content,
        tool_call_id: input.toolCallId,
        name: input.name,
        ...(input.status ? { status: input.status } : {})
      }
    },
    { langgraph_checkpoint_ns: input.checkpointNs }
  ]
}

async function testSubagentToolErrorsAreForwarded(): Promise<void> {
  const converter = new StreamConverter()

  converter.processChunk(
    "messages",
    aiMessage("main-ai", [
      {
        id: "task-1",
        name: "task",
        args: { subagent_type: "implementer", description: "inspect failure" }
      }
    ])
  )

  const events = converter.processChunk(
    "messages",
    toolMessage({
      id: "inner-tool-result",
      toolCallId: "inner-tool-call",
      name: "read_file",
      content: "permission denied",
      status: "error",
      checkpointNs: "agent:tools:task-1"
    })
  )

  const toolEvent = events.find((event) => event.type === "tool-message")
  assert(toolEvent, "subagent interior tool result should produce a tool-message event")
  assert(toolEvent?.subagentId === "task-1", "tool-message should be routed to the subagent")
  assert(toolEvent?.isError === true, "failed subagent tool result should preserve isError")
}

async function testPrefixedNamespaceRoutesConcurrentSubagents(): Promise<void> {
  const converter = new StreamConverter()

  converter.processChunk(
    "messages",
    aiMessage("main-ai", [
      {
        id: "task-1",
        name: "task",
        args: { subagent_type: "implementer", description: "inspect first" }
      },
      {
        id: "task-2",
        name: "task",
        args: { subagent_type: "verifier", description: "inspect second" }
      }
    ])
  )

  const firstEvents = converter.processChunk(
    "messages",
    toolMessage({
      id: "inner-tool-result-1",
      toolCallId: "inner-tool-call-1",
      name: "read_file",
      content: "first result",
      checkpointNs: "agent:tools:runtime-task-a|read_file:1"
    })
  )
  const firstToolEvent = firstEvents.find((event) => event.type === "tool-message")
  assert(firstToolEvent?.subagentId === "task-1", "first runtime task uuid should map to task-1")

  const secondEvents = converter.processChunk(
    "messages",
    toolMessage({
      id: "inner-tool-result-2",
      toolCallId: "inner-tool-call-2",
      name: "list_dir",
      content: "second result",
      checkpointNs: "agent:tools:runtime-task-b|list_dir:1"
    })
  )
  const secondToolEvent = secondEvents.find((event) => event.type === "tool-message")
  assert(
    secondToolEvent?.subagentId === "task-2",
    "second runtime task uuid should map to the next running subagent"
  )
}

async function testSubagentToolCallChunksAreForwarded(): Promise<void> {
  const converter = new StreamConverter()

  converter.processChunk(
    "messages",
    aiMessage("main-ai", [
      {
        id: "task-1",
        name: "task",
        args: { subagent_type: "implementer", description: "stream chunks" }
      }
    ])
  )

  converter.processChunk("messages", [
    (aiMessageChunk({
      id: "subagent-ai",
      toolCallChunks: [
        {
          id: "inner-tool-call",
          name: "read_file",
          args: '{"file_path":"README'
        }
      ]
    }) as [unknown, unknown])[0],
    { langgraph_checkpoint_ns: "agent:tools:task-runtime|read_file:1" }
  ])

  const completedEvents = converter.processChunk("messages", [
    (aiMessageChunk({
      id: "subagent-ai",
      toolCallChunks: [
        {
          id: "inner-tool-call",
          args: '.md"}'
        }
      ]
    }) as [unknown, unknown])[0],
    { langgraph_checkpoint_ns: "agent:tools:task-runtime|read_file:1" }
  ])
  const assistantEvent = completedEvents.find((event) => event.type === "message-delta")
  assert(assistantEvent?.subagentId === "task-1", "chunked tool call should target the subagent")
  const toolCalls = assistantEvent?.toolCalls as
    | Array<{ id?: string; name?: string; args?: Record<string, unknown> }>
    | undefined
  assert(toolCalls?.[0]?.name === "read_file", "chunked tool call should preserve tool name")
  assert(
    toolCalls?.[0]?.args?.file_path === "README.md",
    "chunked tool call should hydrate full JSON args"
  )
}

async function run(): Promise<void> {
  await testSubagentToolErrorsAreForwarded()
  console.log("PASS stream converter forwards subagent tool errors")
  await testPrefixedNamespaceRoutesConcurrentSubagents()
  console.log("PASS stream converter routes prefixed concurrent subagent namespaces")
  await testSubagentToolCallChunksAreForwarded()
  console.log("PASS stream converter forwards subagent tool-call chunks")
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
