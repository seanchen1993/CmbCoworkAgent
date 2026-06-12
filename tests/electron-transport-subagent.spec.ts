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
import { useAppStore, type WorkerFocusView } from "../src/renderer/src/lib/store.ts"
import {
  getWorkerToolResultKey,
  getWorkerToolUiKey
} from "../src/renderer/src/lib/worker-tool-result-key.ts"

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

function resetWorkerFocusStore(): void {
  useAppStore.setState({
    workerFocusView: null,
    workerFocusMessagesThreadId: null,
    workerFocusMessages: []
  })
}

function openWorkerFocusViewForTest(
  view: Omit<WorkerFocusView, "role" | "description"> &
    Partial<Pick<WorkerFocusView, "role" | "description">>
): void {
  useAppStore.getState().openWorkerFocusView({
    role: "implementer",
    description: "Inspect worker stream",
    ...view
  })
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

function aiMessageChunk(input: {
  id?: string
  content?: unknown
  toolCallChunks?: Array<{ id?: string; name?: string; args?: string }>
}): unknown {
  return {
    id: ["langchain_core", "messages", "AIMessageChunk"],
    kwargs: {
      id: input.id,
      content: input.content ?? "",
      tool_call_chunks: input.toolCallChunks
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

function humanMessage(content: string, input?: { id?: string }): unknown {
  return {
    id: ["langchain_core", "messages", "HumanMessage"],
    kwargs: {
      id: input?.id ?? `human-${content}`,
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

function plainUserMessage(content: string): unknown {
  return {
    kwargs: {
      id: `plain-user-${content}`,
      type: "user",
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

async function testFocusedAsyncWorkerStreamsToWorkerPanel(): Promise<void> {
  const transport = new ElectronIPCTransport()
  useAppStore.setState({
    workerFocusView: {
      threadId: "thread-123",
      workerId: "implementer-1",
      workerThreadId: "thread-123__worker__implementer-1",
      role: "implementer",
      description: "Inspect worker stream"
    },
    workerFocusMessagesThreadId: "thread-123__worker__implementer-1",
    workerFocusMessages: []
  })

  try {
    const workerToolEvents = convertCoordinator(
      transport,
      streamMessageEvent(
        aiMessage({
          id: "focused-worker-ai-1",
          toolCalls: [
            {
              id: "focused-worker-tool-1",
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
      "focused worker internals should still stay out of main chat messages"
    )
    assert(
      customEvents(workerToolEvents, "coordinator_worker_stream_message").length === 0,
      "main coordinator stream should not parse focused worker internals; worker panel uses the side channel"
    )

    const directSideChannelMessages = transport.convertFocusedCoordinatorWorkerIPCEvent(
      streamMessageEvent(
        aiMessage({
          id: "focused-worker-ai-direct",
          toolCalls: [
            {
              id: "focused-worker-tool-direct",
              name: "execute",
              args: { command: "npm test" }
            }
          ]
        }),
        {}
      ) as never,
      "thread-123"
    )
    assert(
      directSideChannelMessages.length === 1,
      "worker side-channel should not require checkpoint namespace metadata"
    )
    assert(
      directSideChannelMessages[0]?.tool_calls?.[0]?.name === "execute",
      "worker side-channel should parse live tool calls without namespace metadata"
    )

    const directHumanSideChannelMessages = transport.convertFocusedCoordinatorWorkerIPCEvent(
      streamMessageEvent(humanMessage("Continue with the redirected worker instructions"), {}) as never,
      "thread-123"
    )
    assert(
      directHumanSideChannelMessages.some(
        (message) =>
          message.role === "user" &&
          message.content === "Continue with the redirected worker instructions"
      ),
      "worker side-channel should display live human continuation prompts"
    )

    const directPlainUserSideChannelMessages = transport.convertFocusedCoordinatorWorkerIPCEvent(
      streamMessageEvent(plainUserMessage("User-shaped live worker prompt"), {}) as never,
      "thread-123"
    )
    assert(
      directPlainUserSideChannelMessages.some(
        (message) =>
          message.role === "user" && message.content === "User-shaped live worker prompt"
      ),
      "worker side-channel should recognize live plain user-shaped messages"
    )

    const repeatedHumanIdAcrossTurnsTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "worker-1",
      workerThreadId: "thread-123__worker__worker-1"
    })
    const firstTurnHumanPrompt =
      repeatedHumanIdAcrossTurnsTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            humanMessage("turn one prompt", { id: "reused-human-message-id" }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages("thread-123__worker__worker-1", firstTurnHumanPrompt)
    const secondTurnHumanPrompt =
      repeatedHumanIdAcrossTurnsTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            humanMessage("turn two prompt", { id: "reused-human-message-id" }),
            {}
          ) as object),
          workerTurn: 2
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages("thread-123__worker__worker-1", secondTurnHumanPrompt)
    const repeatedHumanPrompts = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "user")
    assert(
      repeatedHumanPrompts.length === 2 &&
        repeatedHumanPrompts[0]?.content === "turn one prompt" &&
        repeatedHumanPrompts[1]?.content === "turn two prompt" &&
        repeatedHumanPrompts[0]?.id !== repeatedHumanPrompts[1]?.id,
      "focused worker store should preserve previous-turn human prompts when provider ids are reused"
    )

    const directFailedToolMessages = transport.convertFocusedCoordinatorWorkerIPCEvent(
      streamMessageEvent(
        toolMessage({
          name: "read_file",
          toolCallId: "focused-worker-failed-tool",
          content: "Permission denied",
          status: "error"
        }),
        {}
      ) as never,
      "thread-123"
    )
    assert(
      directFailedToolMessages.some(
        (message) =>
          message.role === "tool" &&
          message.tool_call_id === "focused-worker-failed-tool" &&
          message.is_error === true &&
          message.status === "error"
      ),
      "worker side-channel should preserve failed tool result status"
    )

    const cumulativeTextTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "worker-1",
      workerThreadId: "thread-123__worker__worker-1"
    })
    cumulativeTextTransport.convertFocusedCoordinatorWorkerIPCEvent(
      streamMessageEvent(aiMessageChunk({ content: "## 项目" }), {}) as never,
      "thread-123"
    )
    cumulativeTextTransport.convertFocusedCoordinatorWorkerIPCEvent(
      streamMessageEvent(aiMessageChunk({ content: "## 项目架构" }), {}) as never,
      "thread-123"
    )
    const cumulativeFinal = cumulativeTextTransport.convertFocusedCoordinatorWorkerIPCEvent(
      streamMessageEvent(aiMessageChunk({ content: "## 项目架构\n\n- controller" }), {}) as never,
      "thread-123"
    )
    assert(
      cumulativeFinal.find((message) => message.role === "assistant")?.content ===
        "## 项目架构\n\n- controller",
      "worker side-channel should replace cumulative assistant chunks instead of appending duplicated text"
    )

    const overlappingTextTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "worker-1",
      workerThreadId: "thread-123__worker__worker-1"
    })
    overlappingTextTransport.convertFocusedCoordinatorWorkerIPCEvent(
      streamMessageEvent(aiMessageChunk({ content: "Controller" }), {}) as never,
      "thread-123"
    )
    const overlappingFinal = overlappingTextTransport.convertFocusedCoordinatorWorkerIPCEvent(
      streamMessageEvent(aiMessageChunk({ content: "Controller 层" }), {}) as never,
      "thread-123"
    )
    assert(
      overlappingFinal.find((message) => message.role === "assistant")?.content ===
        "Controller 层",
      "worker side-channel should merge overlapping assistant chunks without duplicating text"
    )

    const deltaTextTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "worker-1",
      workerThreadId: "thread-123__worker__worker-1"
    })
    deltaTextTransport.convertFocusedCoordinatorWorkerIPCEvent(
      streamMessageEvent(aiMessageChunk({ content: "## " }), {}) as never,
      "thread-123"
    )
    deltaTextTransport.convertFocusedCoordinatorWorkerIPCEvent(
      streamMessageEvent(aiMessageChunk({ content: "项目" }), {}) as never,
      "thread-123"
    )
    const deltaFinal = deltaTextTransport.convertFocusedCoordinatorWorkerIPCEvent(
      streamMessageEvent(aiMessageChunk({ content: "架构" }), {}) as never,
      "thread-123"
    )
    assert(
      deltaFinal.find((message) => message.role === "assistant")?.content === "## 项目架构",
      "worker side-channel should still append true assistant deltas"
    )

    const directValuesMessages = transport.convertFocusedCoordinatorWorkerIPCEvent(
      streamValuesEvent([
        humanMessage("Worker prompt"),
        aiMessage({
          id: "focused-worker-values-ai",
          content: "I will inspect files",
          toolCalls: [
            {
              id: "focused-worker-values-tool",
              name: "list_dir",
              args: { path: "src" }
            }
          ]
        }),
        toolMessage({
          id: "focused-worker-values-result",
          name: "list_dir",
          toolCallId: "focused-worker-values-tool",
          content: "src/main"
        })
      ]) as never,
      "thread-123"
    )
    assert(
      directValuesMessages.some(
        (message) => message.role === "assistant" && message.tool_calls?.[0]?.name === "list_dir"
      ),
      "worker side-channel should use values snapshots as a live fallback"
    )
    assert(
      directValuesMessages.some(
        (message) =>
          message.role === "tool" &&
          message.tool_call_id === "focused-worker-values-tool" &&
          message.content === "src/main"
      ),
      "worker values fallback should surface tool results"
    )

    const snapshotFallbackTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "worker-1",
      workerThreadId: "thread-123__worker__worker-1"
    })

    const directValuesWithoutIds =
      snapshotFallbackTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamValuesEvent([
          {
            id: ["langchain_core", "messages", "HumanMessage"],
            kwargs: { content: "Worker prompt without provider id" }
          },
          aiMessage({ content: "id-less assistant output" }),
          toolMessage({
            name: "read_file",
            toolCallId: "id-less-tool-call",
            content: "tool result without provider id"
          })
        ]) as never,
        "thread-123"
      )
    assert(
      directValuesWithoutIds[0]?.id === "worker-snapshot-0" &&
        directValuesWithoutIds[1]?.id === "worker-snapshot-1" &&
        directValuesWithoutIds[2]?.id === "worker-snapshot-2",
      "worker values fallback IDs should match checkpoint history fallback IDs"
    )

    const directValuesWithOriginalIndexes =
      snapshotFallbackTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamValuesEvent([
          {
            id: ["langchain_core", "messages", "HumanMessage"],
            kwargs: {
              content: "continued worker prompt",
              additional_kwargs: { cmb_worker_snapshot_index: 16 }
            }
          },
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: {
              content: "continued worker answer",
              additional_kwargs: { cmb_worker_snapshot_index: 17 }
            }
          }
        ]) as never,
        "thread-123"
      )
    assert(
      directValuesWithOriginalIndexes[0]?.id === "worker-snapshot-16" &&
        directValuesWithOriginalIndexes[1]?.id === "worker-snapshot-17",
      "worker values fallback IDs should use original checkpoint indexes after current-turn slicing"
    )

    const liveThenValuesTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "worker-1",
      workerThreadId: "thread-123__worker__worker-1"
    })
    const liveAiMessages = liveThenValuesTransport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        ...(streamMessageEvent(
          aiMessage({
            content: "same assistant before tool",
            toolCalls: [{ id: "id-less-live-tool-call", name: "read_file", args: {} }]
          }),
          {}
        ) as object),
        workerTurn: 1
      } as never,
      "thread-123"
    )
    const liveAiId = liveAiMessages.find((message) => message.role === "assistant")?.id
    assert(
      typeof liveAiId === "string" &&
        liveAiId.includes("worker-live-thread-123__worker__worker-1-1") &&
        liveAiId.startsWith("worker-turn-thread-123__worker__worker-1-"),
      "id-less live worker assistant messages should receive a turn-scoped live fallback id"
    )
    useAppStore.getState().appendWorkerFocusMessages("thread-123__worker__worker-1", liveAiMessages)
    const liveToolResultMessages = liveThenValuesTransport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        ...(streamMessageEvent(
          toolMessage({
            name: "read_file",
            toolCallId: "id-less-live-tool-call",
            content: "tool completed after live assistant"
          }),
          {}
        ) as object),
        workerTurn: 1
      } as never,
      "thread-123"
    )
    const liveToolResultId = liveToolResultMessages.find((message) => message.role === "tool")?.id
    const idLessLiveToolResultKey = getWorkerToolResultKey(
      liveAiId ?? "",
      liveAiMessages.find((message) => message.role === "assistant")?.tool_calls?.[0]?.id ??
        "id-less-live-tool-call"
    )
    const idLessLiveToolMessageKey = getWorkerToolResultKey(
      liveToolResultId ?? "",
      liveToolResultMessages.find((message) => message.role === "tool")?.tool_call_id
    )
    assert(
      typeof idLessLiveToolResultKey === "string" &&
        idLessLiveToolResultKey === idLessLiveToolMessageKey,
      "id-less live worker tool results should resolve against the same turn-scoped lookup key"
    )
    const valuesAfterTool = liveThenValuesTransport.convertFocusedCoordinatorWorkerIPCEvent(
      streamValuesEvent([
        {
          id: ["langchain_core", "messages", "HumanMessage"],
          kwargs: { content: "prompt before live assistant" }
        },
        aiMessage({
          content: "same assistant before tool",
          toolCalls: [{ id: "id-less-live-tool-call", name: "read_file", args: {} }]
        }),
        toolMessage({
          name: "read_file",
          toolCallId: "id-less-live-tool-call",
          content: "tool completed after live assistant"
        })
      ]) as never,
      "thread-123"
    )
    assert(
      valuesAfterTool.find((message) => message.role === "assistant")?.id === "worker-snapshot-1",
      "worker values snapshots should keep checkpoint-compatible fallback ids"
    )
    useAppStore
      .getState()
      .appendWorkerFocusMessages("thread-123__worker__worker-1", valuesAfterTool)
    const mergedAssistants = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant")
    assert(
      mergedAssistants.length === 1 && mergedAssistants[0]?.id === liveAiId,
      "worker focus store should merge snapshot replay into the existing live assistant message"
    )

    const turnBoundaryTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "worker-1",
      workerThreadId: "thread-123__worker__worker-1"
    })
    const firstTurnAssistant = turnBoundaryTransport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        ...(streamMessageEvent(aiMessage({ content: "first assistant-only turn" }), {}) as object),
        workerTurn: 1
      } as never,
      "thread-123"
    )
    const secondTurnAssistant = turnBoundaryTransport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        ...(streamMessageEvent(aiMessage({ content: "second assistant-only turn" }), {}) as object),
        workerTurn: 2
      } as never,
      "thread-123"
    )
    const firstTurnId = firstTurnAssistant.find((message) => message.role === "assistant")?.id
    const secondTurnId = secondTurnAssistant.find((message) => message.role === "assistant")?.id
    assert(
      typeof firstTurnId === "string" &&
        typeof secondTurnId === "string" &&
        firstTurnId !== secondTurnId,
      "focused worker assistant-only turns should not reuse the previous live assistant id"
    )

    const turnBoundaryToolHydrationTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "worker-1",
      workerThreadId: "thread-123__worker__worker-1"
    })
    turnBoundaryToolHydrationTransport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        ...(streamMessageEvent(
          aiMessageChunk({
            id: "reused-worker-message",
            toolCallChunks: [
              {
                id: "reused-worker-tool",
                name: "read_file",
                args: '{"file_path":"README.md"}'
              }
            ]
          }),
          {}
        ) as object),
        workerTurn: 1
      } as never,
      "thread-123"
    )
    const secondTurnToolHydration =
      turnBoundaryToolHydrationTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessage({
              id: "reused-worker-message",
              toolCalls: [{ id: "reused-worker-tool", name: "read_file" }]
            }),
            {}
          ) as object),
          workerTurn: 2
        } as never,
        "thread-123"
      )
    const secondTurnToolCalls = secondTurnToolHydration.find(
      (message) => message.role === "assistant"
    )?.tool_calls
    assert(
      secondTurnToolCalls?.[0]?.args === undefined,
      "focused worker tool hydration should not leak previous-turn tool args when ids are reused"
    )

    const repeatedToolIdAcrossTurnsTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "worker-1",
      workerThreadId: "thread-123__worker__worker-1"
    })
    const firstTurnRepeatedToolId = repeatedToolIdAcrossTurnsTransport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        ...(streamMessageEvent(
          aiMessage({
            id: "reused-tool-call-message",
            toolCalls: [{ id: "reused-tool-call-id", name: "read_file" }]
          }),
          {}
        ) as object),
        workerTurn: 1
      } as never,
      "thread-123"
    )
    const secondTurnRepeatedToolId =
      repeatedToolIdAcrossTurnsTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessage({
              id: "reused-tool-call-message",
              toolCalls: [{ id: "reused-tool-call-id", name: "read_file" }]
            }),
            {}
          ) as object),
          workerTurn: 2
        } as never,
        "thread-123"
      )
    const firstTurnAssistantMessage = firstTurnRepeatedToolId.find(
      (message) => message.role === "assistant"
    )
    const secondTurnAssistantMessage = secondTurnRepeatedToolId.find(
      (message) => message.role === "assistant"
    )
    const firstTurnRepeatedToolResult = repeatedToolIdAcrossTurnsTransport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        ...(streamMessageEvent(
          toolMessage({
            id: "reused-tool-result-message",
            name: "read_file",
            toolCallId: "reused-tool-call-id",
            content: "turn one result"
          }),
          {}
        ) as object),
        workerTurn: 1
      } as never,
      "thread-123"
    )
    const secondTurnRepeatedToolResult =
      repeatedToolIdAcrossTurnsTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            toolMessage({
              id: "reused-tool-result-message",
              name: "read_file",
              toolCallId: "reused-tool-call-id",
              content: "turn two result",
              status: "error"
            }),
            {}
          ) as object),
          workerTurn: 2
        } as never,
        "thread-123"
      )
    const firstTurnToolMessage = firstTurnRepeatedToolResult.find((message) => message.role === "tool")
    const secondTurnToolResultId = secondTurnRepeatedToolResult.find(
      (message) => message.role === "tool"
    )
    const firstTurnToolResultKey = getWorkerToolResultKey(
      firstTurnAssistantMessage?.id ?? "",
      firstTurnAssistantMessage?.tool_calls?.[0]?.id
    )
    const secondTurnToolResultKey = getWorkerToolResultKey(
      secondTurnAssistantMessage?.id ?? "",
      secondTurnAssistantMessage?.tool_calls?.[0]?.id
    )
    const firstTurnToolMessageResultKey = getWorkerToolResultKey(
      firstTurnToolMessage?.id ?? "",
      firstTurnToolMessage?.tool_call_id
    )
    const secondTurnToolMessageResultKey = getWorkerToolResultKey(
      secondTurnToolResultId?.id ?? "",
      secondTurnToolResultId?.tool_call_id
    )
    const firstTurnToolUiKey = getWorkerToolUiKey(
      firstTurnAssistantMessage?.id ?? "",
      firstTurnAssistantMessage?.tool_calls?.[0]?.id,
      0
    )
    const secondTurnToolUiKey = getWorkerToolUiKey(
      secondTurnAssistantMessage?.id ?? "",
      secondTurnAssistantMessage?.tool_calls?.[0]?.id,
      0
    )
    assert(
      typeof firstTurnToolResultKey === "string" &&
        typeof secondTurnToolResultKey === "string" &&
        typeof firstTurnToolMessageResultKey === "string" &&
        typeof secondTurnToolMessageResultKey === "string" &&
        firstTurnToolResultKey === firstTurnToolMessageResultKey &&
        secondTurnToolResultKey === secondTurnToolMessageResultKey &&
        firstTurnToolResultKey !== secondTurnToolResultKey,
      "focused worker tool results should use turn-scoped lookup keys when raw tool ids are reused"
    )
    assert(
      firstTurnToolUiKey !== secondTurnToolUiKey,
      "focused worker tool UI keys should not reuse the same raw tool call id across turns"
    )

    const repeatedMessageIdAcrossTurnsTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "worker-1",
      workerThreadId: "thread-123__worker__worker-1"
    })
    const firstTurnRepeatedId =
      repeatedMessageIdAcrossTurnsTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessage({
              id: "reused-cross-turn-message-id",
              content: "turn one content"
            }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages("thread-123__worker__worker-1", firstTurnRepeatedId)
    const secondTurnRepeatedId =
      repeatedMessageIdAcrossTurnsTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessage({
              id: "reused-cross-turn-message-id",
              content: "turn two content"
            }),
            {}
          ) as object),
          workerTurn: 2
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages("thread-123__worker__worker-1", secondTurnRepeatedId)
    const repeatedIdAssistants = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant")
    assert(
      repeatedIdAssistants.length === 2 &&
        repeatedIdAssistants[0]?.content === "turn one content" &&
        repeatedIdAssistants[1]?.content === "turn two content" &&
        repeatedIdAssistants[0]?.id !== repeatedIdAssistants[1]?.id,
      "focused worker store should preserve previous-turn assistant messages when provider ids are reused"
    )

    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "worker-1",
      workerThreadId: "thread-123__worker__worker-1"
    })
    useAppStore.getState().appendWorkerFocusMessages("thread-123__worker__worker-1", [
      {
        id: "worker-live-thread-123__worker__worker-1-1",
        role: "assistant",
        content: "same repeated assistant",
        created_at: new Date()
      },
      {
        id: "worker-live-thread-123__worker__worker-1-2",
        role: "assistant",
        content: "same repeated assistant",
        created_at: new Date()
      }
    ])
    useAppStore.getState().appendWorkerFocusMessages("thread-123__worker__worker-1", [
      {
        id: "worker-snapshot-1",
        role: "assistant",
        content: "same repeated assistant",
        created_at: new Date()
      },
      {
        id: "worker-snapshot-3",
        role: "assistant",
        content: "same repeated assistant",
        created_at: new Date()
      }
    ])
    const repeatedAssistants = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant")
    assert(
      repeatedAssistants.length === 2 &&
        repeatedAssistants[0]?.id === "worker-live-thread-123__worker__worker-1-1" &&
        repeatedAssistants[1]?.id === "worker-live-thread-123__worker__worker-1-2",
      "worker focus store should match repeated identical snapshot/live assistants by occurrence order"
    )

    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "worker-1",
      workerThreadId: "thread-123__worker__worker-1"
    })
    useAppStore.getState().appendWorkerFocusMessages("thread-123__worker__worker-1", [
      {
        id: "worker-snapshot-1",
        role: "assistant",
        content: "snapshot before live",
        created_at: new Date()
      }
    ])
    useAppStore.getState().appendWorkerFocusMessages("thread-123__worker__worker-1", [
      {
        id: "worker-live-thread-123__worker__worker-1-1",
        role: "assistant",
        content: "snapshot before live",
        created_at: new Date()
      }
    ])
    const snapshotFirstAssistants = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant")
    assert(
      snapshotFirstAssistants.length === 1 &&
        snapshotFirstAssistants[0]?.id === "worker-snapshot-1",
      "worker focus store should also merge when snapshot arrives before live stream"
    )

    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "worker-1",
      workerThreadId: "thread-123__worker__worker-1"
    })
    const oldSnapshotDate = new Date("2026-01-01T00:00:00.000Z")
    const newSnapshotDate = new Date("2026-01-02T00:00:00.000Z")
    const liveReplayDate = new Date("2026-01-03T00:00:00.000Z")
    useAppStore.getState().appendWorkerFocusMessages("thread-123__worker__worker-1", [
      {
        id: "worker-snapshot-1",
        role: "assistant",
        content: "repeated cross-turn assistant",
        created_at: oldSnapshotDate
      },
      {
        id: "worker-snapshot-5",
        role: "assistant",
        content: "repeated cross-turn assistant",
        created_at: newSnapshotDate
      }
    ])
    useAppStore.getState().appendWorkerFocusMessages("thread-123__worker__worker-1", [
      {
        id: "worker-live-thread-123__worker__worker-1-9",
        role: "assistant",
        content: "repeated cross-turn assistant",
        created_at: liveReplayDate
      }
    ])
    const crossTurnAssistants = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant")
    assert(
      crossTurnAssistants.length === 2 &&
        crossTurnAssistants[0]?.id === "worker-snapshot-1" &&
        crossTurnAssistants[0]?.created_at === oldSnapshotDate &&
        crossTurnAssistants[1]?.id === "worker-snapshot-5" &&
        crossTurnAssistants[1]?.created_at === liveReplayDate,
      "worker focus store should match repeated live text to the newest compatible snapshot"
    )

    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "worker-1",
      workerThreadId: "thread-123__worker__worker-1"
    })
    useAppStore.getState().appendWorkerFocusMessages("thread-123__worker__worker-1", [
      {
        id: "tool-id-less-live-tool-call-read_file",
        role: "tool",
        name: "read_file",
        tool_call_id: "id-less-live-tool-call",
        content: "tool completed after live assistant",
        created_at: new Date()
      }
    ])
    useAppStore.getState().appendWorkerFocusMessages("thread-123__worker__worker-1", [
      {
        id: "worker-snapshot-2",
        role: "tool",
        name: "read_file",
        tool_call_id: "id-less-live-tool-call",
        content: "tool completed after live assistant",
        created_at: new Date()
      }
    ])
    const liveFirstTools = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "tool")
    assert(
      liveFirstTools.length === 1 && liveFirstTools[0]?.id === "tool-id-less-live-tool-call-read_file",
      "worker focus store should merge snapshot tool result replay into the existing live tool result"
    )

    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "worker-1",
      workerThreadId: "thread-123__worker__worker-1"
    })
    useAppStore.getState().appendWorkerFocusMessages("thread-123__worker__worker-1", [
      {
        id: "worker-snapshot-2",
        role: "tool",
        name: "read_file",
        tool_call_id: "id-less-live-tool-call",
        content: "tool completed after live assistant",
        created_at: new Date()
      }
    ])
    useAppStore.getState().appendWorkerFocusMessages("thread-123__worker__worker-1", [
      {
        id: "tool-id-less-live-tool-call-read_file",
        role: "tool",
        name: "read_file",
        tool_call_id: "id-less-live-tool-call",
        content: "tool completed after live assistant",
        created_at: new Date()
      }
    ])
    const snapshotFirstTools = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "tool")
    assert(
      snapshotFirstTools.length === 1 && snapshotFirstTools[0]?.id === "worker-snapshot-2",
      "worker focus store should also merge tool results when snapshot arrives before live stream"
    )

    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "worker-1",
      workerThreadId: "thread-123__worker__worker-1"
    })
    useAppStore.getState().appendWorkerFocusMessages("thread-123__worker__worker-1", [
      {
        id: "worker-live-thread-123__worker__worker-1-1",
        role: "assistant",
        content: "middle of a fenced block without opening fence",
        created_at: new Date()
      }
    ])
    useAppStore.getState().appendWorkerFocusMessages("thread-123__worker__worker-1", [
      {
        id: "worker-snapshot-1",
        role: "assistant",
        content:
          "# Full report\n\n```text\nbeginning of fenced block\nmiddle of a fenced block without opening fence\n```",
        created_at: new Date()
      }
    ])
    const completeSnapshotMessages = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant")
    assert(
      completeSnapshotMessages.length === 1 &&
        typeof completeSnapshotMessages[0]?.content === "string" &&
        completeSnapshotMessages[0].content.startsWith("# Full report"),
      "worker focus store should keep complete checkpoint text over shorter live fragments"
    )
  } finally {
    resetWorkerFocusStore()
  }
}

async function testWorkerFocusCloseDropsLiveBufferForCheckpointRestore(): Promise<void> {
  openWorkerFocusViewForTest({
    threadId: "thread-123",
    workerId: "implementer-1",
    workerThreadId: "thread-123__worker__implementer-1",
    role: "implementer",
    description: "Inspect worker stream"
  })
  useAppStore.getState().appendWorkerFocusMessages("thread-123__worker__implementer-1", [
    {
      id: "worker-live-assistant-1",
      role: "assistant",
      content: "partial live worker text",
      created_at: new Date()
    }
  ])

  useAppStore.getState().closeWorkerFocusView()
  openWorkerFocusViewForTest({
    threadId: "thread-123",
    workerId: "implementer-1",
    workerThreadId: "thread-123__worker__implementer-1",
    role: "implementer",
    description: "Inspect worker stream",
    status: "running"
  })

  const preservedMessages = useAppStore.getState().workerFocusMessages
  assert(
    preservedMessages.length === 0,
    "closing a worker focus view should drop live buffer and let checkpoint restore history"
  )
  useAppStore.getState().appendWorkerFocusMessages("thread-123__worker__implementer-1", [
    {
      id: "worker-live-assistant-1",
      role: "assistant",
      content: "partial live worker text plus the final summary",
      created_at: new Date()
    }
  ])
  const resumedMessages = useAppStore.getState().workerFocusMessages
  assert(
    resumedMessages.length === 1 &&
      resumedMessages[0]?.content === "partial live worker text plus the final summary",
    "new live chunks after reopening should start from a clean worker buffer"
  )

  useAppStore.getState().closeWorkerFocusView()
  openWorkerFocusViewForTest({
    threadId: "thread-123",
    workerId: "implementer-1",
    workerThreadId: "thread-123__worker__implementer-1",
    role: "implementer",
    description: "Inspect worker stream",
    status: "completed"
  })
  assert(
    useAppStore.getState().workerFocusMessages.length === 0,
    "closing without preserve should drop stale live text"
  )

  openWorkerFocusViewForTest({
    threadId: "thread-123",
    workerId: "implementer-2",
    workerThreadId: "thread-123__worker__implementer-2",
    role: "implementer",
    description: "Inspect another worker"
  })
  assert(
    useAppStore.getState().workerFocusMessages.length === 0,
    "opening a different worker should clear the previous worker buffer"
  )
  useAppStore.getState().appendWorkerFocusMessages("thread-123__worker__implementer-2", [
    {
      id: "worker-live-assistant-2",
      role: "assistant",
      content: "other live worker text",
      created_at: new Date()
    }
  ])
  openWorkerFocusViewForTest({
    threadId: "thread-123",
    workerId: "implementer-1",
    workerThreadId: "thread-123__worker__implementer-1",
    role: "implementer",
    description: "Inspect worker stream",
    status: "running"
  })
  assert(
    useAppStore.getState().workerFocusMessages.length === 0,
    "switching away to another worker and back should not restore stale live text"
  )

  useAppStore.getState().closeWorkerFocusView()
}

async function testCoordinatorToolCallChunksHydrateDisplayedArgs(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const firstEvents = convertCoordinator(
    transport,
    streamMessageEvent(
      aiMessageChunk({
        id: "coordinator-ai-args",
        toolCallChunks: [
          {
            id: "start-worker-1",
            name: "start_worker",
            args: '{"subagent_type":"worker","workload":"read_only",'
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )
  assert(
    messageEvents(firstEvents).length === 0,
    "incomplete tool-call args should not force a visible message update"
  )

  const completedEvents = convertCoordinator(
    transport,
    streamMessageEvent(
      aiMessageChunk({
        id: "coordinator-ai-args",
        toolCallChunks: [
          {
            id: "start-worker-1",
            args: '"description":"Search clients","prompt":"Find Elasticsearch usages"}'
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )
  const message = firstMessage(completedEvents)
  const toolCalls = message.tool_calls as Array<{
    id?: string
    name?: string
    args?: Record<string, unknown>
  }>
  assert(toolCalls?.[0]?.name === "start_worker", "completed chunk should emit start_worker")
  assert(
    toolCalls[0]?.args?.description === "Search clients",
    "completed chunk args should replace the early empty args placeholder"
  )
  assert(
    toolCalls[0]?.args?.prompt === "Find Elasticsearch usages",
    "completed chunk should preserve full prompt args for raw argument display"
  )
}

async function testCoordinatorToolCallChunksHandleCumulativeProviderArgs(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const cumulativeArgs =
    '{"subagent_type":"worker","role":"implementer","workload":"read_only","description":"Search clients","prompt":"Find Elasticsearch usages"}'

  convertCoordinator(
    transport,
    streamMessageEvent(
      aiMessageChunk({
        id: "coordinator-ai-cumulative",
        toolCallChunks: [
          {
            id: "start-worker-cumulative",
            name: "start_worker",
            args: cumulativeArgs
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )
  const repeatedEvents = convertCoordinator(
    transport,
    streamMessageEvent(
      aiMessageChunk({
        id: "coordinator-ai-cumulative",
        toolCallChunks: [
          {
            id: "start-worker-cumulative",
            name: "start_worker",
            args: cumulativeArgs
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )
  const message = firstMessage(repeatedEvents)
  const toolCalls = message.tool_calls as Array<{
    id?: string
    name?: string
    args?: Record<string, unknown>
  }>
  assert(
    toolCalls[0]?.args?.subagent_type === "worker",
    "repeated cumulative chunks should not duplicate string argument values"
  )
  assert(
    toolCalls[0]?.args?.prompt === "Find Elasticsearch usages",
    "repeated cumulative chunks should preserve prompt once"
  )

  const overlapTransport = new ElectronIPCTransport()
  convertCoordinator(
    overlapTransport,
    streamMessageEvent(
      aiMessageChunk({
        id: "coordinator-ai-overlap",
        toolCallChunks: [
          {
            id: "start-worker-overlap",
            name: "start_worker",
            args: '{"subagent_type":"worker","workload":"read_only","description":"调研'
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )
  const overlapEvents = convertCoordinator(
    overlapTransport,
    streamMessageEvent(
      aiMessageChunk({
        id: "coordinator-ai-overlap",
        toolCallChunks: [
          {
            id: "start-worker-overlap",
            args: '调研项目","prompt":"请调研controller结构"}'
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )
  const overlapMessage = firstMessage(overlapEvents)
  const overlapToolCalls = overlapMessage.tool_calls as Array<{
    id?: string
    name?: string
    args?: Record<string, unknown>
  }>
  assert(
    overlapToolCalls[0]?.args?.description === "调研项目",
    "overlapping tool-call chunks should not duplicate string argument suffixes"
  )

  const repeatedSuffixTransport = new ElectronIPCTransport()
  convertCoordinator(
    repeatedSuffixTransport,
    streamMessageEvent(
      aiMessageChunk({
        id: "coordinator-ai-repeated-suffix",
        toolCallChunks: [
          {
            id: "start-worker-repeated-suffix",
            name: "start_worker",
            args: '{"subagent_type":"worker","workload":"read_only","description":"foo'
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )
  convertCoordinator(
    repeatedSuffixTransport,
    streamMessageEvent(
      aiMessageChunk({
        id: "coordinator-ai-repeated-suffix",
        toolCallChunks: [
          {
            id: "start-worker-repeated-suffix",
            args: 'foo'
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )
  const repeatedSuffixEvents = convertCoordinator(
    repeatedSuffixTransport,
    streamMessageEvent(
      aiMessageChunk({
        id: "coordinator-ai-repeated-suffix",
        toolCallChunks: [
          {
            id: "start-worker-repeated-suffix",
            args: '","prompt":"done"}'
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )
  const repeatedSuffixMessage = firstMessage(repeatedSuffixEvents)
  const repeatedSuffixToolCalls = repeatedSuffixMessage.tool_calls as Array<{
    id?: string
    name?: string
    args?: Record<string, unknown>
  }>
  assert(
    repeatedSuffixToolCalls[0]?.args?.description === "foofoo",
    "legitimate repeated suffix chunks should not be mistaken for replayed chunks"
  )

  const repeatedPrefixWithTailTransport = new ElectronIPCTransport()
  convertCoordinator(
    repeatedPrefixWithTailTransport,
    streamMessageEvent(
      aiMessageChunk({
        id: "coordinator-ai-repeated-prefix-tail",
        toolCallChunks: [
          {
            id: "start-worker-repeated-prefix-tail",
            name: "start_worker",
            args: '{"subagent_type":"worker","workload":"read_only","description":"foo'
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )
  const repeatedPrefixWithTailEvents = convertCoordinator(
    repeatedPrefixWithTailTransport,
    streamMessageEvent(
      aiMessageChunk({
        id: "coordinator-ai-repeated-prefix-tail",
        toolCallChunks: [
          {
            id: "start-worker-repeated-prefix-tail",
            args: 'foo","prompt":"done"}'
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )
  const repeatedPrefixWithTailMessage = firstMessage(repeatedPrefixWithTailEvents)
  const repeatedPrefixWithTailToolCalls = repeatedPrefixWithTailMessage.tool_calls as Array<{
    id?: string
    name?: string
    args?: Record<string, unknown>
  }>
  assert(
    repeatedPrefixWithTailToolCalls[0]?.args?.description === "foofoo",
    "legitimate repeated prefix plus tail chunks should not be collapsed as overlap"
  )

  const exactDuplicateEvents = convertCoordinator(
    new ElectronIPCTransport(),
    streamMessageEvent(
      aiMessage({
        id: "coordinator-ai-exact-duplicate",
        toolCalls: [
          {
            id: "start-worker-exact-duplicate",
            name: "start_worker",
            args: {
              subagent_type: "workerworker",
              consumed_notification_ids: ["implementer-1@turn-1", "implementer-1@turn-1"],
              workload: "read_onlyread_only",
              description: "调研项目controller结构调研项目controller结构",
              prompt: "请调研controller结构。请调研controller结构。"
            }
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )
  const exactDuplicateMessage = firstMessage(exactDuplicateEvents)
  const exactDuplicateToolCalls = exactDuplicateMessage.tool_calls as Array<{
    id?: string
    name?: string
    args?: Record<string, unknown>
  }>
  assert(
    exactDuplicateToolCalls[0]?.args?.subagent_type === "worker",
    "exact duplicate string args should be collapsed for coordinator worker tools"
  )
  assert(
    exactDuplicateToolCalls[0]?.args?.workload === "read_only",
    "exact duplicate short enum args should be collapsed for coordinator worker tools"
  )
  assert(
    JSON.stringify(exactDuplicateToolCalls[0]?.args?.consumed_notification_ids) ===
      JSON.stringify(["implementer-1@turn-1"]),
    "duplicate consumed notification ids should be removed for coordinator worker tool display"
  )
  assert(
    exactDuplicateToolCalls[0]?.args?.prompt === "请调研controller结构。请调研controller结构。",
    "freeform prompt args should not be collapsed because repeated text may be intentional"
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
    (first?.[0]?.tool_calls as Array<{ name?: string }> | undefined)?.[0]?.name === "read_file",
    "coordinator values-mode AI message should include visible tool call"
  )
  assert(
    second?.[0]?.type === "tool",
    "coordinator values-mode should surface current-turn tool result"
  )
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
  assert(
    events.length === 1,
    "coordinator values-mode should only emit messages after the latest human turn"
  )
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
  const repeatedEvents = messageEvents(convertCoordinator(transport, snapshot))
  assert(
    repeatedEvents.length === 1,
    "repeated coordinator values snapshots should only update the assistant message"
  )
  const repeatedData = repeatedEvents[0]?.data as Array<{
    id?: string
    type?: string
    content?: string
  }>
  assert(
    repeatedData?.[0]?.id === "duplicate-values-ai" && repeatedData?.[0]?.type === "ai",
    "repeated coordinator values snapshots should not duplicate already emitted tool messages"
  )
  assert(
    repeatedData?.[0]?.content === "",
    "repeated coordinator values snapshots should not append duplicate assistant text"
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
    (messages[0]?.tool_calls as Array<{ name?: string }> | undefined)?.[0]?.name === "read_file",
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
    "values-mode AI fallback should not append an already emitted messages-mode AI snapshot"
  )
}

async function testCoordinatorAiFallbackEmitsOnlyGrowingValuesDelta(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const messagesModeEvents = convertCoordinator(
    transport,
    streamMessageEvent(aiMessage({ content: "partial answer" }))
  ).filter((event) => event.event === "messages")

  assert(messagesModeEvents.length === 1, "messages-mode AI fallback should emit initial text")
  const messagesModeData = messagesModeEvents[0]?.data as Array<{ id?: string }>

  const valuesModeEvents = convertCoordinator(
    transport,
    streamValuesEvent([
      { id: ["langchain_core", "messages", "HumanMessage"], kwargs: { content: "question" } },
      aiMessage({ content: "partial answer with detail" })
    ])
  ).filter((event) => event.event === "messages")

  assert(
    valuesModeEvents.length === 1,
    "growing values-mode AI fallback should append one delta event"
  )
  const valuesModeData = valuesModeEvents[0]?.data as Array<{ id?: string; content?: string }>
  assert(
    valuesModeData?.[0]?.id === messagesModeData?.[0]?.id,
    "growing values-mode AI fallback should update the existing messages-mode AI id"
  )
  assert(
    valuesModeData?.[0]?.content === " with detail",
    "growing values-mode AI fallback should only emit the appended assistant text"
  )
}

async function testCoordinatorValuesSnapshotWithProviderIdDoesNotReplayWrappedLiveText(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const liveText = "总结：firstDemo 是一个 Spring Boot 用户认证服务。"
  const wrappedSnapshot = `项目研究已经完成。\n\n${liveText}\n\n## 项目概览\n\nfirstDemo 使用 JWT 和内存存储。`

  assert(
    convertCoordinator(
      transport,
      streamMessageEvent(aiMessage({ id: "live-ai-id", content: liveText }))
    ).filter((event) => event.event === "messages").length === 1,
    "messages-mode AI should emit the live answer"
  )

  const valuesModeEvents = convertCoordinator(
    transport,
    streamValuesEvent([
      humanMessage("分析项目"),
      aiMessage({ id: "provider-final-ai-id", content: wrappedSnapshot })
    ])
  )
  const messageEvents = valuesModeEvents.filter((event) => event.event === "messages")
  const snapshotEvents = customEvents(valuesModeEvents, "coordinator_ai_snapshot_message")
  const snapshotMessage = snapshotEvents[0]?.assistantMessage as
    | { id?: string; content?: string }
    | undefined

  assert(messageEvents.length === 0, "wrapped values snapshot must not be appended as a delta")
  assert(snapshotMessage?.id === "live-ai-id", "wrapped provider snapshot should replace live id")
  assert(
    snapshotMessage?.content === wrappedSnapshot,
    "wrapped provider snapshot should preserve the full final values content"
  )
}

async function testCoordinatorValuesSnapshotWithoutProviderIdDoesNotReplayWrappedLiveText(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const liveText = "总结：firstDemo 是一个 Spring Boot 用户认证服务。"
  const wrappedSnapshot = `项目研究已经完成。\n\n${liveText}\n\n## 项目概览\n\nfirstDemo 使用 JWT 和内存存储。`

  const messagesModeEvents = convertCoordinator(
    transport,
    streamMessageEvent(aiMessage({ content: liveText }))
  ).filter((event) => event.event === "messages")
  assert(messagesModeEvents.length === 1, "messages-mode AI should emit the live answer")

  const valuesModeEvents = convertCoordinator(
    transport,
    streamValuesEvent([humanMessage("分析项目"), aiMessage({ content: wrappedSnapshot })])
  )
  const messageEvents = valuesModeEvents.filter((event) => event.event === "messages")
  const snapshotEvents = customEvents(valuesModeEvents, "coordinator_ai_snapshot_message")
  const snapshotMessage = snapshotEvents[0]?.assistantMessage as
    | { id?: string; content?: string }
    | undefined

  assert(messageEvents.length === 0, "wrapped values snapshot must not be appended as a delta")
  assert(snapshotMessage?.content === wrappedSnapshot, "snapshot should preserve full final content")
}

async function testCoordinatorValuesSnapshotWithSameProviderIdDoesNotReplayWrappedLiveText(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const liveText = "总结：firstDemo 是一个 Spring Boot 用户认证服务。"
  const wrappedSnapshot = `项目研究已经完成。\n\n${liveText}\n\n## 项目概览\n\nfirstDemo 使用 JWT 和内存存储。`

  assert(
    convertCoordinator(
      transport,
      streamMessageEvent(aiMessage({ id: "same-ai-id", content: liveText }))
    ).filter((event) => event.event === "messages").length === 1,
    "messages-mode AI should emit the live answer"
  )

  const valuesModeEvents = convertCoordinator(
    transport,
    streamValuesEvent([
      humanMessage("分析项目"),
      aiMessage({ id: "same-ai-id", content: wrappedSnapshot })
    ])
  )
  const messageEvents = valuesModeEvents.filter((event) => event.event === "messages")
  const snapshotEvents = customEvents(valuesModeEvents, "coordinator_ai_snapshot_message")
  const snapshotMessage = snapshotEvents[0]?.assistantMessage as
    | { id?: string; content?: string }
    | undefined

  assert(messageEvents.length === 0, "wrapped values snapshot must not be appended as a delta")
  assert(snapshotMessage?.id === "same-ai-id", "snapshot should keep the same provider id")
  assert(snapshotMessage?.content === wrappedSnapshot, "snapshot should preserve full final content")
}

async function testCoordinatorValuesSnapshotDoesNotAppendRepeatedFullTextSuffix(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const liveText =
    "总结：firstDemo 是一个 Spring Boot 用户认证服务，包含 JWT 认证、用户注册登录和内存存储。"
  const repeatedSnapshot = `${liveText}\n\n${liveText}\n\n## 项目概览\n\nJava 17 + Spring Boot 3.4.5。`

  assert(
    convertCoordinator(
      transport,
      streamMessageEvent(aiMessage({ id: "same-ai-id", content: liveText }))
    ).filter((event) => event.event === "messages").length === 1,
    "messages-mode AI should emit the live answer"
  )

  const valuesModeEvents = convertCoordinator(
    transport,
    streamValuesEvent([
      humanMessage("分析项目"),
      aiMessage({ id: "same-ai-id", content: repeatedSnapshot })
    ])
  ).filter((event) => event.event === "messages")

  assert(valuesModeEvents.length === 1, "values snapshot should preserve new text after replay")
  const valuesModeData = valuesModeEvents[0]?.data as Array<{ content?: string }>
  assert(
    valuesModeData?.[0]?.content === "\n\n## 项目概览\n\nJava 17 + Spring Boot 3.4.5。",
    "values snapshot should append only the new tail after the repeated full text"
  )
}

async function testCoordinatorValuesSnapshotKeepsSubsequentReplayGrowth(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const liveText =
    "总结：firstDemo 是一个 Spring Boot 用户认证服务，包含 JWT 认证、用户注册登录和内存存储。"
  const firstSnapshot = `${liveText}\n\n${liveText}\n\n结论 A：适合作为教学原型。`
  const secondSnapshot = `${liveText}\n\n${liveText}\n\n结论 A：适合作为教学原型。\n结论 B：生产环境需要数据库。`

  assert(
    convertCoordinator(
      transport,
      streamMessageEvent(aiMessage({ id: "same-ai-id", content: liveText }))
    ).filter((event) => event.event === "messages").length === 1,
    "messages-mode AI should emit the live answer"
  )

  const firstValuesEvents = convertCoordinator(
    transport,
    streamValuesEvent([
      humanMessage("分析项目"),
      aiMessage({ id: "same-ai-id", content: firstSnapshot })
    ])
  ).filter((event) => event.event === "messages")
  assert(firstValuesEvents.length === 1, "first replay snapshot should emit conclusion A")

  const secondValuesEvents = convertCoordinator(
    transport,
    streamValuesEvent([
      humanMessage("分析项目"),
      aiMessage({ id: "same-ai-id", content: secondSnapshot })
    ])
  )
  const replacement = customEvents(
    secondValuesEvents,
    "coordinator_ai_snapshot_message"
  )[0]?.assistantMessage as { id?: string; content?: string } | undefined

  assert(
    replacement?.id === "same-ai-id" && replacement.content === secondSnapshot,
    "subsequent replay growth should replace with the full latest snapshot instead of disappearing"
  )
}

async function testCoordinatorValuesSnapshotKeepsPartialReplayPrefixTail(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const liveText =
    "总结：firstDemo 是一个 Spring Boot 用户认证服务，包含 JWT 认证、用户注册登录和内存存储。"
  const partialReplayTail =
    "\n\n总结：firstDemo 是一个 Spring Boot 用户认证服务，新增最终结论：应补充数据库持久化。"
  const finalSnapshot = `${liveText}${partialReplayTail}`

  assert(
    convertCoordinator(
      transport,
      streamMessageEvent(aiMessage({ id: "same-ai-id", content: liveText }))
    ).filter((event) => event.event === "messages").length === 1,
    "messages-mode AI should emit the live answer"
  )

  const valuesModeEvents = convertCoordinator(
    transport,
    streamValuesEvent([
      humanMessage("分析项目"),
      aiMessage({ id: "same-ai-id", content: finalSnapshot })
    ])
  ).filter((event) => event.event === "messages")

  assert(
    valuesModeEvents.length === 1,
    "partial replay prefix with new tail must still emit the final tail"
  )
  const valuesModeData = valuesModeEvents[0]?.data as Array<{ content?: string }>
  assert(
    valuesModeData?.[0]?.content === partialReplayTail,
    "partial replay prefix should not be mistaken for a pure full-text replay"
  )
}

async function testCoordinatorValuesSnapshotKeepsQuotedPriorTextInSuffix(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const liveText =
    "总结：firstDemo 是一个 Spring Boot 用户认证服务，包含 JWT 认证、用户注册登录和内存存储。"
  const quotedTail = `\n\n引用前文：${liveText}\n\n补充：生产环境需要数据库。`
  const finalSnapshot = `${liveText}${quotedTail}`

  assert(
    convertCoordinator(
      transport,
      streamMessageEvent(aiMessage({ id: "same-ai-id", content: liveText }))
    ).filter((event) => event.event === "messages").length === 1,
    "messages-mode AI should emit the live answer"
  )

  const valuesModeEvents = convertCoordinator(
    transport,
    streamValuesEvent([
      humanMessage("分析项目"),
      aiMessage({ id: "same-ai-id", content: finalSnapshot })
    ])
  ).filter((event) => event.event === "messages")

  assert(valuesModeEvents.length === 1, "quoted prior text should still be emitted")
  const valuesModeData = valuesModeEvents[0]?.data as Array<{ content?: string }>
  assert(
    valuesModeData?.[0]?.content === quotedTail,
    "quoted prior text in the suffix should not be mistaken for a leading replay"
  )
}

async function testCoordinatorValuesSnapshotDoesNotAppendAlternativeFullSnapshot(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const sharedPrefix =
    "## firstDemo 项目分析报告\n\n### 项目定位\n\n这是一个基于 Spring Boot 3.4.5 + Java 17 的用户认证系统，提供完整的注册、登录、JWT 鉴权、用户资料管理、密码重置和邮箱验证功能。"
  const liveText = `${sharedPrefix}\n\n### 当前流式版本\n\n- 已完成项目结构扫描\n- 正在整理模块说明\n- 旧版流式结尾`
  const valuesSnapshot = `${sharedPrefix}\n\n### values 完整快照版本\n\n- 项目结构扫描完成\n- 模块说明已经归纳\n- 新版最终结尾`

  assert(
    convertCoordinator(
      transport,
      streamMessageEvent(aiMessage({ id: "same-ai-id", content: liveText }))
    ).filter((event) => event.event === "messages").length === 1,
    "messages-mode AI should emit the live answer"
  )

  const valuesModeEvents = convertCoordinator(
    transport,
    streamValuesEvent([
      humanMessage("分析项目"),
      aiMessage({ id: "same-ai-id", content: valuesSnapshot })
    ])
  )
  const messageEvents = valuesModeEvents.filter((event) => event.event === "messages")
  const snapshotEvents = customEvents(valuesModeEvents, "coordinator_ai_snapshot_message")
  const snapshotMessage = snapshotEvents[0]?.assistantMessage as
    | { id?: string; content?: string }
    | undefined

  assert(messageEvents.length === 0, "replacement snapshot must not be appended as a delta")
  assert(snapshotMessage?.id === "same-ai-id", "replacement snapshot should target same id")
  assert(
    snapshotMessage?.content === valuesSnapshot,
    "replacement snapshot should preserve rewritten final content"
  )
}

async function testCoordinatorValuesSnapshotWithReplayStillEmitsToolCalls(): Promise<void> {
  const transport = new ElectronIPCTransport()

  assert(
    convertCoordinator(
      transport,
      streamMessageEvent(aiMessage({ id: "live-ai-id", content: "partial" }))
    ).filter((event) => event.event === "messages").length === 1,
    "messages-mode AI should emit the live answer"
  )

  const events = convertCoordinator(
    transport,
    streamValuesEvent([
      humanMessage("分析项目"),
      aiMessage({
        id: "provider-final-ai-id",
        content: "prefix partial suffix",
        toolCalls: [{ id: "tool-1", name: "execute_command", args: { cmd: "pwd" } }]
      })
    ])
  )
  const snapshotEvents = customEvents(events, "coordinator_ai_snapshot_message")
  const snapshotMessage = snapshotEvents[0]?.assistantMessage as
    | { tool_calls?: Array<{ id?: string; name?: string }> }
    | undefined
  assert(
    snapshotMessage?.tool_calls?.[0]?.name === "execute_command",
    "replay replacement snapshots must still carry newly visible tool calls"
  )
}

async function testCoordinatorValuesSnapshotContainingPriorTextStillEmits(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const liveText = "已完成检查清单：配置、接口、认证。"
  const finalText = `最终结论如下。\n\n引用上一段清单：${liveText}\n\n补充风险：内存存储不适合生产。`

  assert(
    convertCoordinator(
      transport,
      streamMessageEvent(aiMessage({ id: "live-ai-id", content: liveText }))
    ).filter((event) => event.event === "messages").length === 1,
    "messages-mode AI should emit the live answer"
  )

  const events = convertCoordinator(
    transport,
    streamValuesEvent([
      humanMessage("分析项目"),
      aiMessage({ id: "provider-final-ai-id", content: finalText })
    ])
  )
  const snapshotEvents = customEvents(events, "coordinator_ai_snapshot_message")
  const snapshotMessage = snapshotEvents[0]?.assistantMessage as
    | { id?: string; content?: string }
    | undefined

  assert(snapshotMessage?.id === "live-ai-id", "provider replay should target live message id")
  assert(
    snapshotMessage?.content === finalText,
    "provider replay should preserve the full final snapshot instead of disappearing"
  )
}

async function testCoordinatorValuesSnapshotKeepsUnrelatedProviderAssistant(): Promise<void> {
  const transport = new ElectronIPCTransport()

  assert(
    convertCoordinator(
      transport,
      streamMessageEvent(aiMessage({ id: "first-ai-id", content: "我先检查项目结构。" }))
    ).filter((event) => event.event === "messages").length === 1,
    "messages-mode AI should emit the first assistant"
  )

  const valuesModeEvents = convertCoordinator(
    transport,
    streamValuesEvent([
      humanMessage("分析项目"),
      aiMessage({ id: "second-ai-id", content: "检查完成，下面给出结论。" })
    ])
  ).filter((event) => event.event === "messages")

  assert(valuesModeEvents.length === 1, "unrelated provider assistant should still be emitted")
  const valuesModeData = valuesModeEvents[0]?.data as Array<{ id?: string; content?: string }>
  assert(
    valuesModeData?.[0]?.id === "second-ai-id" &&
      valuesModeData?.[0]?.content === "检查完成，下面给出结论。",
    "unrelated provider assistant should keep its own id and content"
  )
}

async function testCoordinatorValuesSnapshotMatchesEarlierLiveAssistantBeforeNewAssistant(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const liveText = "我先检查项目结构。"
  const newAssistantText = `引用上一条：${liveText}\n\n下面给出结论。`

  assert(
    convertCoordinator(
      transport,
      streamMessageEvent(aiMessage({ id: "live-ai-id", content: liveText }))
    ).filter((event) => event.event === "messages").length === 1,
    "messages-mode AI should emit the initial live assistant"
  )

  const valuesModeEvents = convertCoordinator(
    transport,
    streamValuesEvent([
      humanMessage("分析项目"),
      aiMessage({ id: "provider-ai-1", content: liveText }),
      aiMessage({ id: "provider-ai-2", content: newAssistantText })
    ])
  )
  const messageEvents = valuesModeEvents.filter((event) => event.event === "messages")
  const snapshotEvents = customEvents(valuesModeEvents, "coordinator_ai_snapshot_message")

  assert(
    snapshotEvents.length === 0,
    "new provider assistant should not replace the earlier live assistant"
  )
  assert(
    messageEvents.length === 1,
    "values snapshot should skip the already-live assistant and emit only the new assistant"
  )
  const valuesModeData = messageEvents[0]?.data as Array<{ id?: string; content?: string }>
  assert(
    valuesModeData?.[0]?.id === "provider-ai-2" &&
      valuesModeData?.[0]?.content === newAssistantText,
    "values snapshot should keep the second provider assistant as a distinct message"
  )
}

async function testCoordinatorValuesSnapshotKeepsPostToolAssistantSeparateAfterPreToolGrowth(): Promise<void> {
  const transport = new ElectronIPCTransport()

  assert(
    convertCoordinator(
      transport,
      streamMessageEvent(aiMessage({ id: "live-ai-2", content: "好的" }))
    ).filter((event) => event.event === "messages").length === 1,
    "messages-mode AI should emit the short live assistant"
  )

  const valuesModeEvents = convertCoordinator(
    transport,
    streamValuesEvent([
      humanMessage("分析项目"),
      aiMessage({ id: "provider-ai-1", content: "好的，我先检查项目结构。" }),
      toolMessage({
        id: "tool-1",
        name: "execute_command",
        toolCallId: "call-1",
        content: "scan done"
      }),
      aiMessage({ id: "provider-ai-2", content: "好的，下面给出结论。" })
    ])
  )

  const messageEvents = valuesModeEvents.filter((event) => event.event === "messages")
  const snapshotEvents = customEvents(valuesModeEvents, "coordinator_ai_snapshot_message")
  const aiMessages = messageEvents.flatMap((event) => event.data as Array<{ id?: string; content?: string }>)

  assert(snapshotEvents.length === 0, "short prefix matches should not replace the live assistant")
  assert(
    aiMessages.some(
      (message) => message.id === "live-ai-2" && message.content === "，我先检查项目结构。"
    ),
    "pre-tool assistant growth should extend the current live message"
  )
  assert(
    aiMessages.some(
      (message) => message.id === "provider-ai-2" && message.content === "好的，下面给出结论。"
    ),
    "post-tool assistant with the same generic prefix should stay as its own message"
  )
}

async function testCoordinatorValuesSnapshotDoesNotLetEarlierExactShortReplayStealLiveAssistant(): Promise<void> {
  const transport = new ElectronIPCTransport()

  assert(
    convertCoordinator(
      transport,
      streamMessageEvent(aiMessage({ id: "live-ai-2", content: "好的" }))
    ).filter((event) => event.event === "messages").length === 1,
    "messages-mode AI should emit the short live assistant"
  )

  const valuesModeEvents = convertCoordinator(
    transport,
    streamValuesEvent([
      humanMessage("分析项目"),
      aiMessage({ id: "provider-ai-1", content: "好的" }),
      toolMessage({
        id: "tool-1",
        name: "execute_command",
        toolCallId: "call-1",
        content: "scan done"
      }),
      aiMessage({ id: "provider-ai-2", content: "好的，下面给出结论。" })
    ])
  )

  const messageEvents = valuesModeEvents.filter((event) => event.event === "messages")
  const snapshotEvents = customEvents(valuesModeEvents, "coordinator_ai_snapshot_message")
  const aiMessages = messageEvents.flatMap((event) => event.data as Array<{ id?: string; content?: string }>)

  assert(snapshotEvents.length === 0, "exact short replay should not trigger replacement")
  assert(
    !aiMessages.some((message) => message.id === "provider-ai-1"),
    "earlier exact replay of the short live assistant should be skipped"
  )
  assert(
    aiMessages.some(
      (message) => message.id === "provider-ai-2" && message.content === "好的，下面给出结论。"
    ),
    "later assistant after a tool boundary should stay as its own provider message"
  )
}

async function testCoordinatorValuesSnapshotKeepsIdenticalPostToolAssistantSeparate(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const liveText = "好的"

  assert(
    convertCoordinator(
      transport,
      streamMessageEvent(aiMessage({ id: "live-ai", content: liveText }))
    ).filter((event) => event.event === "messages").length === 1,
    "messages-mode AI should emit the short live assistant"
  )

  const valuesModeEvents = convertCoordinator(
    transport,
    streamValuesEvent([
      humanMessage("分析项目"),
      aiMessage({ id: "provider-ai-1", content: liveText }),
      toolMessage({
        id: "tool-1",
        name: "execute_command",
        toolCallId: "call-1",
        content: "scan done"
      }),
      aiMessage({ id: "provider-ai-2", content: liveText })
    ])
  )

  const messageEvents = valuesModeEvents.filter((event) => event.event === "messages")
  const snapshotEvents = customEvents(valuesModeEvents, "coordinator_ai_snapshot_message")
  const aiMessages = messageEvents.flatMap((event) => event.data as Array<{ id?: string; content?: string }>)

  assert(snapshotEvents.length === 0, "exact same-text replay should not trigger replacement")
  assert(
    !aiMessages.some((message) => message.id === "provider-ai-1"),
    "pre-tool exact replay of the live assistant should be skipped"
  )
  assert(
    aiMessages.some((message) => message.id === "provider-ai-2" && message.content === liveText),
    "post-tool assistant with identical text should remain a distinct provider message"
  )
}

async function testCoordinatorValuesSnapshotDoesNotMergeAcrossToolBoundaryAfterExactReplay(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const liveText = "我先检查项目结构，然后总结关键模块。"
  const finalText = `${liveText}\n\n下面给出结论。`

  assert(
    convertCoordinator(
      transport,
      streamMessageEvent(aiMessage({ id: "live-ai", content: liveText }))
    ).filter((event) => event.event === "messages").length === 1,
    "messages-mode AI should emit the live assistant"
  )

  const valuesModeEvents = convertCoordinator(
    transport,
    streamValuesEvent([
      humanMessage("分析项目"),
      aiMessage({ id: "provider-ai-1", content: liveText }),
      toolMessage({
        id: "tool-1",
        name: "execute_command",
        toolCallId: "call-1",
        content: "scan done"
      }),
      aiMessage({ id: "provider-ai-2", content: finalText })
    ])
  )

  const messageEvents = valuesModeEvents.filter((event) => event.event === "messages")
  const aiMessages = messageEvents.flatMap((event) => event.data as Array<{ id?: string; content?: string }>)

  assert(
    !aiMessages.some((message) => message.id === "provider-ai-1"),
    "the exact replay before the tool should be skipped"
  )
  assert(
    aiMessages.some((message) => message.id === "provider-ai-2" && message.content === finalText),
    "the assistant after the tool boundary should remain a distinct provider message"
  )
  assert(
    !aiMessages.some((message) => message.id === "live-ai" && message.content === "\n\n下面给出结论。"),
    "the tool-after assistant must not be merged into the pre-tool live message"
  )
}

async function testCoordinatorValuesSnapshotDoesNotMergeAcrossToolBoundaryAfterGrowth(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const liveText = "我先检查项目结构"
  const preToolText = `${liveText}，然后总结关键模块。`
  const postToolText = `${preToolText}\n\n下面给出结论。`

  assert(
    convertCoordinator(
      transport,
      streamMessageEvent(aiMessage({ id: "live-ai", content: liveText }))
    ).filter((event) => event.event === "messages").length === 1,
    "messages-mode AI should emit the live assistant"
  )

  const valuesModeEvents = convertCoordinator(
    transport,
    streamValuesEvent([
      humanMessage("分析项目"),
      aiMessage({ id: "provider-ai-1", content: preToolText }),
      toolMessage({
        id: "tool-1",
        name: "execute_command",
        toolCallId: "call-1",
        content: "scan done"
      }),
      aiMessage({ id: "provider-ai-2", content: postToolText })
    ])
  )

  const messageEvents = valuesModeEvents.filter((event) => event.event === "messages")
  const aiMessages = messageEvents.flatMap((event) => event.data as Array<{ id?: string; content?: string }>)

  assert(
    aiMessages.some(
      (message) => message.id === "live-ai" && message.content === "，然后总结关键模块。"
    ),
    "pre-tool growth should update the live assistant"
  )
  assert(
    aiMessages.some((message) => message.id === "provider-ai-2" && message.content === postToolText),
    "post-tool assistant after a growth candidate should remain a distinct provider message"
  )
  assert(
    !aiMessages.some(
      (message) => message.id === "live-ai" && message.content?.includes("下面给出结论")
    ),
    "post-tool assistant must not be merged into the pre-tool live message"
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

async function testSubagentThinkingStreamingAccumulation(): Promise<void> {
  const transport = new ElectronIPCTransport()
  // Register the subagent via a main-flow task tool call.
  convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "main-ai-1",
        toolCalls: [
          { id: "task-1", name: "task", args: { subagent_type: "implementer", description: "think" } }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )

  const ns = "agent:tools:task-1"
  const feed = (content: string): SdkEvent[] =>
    convert(
      transport,
      streamMessageEvent(aiMessageChunk({ id: "subagent-ai-1", content }), {
        langgraph_checkpoint_ns: ns
      })
    )

  // Stream "hello" + " " + "world" as separate delta chunks; the whitespace chunk
  // must not be dropped (otherwise the text glues into "helloworld").
  feed("hello")
  feed(" ")
  const lastEvents = feed("world")

  const assistantLogs = customEvents(lastEvents, "subagent_log_entry").filter(
    (data) => asRecord(data.entry).kind === "assistant"
  )
  assert(assistantLogs.length > 0, "subagent thinking should emit an assistant log entry")
  const entry = asRecord(assistantLogs[assistantLogs.length - 1].entry)
  assert(
    entry.content === "hello world",
    `streamed thinking should accumulate with spaces, got ${JSON.stringify(entry.content)}`
  )
  assert(
    entry.subagentToolCallId === "task-1",
    "thinking entry should be attributed to the owning subagent"
  )
  assert(
    messageEvents(lastEvents).length === 0,
    "subagent thinking must not leak into the main chat stream"
  )
}

async function run(): Promise<void> {
  await testSubagentInternalsAreHiddenButObservable()
  console.log("PASS electron transport hides subagent internals")
  await testNamespacedToolsWithoutRunningSubagentRemainVisible()
  console.log("PASS electron transport avoids false subagent classification")
  await testAsyncWorkerInternalsStayOutOfMainThread()
  console.log("PASS electron transport hides async worker internals")
  await testFocusedAsyncWorkerStreamsToWorkerPanel()
  console.log("PASS electron transport routes focused worker internals")
  await testWorkerFocusCloseDropsLiveBufferForCheckpointRestore()
  console.log("PASS worker focus drops live buffer across close/reopen")
  await testCoordinatorToolCallChunksHydrateDisplayedArgs()
  console.log("PASS electron transport hydrates coordinator tool-call chunk args")
  await testCoordinatorToolCallChunksHandleCumulativeProviderArgs()
  console.log("PASS electron transport handles cumulative tool-call chunk args")
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
  await testCoordinatorAiFallbackEmitsOnlyGrowingValuesDelta()
  console.log("PASS electron transport emits only growing AI fallback deltas")
  await testCoordinatorValuesSnapshotWithProviderIdDoesNotReplayWrappedLiveText()
  console.log("PASS electron transport avoids replaying wrapped provider values snapshots")
  await testCoordinatorValuesSnapshotWithoutProviderIdDoesNotReplayWrappedLiveText()
  console.log("PASS electron transport avoids replaying wrapped fallback values snapshots")
  await testCoordinatorValuesSnapshotWithSameProviderIdDoesNotReplayWrappedLiveText()
  console.log("PASS electron transport avoids replaying wrapped same-id values snapshots")
  await testCoordinatorValuesSnapshotDoesNotAppendRepeatedFullTextSuffix()
  console.log("PASS electron transport avoids appending repeated full-text values suffixes")
  await testCoordinatorValuesSnapshotKeepsSubsequentReplayGrowth()
  console.log("PASS electron transport keeps subsequent replay growth")
  await testCoordinatorValuesSnapshotKeepsPartialReplayPrefixTail()
  console.log("PASS electron transport keeps partial replay prefix tails")
  await testCoordinatorValuesSnapshotKeepsQuotedPriorTextInSuffix()
  console.log("PASS electron transport keeps quoted prior text in suffixes")
  await testCoordinatorValuesSnapshotDoesNotAppendAlternativeFullSnapshot()
  console.log("PASS electron transport avoids appending alternative full values snapshots")
  await testCoordinatorValuesSnapshotWithReplayStillEmitsToolCalls()
  console.log("PASS electron transport keeps tool calls on replay replacement snapshots")
  await testCoordinatorValuesSnapshotContainingPriorTextStillEmits()
  console.log("PASS electron transport keeps provider snapshots that quote prior text")
  await testCoordinatorValuesSnapshotKeepsUnrelatedProviderAssistant()
  console.log("PASS electron transport keeps unrelated provider assistant snapshots")
  await testCoordinatorValuesSnapshotMatchesEarlierLiveAssistantBeforeNewAssistant()
  console.log("PASS electron transport matches earlier live assistant before new assistant")
  await testCoordinatorValuesSnapshotKeepsPostToolAssistantSeparateAfterPreToolGrowth()
  console.log("PASS electron transport keeps post-tool assistant separate after pre-tool growth")
  await testCoordinatorValuesSnapshotDoesNotLetEarlierExactShortReplayStealLiveAssistant()
  console.log("PASS electron transport ignores earlier exact short replay before live growth")
  await testCoordinatorValuesSnapshotKeepsIdenticalPostToolAssistantSeparate()
  console.log("PASS electron transport keeps identical post-tool assistant distinct")
  await testCoordinatorValuesSnapshotDoesNotMergeAcrossToolBoundaryAfterExactReplay()
  console.log("PASS electron transport keeps post-tool assistant distinct after exact replay")
  await testCoordinatorValuesSnapshotDoesNotMergeAcrossToolBoundaryAfterGrowth()
  console.log("PASS electron transport keeps post-tool assistant distinct after growth")
  await testValuesModeRegistersAndCompletesSubagents()
  console.log("PASS electron transport values-mode subagent lifecycle")
  await testSubagentThinkingStreamingAccumulation()
  console.log("PASS electron transport accumulates streamed subagent thinking")
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
