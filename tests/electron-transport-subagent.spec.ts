/**
 * Unit tests for ElectronIPCTransport subagent stream conversion.
 *
 * These feed realistic LangGraph IPC stream events into the transport converter
 * to verify subagent internals stay out of the main chat while right-panel
 * observability events are still emitted.
 *
 * Run:
 *   npx -y tsx tests/electron-transport-subagent.spec.ts
 */

import { ElectronIPCTransport } from "../src/renderer/src/lib/electron-transport.ts"

interface SdkEvent {
  event: string
  data: unknown
}

interface TestableTransport {
  convertToSDKEvents: (
    event: unknown,
    threadId: string,
    agentMode?: "normal" | "coordinator"
  ) => SdkEvent[]
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function asRecord(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), "expected object")
  return value as Record<string, unknown>
}

function customEvents(events: SdkEvent[], type: string): Record<string, unknown>[] {
  return events
    .filter((event) => event.event === "custom")
    .map((event) => asRecord(event.data))
    .filter((data) => data.type === type)
}

function messageEvents(events: SdkEvent[]): SdkEvent[] {
  return events.filter((event) => event.event === "messages" || event.event === "values")
}

function firstMessage(events: SdkEvent[]): Record<string, unknown> {
  const messageEvent = events.find((event) => event.event === "messages")
  assert(messageEvent, "expected message event")
  const data = messageEvent.data as Array<Record<string, unknown>>
  assert(Array.isArray(data) && data[0], "expected message data")
  return data[0]
}

function aiMessage(input: {
  id?: string
  content?: unknown
  toolCalls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>
}): unknown {
  return {
    id: ["langchain_core", "messages", "AIMessage"],
    kwargs: {
      id: input.id,
      content: input.content ?? "",
      tool_calls: input.toolCalls
    }
  }
}

function toolMessage(input: {
  id?: string
  name: string
  toolCallId: string
  content?: unknown
  status?: string
}): unknown {
  return {
    id: ["langchain_core", "messages", "ToolMessage"],
    kwargs: {
      id: input.id,
      name: input.name,
      tool_call_id: input.toolCallId,
      content: input.content ?? "",
      status: input.status
    }
  }
}

function humanMessage(content: string): unknown {
  return {
    id: ["langchain_core", "messages", "HumanMessage"],
    kwargs: {
      id: `human-${content}`,
      content
    }
  }
}

function plainHumanMessage(content: string): unknown {
  return {
    kwargs: {
      id: `plain-human-${content}`,
      type: "human",
      content
    }
  }
}

function plainAiMessage(input: {
  id?: string
  content?: unknown
  toolCalls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>
}): unknown {
  return {
    kwargs: {
      id: input.id,
      type: "ai",
      content: input.content ?? "",
      tool_calls: input.toolCalls
    }
  }
}

function plainToolMessage(input: {
  id?: string
  name: string
  toolCallId: string
  content?: unknown
  status?: string
}): unknown {
  return {
    kwargs: {
      id: input.id,
      type: "tool",
      name: input.name,
      tool_call_id: input.toolCallId,
      content: input.content ?? "",
      status: input.status
    }
  }
}

function streamMessageEvent(message: unknown, metadata: Record<string, unknown> = {}): unknown {
  return {
    type: "stream",
    mode: "messages",
    data: [message, metadata]
  }
}

function streamValuesEvent(messages: unknown[]): unknown {
  return {
    type: "stream",
    mode: "values",
    data: { messages }
  }
}

async function collectStreamEvents(
  transport: ElectronIPCTransport,
  payload: Record<string, unknown>
): Promise<SdkEvent[]> {
  const stream = await transport.stream(payload as never)
  const events: SdkEvent[] = []
  for await (const event of stream as AsyncGenerator<SdkEvent>) {
    events.push(event)
  }
  return events
}

function convert(
  transport: ElectronIPCTransport,
  event: unknown,
  agentMode: "normal" | "coordinator" = "normal"
): SdkEvent[] {
  return (transport as unknown as TestableTransport).convertToSDKEvents(
    event,
    "thread-123",
    agentMode
  )
}

function convertCoordinator(transport: ElectronIPCTransport, event: unknown): SdkEvent[] {
  return convert(transport, event, "coordinator")
}

async function testSubagentInternalsAreHiddenButObservable(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const taskToolCall = {
    id: "task-1",
    name: "task",
    args: {
      subagent_type: "implementer",
      description: "Inspect README and write handoff"
    }
  }

  const taskStartEvents = convert(
    transport,
    streamMessageEvent(aiMessage({ id: "main-ai-1", toolCalls: [taskToolCall] }), {
      langgraph_node: "agent"
    })
  )
  const subagentStart = customEvents(taskStartEvents, "subagents")[0]
  assert(subagentStart, "task tool call should create a subagent event")
  const startedSubagents = subagentStart.subagents as Array<Record<string, unknown>>
  assert(startedSubagents[0]?.status === "running", "subagent should start as running")
  assert(
    startedSubagents[0]?.description === "Inspect README and write handoff",
    "subagent event should expose task description"
  )

  const internalToolEvents = convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "subagent-ai-1",
        toolCalls: [
          {
            id: "inner-tool-1",
            name: "read_file",
            args: { file_path: "README.md" }
          }
        ]
      }),
      { langgraph_checkpoint_ns: "agent:tools:task-1" }
    )
  )
  assert(
    messageEvents(internalToolEvents).length === 0,
    "subagent internal AI tool calls should not appear as main chat messages"
  )
  const countEvent = customEvents(internalToolEvents, "subagent_tool_count")[0]
  assert(countEvent?.count === 1, "subagent internal tool call should increment aggregate count")
  const toolCallLog = customEvents(internalToolEvents, "subagent_log_entry")[0]
  assert(toolCallLog, "subagent internal tool call should emit a right-panel log entry")
  const toolCallEntry = asRecord(toolCallLog.entry)
  assert(toolCallEntry.kind === "tool_call", "tool log entry should mark tool_call")
  assert(toolCallEntry.toolName === "read_file", "tool log entry should expose tool name")
  assert(
    String(toolCallEntry.content).includes("README.md"),
    "tool log entry should include compact input summary"
  )

  const internalResultEvents = convert(
    transport,
    streamMessageEvent(
      toolMessage({
        id: "tool-result-1",
        name: "read_file",
        toolCallId: "inner-tool-1",
        content: "README contents"
      }),
      { langgraph_checkpoint_ns: "agent:tools:task-1" }
    )
  )
  assert(
    messageEvents(internalResultEvents).length === 0,
    "subagent internal tool results should not appear as main chat messages"
  )
  const toolResultLog = customEvents(internalResultEvents, "subagent_log_entry")[0]
  assert(toolResultLog, "subagent internal tool result should update right-panel log")
  const toolResultEntry = asRecord(toolResultLog.entry)
  assert(
    toolResultEntry.id === toolCallEntry.id,
    "tool result should update the same log entry as its tool call"
  )
  assert(toolResultEntry.kind === "tool_result", "tool result log should mark tool_result")
  assert(toolResultEntry.status === "completed", "tool result log should mark completed")
  assert(
    String(toolResultEntry.result).includes("README contents"),
    "tool result log should include compact result"
  )

  const taskDoneEvents = convert(
    transport,
    streamMessageEvent(
      toolMessage({
        id: "task-result-1",
        name: "task",
        toolCallId: "task-1",
        content: "subagent final answer"
      }),
      { langgraph_node: "tools" }
    )
  )
  const subagentDone = customEvents(taskDoneEvents, "subagents")[0]
  assert(subagentDone, "task result should update subagent status")
  const doneSubagents = subagentDone.subagents as Array<Record<string, unknown>>
  assert(doneSubagents[0]?.status === "completed", "task result should complete subagent")
  assert(
    messageEvents(taskDoneEvents).length > 0,
    "parent task result should remain visible to the main agent thread"
  )

  const lateResultEvents = convert(
    transport,
    streamMessageEvent(
      toolMessage({
        id: "late-tool-result",
        name: "read_file",
        toolCallId: "inner-tool-1",
        content: "late result"
      }),
      { langgraph_checkpoint_ns: "agent:tools:task-1" }
    )
  )
  assert(
    messageEvents(lateResultEvents).length === 0,
    "known late subagent tool results should stay hidden after subagent completion"
  )
  assert(
    customEvents(lateResultEvents, "subagent_log_entry").length === 1,
    "known late subagent tool result should still update observability"
  )
}

async function testNamespacedToolsWithoutRunningSubagentRemainVisible(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const events = convert(
    transport,
    streamMessageEvent(
      toolMessage({
        id: "main-tool-result",
        name: "execute",
        toolCallId: "main-tool-1",
        content: "command output"
      }),
      { langgraph_checkpoint_ns: "agent:tools:execute" }
    )
  )

  assert(
    messageEvents(events).length === 1,
    "namespaced tool result without running subagent should remain a main message"
  )
  assert(
    customEvents(events, "subagent_log_entry").length === 0,
    "namespaced main tool result should not be misclassified as subagent internals"
  )
}

async function testAsyncWorkerInternalsStayOutOfMainThread(): Promise<void> {
  const transport = new ElectronIPCTransport()

  const workerToolEvents = convertCoordinator(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "worker-ai-1",
        toolCalls: [
          {
            id: "worker-tool-1",
            name: "read_file",
            args: { file_path: "README.md" }
          }
        ]
      }),
      { langgraph_checkpoint_ns: "graph:thread-123__worker__implementer-1:agent" }
    )
  )
  assert(
    messageEvents(workerToolEvents).length === 0,
    "async worker internal AI tool calls should not appear as main chat messages"
  )
  assert(
    customEvents(workerToolEvents, "subagent_log_entry").length === 0,
    "async worker internals should be represented by coordinator worker state, not subagent logs"
  )

  const workerResultEvents = convertCoordinator(
    transport,
    streamMessageEvent(
      toolMessage({
        id: "worker-tool-result-1",
        name: "read_file",
        toolCallId: "worker-tool-1",
        content: "README contents"
      }),
      { checkpoint_ns: "graph:thread-123__worker__implementer-1:tools" }
    )
  )
  assert(
    messageEvents(workerResultEvents).length === 0,
    "async worker internal tool results should not appear as main chat messages"
  )

  const startWorkerResultEvents = convert(
    transport,
    streamMessageEvent(
      toolMessage({
        id: "start-worker-result",
        name: "start_worker",
        toolCallId: "main-start-worker",
        content: '{"worker_thread_id":"thread-123__worker__implementer-1"}'
      }),
      { langgraph_checkpoint_ns: "graph:thread-123:tools" }
    )
  )
  assert(
    messageEvents(startWorkerResultEvents).length === 1,
    "main start_worker result should remain visible even when content mentions worker_thread_id"
  )
}

async function testReadWorkerStateIsQuietLikeTaskOutput(): Promise<void> {
  const transport = new ElectronIPCTransport()

  const quietToolCallEvents = convertCoordinator(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "main-ai-read-worker",
        toolCalls: [
          {
            id: "read-worker-state-1",
            name: "read_worker_state",
            args: { worker_id: "implementer-1", block: true }
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )
  assert(
    messageEvents(quietToolCallEvents).length === 0,
    "read_worker_state-only AI messages should not appear in the main chat"
  )
  assert(
    customEvents(quietToolCallEvents, "tool_call").length === 0,
    "read_worker_state streaming tool cards should not be emitted"
  )

  const quietToolResultEvents = convertCoordinator(
    transport,
    streamMessageEvent(
      toolMessage({
        id: "read-worker-state-result-1",
        name: "read_worker_state",
        toolCallId: "read-worker-state-1",
        content: '{"running":1}'
      }),
      { langgraph_node: "tools" }
    )
  )
  assert(
    messageEvents(quietToolResultEvents).length === 0,
    "read_worker_state tool results should not appear in the main chat"
  )
}

async function testReadWorkerStateIsRemovedFromMixedToolCalls(): Promise<void> {
  const transport = new ElectronIPCTransport()

  const events = convertCoordinator(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "main-ai-mixed-tools",
        content: "继续处理通知",
        toolCalls: [
          {
            id: "read-worker-state-2",
            name: "read_worker_state",
            args: { worker_id: "implementer-1", block: false }
          },
          {
            id: "start-worker-1",
            name: "start_worker",
            args: {
              subagent_type: "worker",
              role: "implementer",
              description: "继续处理通知",
              prompt: "请继续处理。"
            }
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )

  const messages = messageEvents(events)
  assert(messages.length === 1, "mixed visible tool calls should still render one message")
  const messageData = messages[0]?.data as Array<{ tool_calls?: Array<{ name?: string }> }>
  const toolCalls = messageData?.[0]?.tool_calls ?? []
  assert(toolCalls.length === 1, "quiet read_worker_state should be stripped from mixed calls")
  assert(toolCalls[0]?.name === "start_worker", "visible coordinator tool should remain")

  const toolCallEvents = customEvents(events, "tool_call")
  assert(
    toolCallEvents.length === 0,
    "complete non-streaming tool calls should not emit tool_call custom events"
  )

  const quietResultEvents = convertCoordinator(
    transport,
    streamMessageEvent(
      toolMessage({
        id: "read-worker-state-result-2",
        name: "read_worker_state",
        toolCallId: "read-worker-state-2",
        content: '{"completed":1}'
      }),
      { langgraph_node: "tools" }
    )
  )
  assert(
    messageEvents(quietResultEvents).length === 0,
    "stripped read_worker_state result should also stay hidden"
  )
}

async function testReadWorkerStateIsQuietInValuesMode(): Promise<void> {
  const transport = new ElectronIPCTransport()

  const events = convertCoordinator(
    transport,
    streamValuesEvent([
      aiMessage({
        id: "values-read-worker",
        toolCalls: [
          {
            id: "values-read-worker-state",
            name: "read_worker_state",
            args: { worker_id: "implementer-1" }
          }
        ]
      }),
      toolMessage({
        id: "values-read-worker-result",
        name: "read_worker_state",
        toolCallId: "values-read-worker-state",
        content: '{"running":1}'
      })
    ])
  )

  assert(
    messageEvents(events).length === 0,
    "coordinator values-mode read_worker_state messages should stay out of the main chat"
  )
}

async function testCoordinatorValuesModeForwardsCurrentTurnToolDeltas(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const snapshot = streamValuesEvent([
    humanMessage("Inspect README"),
    aiMessage({
      id: "values-ai-tool-call",
      content: "I will inspect the repository",
      toolCalls: [
        {
          id: "readme-tool-call",
          name: "read_file",
          args: { file_path: "README.md" }
        }
      ]
    }),
    toolMessage({
      id: "values-tool-result",
      name: "read_file",
      toolCallId: "readme-tool-call",
      content: "README contents"
    })
  ])

  const events = messageEvents(convertCoordinator(transport, snapshot))
  assert(
    events.length === 2,
    "coordinator values-mode should surface current-turn tool calls when messages mode does not"
  )
  const first = events[0]?.data as Array<Record<string, unknown>>
  const second = events[1]?.data as Array<Record<string, unknown>>
  assert(
    (first?.[0]?.tool_calls as Array<{ name?: string }> | undefined)?.[0]?.name ===
      "read_file",
    "coordinator values-mode AI message should include visible tool call"
  )
  assert(second?.[0]?.type === "tool", "coordinator values-mode should surface current-turn tool result")
}

async function testCoordinatorValuesModeDoesNotReplayPreviousTurnHistory(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const snapshot = streamValuesEvent([
    humanMessage("First request"),
    aiMessage({
      id: "old-ai",
      content: "Old answer",
      toolCalls: [
        {
          id: "old-tool-call",
          name: "read_file",
          args: { file_path: "old.md" }
        }
      ]
    }),
    humanMessage("Second request"),
    aiMessage({
      id: "new-ai",
      content: "New answer",
      toolCalls: [
        {
          id: "new-tool-call",
          name: "read_file",
          args: { file_path: "new.md" }
        }
      ]
    })
  ])

  const events = messageEvents(convertCoordinator(transport, snapshot))
  assert(events.length === 1, "coordinator values-mode should only emit messages after the latest human turn")
  const data = events[0]?.data as Array<{ id?: string; tool_calls?: Array<{ id?: string }> }>
  assert(data?.[0]?.id === "new-ai", "values-mode should emit the current-turn AI message")
  assert(
    data?.[0]?.tool_calls?.[0]?.id === "new-tool-call",
    "coordinator values-mode should not replay old tool calls"
  )
}

async function testCoordinatorValuesModeDoesNotDuplicateRepeatedSnapshots(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const snapshot = streamValuesEvent([
    humanMessage("Inspect README"),
    aiMessage({
      id: "duplicate-values-ai",
      toolCalls: [
        {
          id: "duplicate-read-file",
          name: "read_file",
          args: { file_path: "README.md" }
        }
      ]
    }),
    toolMessage({
      id: "duplicate-values-tool",
      name: "read_file",
      toolCallId: "duplicate-read-file",
      content: "README contents"
    })
  ])

  assert(
    messageEvents(convertCoordinator(transport, snapshot)).length === 2,
    "first coordinator values snapshot should surface current-turn tool messages"
  )
  assert(
    messageEvents(convertCoordinator(transport, snapshot)).length === 0,
    "repeated coordinator values snapshots should not duplicate already emitted messages"
  )
}

async function testCoordinatorValuesModeRecognizesPlainMessageTypeShapes(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const snapshot = streamValuesEvent([
    plainHumanMessage("Inspect README"),
    plainAiMessage({
      id: "plain-values-ai",
      toolCalls: [
        {
          id: "plain-read-file",
          name: "read_file",
          args: { file_path: "README.md" }
        }
      ]
    }),
    plainToolMessage({
      id: "plain-values-tool",
      name: "read_file",
      toolCallId: "plain-read-file",
      content: "README contents"
    })
  ])

  const events = messageEvents(convertCoordinator(transport, snapshot))
  assert(events.length === 2, "coordinator values-mode should recognize kwargs.type message shapes")
  const first = events[0]?.data as Array<{ id?: string; tool_calls?: Array<{ name?: string }> }>
  const second = events[1]?.data as Array<{ type?: string; name?: string }>
  assert(first?.[0]?.id === "plain-values-ai", "plain AI values message should be surfaced")
  assert(
    first?.[0]?.tool_calls?.[0]?.name === "read_file",
    "plain AI values message should preserve tool call"
  )
  assert(second?.[0]?.type === "tool", "plain tool values message should be surfaced")
  assert(second?.[0]?.name === "read_file", "plain tool values message should preserve name")
}

async function testNormalValuesModeRestoresFullToolMessages(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const events = messageEvents(
    convert(
      transport,
      streamValuesEvent([
        humanMessage("First request"),
        aiMessage({
          id: "old-ai",
          content: "Old answer",
          toolCalls: [
            {
              id: "old-tool-call",
              name: "read_file",
              args: { file_path: "old.md" }
            }
          ]
        }),
        toolMessage({
          id: "old-tool-result",
          name: "read_file",
          toolCallId: "old-tool-call",
          content: "old result"
        }),
        humanMessage("Second request"),
        aiMessage({
          id: "new-ai",
          content: "New answer",
          toolCalls: [
            {
              id: "new-tool-call",
              name: "execute",
              args: { command: "npm test" }
            }
          ]
        }),
        toolMessage({
          id: "new-tool-result",
          name: "execute",
          toolCallId: "new-tool-call",
          content: "new result"
        })
      ])
    )
  )

  assert(events.length === 1, "normal values mode should emit a values snapshot")
  const valuesData = asRecord(events[0]?.data)
  const messages = valuesData.messages as Array<Record<string, unknown>>
  assert(messages.length === 4, "normal values mode should keep full non-human message history")
  assert(messages[0]?.id === "old-ai", "normal values mode should preserve old AI tool call")
  assert(
    (messages[0]?.tool_calls as Array<{ name?: string }> | undefined)?.[0]?.name ===
      "read_file",
    "normal values mode should preserve old AI tool call details"
  )
  assert(messages[1]?.type === "tool", "normal values mode should preserve old tool result")
  assert(messages[2]?.id === "new-ai", "normal values mode should preserve latest AI tool call")
  assert(messages[3]?.type === "tool", "normal values mode should preserve latest tool result")
}

async function testRuntimeAgentModeEventUpdatesCurrentStreamParsing(): Promise<void> {
  const previousWindow = (globalThis as { window?: unknown }).window
  try {
    ;(globalThis as { window?: unknown }).window = {
      api: {
        agent: {
          streamAgent: (
            _threadId: string,
            _message: string,
            _command: unknown,
            callback: (event: unknown) => void
          ) => {
            queueMicrotask(() => {
              callback({
                type: "custom",
                data: {
                  type: "agent_mode",
                  mode: "coordinator",
                  source: "environment",
                  persisted: false
                }
              })
              callback(
                streamValuesEvent([
                  humanMessage("Inspect worker state"),
                  aiMessage({
                    id: "env-forced-read-worker",
                    toolCalls: [
                      {
                        id: "env-read-worker-state",
                        name: "read_worker_state",
                        args: { worker_id: "implementer-1", block: true }
                      }
                    ]
                  }),
                  toolMessage({
                    id: "env-read-worker-result",
                    name: "read_worker_state",
                    toolCallId: "env-read-worker-state",
                    content: '{"running":1}'
                  })
                ])
              )
              callback({ type: "done" })
            })
            return () => undefined
          }
        }
      }
    }

    const transport = new ElectronIPCTransport()
    const events = await collectStreamEvents(transport, {
      input: { messages: [{ type: "human", content: "Inspect worker state" }] },
      config: {
        configurable: {
          thread_id: "thread-123",
          model_id: "test-model",
          agent_mode: "normal"
        }
      },
      signal: new AbortController().signal
    })

    assert(
      customEvents(events, "agent_mode")[0]?.persisted === false,
      "env-forced coordinator agent_mode event should stay non-persistent"
    )
    assert(
      messageEvents(events).length === 0,
      "agent_mode event should switch the current stream to coordinator parsing without persisting mode"
    )
  } finally {
    ;(globalThis as { window?: unknown }).window = previousWindow
  }
}

async function testFallbackToolMessageIdIsStableAcrossRepeatedMessages(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const toolResult = streamMessageEvent(
    toolMessage({
      name: "execute",
      toolCallId: "execute-1",
      content: "ok"
    }),
    { langgraph_node: "tools" }
  )

  const firstId = firstMessage(convert(transport, toolResult)).id
  const secondId = firstMessage(convert(transport, toolResult)).id

  assert(firstId === secondId, "fallback ToolMessage ID should be stable across repeated events")
  assert(
    firstId === "tool-execute-1-execute",
    "tool fallback ID should be based on tool_call_id and tool name"
  )
}

async function testCoordinatorAiFallbackIdDedupesMessagesThenValues(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const messagesModeEvents = convertCoordinator(
    transport,
    streamMessageEvent(aiMessage({ content: "final answer" }))
  ).filter((event) => event.event === "messages")

  assert(messagesModeEvents.length === 1, "messages-mode AI fallback should emit once")

  const valuesModeEvents = convertCoordinator(
    transport,
    streamValuesEvent([
      { id: ["langchain_core", "messages", "HumanMessage"], kwargs: { content: "question" } },
      aiMessage({ content: "final answer" })
    ])
  ).filter((event) => event.event === "messages")

  assert(
    valuesModeEvents.length === 0,
    "values-mode AI fallback should not duplicate the already emitted messages-mode AI message"
  )
}

async function testValuesModeRegistersAndCompletesSubagents(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const runningEvents = convert(
    transport,
    streamValuesEvent([
      aiMessage({
        id: "values-ai-1",
        toolCalls: [
          {
            id: "task-values-1",
            name: "task",
            args: {
              subagent_type: "verifier",
              description: "Verify report"
            }
          }
        ]
      })
    ])
  )
  const runningSubagents = customEvents(runningEvents, "subagents")[0]?.subagents as Array<
    Record<string, unknown>
  >
  assert(runningSubagents?.[0]?.status === "running", "values mode should register subagent")
  assert(runningSubagents?.[0]?.subagentType === "verifier", "values mode should preserve type")

  const completedEvents = convert(
    transport,
    streamValuesEvent([
      toolMessage({
        id: "task-values-result",
        name: "task",
        toolCallId: "task-values-1",
        content: "verified"
      })
    ])
  )
  const completedSubagents = customEvents(completedEvents, "subagents")[0]?.subagents as Array<
    Record<string, unknown>
  >
  assert(
    completedSubagents?.[0]?.status === "completed",
    "values mode should complete subagent from task ToolMessage"
  )
}

async function run(): Promise<void> {
  await testSubagentInternalsAreHiddenButObservable()
  console.log("PASS electron transport hides subagent internals")
  await testNamespacedToolsWithoutRunningSubagentRemainVisible()
  console.log("PASS electron transport avoids false subagent classification")
  await testAsyncWorkerInternalsStayOutOfMainThread()
  console.log("PASS electron transport hides async worker internals")
  await testReadWorkerStateIsQuietLikeTaskOutput()
  console.log("PASS electron transport hides read_worker_state-only checks")
  await testReadWorkerStateIsRemovedFromMixedToolCalls()
  console.log("PASS electron transport strips read_worker_state from mixed calls")
  await testReadWorkerStateIsQuietInValuesMode()
  console.log("PASS electron transport hides read_worker_state in values mode")
  await testCoordinatorValuesModeForwardsCurrentTurnToolDeltas()
  console.log("PASS electron transport forwards coordinator values-mode current-turn tool deltas")
  await testCoordinatorValuesModeDoesNotReplayPreviousTurnHistory()
  console.log("PASS electron transport avoids replaying previous coordinator values-mode turns")
  await testCoordinatorValuesModeDoesNotDuplicateRepeatedSnapshots()
  console.log("PASS electron transport dedupes repeated coordinator values-mode snapshots")
  await testCoordinatorValuesModeRecognizesPlainMessageTypeShapes()
  console.log("PASS electron transport recognizes plain coordinator values-mode message shapes")
  await testNormalValuesModeRestoresFullToolMessages()
  console.log("PASS electron transport restores normal values-mode tool messages")
  await testRuntimeAgentModeEventUpdatesCurrentStreamParsing()
  console.log("PASS electron transport updates current stream parsing from agent_mode event")
  await testFallbackToolMessageIdIsStableAcrossRepeatedMessages()
  console.log("PASS electron transport keeps ToolMessage fallback IDs stable")
  await testCoordinatorAiFallbackIdDedupesMessagesThenValues()
  console.log("PASS electron transport dedupes AI fallback IDs across messages and values")
  await testValuesModeRegistersAndCompletesSubagents()
  console.log("PASS electron transport values-mode subagent lifecycle")
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
