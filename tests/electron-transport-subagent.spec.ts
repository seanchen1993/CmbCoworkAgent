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
  getSubagentTranscriptsFromThreadValues,
  mergeSubagentTranscripts,
  serializeSubagentTranscripts
} from "../src/renderer/src/lib/subagent-transcripts.ts"
import type { Message } from "../src/renderer/src/types.ts"
import {
  upsertSubagentLogEntry,
  type SubagentInternalLogEntry
} from "../src/renderer/src/lib/thread-state-helpers.ts"
import { CONTEXT_COMPACTION_MODEL_TAG } from "../src/shared/context-compaction-events.ts"
import { buildSubagentTaskInvocationIdentity } from "../src/shared/subagent-invocation-identity.ts"
import {
  buildWorkerCheckpointHistory,
  isExplicitWorkerOccurrenceAfter,
  isCompleteWorkerSnapshotCoveringHistory,
  mergeWorkerCheckpointSparseContent,
  normalizeWorkerMessagesAfterHistory
} from "../src/renderer/src/lib/worker-checkpoint-history.ts"
import {
  buildToolResultAssociations,
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
    agentMode?: "normal" | "coordinator" | "workflow"
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
  additionalKwargs?: Record<string, unknown>
}): unknown {
  return {
    id: ["langchain_core", "messages", "AIMessage"],
    kwargs: {
      id: input.id,
      content: input.content ?? "",
      tool_calls: input.toolCalls,
      additional_kwargs: input.additionalKwargs
    }
  }
}

function aiMessageChunk(input: {
  id?: string
  content?: unknown
  reasoning?: string
  toolCallChunks?: Array<{ id?: string; name?: string; args?: string; index?: number }>
}): unknown {
  return {
    id: ["langchain_core", "messages", "AIMessageChunk"],
    kwargs: {
      id: input.id,
      content: input.content ?? "",
      ...(input.reasoning !== undefined && { reasoning_content: input.reasoning }),
      tool_call_chunks: input.toolCallChunks
    }
  }
}

function toolMessage(input: {
  id?: string
  name?: string
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

function humanMessage(
  content: string,
  input?: { id?: string; additionalKwargs?: Record<string, unknown> }
): unknown {
  return {
    id: ["langchain_core", "messages", "HumanMessage"],
    kwargs: {
      id: input?.id ?? `human-${content}`,
      content,
      additional_kwargs: input?.additionalKwargs
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
  agentMode: "normal" | "coordinator" | "workflow" = "normal"
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
  const transcriptToolCall = customEvents(internalToolEvents, "subagent_transcript_message")[0]
  assert(transcriptToolCall, "subagent internal tool call should emit a transcript message")
  assert(transcriptToolCall.subagentId === "task-1", "transcript message should target subagent")
  const transcriptAssistant = asRecord(transcriptToolCall.subagentMessage)
  const transcriptToolCalls = transcriptAssistant.tool_calls as Array<Record<string, unknown>>
  assert(
    transcriptToolCalls?.[0]?.name === "read_file",
    "transcript assistant message should include subagent tool call"
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
  const transcriptToolResult = customEvents(internalResultEvents, "subagent_transcript_message")[0]
  assert(transcriptToolResult, "subagent internal tool result should emit a transcript message")
  const transcriptToolMessage = asRecord(transcriptToolResult.subagentMessage)
  assert(
    transcriptToolMessage.role === "tool" &&
      transcriptToolMessage.tool_call_id === "inner-tool-1" &&
      transcriptToolMessage.content === "README contents",
    "transcript tool message should preserve tool result content"
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
  assert(
    firstMessage(taskDoneEvents).content === "subagent final answer",
    "parent task result should keep the complete final content"
  )
  const finalTranscriptEvent = customEvents(
    taskDoneEvents,
    "subagent_transcript_message"
  )[0]
  assert(finalTranscriptEvent, "task result should backfill the subagent transcript")
  const finalTranscriptMessage = asRecord(finalTranscriptEvent.subagentMessage)
  assert(
    finalTranscriptEvent.subagentId === "task-1" &&
      finalTranscriptMessage.role === "assistant" &&
      finalTranscriptMessage.content === "subagent final answer",
    "task result backfill should be a visible assistant message for the owning subagent"
  )
  assert(
    String(finalTranscriptMessage.id).startsWith("subagent-final-task-1"),
    "a task without a streamed terminal assistant should use a stable final id"
  )

  const replayedTaskDoneEvents = convert(
    transport,
    streamValuesEvent([
      toolMessage({
        id: "task-result-replayed-with-another-provider-id",
        name: "task",
        toolCallId: "task-1",
        content: "subagent final answer"
      })
    ])
  )
  assert(
    customEvents(replayedTaskDoneEvents, "subagent_transcript_message").length === 0,
    "messages-to-values task result replay should not resend an unchanged final transcript"
  )
  const mergedFinalTranscript = mergeSubagentTranscripts({}, "task-1", [
    finalTranscriptMessage as unknown as Message
  ])["task-1"]
  assert(
    mergedFinalTranscript?.length === 1 &&
      mergedFinalTranscript[0]?.content === "subagent final answer",
    "replayed task results should remain one complete subagent transcript entry"
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

async function testPrefixedNamespaceRoutesConcurrentSubagentInternals(): Promise<void> {
  const transport = new ElectronIPCTransport()
  convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "main-ai-prefixed",
        toolCalls: [
          {
            id: "task-1",
            name: "task",
            args: { subagent_type: "implementer", description: "Inspect first target" }
          },
          {
            id: "task-2",
            name: "task",
            args: { subagent_type: "verifier", description: "Inspect second target" }
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )

  const firstEvents = convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "subagent-ai-prefixed-1",
        toolCalls: [{ id: "inner-tool-1", name: "read_file", args: { file_path: "one.md" } }]
      }),
      { langgraph_checkpoint_ns: "agent:tools:runtime-task-a|read_file:1" }
    )
  )
  assert(
    messageEvents(firstEvents).length === 0,
    "prefixed subagent namespace should stay hidden from main chat"
  )
  const firstTranscript = customEvents(firstEvents, "subagent_transcript_message")[0]
  assert(
    firstTranscript?.subagentId === "task-1",
    "first prefixed runtime task uuid should map to the first running subagent"
  )

  const secondEvents = convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "subagent-ai-prefixed-2",
        toolCalls: [{ id: "inner-tool-2", name: "list_dir", args: { path: "src" } }]
      }),
      { langgraph_checkpoint_ns: "agent:tools:runtime-task-b|list_dir:1" }
    )
  )
  const secondTranscript = customEvents(secondEvents, "subagent_transcript_message")[0]
  assert(
    secondTranscript?.subagentId === "task-2",
    "second prefixed runtime task uuid should map to the next running subagent"
  )
}

async function testSubagentToolCallChunksHydrateTranscriptArgs(): Promise<void> {
  const transport = new ElectronIPCTransport()
  convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "main-ai-subagent-chunk-args",
        toolCalls: [
          {
            id: "task-1",
            name: "task",
            args: { subagent_type: "implementer", description: "Inspect streamed args" }
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )

  const namespace = "agent:tools:task-1"
  convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "subagent-ai-chunk-args",
        toolCalls: [{ id: "inner-tool-1", name: "read_file", args: {} }]
      }),
      { langgraph_checkpoint_ns: namespace }
    )
  )

  const completedEvents = convert(
    transport,
    streamMessageEvent(
      aiMessageChunk({
        id: "subagent-ai-chunk-args",
        toolCallChunks: [
          {
            id: "inner-tool-1",
            name: "read_file",
            args: '{"file_path":"README.md"}'
          }
        ]
      }),
      { langgraph_checkpoint_ns: namespace }
    )
  )
  const transcript = customEvents(completedEvents, "subagent_transcript_message")[0]
  assert(transcript, "subagent tool-call chunks should emit a transcript update")
  const assistant = asRecord(transcript.subagentMessage)
  const toolCalls = assistant.tool_calls as Array<{
    id?: string
    name?: string
    args?: Record<string, unknown>
  }>
  assert(toolCalls?.[0]?.name === "read_file", "transcript should preserve the tool name")
  assert(
    toolCalls[0]?.args?.file_path === "README.md",
    "subagent transcript should hydrate streamed raw arguments after an early empty args object"
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

    const hiddenSummarySideChannelMessages =
      transport.convertFocusedCoordinatorWorkerIPCEvent(
        streamMessageEvent(
          humanMessage("You are in the middle of a conversation that has been summarized.", {
            id: "focused-worker-summary",
            additionalKwargs: { lc_source: "summarization" }
          }),
          {}
        ) as never,
        "thread-123"
      )
    assert(
      hiddenSummarySideChannelMessages.length === 0,
      "worker message side-channel should hide structurally marked summaries"
    )

    const hiddenMessageShapes = [
      {
        id: ["langchain_core", "messages", "HumanMessage"],
        kwargs: { id: "hidden-human", content: "secret human" }
      },
      {
        id: ["langchain_core", "messages", "AIMessage"],
        kwargs: { id: "hidden-ai", content: "secret assistant" }
      },
      {
        id: ["langchain_core", "messages", "ToolMessage"],
        kwargs: {
          id: "hidden-tool",
          content: "secret tool",
          tool_call_id: "hidden-call"
        }
      },
      {
        id: ["langchain_core", "messages", "SystemMessage"],
        kwargs: { id: "hidden-system", content: "secret system" }
      }
    ].map((message) => ({
      ...message,
      kwargs: {
        ...message.kwargs,
        additional_kwargs: { cmb_internal_coordinator_notification: true }
      }
    }))
    for (const hiddenMessage of hiddenMessageShapes) {
      const hiddenMessages = transport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(hiddenMessage, {}) as object),
          workerTurn: 3
        } as never,
        "thread-123"
      )
      assert(
        hiddenMessages.length === 0,
        "worker messages mode must hide internal coordinator notifications for every role"
      )
    }

    const hiddenTurnStateTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "hidden-turn-state-worker",
      workerThreadId: "thread-123__worker__hidden-turn-state-worker"
    })
    const visibleChunkA = hiddenTurnStateTransport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        ...(streamMessageEvent(
          aiMessageChunk({ id: "hidden-turn-state-shared", content: "A" }),
          {}
        ) as object),
        workerTurn: 1
      } as never,
      "thread-123"
    )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__hidden-turn-state-worker",
        visibleChunkA
      )
    const hiddenTurnChunk = aiMessageChunk({
      id: "hidden-turn-state-internal",
      content: "secret"
    }) as { kwargs: Record<string, unknown> }
    hiddenTurnChunk.kwargs.additional_kwargs = {
      cmb_internal_coordinator_notification: true
    }
    const hiddenTurnOutput =
      hiddenTurnStateTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(hiddenTurnChunk, {}) as object),
          workerTurn: 2
        } as never,
        "thread-123"
      )
    const visibleChunkB = hiddenTurnStateTransport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        ...(streamMessageEvent(
          aiMessageChunk({ id: "hidden-turn-state-shared", content: "B" }),
          {}
        ) as object),
        workerTurn: 1
      } as never,
      "thread-123"
    )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__hidden-turn-state-worker",
        visibleChunkB
      )
    assert(
      hiddenTurnOutput.length === 0 &&
        visibleChunkB.at(-1)?.content === "AB" &&
        useAppStore.getState().workerFocusMessages.at(-1)?.content === "AB",
      "an internal message from another turn must not reset visible assistant accumulation"
    )

    const hiddenValuesStateTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "hidden-values-state-worker",
      workerThreadId: "thread-123__worker__hidden-values-state-worker"
    })
    const visibleBeforeHiddenValues =
      hiddenValuesStateTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessageChunk({ id: "hidden-values-state-shared", content: "A" }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__hidden-values-state-worker",
        visibleBeforeHiddenValues
      )
    const hiddenValuesOutput =
      hiddenValuesStateTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamValuesEvent([
            {
              id: ["langchain_core", "messages", "AIMessage"],
              kwargs: {
                id: "hidden-values-internal",
                content: "secret",
                additional_kwargs: { cmb_internal_coordinator_notification: true }
              }
            }
          ]) as object),
          workerTurn: 2
        } as never,
        "thread-123"
      )
    const visibleAfterHiddenValues =
      hiddenValuesStateTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessageChunk({ id: "hidden-values-state-shared", content: "B" }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__hidden-values-state-worker",
        visibleAfterHiddenValues
      )
    assert(
      hiddenValuesOutput.length === 0 &&
        visibleAfterHiddenValues.at(-1)?.content === "AB" &&
        useAppStore.getState().workerFocusMessages.at(-1)?.content === "AB",
      "an internal-only values snapshot must not reset visible assistant accumulation"
    )

    const emptyValuesStateTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "empty-values-state-worker",
      workerThreadId: "thread-123__worker__empty-values-state-worker"
    })
    const visibleBeforeEmptyValues =
      emptyValuesStateTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessageChunk({ id: "empty-values-state-shared", content: "A" }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__empty-values-state-worker",
        visibleBeforeEmptyValues
      )
    const emptyValuesOutput =
      emptyValuesStateTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamValuesEvent([]) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    const visibleAfterEmptyValues =
      emptyValuesStateTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessageChunk({ id: "empty-values-state-shared", content: "B" }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__empty-values-state-worker",
        visibleAfterEmptyValues
      )
    assert(
      emptyValuesOutput.length === 0 &&
        visibleAfterEmptyValues.at(-1)?.content === "AB" &&
        useAppStore.getState().workerFocusMessages.at(-1)?.content === "AB",
      "an empty values snapshot must not reset visible assistant accumulation"
    )

    const lateTurnMetadataTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "late-turn-metadata-worker",
      workerThreadId: "thread-123__worker__late-turn-metadata-worker"
    })
    const beforeTurnMetadata =
      lateTurnMetadataTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamMessageEvent(
          aiMessageChunk({ id: "late-turn-metadata-ai", content: "A" }),
          {}
        ) as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__late-turn-metadata-worker",
        beforeTurnMetadata
      )
    const afterTurnMetadata =
      lateTurnMetadataTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessageChunk({ id: "late-turn-metadata-ai", content: "B" }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__late-turn-metadata-worker",
        afterTurnMetadata
      )
    const lateTurnMetadataMessages = useAppStore.getState().workerFocusMessages
    assert(
      beforeTurnMetadata[0]?.id === afterTurnMetadata[0]?.id &&
        afterTurnMetadata[0]?.content === "AB" &&
        lateTurnMetadataMessages.length === 1 &&
        lateTurnMetadataMessages[0]?.content === "AB",
      "first workerTurn metadata must adopt the active unscoped assistant without splitting it"
    )

    const lateTurnValuesTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "late-turn-values-worker",
      workerThreadId: "thread-123__worker__late-turn-values-worker"
    })
    const lateTurnValuesStart =
      lateTurnValuesTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamMessageEvent(
          aiMessageChunk({ id: "late-turn-values-ai", content: "A" }),
          {}
        ) as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__late-turn-values-worker",
        lateTurnValuesStart
      )
    const lateTurnValuesSnapshot =
      lateTurnValuesTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamValuesEvent([
            aiMessage({ id: "late-turn-values-ai", content: "AB" })
          ]) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore.getState().appendWorkerFocusMessages(
      "thread-123__worker__late-turn-values-worker",
      lateTurnValuesSnapshot,
      { orderedSnapshot: true }
    )
    const lateTurnValuesTail =
      lateTurnValuesTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessageChunk({ id: "late-turn-values-ai", content: "C" }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__late-turn-values-worker",
        lateTurnValuesTail
      )
    const lateTurnValuesMessages = useAppStore.getState().workerFocusMessages
    assert(
      lateTurnValuesSnapshot[0]?.id === lateTurnValuesStart[0]?.id &&
        lateTurnValuesTail[0]?.id === lateTurnValuesStart[0]?.id &&
        lateTurnValuesTail[0]?.content === "ABC" &&
        lateTurnValuesMessages.length === 1 &&
        lateTurnValuesMessages[0]?.content === "ABC",
      "messages-values-messages must retain one active id across first workerTurn adoption"
    )

    const sparseLateTurnValuesTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "sparse-late-turn-values-worker",
      workerThreadId: "thread-123__worker__sparse-late-turn-values-worker"
    })
    const sparseLateTurnStart =
      sparseLateTurnValuesTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamMessageEvent(
          aiMessageChunk({ id: "sparse-late-turn-values-ai", content: "A" }),
          {}
        ) as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__sparse-late-turn-values-worker",
        sparseLateTurnStart
      )
    const sparseLateTurnSnapshot =
      sparseLateTurnValuesTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamValuesEvent([
            aiMessage({ id: "sparse-late-turn-values-ai", content: "", toolCalls: [] })
          ]) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore.getState().appendWorkerFocusMessages(
      "thread-123__worker__sparse-late-turn-values-worker",
      sparseLateTurnSnapshot,
      { orderedSnapshot: true }
    )
    const sparseLateTurnTail =
      sparseLateTurnValuesTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessageChunk({ id: "sparse-late-turn-values-ai", content: "B" }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__sparse-late-turn-values-worker",
        sparseLateTurnTail
      )
    const sparseLateTurnMessages = useAppStore.getState().workerFocusMessages
    assert(
      sparseLateTurnSnapshot[0]?.id === sparseLateTurnStart[0]?.id &&
        sparseLateTurnTail[0]?.id === sparseLateTurnStart[0]?.id &&
      sparseLateTurnTail[0]?.content === "AB" &&
        sparseLateTurnMessages.length === 1 &&
        sparseLateTurnMessages[0]?.content === "AB",
      "sparse values must retain the active unscoped id during first workerTurn adoption"
    )

    const repeatedSparseAdoptionTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "repeated-sparse-adoption-worker",
      workerThreadId: "thread-123__worker__repeated-sparse-adoption-worker"
    })
    const repeatedSparseFirst =
      repeatedSparseAdoptionTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamMessageEvent(
          aiMessage({
            id: "repeated-sparse-adoption-ai",
            content: "first",
            toolCalls: [
              { id: "repeated-sparse-adoption-call", name: "read_file", args: {} }
            ]
          }),
          {}
        ) as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__repeated-sparse-adoption-worker",
        repeatedSparseFirst
      )
    const repeatedSparseTool =
      repeatedSparseAdoptionTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamMessageEvent(
          toolMessage({
            id: "repeated-sparse-adoption-tool",
            name: "read_file",
            toolCallId: "repeated-sparse-adoption-call",
            content: "result"
          }),
          {}
        ) as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__repeated-sparse-adoption-worker",
        repeatedSparseTool
      )
    const repeatedSparseSecond =
      repeatedSparseAdoptionTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamMessageEvent(
          aiMessageChunk({ id: "repeated-sparse-adoption-ai", content: "second" }),
          {}
        ) as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__repeated-sparse-adoption-worker",
        repeatedSparseSecond
      )
    const repeatedSparseSnapshot =
      repeatedSparseAdoptionTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamValuesEvent([
            aiMessage({
              id: "repeated-sparse-adoption-ai",
              content: "first",
              toolCalls: [
                { id: "repeated-sparse-adoption-call", name: "read_file", args: {} }
              ]
            }),
            toolMessage({
              id: "repeated-sparse-adoption-tool",
              name: "read_file",
              toolCallId: "repeated-sparse-adoption-call",
              content: "result"
            }),
            aiMessage({ id: "repeated-sparse-adoption-ai", content: "" })
          ]) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore.getState().appendWorkerFocusMessages(
      "thread-123__worker__repeated-sparse-adoption-worker",
      repeatedSparseSnapshot,
      { orderedSnapshot: true }
    )
    const repeatedSparseTail =
      repeatedSparseAdoptionTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessageChunk({ id: "repeated-sparse-adoption-ai", content: " tail" }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__repeated-sparse-adoption-worker",
        repeatedSparseTail
      )
    const repeatedSparseAssistants = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant")
    assert(
      repeatedSparseSecond[0]?.id.includes("::cmb-same-role-duplicate:assistant:2") &&
        repeatedSparseSnapshot.at(-1)?.id === repeatedSparseSecond[0]?.id &&
        repeatedSparseTail[0]?.id === repeatedSparseSecond[0]?.id &&
        repeatedSparseAssistants.map((message) => message.content).join("|") ===
          "first|second tail",
      "sparse adoption must preserve the active repeated provider occurrence"
    )

    const differentProviderAdoptionTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "different-provider-adoption-worker",
      workerThreadId: "thread-123__worker__different-provider-adoption-worker"
    })
    const differentProviderStart =
      differentProviderAdoptionTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamMessageEvent(
          aiMessage({
            id: "different-provider-first",
            content: "first",
            toolCalls: [
              { id: "different-provider-call", name: "read_file", args: {} }
            ]
          }),
          {}
        ) as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__different-provider-adoption-worker",
        differentProviderStart
      )
    const differentProviderSnapshot =
      differentProviderAdoptionTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamValuesEvent([
            aiMessage({
              id: "different-provider-first",
              content: "",
              toolCalls: [
                { id: "different-provider-call", name: "read_file", args: {} }
              ]
            }),
            toolMessage({
              id: "different-provider-tool",
              name: "read_file",
              toolCallId: "different-provider-call",
              content: "result"
            }),
            aiMessage({ id: "different-provider-second", content: "second" })
          ]) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore.getState().appendWorkerFocusMessages(
      "thread-123__worker__different-provider-adoption-worker",
      differentProviderSnapshot,
      { orderedSnapshot: true }
    )
    const differentProviderTail =
      differentProviderAdoptionTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessageChunk({ id: "different-provider-second", content: " tail" }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__different-provider-adoption-worker",
        differentProviderTail
      )
    const differentProviderAssistants = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant")
    assert(
      differentProviderSnapshot[0]?.id === differentProviderStart[0]?.id &&
        differentProviderTail[0]?.id !== differentProviderStart[0]?.id &&
        differentProviderAssistants.map((message) => message.content).join("|") ===
          "first|second tail",
      "known-provider adoption must not rebind a later different-provider assistant"
    )

    const baseOccurrenceAdoptionTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "base-occurrence-adoption-worker",
      workerThreadId: "thread-123__worker__base-occurrence-adoption-worker"
    })
    const baseOccurrenceStart =
      baseOccurrenceAdoptionTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamMessageEvent(
          aiMessage({
            id: "base-occurrence-adoption-ai",
            content: "first",
            toolCalls: [
              { id: "base-occurrence-adoption-call", name: "read_file", args: {} }
            ]
          }),
          {}
        ) as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__base-occurrence-adoption-worker",
        baseOccurrenceStart
      )
    const baseOccurrenceSnapshot =
      baseOccurrenceAdoptionTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamValuesEvent([
            aiMessage({
              id: "base-occurrence-adoption-ai",
              content: "",
              toolCalls: [
                { id: "base-occurrence-adoption-call", name: "read_file", args: {} }
              ]
            }),
            toolMessage({
              id: "base-occurrence-adoption-tool",
              name: "read_file",
              toolCallId: "base-occurrence-adoption-call",
              content: "result"
            }),
            aiMessage({ id: "base-occurrence-adoption-ai", content: "second" })
          ]) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore.getState().appendWorkerFocusMessages(
      "thread-123__worker__base-occurrence-adoption-worker",
      baseOccurrenceSnapshot,
      { orderedSnapshot: true }
    )
    const baseOccurrenceTail =
      baseOccurrenceAdoptionTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessageChunk({ id: "base-occurrence-adoption-ai", content: " tail" }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__base-occurrence-adoption-worker",
        baseOccurrenceTail
      )
    const baseOccurrenceAssistants = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant")
    assert(
      baseOccurrenceSnapshot[0]?.id === baseOccurrenceStart[0]?.id &&
        baseOccurrenceTail[0]?.id !== baseOccurrenceStart[0]?.id &&
        baseOccurrenceAssistants.map((message) => message.content).join("|") ===
          "first|second tail",
      "base occurrence adoption must use its exact raw id before a later same-provider occurrence"
    )

    const unknownProviderMultiTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "unknown-provider-multi-worker",
      workerThreadId: "thread-123__worker__unknown-provider-multi-worker"
    })
    const unknownProviderMultiStart =
      unknownProviderMultiTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamMessageEvent(
          aiMessage({
            content: "first",
            toolCalls: [{ id: "unknown-provider-call", name: "read_file", args: {} }]
          }),
          {}
        ) as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__unknown-provider-multi-worker",
        unknownProviderMultiStart
      )
    const unknownProviderMultiSnapshot =
      unknownProviderMultiTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamValuesEvent([
            aiMessage({
              id: "unknown-provider-first",
              content: "first",
              toolCalls: [
                { id: "unknown-provider-call", name: "read_file", args: {} }
              ]
            }),
            toolMessage({
              id: "unknown-provider-tool",
              name: "read_file",
              toolCallId: "unknown-provider-call",
              content: "result"
            }),
            aiMessage({ id: "unknown-provider-second", content: "second" })
          ]) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore.getState().appendWorkerFocusMessages(
      "thread-123__worker__unknown-provider-multi-worker",
      unknownProviderMultiSnapshot,
      { orderedSnapshot: true }
    )
    const unknownProviderMultiTail =
      unknownProviderMultiTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessageChunk({ id: "unknown-provider-second", content: " tail" }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__unknown-provider-multi-worker",
        unknownProviderMultiTail
      )
    const unknownProviderMultiAssistants = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant")
    assert(
      unknownProviderMultiSnapshot[0]?.id === unknownProviderMultiStart[0]?.id &&
        unknownProviderMultiTail[0]?.id !== unknownProviderMultiStart[0]?.id &&
        unknownProviderMultiAssistants.map((message) => message.content).join("|") ===
          "first|second tail" &&
        unknownProviderMultiAssistants[0]?.tool_calls?.length === 1 &&
        !unknownProviderMultiAssistants[1]?.tool_calls?.length,
      "id-less adoption must use unique content or tool evidence before the latest assistant"
    )

    const ambiguousFallbackTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "ambiguous-fallback-worker",
      workerThreadId: "thread-123__worker__ambiguous-fallback-worker"
    })
    const ambiguousFallbackStart =
      ambiguousFallbackTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamMessageEvent(
          aiMessage({
            content: "same",
            toolCalls: [{ id: "ambiguous-fallback-call", name: "read_file", args: {} }]
          }),
          {}
        ) as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__ambiguous-fallback-worker",
        ambiguousFallbackStart
      )
    const ambiguousFallbackSnapshot =
      ambiguousFallbackTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamValuesEvent([
            aiMessage({
              id: "ambiguous-fallback-first",
              content: "same",
              toolCalls: [
                { id: "ambiguous-fallback-call", name: "read_file", args: {} }
              ]
            }),
            toolMessage({
              id: "ambiguous-fallback-tool",
              name: "read_file",
              toolCallId: "ambiguous-fallback-call",
              content: "result"
            }),
            aiMessage({
              id: "ambiguous-fallback-second",
              content: "same",
              toolCalls: [
                { id: "ambiguous-fallback-call", name: "read_file", args: {} }
              ]
            })
          ]) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore.getState().appendWorkerFocusMessages(
      "thread-123__worker__ambiguous-fallback-worker",
      ambiguousFallbackSnapshot,
      { orderedSnapshot: true }
    )
    const ambiguousFallbackMessages = useAppStore.getState().workerFocusMessages
    const ambiguousFallbackAssistants = ambiguousFallbackMessages.filter(
      (message) => message.role === "assistant"
    )
    const ambiguousFallbackResults = buildToolResultAssociations(
      ambiguousFallbackMessages
    )
    const ambiguousFirstKey = getWorkerToolUiKey(
      ambiguousFallbackAssistants[0]?.id ?? "",
      "ambiguous-fallback-call",
      0
    )
    const ambiguousSecondKey = getWorkerToolUiKey(
      ambiguousFallbackAssistants[1]?.id ?? "",
      "ambiguous-fallback-call",
      0
    )
    assert(
      ambiguousFallbackAssistants.length === 2 &&
        ambiguousFallbackAssistants[0]?.id !== ambiguousFallbackAssistants[1]?.id &&
        ambiguousFallbackAssistants.some(
          (message) => message.id === ambiguousFallbackStart[0]?.id
        ) &&
        ambiguousFallbackResults.get(ambiguousFirstKey)?.content === "result" &&
        ambiguousFallbackResults.get(ambiguousSecondKey) === undefined,
      "ambiguous id-less adoption must consume the fallback without duplicating occurrences"
    )

    const strongToolEvidenceTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "strong-tool-evidence-worker",
      workerThreadId: "thread-123__worker__strong-tool-evidence-worker"
    })
    const strongToolEvidenceStart =
      strongToolEvidenceTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamMessageEvent(
          aiMessage({
            content: "same",
            toolCalls: [{ id: "strong-tool-call-one", name: "read_file", args: {} }]
          }),
          {}
        ) as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__strong-tool-evidence-worker",
        strongToolEvidenceStart
      )
    const strongToolEvidenceSnapshot =
      strongToolEvidenceTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamValuesEvent([
            aiMessage({
              id: "strong-tool-evidence-first",
              content: "same",
              toolCalls: [
                { id: "strong-tool-call-one", name: "read_file", args: {} }
              ]
            }),
            toolMessage({
              id: "strong-tool-evidence-result",
              name: "read_file",
              toolCallId: "strong-tool-call-one",
              content: "result"
            }),
            aiMessage({
              id: "strong-tool-evidence-second",
              content: "same",
              toolCalls: [
                { id: "strong-tool-call-two", name: "read_file", args: {} }
              ]
            })
          ]) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore.getState().appendWorkerFocusMessages(
      "thread-123__worker__strong-tool-evidence-worker",
      strongToolEvidenceSnapshot,
      { orderedSnapshot: true }
    )
    const strongToolEvidenceAssistants = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant")
    assert(
      strongToolEvidenceSnapshot[0]?.id === strongToolEvidenceStart[0]?.id &&
        strongToolEvidenceAssistants.length === 2 &&
        strongToolEvidenceAssistants[0]?.tool_calls?.[0]?.id ===
          "strong-tool-call-one" &&
        strongToolEvidenceAssistants[1]?.tool_calls?.[0]?.id ===
          "strong-tool-call-two",
      "tool identity must take precedence over ambiguous equal assistant text"
    )

    const reorderedArgsEvidenceTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "reordered-args-evidence-worker",
      workerThreadId: "thread-123__worker__reordered-args-evidence-worker"
    })
    const reorderedArgsEvidenceStart =
      reorderedArgsEvidenceTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamMessageEvent(
          aiMessage({
            content: "active",
            toolCalls: [
              {
                id: "reordered-args-evidence-call",
                name: "read_file",
                args: { a: 1, b: 2 }
              }
            ]
          }),
          {}
        ) as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__reordered-args-evidence-worker",
        reorderedArgsEvidenceStart
      )
    const reorderedArgsEvidenceSnapshot =
      reorderedArgsEvidenceTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamValuesEvent([
            aiMessage({ id: "reordered-args-evidence-earlier", content: "earlier" }),
            aiMessage({
              id: "reordered-args-evidence-active",
              content: "",
              toolCalls: [
                {
                  id: "reordered-args-evidence-call",
                  name: "read_file",
                  args: { b: 2, a: 1 }
                }
              ]
            })
          ]) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore.getState().appendWorkerFocusMessages(
      "thread-123__worker__reordered-args-evidence-worker",
      reorderedArgsEvidenceSnapshot,
      { orderedSnapshot: true }
    )
    const reorderedArgsEvidenceAssistants = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant")
    assert(
      reorderedArgsEvidenceSnapshot.at(-1)?.id === reorderedArgsEvidenceStart[0]?.id &&
        reorderedArgsEvidenceAssistants.length === 2 &&
        reorderedArgsEvidenceAssistants.at(-1)?.content === "active",
      "tool evidence must compare reordered JSON objects by semantic value"
    )

    const sparseArgsEvidenceTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "sparse-args-evidence-worker",
      workerThreadId: "thread-123__worker__sparse-args-evidence-worker"
    })
    const sparseArgsEvidenceStart =
      sparseArgsEvidenceTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamMessageEvent(
          aiMessage({
            content: "active",
            toolCalls: [
              {
                id: "sparse-args-evidence-call",
                name: "read_file",
                args: { path: "a.txt" }
              }
            ]
          }),
          {}
        ) as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__sparse-args-evidence-worker",
        sparseArgsEvidenceStart
      )
    const sparseArgsEvidenceSnapshot =
      sparseArgsEvidenceTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamValuesEvent([
            aiMessage({ id: "sparse-args-evidence-earlier", content: "earlier" }),
            aiMessage({
              id: "sparse-args-evidence-active",
              content: "",
              toolCalls: [
                { id: "sparse-args-evidence-call", name: "read_file", args: {} }
              ]
            })
          ]) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore.getState().appendWorkerFocusMessages(
      "thread-123__worker__sparse-args-evidence-worker",
      sparseArgsEvidenceSnapshot,
      { orderedSnapshot: true }
    )
    const sparseArgsEvidenceAssistants = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant")
    const sparseArgsEvidenceActive = sparseArgsEvidenceAssistants.find(
      (message) => message.id === sparseArgsEvidenceStart[0]?.id
    )
    assert(
      sparseArgsEvidenceSnapshot.at(-1)?.id === sparseArgsEvidenceStart[0]?.id &&
        sparseArgsEvidenceAssistants.length === 2 &&
        sparseArgsEvidenceActive?.content === "active" &&
        sparseArgsEvidenceActive.tool_calls?.[0]?.args?.path === "a.txt",
      "sparse empty args must not reject matching complete active tool evidence"
    )

    const sparseArgsPriorityTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "sparse-args-priority-worker",
      workerThreadId: "thread-123__worker__sparse-args-priority-worker"
    })
    const sparseArgsPriorityStart =
      sparseArgsPriorityTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamMessageEvent(
          aiMessage({
            content: "first",
            toolCalls: [
              {
                id: "sparse-args-priority-call",
                name: "read_file",
                args: { path: "one" }
              }
            ]
          }),
          {}
        ) as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__sparse-args-priority-worker",
        sparseArgsPriorityStart
      )
    const sparseArgsPrioritySnapshot =
      sparseArgsPriorityTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamValuesEvent([
            aiMessage({
              id: "sparse-args-priority-first",
              content: "first",
              toolCalls: [
                {
                  id: "sparse-args-priority-call",
                  name: "read_file",
                  args: { path: "one" }
                }
              ]
            }),
            toolMessage({
              toolCallId: "sparse-args-priority-call",
              content: "first result"
            }),
            aiMessage({
              id: "sparse-args-priority-second",
              content: "second",
              toolCalls: [
                { id: "sparse-args-priority-call", name: "read_file", args: {} }
              ]
            })
          ]) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore.getState().appendWorkerFocusMessages(
      "thread-123__worker__sparse-args-priority-worker",
      sparseArgsPrioritySnapshot,
      { orderedSnapshot: true }
    )
    const sparseArgsPriorityAssistants = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant")
    const sparseArgsPriorityFirst = sparseArgsPriorityAssistants.find(
      (message) => message.content === "first"
    )
    const sparseArgsPrioritySecond = sparseArgsPriorityAssistants.find(
      (message) => message.content === "second"
    )
    assert(
      sparseArgsPriorityFirst?.id === sparseArgsPriorityStart[0]?.id &&
        sparseArgsPriorityAssistants.length === 2 &&
        sparseArgsPriorityFirst.tool_calls?.[0]?.args?.path === "one" &&
        Object.keys(sparseArgsPrioritySecond?.tool_calls?.[0]?.args ?? {}).length === 0,
      "exact complete args evidence must outrank a later sparse same-id occurrence"
    )

    const sparseArgsTieTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "sparse-args-tie-worker",
      workerThreadId: "thread-123__worker__sparse-args-tie-worker"
    })
    const sparseArgsTieStart =
      sparseArgsTieTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamMessageEvent(
          aiMessage({
            content: "old",
            toolCalls: [
              { id: "sparse-tie-call-1", name: "tool_one", args: { x: 1 } },
              { id: "sparse-tie-call-2", name: "tool_two", args: { y: 2 } }
            ]
          }),
          {}
        ) as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__sparse-args-tie-worker",
        sparseArgsTieStart
      )
    const sparseArgsTieSnapshot =
      sparseArgsTieTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamValuesEvent([
            aiMessage({
              id: "sparse-args-tie-old",
              content: "old",
              toolCalls: [
                { id: "sparse-tie-call-1", name: "tool_one", args: { x: 1 } },
                { id: "sparse-tie-call-2", name: "tool_two", args: {} }
              ]
            }),
            toolMessage({ toolCallId: "sparse-tie-call-1", content: "one" }),
            toolMessage({ toolCallId: "sparse-tie-call-2", content: "two" }),
            aiMessage({
              id: "sparse-args-tie-new",
              content: "new",
              toolCalls: [
                { id: "sparse-tie-call-1", name: "tool_one", args: {} },
                { id: "sparse-tie-call-2", name: "tool_two", args: { y: 2 } }
              ]
            })
          ]) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore.getState().appendWorkerFocusMessages(
      "thread-123__worker__sparse-args-tie-worker",
      sparseArgsTieSnapshot,
      { orderedSnapshot: true }
    )
    const sparseArgsTieAssistants = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant")
    const sparseArgsTieOld = sparseArgsTieAssistants.find(
      (message) => message.content === "old"
    )
    const sparseArgsTieNew = sparseArgsTieAssistants.find(
      (message) => message.content === "new"
    )
    assert(
      sparseArgsTieOld?.id === sparseArgsTieStart[0]?.id &&
        sparseArgsTieAssistants.length === 2 &&
        sparseArgsTieOld.tool_calls?.[0]?.args?.x === 1 &&
        sparseArgsTieOld.tool_calls?.[1]?.args?.y === 2 &&
        Object.keys(sparseArgsTieNew?.tool_calls?.[0]?.args ?? {}).length === 0 &&
        sparseArgsTieNew?.tool_calls?.[1]?.args?.y === 2,
      "unique content evidence must break tied partial tool-args matches"
    )

    const sparseToolSubsetTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "sparse-tool-subset-worker",
      workerThreadId: "thread-123__worker__sparse-tool-subset-worker"
    })
    const sparseToolSubsetStart =
      sparseToolSubsetTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamMessageEvent(
          aiMessage({
            content: "active",
            toolCalls: [
              { id: "sparse-subset-call-1", name: "tool_one", args: { path: "one" } },
              { id: "sparse-subset-call-2", name: "tool_two", args: { path: "two" } }
            ]
          }),
          {}
        ) as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__sparse-tool-subset-worker",
        sparseToolSubsetStart
      )
    const sparseToolSubsetSnapshot =
      sparseToolSubsetTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamValuesEvent([
            aiMessage({ id: "sparse-tool-subset-earlier", content: "earlier" }),
            aiMessage({
              id: "sparse-tool-subset-active",
              content: "",
              toolCalls: [
                { id: "sparse-subset-call-1", name: "tool_one", args: {} }
              ]
            })
          ]) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore.getState().appendWorkerFocusMessages(
      "thread-123__worker__sparse-tool-subset-worker",
      sparseToolSubsetSnapshot,
      { orderedSnapshot: true }
    )
    const sparseToolSubsetAssistants = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant")
    const sparseToolSubsetActive = sparseToolSubsetAssistants.find(
      (message) => message.id === sparseToolSubsetStart[0]?.id
    )
    assert(
      sparseToolSubsetAssistants.length === 2 &&
        sparseToolSubsetActive?.content === "active" &&
        sparseToolSubsetActive.tool_calls?.length === 2 &&
        sparseToolSubsetActive.tool_calls[0]?.args?.path === "one" &&
        sparseToolSubsetActive.tool_calls[1]?.args?.path === "two",
      "a sparse tool-call subset must adopt and retain omitted active calls"
    )

    const toolOverlapPriorityTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "tool-overlap-priority-worker",
      workerThreadId: "thread-123__worker__tool-overlap-priority-worker"
    })
    const toolOverlapPriorityStart =
      toolOverlapPriorityTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamMessageEvent(
          aiMessage({
            content: "active",
            toolCalls: [
              { id: "overlap-priority-call-1", name: "tool_one", args: { path: "one" } },
              { id: "overlap-priority-call-2", name: "tool_two", args: { path: "two" } }
            ]
          }),
          {}
        ) as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__tool-overlap-priority-worker",
        toolOverlapPriorityStart
      )
    const toolOverlapPrioritySnapshot =
      toolOverlapPriorityTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamValuesEvent([
            aiMessage({
              id: "tool-overlap-priority-earlier",
              content: "",
              toolCalls: [
                {
                  id: "overlap-priority-call-1",
                  name: "tool_one",
                  args: { path: "one" }
                }
              ]
            }),
            toolMessage({
              toolCallId: "overlap-priority-call-1",
              content: "earlier result"
            }),
            aiMessage({
              id: "tool-overlap-priority-active",
              content: "",
              toolCalls: [
                { id: "overlap-priority-call-1", name: "tool_one", args: {} },
                { id: "overlap-priority-call-2", name: "tool_two", args: {} }
              ]
            })
          ]) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore.getState().appendWorkerFocusMessages(
      "thread-123__worker__tool-overlap-priority-worker",
      toolOverlapPrioritySnapshot,
      { orderedSnapshot: true }
    )
    const toolOverlapPriorityAssistants = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant")
    const toolOverlapPriorityActive = toolOverlapPriorityAssistants.find(
      (message) => message.id === toolOverlapPriorityStart[0]?.id
    )
    const toolOverlapPriorityEarlier = toolOverlapPriorityAssistants.find(
      (message) => message.id !== toolOverlapPriorityStart[0]?.id
    )
    assert(
      toolOverlapPriorityAssistants.length === 2 &&
        toolOverlapPriorityActive?.content === "active" &&
        toolOverlapPriorityActive.tool_calls?.length === 2 &&
        toolOverlapPriorityActive.tool_calls[1]?.args?.path === "two" &&
        toolOverlapPriorityEarlier?.tool_calls?.length === 1,
      "more overlapping tool-call ids must outrank fewer exact args matches"
    )

    const sparseContentPriorityTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "sparse-content-priority-worker",
      workerThreadId: "thread-123__worker__sparse-content-priority-worker"
    })
    const sparseContentPriorityStart =
      sparseContentPriorityTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamMessageEvent(
          aiMessage({
            content: "old",
            toolCalls: [
              {
                id: "sparse-content-priority-call",
                name: "read_file",
                args: { path: "one" }
              }
            ]
          }),
          {}
        ) as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__sparse-content-priority-worker",
        sparseContentPriorityStart
      )
    const sparseContentPrioritySnapshot =
      sparseContentPriorityTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamValuesEvent([
            aiMessage({
              id: "sparse-content-priority-old",
              content: "old",
              toolCalls: [
                { id: "sparse-content-priority-call", name: "read_file", args: {} }
              ]
            }),
            toolMessage({
              toolCallId: "sparse-content-priority-call",
              content: "old result"
            }),
            aiMessage({
              id: "sparse-content-priority-new",
              content: "new",
              toolCalls: [
                {
                  id: "sparse-content-priority-call",
                  name: "read_file",
                  args: { path: "one" }
                }
              ]
            })
          ]) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore.getState().appendWorkerFocusMessages(
      "thread-123__worker__sparse-content-priority-worker",
      sparseContentPrioritySnapshot,
      { orderedSnapshot: true }
    )
    const sparseContentPriorityAssistants = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant")
    const sparseContentPriorityOld = sparseContentPriorityAssistants.find(
      (message) => message.content === "old"
    )
    assert(
      sparseContentPriorityAssistants.length === 2 &&
        sparseContentPriorityOld?.id === sparseContentPriorityStart[0]?.id &&
        sparseContentPriorityOld.tool_calls?.[0]?.args?.path === "one",
      "unique content identity must outrank exact args reused by a later occurrence"
    )

    const pendingToolEvidenceTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "pending-tool-evidence-worker",
      workerThreadId: "thread-123__worker__pending-tool-evidence-worker"
    })
    const pendingToolEvidenceStart =
      pendingToolEvidenceTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamMessageEvent(
          aiMessageChunk({
            content: "active",
            toolCallChunks: [
              { id: "pending-tool-evidence-call", name: "read_file", args: '{"path":"' }
            ]
          }),
          {}
        ) as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__pending-tool-evidence-worker",
        pendingToolEvidenceStart
      )
    const pendingToolEvidenceSnapshot =
      pendingToolEvidenceTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamValuesEvent([
            aiMessage({ id: "pending-tool-evidence-earlier", content: "earlier" }),
            aiMessage({
              id: "pending-tool-evidence-active",
              content: "",
              toolCalls: [
                { id: "pending-tool-evidence-call", name: "read_file", args: {} }
              ]
            })
          ]) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore.getState().appendWorkerFocusMessages(
      "thread-123__worker__pending-tool-evidence-worker",
      pendingToolEvidenceSnapshot,
      { orderedSnapshot: true }
    )
    const pendingToolEvidenceTail =
      pendingToolEvidenceTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessageChunk({
              id: "pending-tool-evidence-active",
              toolCallChunks: [
                { id: "pending-tool-evidence-call", args: 'a.txt"}' }
              ]
            }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__pending-tool-evidence-worker",
        pendingToolEvidenceTail
      )
    const pendingToolEvidenceAssistants = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant")
    const pendingToolEvidenceActive = pendingToolEvidenceAssistants.find(
      (message) => message.id === pendingToolEvidenceStart[0]?.id
    )
    assert(
      pendingToolEvidenceSnapshot.at(-1)?.id === pendingToolEvidenceStart[0]?.id &&
        pendingToolEvidenceTail.at(-1)?.id === pendingToolEvidenceStart[0]?.id &&
        pendingToolEvidenceAssistants.length === 2 &&
        pendingToolEvidenceActive?.content === "active" &&
        pendingToolEvidenceActive.tool_calls?.[0]?.args?.path === "a.txt",
      "pending partial tool identity must survive id-less sparse values adoption"
    )

    const idAdoptionMessagesTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "id-adoption-messages-worker",
      workerThreadId: "thread-123__worker__id-adoption-messages-worker"
    })
    const idAdoptionMessageStart =
      idAdoptionMessagesTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamMessageEvent(aiMessageChunk({ content: "A" }), {}) as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__id-adoption-messages-worker",
        idAdoptionMessageStart
      )
    const idAdoptionMessageTail =
      idAdoptionMessagesTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessageChunk({ id: "id-adoption-provider", content: "B" }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__id-adoption-messages-worker",
        idAdoptionMessageTail
      )
    assert(
      idAdoptionMessageTail[0]?.id === idAdoptionMessageStart[0]?.id &&
        idAdoptionMessageTail[0]?.content === "AB" &&
        useAppStore.getState().workerFocusMessages.length === 1,
      "first scoped provider id must adopt the active id-less message"
    )

    const idAdoptionValuesTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "id-adoption-values-worker",
      workerThreadId: "thread-123__worker__id-adoption-values-worker"
    })
    const idAdoptionValuesStart =
      idAdoptionValuesTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamMessageEvent(aiMessageChunk({ content: "A" }), {}) as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__id-adoption-values-worker",
        idAdoptionValuesStart
      )
    const idAdoptionValuesSnapshot =
      idAdoptionValuesTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamValuesEvent([
            aiMessage({ id: "id-adoption-values-provider", content: "AB" })
          ]) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore.getState().appendWorkerFocusMessages(
      "thread-123__worker__id-adoption-values-worker",
      idAdoptionValuesSnapshot,
      { orderedSnapshot: true }
    )
    const idAdoptionValuesTail =
      idAdoptionValuesTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessageChunk({ id: "id-adoption-values-provider", content: "C" }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__id-adoption-values-worker",
        idAdoptionValuesTail
      )
    assert(
      idAdoptionValuesSnapshot[0]?.id === idAdoptionValuesStart[0]?.id &&
        idAdoptionValuesTail[0]?.id === idAdoptionValuesStart[0]?.id &&
        idAdoptionValuesTail[0]?.content === "ABC" &&
        useAppStore.getState().workerFocusMessages.length === 1,
      "first values provider id must adopt the active id-less message"
    )

    const valuesFirstAdoptionTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    const valuesFirstWorkerThreadId =
      "thread-123__worker__values-first-id-adoption-worker"
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "values-first-id-adoption-worker",
      workerThreadId: valuesFirstWorkerThreadId
    })
    const valuesFirstSnapshot =
      valuesFirstAdoptionTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamValuesEvent([aiMessage({ content: "A" })]) as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(valuesFirstWorkerThreadId, valuesFirstSnapshot, {
        orderedSnapshot: true
      })
    const valuesFirstTail =
      valuesFirstAdoptionTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessageChunk({ id: "values-first-provider", content: "B" }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(valuesFirstWorkerThreadId, valuesFirstTail)
    assert(
      valuesFirstTail[0]?.id === valuesFirstSnapshot[0]?.id &&
        valuesFirstTail[0]?.content === "AB" &&
        useAppStore.getState().workerFocusMessages.length === 1,
      "a formal messages chunk must adopt an id-less values fallback"
    )

    const valuesFirstHistoryTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    const valuesFirstHistoryThreadId =
      "thread-123__worker__values-first-history-adoption-worker"
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "values-first-history-adoption-worker",
      workerThreadId: valuesFirstHistoryThreadId
    })
    const valuesFirstHistorySnapshot =
      valuesFirstHistoryTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamValuesEvent([
          aiMessage({ id: "values-first-history-provider", content: "historical" }),
          aiMessage({ content: "A" })
        ]) as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(valuesFirstHistoryThreadId, valuesFirstHistorySnapshot, {
        orderedSnapshot: true
      })
    const valuesFirstHistoryTail =
      valuesFirstHistoryTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessageChunk({ id: "values-first-history-provider", content: "B" }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(valuesFirstHistoryThreadId, valuesFirstHistoryTail)
    const valuesFirstHistoryAssistants = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant")
    assert(
      valuesFirstHistoryTail[0]?.id === valuesFirstHistorySnapshot.at(-1)?.id &&
        valuesFirstHistoryTail[0]?.content === "AB" &&
        valuesFirstHistoryTail[0]?.provider_occurrence === 2 &&
        valuesFirstHistoryAssistants.length === 2,
      "values-first adoption must allocate after an existing provider occurrence"
    )

    const occupiedFallbackTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    const occupiedFallbackThreadId =
      "thread-123__worker__occupied-values-fallback-worker"
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "occupied-values-fallback-worker",
      workerThreadId: occupiedFallbackThreadId
    })
    useAppStore.getState().appendWorkerFocusMessages(occupiedFallbackThreadId, [
      {
        id: "worker-snapshot-0",
        role: "user",
        content: "occupied fallback",
        created_at: new Date()
      }
    ])
    const occupiedFallbackSnapshot =
      occupiedFallbackTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamValuesEvent([aiMessage({ content: "A" })]) as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(occupiedFallbackThreadId, occupiedFallbackSnapshot, {
        orderedSnapshot: true
      })
    const occupiedFallbackTail =
      occupiedFallbackTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessageChunk({ id: "occupied-fallback-provider", content: "B" }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(occupiedFallbackThreadId, occupiedFallbackTail)
    let occupiedFallbackAssistants = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant")
    assert(
      occupiedFallbackTail[0]?.id === occupiedFallbackSnapshot[0]?.id &&
        occupiedFallbackAssistants.length === 1 &&
        occupiedFallbackAssistants[0]?.content === "AB",
      "values adoption must retain the Store-normalized fallback render id"
    )
    const occupiedFallbackReplay =
      occupiedFallbackTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamValuesEvent([aiMessage({ content: "A" })]) as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(occupiedFallbackThreadId, occupiedFallbackReplay, {
        orderedSnapshot: true
      })
    const occupiedFallbackFinal =
      occupiedFallbackTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessageChunk({ id: "occupied-fallback-provider", content: "C" }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(occupiedFallbackThreadId, occupiedFallbackFinal)
    occupiedFallbackAssistants = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant")
    assert(
      occupiedFallbackAssistants.length === 1 &&
        occupiedFallbackAssistants[0]?.content === "ABC",
      `a repeated sparse values snapshot must not reset adopted assistant content: ${occupiedFallbackAssistants
        .map((message) => `${message.id}=${String(message.content)}`)
        .join("|")}`
    )

    const sameRoleFallbackTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    const sameRoleFallbackThreadId =
      "thread-123__worker__same-role-values-fallback-worker"
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "same-role-values-fallback-worker",
      workerThreadId: sameRoleFallbackThreadId
    })
    useAppStore.getState().appendWorkerFocusMessages(sameRoleFallbackThreadId, [
      {
        id: "worker-snapshot-0",
        role: "assistant",
        content: "old answer",
        created_at: new Date()
      },
      { id: "same-role-new-user", role: "user", content: "new prompt", created_at: new Date() }
    ])
    const sameRoleFallbackSnapshot =
      sameRoleFallbackTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamValuesEvent([aiMessage({ content: "A" })]) as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(sameRoleFallbackThreadId, sameRoleFallbackSnapshot, {
        orderedSnapshot: true
      })
    const sameRoleFallbackTail =
      sameRoleFallbackTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessageChunk({ id: "same-role-fallback-provider", content: "B" }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(sameRoleFallbackThreadId, sameRoleFallbackTail)
    const sameRoleFallbackFinal =
      sameRoleFallbackTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessageChunk({ id: "same-role-fallback-provider", content: "C" }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(sameRoleFallbackThreadId, sameRoleFallbackFinal)
    const sameRoleFallbackMessages = useAppStore.getState().workerFocusMessages
    const sameRoleFallbackSummary = sameRoleFallbackMessages
      .map((message) => `${message.role}:${String(message.content)}`)
      .join("|")
    assert(
      sameRoleFallbackSummary === "assistant:old answer|user:new prompt|assistant:ABC" &&
        new Set(sameRoleFallbackMessages.map((message) => message.id)).size === 3,
      `an adopted id-less values fallback must remain one row across later provider chunks: ${sameRoleFallbackMessages
        .map((message) => `${message.role}:${message.id}:${String(message.content)}`)
        .join("|")}; tail=${sameRoleFallbackTail
        .map(
          (message) =>
            `${message.id},source=${message.provider_source_id},occ=${message.provider_occurrence}`
        )
        .join("|")}; final=${sameRoleFallbackFinal
        .map(
          (message) =>
            `${message.id},source=${message.provider_source_id},occ=${message.provider_occurrence}`
        )
        .join("|")}`
    )

    const historicalOccurrenceTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    const historicalOccurrenceThreadId =
      "thread-123__worker__historical-provider-occurrence-worker"
    const historicalOccurrenceProvider =
      `worker-turn-${historicalOccurrenceThreadId}-1::historical-provider`
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "historical-provider-occurrence-worker",
      workerThreadId: historicalOccurrenceThreadId
    })
    useAppStore.getState().appendWorkerFocusMessages(historicalOccurrenceThreadId, [
      {
        id: "historical-provider-answer",
        provider_source_id: historicalOccurrenceProvider,
        provider_occurrence: 1,
        role: "assistant",
        content: "historical answer",
        created_at: new Date()
      }
    ])
    const historicalOccurrenceSnapshot =
      historicalOccurrenceTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamValuesEvent([aiMessage({ content: "A" })]) as never,
        "thread-123"
      )
    useAppStore.getState().appendWorkerFocusMessages(
      historicalOccurrenceThreadId,
      historicalOccurrenceSnapshot,
      { orderedSnapshot: true }
    )
    const historicalOccurrenceTail =
      historicalOccurrenceTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessageChunk({ id: "historical-provider", content: "B" }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(historicalOccurrenceThreadId, historicalOccurrenceTail)
    const historicalOccurrenceFinal =
      historicalOccurrenceTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessageChunk({ id: "historical-provider", content: "C" }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(historicalOccurrenceThreadId, historicalOccurrenceFinal)
    const historicalOccurrenceAssistants = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant")
    assert(
      historicalOccurrenceAssistants.map((message) => message.content).join("|") ===
        "historical answer|ABC" &&
        new Set(historicalOccurrenceAssistants.map((message) => message.id)).size === 2 &&
        historicalOccurrenceAssistants
          .map((message) => message.provider_occurrence)
          .join("|") === "1|2",
      "formal adoption after id-less values must continue after a stored provider occurrence"
    )

    const unknownTurnToolBoundaryTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    const unknownTurnToolBoundaryThreadId =
      "thread-123__worker__unknown-turn-tool-boundary-worker"
    const unknownTurnToolBoundaryProvider =
      `worker-turn-${unknownTurnToolBoundaryThreadId}-1::tool-boundary-provider`
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "unknown-turn-tool-boundary-worker",
      workerThreadId: unknownTurnToolBoundaryThreadId
    })
    useAppStore.getState().appendWorkerFocusMessages(unknownTurnToolBoundaryThreadId, [
      {
        id: "unknown-turn-tool-boundary-history",
        provider_source_id: unknownTurnToolBoundaryProvider,
        provider_occurrence: 1,
        role: "assistant",
        content: "H1",
        created_at: new Date()
      }
    ])
    const unknownTurnToolBoundarySnapshot =
      unknownTurnToolBoundaryTransport.convertFocusedCoordinatorWorkerIPCEvent(
        streamValuesEvent([
          aiMessage({
            content: "A",
            toolCalls: [
              { id: "unknown-turn-tool-boundary-call", name: "read_file", args: {} }
            ]
          }),
          toolMessage({
            toolCallId: "unknown-turn-tool-boundary-call",
            name: "read_file",
            content: "R"
          })
        ]) as never,
        "thread-123"
      )
    useAppStore.getState().appendWorkerFocusMessages(
      unknownTurnToolBoundaryThreadId,
      unknownTurnToolBoundarySnapshot,
      { orderedSnapshot: true }
    )
    for (const content of ["B", "C"]) {
      const chunk = unknownTurnToolBoundaryTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessageChunk({ id: "tool-boundary-provider", content }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
      useAppStore
        .getState()
        .appendWorkerFocusMessages(unknownTurnToolBoundaryThreadId, chunk)
    }
    const unknownTurnToolBoundaryMessages = useAppStore.getState().workerFocusMessages
    assert(
      unknownTurnToolBoundaryMessages.map((message) => message.content).join("|") ===
        "H1|A|R|BC" &&
        unknownTurnToolBoundaryMessages.map((message) => message.role).join("|") ===
          "assistant|assistant|tool|assistant" &&
        unknownTurnToolBoundaryMessages.at(-1)?.provider_occurrence === 2,
      "a formal post-tool assistant must not reuse a historical provider occurrence"
    )

    const lateTurnToolChunkTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "late-turn-tool-chunk-worker",
      workerThreadId: "thread-123__worker__late-turn-tool-chunk-worker"
    })
    lateTurnToolChunkTransport.convertFocusedCoordinatorWorkerIPCEvent(
      streamMessageEvent(
        aiMessageChunk({
          id: "late-turn-tool-chunk-ai",
          toolCallChunks: [
            { id: "late-turn-tool-chunk-call", name: "read_file", args: '{"path":"' }
          ]
        }),
        {}
      ) as never,
      "thread-123"
    )
    const completedAfterTurnMetadata =
      lateTurnToolChunkTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessageChunk({
              id: "late-turn-tool-chunk-ai",
              toolCallChunks: [{ id: "late-turn-tool-chunk-call", args: 'a.txt"}' }]
            }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    assert(
      completedAfterTurnMetadata[0]?.id === "late-turn-tool-chunk-ai" &&
        completedAfterTurnMetadata[0]?.tool_calls?.[0]?.name === "read_file" &&
        completedAfterTurnMetadata[0]?.tool_calls?.[0]?.args?.path === "a.txt",
      "first workerTurn metadata must preserve active tool-call chunk accumulation"
    )

    const staleTurnToolTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "stale-turn-tool-worker",
      workerThreadId: "thread-123__worker__stale-turn-tool-worker"
    })
    const currentTurnChunkA = staleTurnToolTransport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        ...(streamMessageEvent(
          aiMessageChunk({ id: "stale-turn-current-ai", content: "A" }),
          {}
        ) as object),
        workerTurn: 2
      } as never,
      "thread-123"
    )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__stale-turn-tool-worker",
        currentTurnChunkA
      )
    const staleTurnTool = staleTurnToolTransport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        ...(streamMessageEvent(
          toolMessage({
            id: "stale-turn-old-tool",
            name: "read_file",
            toolCallId: "stale-turn-old-call",
            content: "late old result"
          }),
          {}
        ) as object),
        workerTurn: 1
      } as never,
      "thread-123"
    )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__stale-turn-tool-worker",
        staleTurnTool
      )
    const currentTurnChunkB = staleTurnToolTransport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        ...(streamMessageEvent(
          aiMessageChunk({ id: "stale-turn-current-ai", content: "B" }),
          {}
        ) as object),
        workerTurn: 2
      } as never,
      "thread-123"
    )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__stale-turn-tool-worker",
        currentTurnChunkB
      )
    const staleTurnStoreAssistant = useAppStore
      .getState()
      .workerFocusMessages.find((message) => message.role === "assistant")
    assert(
      staleTurnTool[0]?.id.startsWith(
        "worker-turn-thread-123__worker__stale-turn-tool-worker-1::"
      ) &&
        currentTurnChunkB.at(-1)?.content === "AB" &&
        staleTurnStoreAssistant?.content === "AB",
      "a late old-turn tool result must not reset the current assistant accumulator"
    )

    const staleChunkTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "stale-chunk-worker",
      workerThreadId: "thread-123__worker__stale-chunk-worker"
    })
    const newerTurnMessage = staleChunkTransport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        ...(streamMessageEvent(
          aiMessageChunk({ id: "stale-chunk-newer", content: "newer" }),
          {}
        ) as object),
        workerTurn: 2
      } as never,
      "thread-123"
    )
    useAppStore
      .getState()
      .appendWorkerFocusMessages("thread-123__worker__stale-chunk-worker", newerTurnMessage)
    const staleChunkA = staleChunkTransport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        ...(streamMessageEvent(
          aiMessageChunk({ id: "stale-chunk-old", content: "A" }),
          {}
        ) as object),
        workerTurn: 1
      } as never,
      "thread-123"
    )
    useAppStore
      .getState()
      .appendWorkerFocusMessages("thread-123__worker__stale-chunk-worker", staleChunkA)
    const staleChunkB = staleChunkTransport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        ...(streamMessageEvent(
          aiMessageChunk({ id: "stale-chunk-old", content: "B" }),
          {}
        ) as object),
        workerTurn: 1
      } as never,
      "thread-123"
    )
    useAppStore
      .getState()
      .appendWorkerFocusMessages("thread-123__worker__stale-chunk-worker", staleChunkB)
    const staleChunkStoreMessages = useAppStore.getState().workerFocusMessages
    assert(
      staleChunkB[0]?.content === "AB" &&
        staleChunkStoreMessages.map((message) => message.content).join("|") === "AB|newer",
      "stale assistant chunks must accumulate independently and sort before newer turns"
    )

    const staleBoundaryTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "stale-boundary-worker",
      workerThreadId: "thread-123__worker__stale-boundary-worker"
    })
    const staleBoundaryNewer = staleBoundaryTransport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        ...(streamMessageEvent(
          aiMessageChunk({ id: "stale-boundary-newer", content: "newer" }),
          {}
        ) as object),
        workerTurn: 2
      } as never,
      "thread-123"
    )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__stale-boundary-worker",
        staleBoundaryNewer
      )
    const staleBoundaryA = staleBoundaryTransport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        ...(streamMessageEvent(
          aiMessageChunk({ id: "stale-boundary-shared", content: "A" }),
          {}
        ) as object),
        workerTurn: 1
      } as never,
      "thread-123"
    )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__stale-boundary-worker",
        staleBoundaryA
      )
    const staleBoundaryTool = staleBoundaryTransport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        ...(streamMessageEvent(
          toolMessage({
            id: "stale-boundary-tool",
            name: "read_file",
            toolCallId: "stale-boundary-call",
            content: "result"
          }),
          {}
        ) as object),
        workerTurn: 1
      } as never,
      "thread-123"
    )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__stale-boundary-worker",
        staleBoundaryTool
      )
    const staleBoundaryB = staleBoundaryTransport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        ...(streamMessageEvent(
          aiMessageChunk({ id: "stale-boundary-shared", content: "B" }),
          {}
        ) as object),
        workerTurn: 1
      } as never,
      "thread-123"
    )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__stale-boundary-worker",
        staleBoundaryB
      )
    const staleBoundaryMessages = useAppStore.getState().workerFocusMessages
    const staleBoundaryAssistants = staleBoundaryMessages.filter(
      (message) => message.role === "assistant" && message.content !== "newer"
    )
    assert(
      staleBoundaryAssistants.length === 2 &&
        staleBoundaryAssistants[0]?.content === "A" &&
        staleBoundaryAssistants[1]?.content === "B" &&
        staleBoundaryAssistants[0]?.id !== staleBoundaryAssistants[1]?.id &&
        staleBoundaryMessages.map((message) => message.content).join("|") ===
          "A|result|B|newer",
      "stale assistants reusing a provider id across a tool boundary must stay distinct"
    )

    const staleToolChunkTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "stale-tool-chunk-worker",
      workerThreadId: "thread-123__worker__stale-tool-chunk-worker"
    })
    staleToolChunkTransport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        ...(streamMessageEvent(
          aiMessageChunk({ id: "stale-tool-chunk-newer", content: "newer" }),
          {}
        ) as object),
        workerTurn: 2
      } as never,
      "thread-123"
    )
    const staleToolChunkFirst =
      staleToolChunkTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessageChunk({
              id: "stale-tool-chunk-ai",
              toolCallChunks: [
                { id: "stale-tool-chunk-call", name: "read_file", args: '{"path":"' }
              ]
            }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__stale-tool-chunk-worker",
        staleToolChunkFirst
      )
    const staleToolChunkSecond =
      staleToolChunkTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          ...(streamMessageEvent(
            aiMessageChunk({
              id: "stale-tool-chunk-ai",
              toolCallChunks: [{ id: "stale-tool-chunk-call", args: 'a.txt"}' }]
            }),
            {}
          ) as object),
          workerTurn: 1
        } as never,
        "thread-123"
      )
    useAppStore
      .getState()
      .appendWorkerFocusMessages(
        "thread-123__worker__stale-tool-chunk-worker",
        staleToolChunkSecond
      )
    const staleToolChunkCall = staleToolChunkSecond[0]?.tool_calls?.[0]
    const storedStaleToolChunkCall = useAppStore
      .getState()
      .workerFocusMessages.find((message) => message.id === staleToolChunkSecond[0]?.id)
      ?.tool_calls?.[0]
    assert(
      staleToolChunkCall?.name === "read_file" &&
        staleToolChunkCall.args?.path === "a.txt" &&
        storedStaleToolChunkCall?.name === "read_file" &&
        storedStaleToolChunkCall.args?.path === "a.txt",
      "stale tool-call chunks must retain the name and assemble split JSON args"
    )

    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "mixed-scope-worker",
      workerThreadId: "thread-123__worker__mixed-scope-worker"
    })
    useAppStore.getState().appendWorkerFocusMessages(
      "thread-123__worker__mixed-scope-worker",
      [
        {
          id: "legacy-unscoped-message",
          role: "assistant",
          content: "legacy",
          created_at: new Date()
        },
        {
          id: "worker-turn-thread-123__worker__mixed-scope-worker-2::newer",
          role: "assistant",
          content: "newer",
          created_at: new Date()
        },
        {
          id: "worker-turn-thread-123__worker__mixed-scope-worker-1::older",
          role: "assistant",
          content: "older",
          created_at: new Date()
        }
      ]
    )
    assert(
      useAppStore
        .getState()
        .workerFocusMessages.map((message) => message.content)
        .join("|") === "legacy|older|newer",
      "unscoped legacy rows must not disable ordering among known worker turns"
    )

    const staleFallbackTransport = new ElectronIPCTransport()
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "stale-fallback-worker",
      workerThreadId: "thread-123__worker__stale-fallback-worker"
    })
    staleFallbackTransport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        ...(streamMessageEvent(
          aiMessageChunk({ id: "stale-fallback-newer", content: "newer" }),
          {}
        ) as object),
        workerTurn: 2
      } as never,
      "thread-123"
    )
    const staleFallbackA = staleFallbackTransport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        ...(streamMessageEvent(aiMessageChunk({ content: "A" }), {}) as object),
        workerTurn: 1
      } as never,
      "thread-123"
    )
    const staleFallbackB = staleFallbackTransport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        ...(streamMessageEvent(aiMessageChunk({ content: "B" }), {}) as object),
        workerTurn: 1
      } as never,
      "thread-123"
    )
    assert(
      staleFallbackA[0]?.id === staleFallbackB[0]?.id &&
        staleFallbackB[0]?.content === "AB",
      "id-less stale assistant chunks must share one stable turn-scoped fallback"
    )

    const staleToolPartial = staleFallbackTransport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        ...(streamMessageEvent(
          toolMessage({ toolCallId: "stale-growing-call", content: "partial" }),
          {}
        ) as object),
        workerTurn: 1
      } as never,
      "thread-123"
    )
    useAppStore
      .getState()
      .appendWorkerFocusMessages("thread-123__worker__stale-fallback-worker", staleToolPartial)
    const staleToolComplete = staleFallbackTransport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        ...(streamMessageEvent(
          toolMessage({
            toolCallId: "stale-growing-call",
            content: "partial complete"
          }),
          {}
        ) as object),
        workerTurn: 1
      } as never,
      "thread-123"
    )
    useAppStore
      .getState()
      .appendWorkerFocusMessages("thread-123__worker__stale-fallback-worker", staleToolComplete)
    const staleGrowingTools = useAppStore
      .getState()
      .workerFocusMessages.filter(
        (message) => message.role === "tool" && message.tool_call_id === "stale-growing-call"
      )
    assert(
      staleToolPartial[0]?.id === staleToolComplete[0]?.id &&
        staleGrowingTools.length === 1 &&
        staleGrowingTools[0]?.content === "partial complete",
      "id-less stale tool growth must update one stable result row"
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
        humanMessage("Here is a summary of the conversation to date:\nsummary", {
          id: "focused-worker-values-summary",
          additionalKwargs: { lc_source: "summarization" }
        }),
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
      !directValuesMessages.some((message) => message.id.includes("values-summary")),
      "worker values fallback should hide structurally marked summaries"
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
    useAppStore
      .getState()
      .appendWorkerFocusMessages("thread-123__worker__worker-1", liveToolResultMessages)
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
      valuesAfterTool.find((message) => message.role === "assistant")?.id ===
        "worker-turn-thread-123__worker__worker-1-1::worker-snapshot-1",
      "focused worker values fallback ids should retain their checkpoint index and turn scope"
    )
    useAppStore
      .getState()
      .appendWorkerFocusMessages("thread-123__worker__worker-1", valuesAfterTool, {
        orderedSnapshot: true
      })
    const mergedAssistants = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant")
    assert(
      mergedAssistants.length === 1 && mergedAssistants[0]?.id === liveAiId,
      "worker focus store should merge snapshot replay into the existing live assistant message"
    )
    const mergedLiveThenValues = useAppStore.getState().workerFocusMessages
    const mergedLiveThenValuesTools = mergedLiveThenValues.filter(
      (message) => message.role === "tool"
    )
    assert(
      mergedLiveThenValues.map((message) => message.role).join(">") === "user>assistant>tool" &&
        mergedLiveThenValuesTools.length === 1 &&
        mergedLiveThenValuesTools[0]?.id === liveToolResultId,
      "worker focus store should reorder a late values snapshot and dedupe the live tool result"
    )

    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "worker-1",
      workerThreadId: "thread-123__worker__worker-1"
    })
    useAppStore.getState().appendWorkerFocusMessages("thread-123__worker__worker-1", [
      {
        id: "worker-live-thread-123__worker__worker-1-args",
        role: "assistant",
        content: "",
        tool_calls: [{ id: "worker-args-call", name: "execute", args: { command: "git status" } }],
        created_at: new Date()
      }
    ])
    useAppStore.getState().appendWorkerFocusMessages(
      "thread-123__worker__worker-1",
      [
        {
          id: "worker-snapshot-1",
          role: "assistant",
          content: "",
          tool_calls: [{ id: "worker-args-call", name: "execute", args: {} }],
          created_at: new Date()
        }
      ],
      { orderedSnapshot: true }
    )
    const mergedArgAssistants = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant")
    assert(
      mergedArgAssistants.length === 1 &&
        mergedArgAssistants[0]?.tool_calls?.[0]?.args?.command === "git status",
      "worker focus store should merge snapshot/live tool calls without downgrading streamed args"
    )

    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: "thread-123",
      workerId: "worker-1",
      workerThreadId: "thread-123__worker__worker-1"
    })
    useAppStore.getState().appendWorkerFocusMessages("thread-123__worker__worker-1", [
      {
        id: "worker-live-tool-result-partial",
        role: "tool",
        name: "execute",
        tool_call_id: "worker-partial-tool",
        content: "partial output",
        created_at: new Date()
      }
    ])
    useAppStore.getState().appendWorkerFocusMessages(
      "thread-123__worker__worker-1",
      [
        {
          id: "worker-snapshot-2",
          role: "tool",
          name: "execute",
          tool_call_id: "worker-partial-tool",
          content: "partial output with final tail",
          created_at: new Date()
        }
      ],
      { orderedSnapshot: true }
    )
    const mergedPartialTools = useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "tool")
    assert(
      mergedPartialTools.length === 1 &&
        mergedPartialTools[0]?.content === "partial output with final tail",
      "worker focus store should merge partial live tool results with fuller snapshot results"
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

async function testLargeCoordinatorToolArgsParseOnlyAfterCompletion(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const largeContent = `${"function value() { return \\\"ok\\\" }\n".repeat(4096)}tail`
  const argsText = JSON.stringify({ path: "large.ts", content: largeContent })
  const chunkSize = 257
  let completedEvents: ReturnType<typeof convertCoordinator> = []

  for (let offset = 0; offset < argsText.length; offset += chunkSize) {
    completedEvents = convertCoordinator(
      transport,
      streamMessageEvent(
        aiMessageChunk({
          id: "coordinator-ai-large-args",
          toolCallChunks: [
            {
              id: "write-large-file",
              name: "write_file",
              args: argsText.slice(offset, offset + chunkSize)
            }
          ]
        }),
        { langgraph_node: "agent" }
      )
    )
  }

  const message = firstMessage(completedEvents)
  const toolCalls = message.tool_calls as Array<{
    id?: string
    name?: string
    args?: Record<string, unknown>
  }>
  assert(
    toolCalls[0]?.args?.content === largeContent,
    "large streamed file arguments should parse once complete without losing escaped content"
  )
}

async function testCoordinatorTaskIdlessContinuationRegistersSubagent(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const firstEvents = convert(
    transport,
    streamMessageEvent(
      aiMessageChunk({
        id: "coordinator-ai-idless-task",
        toolCallChunks: [
          {
            id: "task-idless-chunks",
            name: "task",
            args: '{"subagent_type":"verifier",',
            index: 0
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )
  assert(
    customEvents(firstEvents, "subagents").length === 0,
    "incomplete task args should not register a subagent"
  )

  const completedEvents = convert(
    transport,
    streamMessageEvent(
      aiMessageChunk({
        id: "coordinator-ai-idless-task",
        toolCallChunks: [
          {
            args: '"description":"Inspect streamed task"}',
            index: 0
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )
  const subagents = customEvents(completedEvents, "subagents").at(-1)?.subagents as
    | Array<Record<string, unknown>>
    | undefined
  assert(
    subagents?.some((subagent) => subagent.toolCallId === "task-idless-chunks"),
    "an id-less final task chunk should register the accumulated task by index"
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
    overlapToolCalls[0]?.args?.description === "调研调研项目",
    "ambiguous provider overlap must preserve bytes instead of guessing replay"
  )

  const boundaryRepeatTransport = new ElectronIPCTransport()
  convertCoordinator(
    boundaryRepeatTransport,
    streamMessageEvent(
      aiMessageChunk({
        id: "coordinator-ai-boundary-repeat",
        toolCallChunks: [
          {
            id: "start-worker-boundary-repeat",
            name: "start_worker",
            args: '{"description":"bana'
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )
  const boundaryRepeatEvents = convertCoordinator(
    boundaryRepeatTransport,
    streamMessageEvent(
      aiMessageChunk({
        id: "coordinator-ai-boundary-repeat",
        toolCallChunks: [
          {
            id: "start-worker-boundary-repeat",
            args: 'nana","prompt":"done"}'
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )
  const boundaryRepeatMessage = firstMessage(boundaryRepeatEvents)
  const boundaryRepeatToolCalls = boundaryRepeatMessage.tool_calls as Array<{
    args?: Record<string, unknown>
  }>
  assert(
    boundaryRepeatToolCalls[0]?.args?.description === "bananana",
    "real AIMessageChunk deltas preserve legitimate repeated boundary bytes"
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

function mainReasoningMessageEvents(
  events: SdkEvent[],
  messageId: string
): Record<string, unknown>[] {
  return events
    .filter((event) => event.event === "messages" && Array.isArray(event.data))
    .map((event) => asRecord((event.data as unknown[])[0]))
    .filter(
      (message) => message.id === messageId && typeof message.reasoning === "string"
    )
}

async function testMainReasoningSnapshotsCoalesceWithinThrottleWindow(): Promise<void> {
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
              callback(
                streamMessageEvent(
                  aiMessageChunk({ id: "main-reasoning-coalesced", reasoning: "first" })
                )
              )
              callback(
                streamMessageEvent(
                  aiMessageChunk({ id: "main-reasoning-coalesced", reasoning: " second" })
                )
              )
            })
            const doneTimer = setTimeout(() => callback({ type: "done" }), 140)
            return () => clearTimeout(doneTimer)
          }
        }
      }
    }

    const events = await collectStreamEvents(new ElectronIPCTransport(), {
      input: { messages: [{ type: "human", content: "Think" }] },
      config: { configurable: { thread_id: "thread-123", model_id: "test-model" } },
      signal: new AbortController().signal
    })
    const reasoningMessages = mainReasoningMessageEvents(events, "main-reasoning-coalesced")
    assert(
      reasoningMessages.length === 1 && reasoningMessages[0]?.reasoning === "first second",
      "reasoning snapshots inside 50ms should collapse to the latest cumulative value"
    )
  } finally {
    ;(globalThis as { window?: unknown }).window = previousWindow
  }
}

async function testMainReasoningFlushesBeforeToolBoundary(): Promise<void> {
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
              callback(
                streamMessageEvent(
                  aiMessageChunk({ id: "main-reasoning-tool", reasoning: "inspect" })
                )
              )
              callback(
                streamMessageEvent(
                  aiMessageChunk({ id: "main-reasoning-tool", reasoning: " files" })
                )
              )
              callback(
                streamMessageEvent(
                  aiMessage({
                    id: "main-reasoning-tool",
                    toolCalls: [{ id: "read-call", name: "read_file", args: { path: "a.txt" } }]
                  })
                )
              )
              callback({ type: "done" })
            })
            return () => undefined
          }
        }
      }
    }

    const events = await collectStreamEvents(new ElectronIPCTransport(), {
      input: { messages: [{ type: "human", content: "Inspect" }] },
      config: { configurable: { thread_id: "thread-123", model_id: "test-model" } },
      signal: new AbortController().signal
    })
    const reasoningMessages = mainReasoningMessageEvents(events, "main-reasoning-tool")
    const reasoningIndex = events.findIndex((event) => {
      if (event.event !== "messages" || !Array.isArray(event.data)) return false
      return asRecord(event.data[0]).reasoning === "inspect files"
    })
    const toolIndex = events.findIndex((event) => {
      if (event.event !== "messages" || !Array.isArray(event.data)) return false
      return Array.isArray(asRecord(event.data[0]).tool_calls)
    })
    assert(
      reasoningMessages.length === 1 && reasoningIndex >= 0 && toolIndex > reasoningIndex,
      "tool start must synchronously flush the latest reasoning before the tool event"
    )
  } finally {
    ;(globalThis as { window?: unknown }).window = previousWindow
  }
}

async function testMainReasoningFlushesAtStreamEnd(): Promise<void> {
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
              callback(
                streamMessageEvent(
                  aiMessageChunk({ id: "main-reasoning-end", reasoning: "final" })
                )
              )
              callback(
                streamMessageEvent(
                  aiMessageChunk({ id: "main-reasoning-end", reasoning: " thought" })
                )
              )
              callback({ type: "done" })
            })
            return () => undefined
          }
        }
      }
    }

    const events = await collectStreamEvents(new ElectronIPCTransport(), {
      input: { messages: [{ type: "human", content: "Finish" }] },
      config: { configurable: { thread_id: "thread-123", model_id: "test-model" } },
      signal: new AbortController().signal
    })
    const reasoningMessages = mainReasoningMessageEvents(events, "main-reasoning-end")
    const snapshots = customEvents(events, "coordinator_ai_snapshot_message").filter((event) => {
      const assistantMessage = asRecord(event.assistantMessage)
      return assistantMessage.id === "main-reasoning-end"
    })
    assert(
      reasoningMessages.length === 1 && reasoningMessages[0]?.reasoning === "final thought",
      "stream end must retain the latest cumulative reasoning message"
    )
    assert(
      snapshots.length === 1 &&
        asRecord(snapshots[0]?.assistantMessage).reasoning === "final thought",
      "stream end must also flush the matching durable reasoning snapshot"
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
  const completedTranscript = customEvents(
    completedEvents,
    "subagent_transcript_message"
  )[0]
  const completedTranscriptMessage = asRecord(completedTranscript?.subagentMessage)
  assert(
    completedTranscript?.subagentId === "task-values-1" &&
      completedTranscriptMessage.role === "assistant" &&
      completedTranscriptMessage.content === "verified",
    "values-only completion should backfill the final subagent assistant content"
  )
}

async function testStableTranscriptHistoryDoesNotReplayAcrossStreams(): Promise<void> {
  const previousWindow = (globalThis as { window?: unknown }).window
  try {
    const snapshot = streamValuesEvent([
      aiMessage({
        id: "history-main-ai",
        toolCalls: [
          {
            id: "task-history-stable",
            name: "task",
            args: { subagent_type: "verifier", description: "stable history" }
          }
        ]
      }),
      toolMessage({
        id: "task-history-result",
        name: "task",
        toolCallId: "task-history-stable",
        content: "stable final"
      })
    ])
    ;(globalThis as { window?: unknown }).window = {
      api: {
        agent: {
          streamAgent: (
            _threadId: string,
            _message: string,
            _command: unknown,
            callback: (event: unknown) => void
          ) => {
            callback(snapshot)
            callback({ type: "done" })
            return () => undefined
          }
        }
      }
    }
    const transport = new ElectronIPCTransport()
    const payload = {
      input: { messages: [{ type: "human", content: "continue" }] },
      config: {
        configurable: {
          thread_id: "thread-stable-history",
          model_id: "test-model",
          agent_mode: "normal"
        }
      },
      signal: new AbortController().signal
    }
    const first = await collectStreamEvents(transport, payload)
    const second = await collectStreamEvents(transport, payload)
    const transcriptIds = (events: SdkEvent[]): string[] =>
      customEvents(events, "subagent_transcript_message").map((event) =>
        String(asRecord(event.subagentMessage).id)
      )
    const firstIds = transcriptIds(first)
    const secondIds = transcriptIds(second)
    assert(
      firstIds.filter((id) => id === "subagent-prompt-task-history-stable").length === 1 &&
        firstIds.filter((id) => id === "subagent-final-task-history-stable").length === 1,
      "the first stream should hydrate stable prompt and final transcript rows"
    )
    assert(
      !secondIds.includes("subagent-prompt-task-history-stable") &&
        !secondIds.includes("subagent-final-task-history-stable"),
      "an unchanged full-history snapshot must not replay stable rows in a later stream"
    )
  } finally {
    ;(globalThis as { window?: unknown }).window = previousWindow
  }
}

async function testInterruptedStreamDoesNotSuppressStableTranscriptRecovery(): Promise<void> {
  const previousWindow = (globalThis as { window?: unknown }).window
  try {
    let failStream = true
    const snapshot = streamValuesEvent([
      aiMessage({
        id: "recovery-main-ai",
        toolCalls: [
          {
            id: "task-stable-recovery",
            name: "task",
            args: { subagent_type: "verifier", description: "recover stable history" }
          }
        ]
      }),
      toolMessage({
        id: "task-stable-recovery-result",
        name: "task",
        toolCallId: "task-stable-recovery",
        content: "recoverable final"
      })
    ])
    ;(globalThis as { window?: unknown }).window = {
      api: {
        agent: {
          streamAgent: (
            _threadId: string,
            _message: string,
            _command: unknown,
            callback: (event: unknown) => void
          ) => {
            callback(snapshot)
            callback(
              failStream
                ? { type: "error", error: "INTERRUPTED", message: "interrupted" }
                : { type: "done" }
            )
            return () => undefined
          }
        }
      }
    }
    const transport = new ElectronIPCTransport()
    const payload = {
      input: { messages: [{ type: "human", content: "recover" }] },
      config: {
        configurable: {
          thread_id: "thread-stable-recovery",
          model_id: "test-model",
          agent_mode: "normal"
        }
      },
      signal: new AbortController().signal
    }
    await collectStreamEvents(transport, payload)
    failStream = false
    const recovered = await collectStreamEvents(transport, payload)
    const recoveredIds = customEvents(recovered, "subagent_transcript_message").map((event) =>
      String(asRecord(event.subagentMessage).id)
    )
    assert(
      recoveredIds.includes("subagent-prompt-task-stable-recovery") &&
        recoveredIds.includes("subagent-final-task-stable-recovery"),
      "an interrupted stream must allow its potentially undelivered stable rows to rehydrate"
    )
  } finally {
    ;(globalThis as { window?: unknown }).window = previousWindow
  }
}

async function testStableTranscriptSignaturesDoNotThrashPastOneThousand(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const count = 1_001
  const taskCalls = Array.from({ length: count }, (_, index) => ({
    id: `task-signature-boundary-${index}`,
    name: "task",
    args: { subagent_type: "verifier", description: `boundary ${index}` }
  }))
  const snapshot = streamValuesEvent([
    aiMessage({ id: "signature-boundary-main", toolCalls: taskCalls }),
    ...taskCalls.map((toolCall, index) =>
      toolMessage({
        id: `signature-boundary-result-${index}`,
        name: "task",
        toolCallId: toolCall.id,
        content: `done ${index}`
      })
    )
  ])
  const first = convert(transport, snapshot)
  const second = convert(transport, snapshot)
  const countFinals = (events: SdkEvent[]): number =>
    customEvents(events, "subagent_transcript_message")
      .map((event) => String(asRecord(event.subagentMessage).id))
      .filter((id) => id.startsWith("subagent-final-task-signature-boundary-")).length
  assert(countFinals(first) === count, "the first large snapshot should hydrate every final row")
  assert(
    countFinals(second) === 0,
    "an identical snapshot above 1000 tasks must not trigger FIFO signature-cache replay"
  )
}

async function testQueuedSubagentSnapshotsCoalesceAndStayBounded(): Promise<void> {
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
            callback(
              streamMessageEvent(
                aiMessage({
                  id: "main-ai-queued-subagent",
                  toolCalls: [
                    {
                      id: "task-queued-subagent",
                      name: "task",
                      args: { subagent_type: "implementer", description: "large queued output" }
                    }
                  ]
                }),
                { langgraph_node: "agent" }
              )
            )
            const repeatedDelta = ".".repeat(100)
            for (let index = 0; index < 300; index += 1) {
              callback(
                streamMessageEvent(
                  aiMessageChunk({ id: "subagent-queued-live", content: repeatedDelta }),
                  { langgraph_checkpoint_ns: "agent:tools:task-queued-subagent" }
                )
              )
            }
            callback({ type: "done" })
            return () => undefined
          }
        }
      }
    }

    const events = await collectStreamEvents(new ElectronIPCTransport(), {
      input: { messages: [{ type: "human", content: "run queued subagent" }] },
      config: {
        configurable: {
          thread_id: "thread-queued-subagent",
          model_id: "test-model",
          agent_mode: "normal"
        }
      },
      signal: new AbortController().signal
    })
    const assistantSnapshots = customEvents(events, "subagent_transcript_message")
      .map((event) => asRecord(event.subagentMessage))
      .filter((message) => message.role === "assistant")
    const assistantLogs = customEvents(events, "subagent_log_entry")
      .map((event) => asRecord(event.entry))
      .filter((entry) => entry.kind === "assistant")
    assert(
      assistantSnapshots.length === 2 && assistantLogs.length === 1,
      "a synchronous burst should keep one bounded preview plus one lossless terminal repair"
    )
    const previewContent = assistantSnapshots[0]?.content
    assert(
      typeof previewContent === "string" &&
        previewContent.length <= 24_000 &&
        previewContent.includes("省略"),
      "the coalesced live transcript payload should remain a bounded head-tail projection"
    )
    assert(
      assistantSnapshots[1]?.content === ".".repeat(30_000) &&
        assistantSnapshots[1]?.content_priority === 0.5,
      "the done boundary should repair the bounded preview with exact full content"
    )
  } finally {
    ;(globalThis as { window?: unknown }).window = previousWindow
  }
}

async function testQueuedFinalCorrectionsPreserveRepairMetadata(): Promise<void> {
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
            callback(
              streamMessageEvent(
                aiMessage({
                  id: "main-ai-queued-final",
                  toolCalls: [
                    {
                      id: "task-queued-final",
                      name: "task",
                      args: { subagent_type: "verifier", description: "queued final" }
                    }
                  ]
                }),
                { langgraph_node: "agent" }
              )
            )
            callback(
              streamMessageEvent(
                aiMessage({
                  id: "subagent-queued-final-tool-call",
                  toolCalls: [
                    {
                      id: "queued-final-inner-tool",
                      name: "read_file",
                      args: { path: "secret.ts" }
                    }
                  ]
                }),
                { langgraph_checkpoint_ns: "agent:tools:task-queued-final" }
              )
            )
            callback(
              streamMessageEvent(
                toolMessage({
                  id: "subagent-queued-final-tool-result",
                  name: "read_file",
                  toolCallId: "queued-final-inner-tool",
                  content: "file body"
                }),
                { langgraph_checkpoint_ns: "agent:tools:task-queued-final" }
              )
            )
            callback(
              streamMessageEvent(
                aiMessageChunk({ id: "subagent-queued-final-live", content: "candidate" }),
                { langgraph_checkpoint_ns: "agent:tools:task-queued-final" }
              )
            )
            callback(
              streamMessageEvent(
                toolMessage({
                  id: "task-queued-final-success",
                  name: "task",
                  toolCallId: "task-queued-final",
                  content: "candidate"
                }),
                { langgraph_node: "tools" }
              )
            )
            callback(
              streamValuesEvent([
                toolMessage({
                  id: "task-queued-final-error",
                  name: "task",
                  toolCallId: "task-queued-final",
                  content: "actual failure",
                  status: "error"
                })
              ])
            )
            callback({ type: "done" })
            return () => undefined
          }
        }
      }
    }

    const events = await collectStreamEvents(new ElectronIPCTransport(), {
      input: { messages: [{ type: "human", content: "run queued final" }] },
      config: {
        configurable: {
          thread_id: "thread-queued-final",
          model_id: "test-model",
          agent_mode: "normal"
        }
      },
      signal: new AbortController().signal
    })
    const transcriptEvents = customEvents(events, "subagent_transcript_message")
    let merged: Record<string, Message[]> = {}
    for (const event of transcriptEvents) {
      merged = mergeSubagentTranscripts(merged, String(event.subagentId), [
        event.subagentMessage as Message
      ])
    }
    const assistants = (merged["task-queued-final"] ?? []).filter(
      (message) => message.role === "assistant" && !message.tool_calls?.length
    )
    const stableEvents = transcriptEvents
      .map((event) => asRecord(event.subagentMessage))
      .filter((message) => message.id === "subagent-final-task-queued-final")
    assert(
      stableEvents.length === 2 &&
        assistants.length === 1 &&
        assistants[0]?.content === "actual failure" &&
        assistants[0]?.is_error === true,
      "queued final corrections must retain the earlier repair before applying the error update"
    )
    let logs: SubagentInternalLogEntry[] = []
    for (const event of customEvents(events, "subagent_log_entry")) {
      logs = upsertSubagentLogEntry(logs, event.entry as SubagentInternalLogEntry)
    }
    const toolLog = logs.find((entry) => entry.toolCallId === "queued-final-inner-tool")
    assert(
      toolLog?.content.includes("secret.ts") && toolLog.result?.includes("file body"),
      "queued tool-call/result patches should retain both the arguments and result"
    )
  } finally {
    ;(globalThis as { window?: unknown }).window = previousWindow
  }
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
  feed("world")
  const flushSuffix = "!".repeat(1_018)
  const lastEvents = feed(flushSuffix)

  const assistantLogs = customEvents(lastEvents, "subagent_log_entry").filter(
    (data) => asRecord(data.entry).kind === "assistant"
  )
  assert(assistantLogs.length > 0, "subagent thinking should emit an assistant log entry")
  const entry = asRecord(assistantLogs[assistantLogs.length - 1].entry)
  assert(
    entry.content === `hello world${flushSuffix}`,
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

  const oversizedEvents = feed("A".repeat(25_000))
  const liveTail = "TAIL-SHOULD-KEEP-UPDATING"
  const tailDelta = `${"T".repeat(1_024 - liveTail.length)}${liveTail}`
  const tailEvents = feed(tailDelta)
  const tailTranscriptEvent = customEvents(tailEvents, "subagent_transcript_message")[0]
  const tailTranscriptMessage = asRecord(tailTranscriptEvent?.subagentMessage)
  assert(
    typeof tailTranscriptMessage.content === "string" &&
      tailTranscriptMessage.content.length > 16_000 &&
      tailTranscriptMessage.content.endsWith(liveTail),
    "subagent transcript should continue growing after the former 16k cutoff"
  )

  let merged: Record<string, Message[]> = {}
  for (const event of [...oversizedEvents, ...tailEvents]) {
    const data = event.event === "custom" ? asRecord(event.data) : undefined
    if (data?.type !== "subagent_transcript_message") continue
    merged = mergeSubagentTranscripts(merged, String(data.subagentId), [
      data.subagentMessage as Message
    ])
  }
  const storedTail = merged["task-1"]?.[0]?.content
  assert(
    typeof storedTail === "string" &&
      storedTail.includes("省略") &&
      storedTail.endsWith(liveTail),
    "the bounded in-flight preview should preserve the moving tail"
  )

  const completeContent = `hello world${flushSuffix}${"A".repeat(25_000)}${tailDelta}`
  const completionEvents = convert(
    transport,
    streamMessageEvent(
      toolMessage({
        id: "task-long-thinking-result",
        name: "task",
        toolCallId: "task-1",
        content: completeContent
      }),
      { langgraph_node: "tools", langgraph_checkpoint_ns: ns }
    )
  )
  const finalMessage = asRecord(
    customEvents(completionEvents, "subagent_transcript_message")
      .map((event) => asRecord(event.subagentMessage))
      .find((message) => message.id === "subagent-final-task-1")
  )
  assert(
    finalMessage.content === completeContent,
    "task completion must replace the bounded live preview with lossless final content"
  )
}

async function testSubagentCumulativeThinkingContinuesPast16k(): Promise<void> {
  const transport = new ElectronIPCTransport()
  convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "main-ai-cumulative",
        toolCalls: [
          {
            id: "task-cumulative",
            name: "task",
            args: { subagent_type: "implementer", description: "stream cumulative text" }
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )

  const prefix = `CUMULATIVE-HEAD-${"C".repeat(17_000)}`
  const ns = "agent:tools:task-cumulative"
  convert(
    transport,
    streamMessageEvent(aiMessage({ id: "subagent-cumulative", content: prefix }), {
      langgraph_checkpoint_ns: ns
    })
  )
  const cumulativeTail = "-CUMULATIVE-TAIL"
  const cumulativeEvents = convert(
    transport,
    streamMessageEvent(
      aiMessage({ id: "subagent-cumulative", content: `${prefix}${cumulativeTail}` }),
      { langgraph_checkpoint_ns: ns }
    )
  )
  const transcript = asRecord(
    customEvents(cumulativeEvents, "subagent_transcript_message")[0]?.subagentMessage
  )
  assert(
    transcript.content === `${prefix}${cumulativeTail}`,
    "cumulative subagent snapshots should keep growing beyond 16k without duplicating the prefix"
  )
}

async function testSubagentReasoningOnlyStreamingIsLosslessAndSeparate(): Promise<void> {
  const transport = new ElectronIPCTransport()
  convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "main-ai-reasoning-only",
        toolCalls: [
          {
            id: "task-reasoning-only",
            name: "task",
            args: { subagent_type: "implementer", description: "reason without content" }
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )

  const namespace = "agent:tools:task-reasoning-only"
  const reasoningPrefix = `REASONING-HEAD-${"R".repeat(31_000)}`
  const firstEvents = convert(
    transport,
    streamMessageEvent(
      aiMessageChunk({
        id: "subagent-reasoning-only",
        content: "",
        reasoning: reasoningPrefix
      }),
      { langgraph_checkpoint_ns: namespace }
    )
  )
  const firstTranscript = asRecord(
    customEvents(firstEvents, "subagent_transcript_message")[0]?.subagentMessage
  )
  assert(firstTranscript.content === "", "reasoning-only chunks must not leak into final content")
  assert(
    typeof firstTranscript.reasoning === "string" && firstTranscript.reasoning.includes("省略"),
    "oversized live reasoning should emit a bounded head/tail projection"
  )
  assert(
    firstTranscript.reasoning_full_length === reasoningPrefix.length &&
      firstTranscript.reasoning_is_projection === true,
    "live reasoning projection should advertise its authoritative full length"
  )

  // Exceed the live snapshot delta threshold so this direct converter test
  // observes the update synchronously (the real stream also has a timer sink).
  const reasoningTail = `${"T".repeat(1_024)}-REASONING-TAIL`
  const cumulativeEvents = convert(
    transport,
    streamMessageEvent(
      aiMessageChunk({
        id: "subagent-reasoning-only",
        content: "",
        reasoning: `${reasoningPrefix}${reasoningTail}`
      }),
      { langgraph_checkpoint_ns: namespace }
    )
  )
  const cumulativeTranscript = asRecord(
    customEvents(cumulativeEvents, "subagent_transcript_message")[0]?.subagentMessage
  )
  assert(
    typeof cumulativeTranscript.reasoning === "string" &&
      cumulativeTranscript.reasoning.endsWith(reasoningTail) &&
      cumulativeTranscript.reasoning_full_length === reasoningPrefix.length + reasoningTail.length,
    "cumulative reasoning chunks should replace their prefix instead of duplicating it"
  )

  const completionEvents = convert(
    transport,
    streamMessageEvent(
      toolMessage({
        id: "task-reasoning-only-result",
        name: "task",
        toolCallId: "task-reasoning-only",
        content: "final answer"
      }),
      { langgraph_node: "tools" }
    )
  )
  const finalMessage = asRecord(
    customEvents(completionEvents, "subagent_transcript_message")
      .map((event) => asRecord(event.subagentMessage))
      .find((message) => message.id === "subagent-final-task-reasoning-only")
  )
  assert(finalMessage.content === "final answer", "task result should remain the final content")
  assert(
    finalMessage.reasoning === `${reasoningPrefix}${reasoningTail}` &&
      finalMessage.reasoning_is_projection === false,
    "task completion should persist the complete reasoning separately from content"
  )
}

async function testSubagentPrefixRelatedTextDeltasAreNotDropped(): Promise<void> {
  const transport = new ElectronIPCTransport()
  convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "main-ai-prefix-related-deltas",
        toolCalls: [
          {
            id: "task-prefix-related-deltas",
            name: "task",
            args: { subagent_type: "implementer", description: "prefix-related deltas" }
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )
  const feed = (content: string): SdkEvent[] =>
    convert(
      transport,
      streamMessageEvent(aiMessageChunk({ id: "subagent-prefix-related", content }), {
        langgraph_checkpoint_ns: "agent:tools:task-prefix-related-deltas"
      })
    )
  feed("ha")
  const flushSuffix = "x".repeat(1_020)
  const events = feed(`haha${flushSuffix}`)
  const message = asRecord(
    customEvents(events, "subagent_transcript_message")[0]?.subagentMessage
  )
  assert(
    message.content === `hahaha${flushSuffix}`,
    "a longer delta that starts with prior text must append byte-for-byte"
  )
}

async function testSubagentRepeatedTextDeltasAreNotDropped(): Promise<void> {
  const transport = new ElectronIPCTransport()
  convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "main-ai-repeated-text",
        toolCalls: [
          {
            id: "task-repeated-text",
            name: "task",
            args: { subagent_type: "implementer", description: "repeat text" }
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )
  const feed = (content: string): SdkEvent[] =>
    convert(
      transport,
      streamMessageEvent(aiMessageChunk({ id: "subagent-repeated-text", content }), {
        langgraph_checkpoint_ns: "agent:tools:task-repeated-text"
      })
    )
  feed("ha")
  feed("ha")
  const flushSuffix = "x".repeat(1_021)
  const events = feed(`.${flushSuffix}`)
  const message = asRecord(
    customEvents(events, "subagent_transcript_message")[0]?.subagentMessage
  )
  assert(
    message.content === `haha.${flushSuffix}`,
    "identical legal text deltas must append instead of being mistaken for replays"
  )
}

async function testTaskResultRebasesStreamedTerminalAssistant(): Promise<void> {
  const transport = new ElectronIPCTransport()
  convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "main-ai-terminal",
        toolCalls: [
          {
            id: "task-terminal",
            name: "task",
            args: { subagent_type: "verifier", description: "produce a final answer" }
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )

  const finalContent = "streamed terminal answer"
  const streamedContent = `${finalContent} with speculative suffix`
  const streamedEvents = convert(
    transport,
    streamMessageEvent(
      aiMessageChunk({ id: "subagent-terminal-ai", content: streamedContent }),
      { langgraph_checkpoint_ns: "agent:tools:task-terminal" }
    )
  )
  const streamedMessage = asRecord(
    customEvents(streamedEvents, "subagent_transcript_message")[0]?.subagentMessage
  )
  const completionEvents = convert(
    transport,
    streamMessageEvent(
      toolMessage({
        id: "task-terminal-result",
        name: "task",
        toolCallId: "task-terminal",
        content: finalContent
      }),
      { langgraph_node: "tools" }
    )
  )
  const completedMessage = asRecord(
    customEvents(completionEvents, "subagent_transcript_message")[0]?.subagentMessage
  )
  assert(
    completedMessage.id === "subagent-final-task-terminal" &&
      completedMessage.replaces_message_id === streamedMessage.id,
    "task completion should rebase the matching streamed assistant onto a stable final id"
  )
  const finalEventIndex = completionEvents.findIndex(
    (event) =>
      event.event === "custom" &&
      asRecord(event.data).type === "subagent_transcript_message"
  )
  const statusEventIndex = completionEvents.findIndex(
    (event) => event.event === "custom" && asRecord(event.data).type === "subagents"
  )
  assert(
    finalEventIndex >= 0 && statusEventIndex > finalEventIndex,
    "the final transcript repair should arrive before the completed status"
  )

  const merged = mergeSubagentTranscripts({}, "task-terminal", [
    streamedMessage as unknown as Message,
    completedMessage as unknown as Message
  ])["task-terminal"]
  assert(
    merged?.length === 1 &&
      merged[0]?.id === "subagent-final-task-terminal" &&
      merged[0]?.content === finalContent,
    `a streamed terminal answer and its task result should render as one assistant entry: ${JSON.stringify(merged)}`
  )

  const sameTransportReplay = convert(
    transport,
    streamValuesEvent([
      toolMessage({
        id: "task-terminal-result-values-replay",
        name: "task",
        toolCallId: "task-terminal",
        content: finalContent
      })
    ])
  )
  assert(
    customEvents(sameTransportReplay, "subagent_transcript_message").length === 0,
    "an unchanged final must stay deduped after its live replacement candidate is sealed"
  )

  const restoredTransport = new ElectronIPCTransport()
  const restoredEvents = convert(
    restoredTransport,
    streamValuesEvent([
      aiMessage({
        id: "restored-main-ai-terminal",
        toolCalls: [
          {
            id: "task-terminal",
            name: "task",
            args: { subagent_type: "verifier", description: "produce a final answer" }
          }
        ]
      }),
      toolMessage({
        id: "restored-task-terminal-result",
        name: "task",
        toolCallId: "task-terminal",
        content: finalContent
      })
    ])
  )
  const restoredFinalMessage = asRecord(
    customEvents(restoredEvents, "subagent_transcript_message")
      .map((event) => asRecord(event.subagentMessage))
      .find((message) => message.id === "subagent-final-task-terminal")
  )
  const afterRestoreReplay = mergeSubagentTranscripts(
    { "task-terminal": merged ?? [] },
    "task-terminal",
    [restoredFinalMessage as unknown as Message]
  )["task-terminal"]
  assert(
    restoredFinalMessage.id === "subagent-final-task-terminal" &&
      afterRestoreReplay?.length === 1,
    "a fresh transport values replay should keep the canonical final entry idempotent"
  )
}

async function testConcurrentSubagentsDoNotShareProviderAccumulator(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const ownerKey = "cmb_subagent_owner_tool_call_id"
  convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "main-ai-shared-provider",
        toolCalls: [
          {
            id: "task-shared-provider-a",
            name: "task",
            args: { subagent_type: "implementer", description: "first" }
          },
          {
            id: "task-shared-provider-b",
            name: "task",
            args: { subagent_type: "verifier", description: "second" }
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )

  const firstEvents = convert(
    transport,
    streamMessageEvent(aiMessageChunk({ id: "shared-provider-ai", content: "alpha" }), {
      langgraph_checkpoint_ns: "tools:shared-runtime|model:1",
      [ownerKey]: "task-shared-provider-a"
    })
  )
  const secondEvents = convert(
    transport,
    streamMessageEvent(aiMessageChunk({ id: "shared-provider-ai", content: "beta" }), {
      langgraph_checkpoint_ns: "tools:shared-runtime|model:1",
      [ownerKey]: "task-shared-provider-b"
    })
  )
  const first = asRecord(
    customEvents(firstEvents, "subagent_transcript_message")[0]?.subagentMessage
  )
  const second = asRecord(
    customEvents(secondEvents, "subagent_transcript_message")[0]?.subagentMessage
  )
  assert(
    first.content === "alpha" && second.content === "beta",
    "concurrent subagents reusing a provider message id must keep independent text"
  )
}

async function testTaskFinalRepairsPersistedLiveMessageAcrossTransportReset(): Promise<void> {
  const firstTransport = new ElectronIPCTransport()
  convert(
    firstTransport,
    streamMessageEvent(
      aiMessage({
        id: "main-ai-reset",
        toolCalls: [
          {
            id: "task-reset",
            name: "task",
            args: { subagent_type: "verifier", description: "survive reset" }
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )
  const liveEvents = convert(
    firstTransport,
    streamMessageEvent(
      aiMessageChunk({ id: "subagent-reset-live", content: "speculative suffix" }),
      { langgraph_checkpoint_ns: "agent:tools:task-reset" }
    )
  )
  const liveMessage = asRecord(
    customEvents(liveEvents, "subagent_transcript_message")[0]?.subagentMessage
  ) as unknown as Message
  const persisted = serializeSubagentTranscripts(
    mergeSubagentTranscripts({}, "task-reset", [liveMessage])
  )
  const restored = getSubagentTranscriptsFromThreadValues({
    subagentTranscripts: persisted
  })

  const secondTransport = new ElectronIPCTransport()
  const completionEvents = convert(
    secondTransport,
    streamValuesEvent([
      aiMessage({
        id: "main-ai-reset-restored",
        toolCalls: [
          {
            id: "task-reset",
            name: "task",
            args: { subagent_type: "verifier", description: "survive reset" }
          }
        ]
      }),
      toolMessage({
        id: "task-reset-result",
        name: "task",
        toolCallId: "task-reset",
        content: "authoritative result"
      })
    ])
  )
  const finalMessage = asRecord(
    customEvents(completionEvents, "subagent_transcript_message")
      .map((event) => asRecord(event.subagentMessage))
      .find((message) => message.id === "subagent-final-task-reset")
  ) as unknown as Message
  const repaired = mergeSubagentTranscripts(restored, "task-reset", [finalMessage])
  assert(
    repaired["task-reset"]?.length === 1 &&
      repaired["task-reset"]?.[0]?.id === "subagent-final-task-reset" &&
      repaired["task-reset"]?.[0]?.content === "authoritative result",
    "a values completion after transport reset should replace the persisted live terminal row"
  )

  const emptyCompletionEvents = convert(
    new ElectronIPCTransport(),
    streamValuesEvent([
      aiMessage({
        id: "main-ai-reset-empty",
        toolCalls: [
          {
            id: "task-reset",
            name: "task",
            args: { subagent_type: "verifier", description: "survive empty completion" }
          }
        ]
      }),
      toolMessage({
        id: "task-reset-empty-result",
        name: "task",
        toolCallId: "task-reset",
        content: ""
      })
    ])
  )
  const emptyFinal = asRecord(
    customEvents(emptyCompletionEvents, "subagent_transcript_message")
      .map((event) => asRecord(event.subagentMessage))
      .find((message) => message.id === "subagent-final-task-reset")
  ) as unknown as Message
  const repairedEmpty = mergeSubagentTranscripts(restored, "task-reset", [emptyFinal])
  assert(
    repairedEmpty["task-reset"]?.length === 1 &&
      repairedEmpty["task-reset"]?.[0]?.id === "subagent-final-task-reset" &&
      repairedEmpty["task-reset"]?.[0]?.content === "speculative suffix",
    "an empty successful completion should still canonicalize a persisted live terminal row"
  )
}

async function testIdlessSubagentAssistantTurnsSplitAtToolResult(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const ns = "agent:tools:task-idless-turns"
  convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "main-ai-idless-turns",
        toolCalls: [
          {
            id: "task-idless-turns",
            name: "task",
            args: { subagent_type: "implementer", description: "use a tool" }
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )

  const beforeEvents = convert(
    transport,
    streamMessageEvent(aiMessageChunk({ content: "before tool" }), {
      langgraph_checkpoint_ns: ns
    })
  )
  const before = asRecord(
    customEvents(beforeEvents, "subagent_transcript_message")[0]?.subagentMessage
  )
  convert(
    transport,
    streamMessageEvent(
      aiMessage({
        toolCalls: [{ id: "idless-inner-tool", name: "read_file", args: { path: "a.ts" } }]
      }),
      { langgraph_checkpoint_ns: ns }
    )
  )
  convert(
    transport,
    streamMessageEvent(
      toolMessage({
        id: "idless-inner-result",
        name: "read_file",
        toolCallId: "idless-inner-tool",
        content: "file body"
      }),
      { langgraph_checkpoint_ns: ns }
    )
  )
  const afterEvents = convert(
    transport,
    streamMessageEvent(aiMessageChunk({ content: "after tool" }), {
      langgraph_checkpoint_ns: ns
    })
  )
  const after = asRecord(
    customEvents(afterEvents, "subagent_transcript_message")[0]?.subagentMessage
  )
  assert(
    after.id !== before.id && after.content === "after tool",
    "id-less assistant output after a tool result should start a new transcript turn"
  )
}

async function testFailedTaskResultBackfillsVisibleDiagnostic(): Promise<void> {
  const transport = new ElectronIPCTransport()
  convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "main-ai-failed-task",
        toolCalls: [
          {
            id: "task-failed",
            name: "task",
            args: { subagent_type: "verifier", description: "fail with diagnostics" }
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )

  const failedEvents = convert(
    transport,
    streamMessageEvent(
      toolMessage({
        id: "task-failed-result",
        name: "task",
        toolCallId: "task-failed",
        content: "diagnostic details",
        status: "error"
      }),
      { langgraph_node: "tools" }
    )
  )
  const failedSubagents = customEvents(failedEvents, "subagents")[0]?.subagents as Array<
    Record<string, unknown>
  >
  const diagnostic = asRecord(
    customEvents(failedEvents, "subagent_transcript_message")[0]?.subagentMessage
  )
  assert(failedSubagents?.[0]?.status === "failed", "error task result should fail the subagent")
  assert(
    diagnostic.role === "assistant" &&
      diagnostic.content === "diagnostic details" &&
      diagnostic.status === "error" &&
      diagnostic.is_error === true,
    "failed task result should remain visible in the subagent transcript with error metadata"
  )
  assert(
    firstMessage(failedEvents).content === "diagnostic details" &&
      firstMessage(failedEvents).status === "error" &&
      firstMessage(failedEvents).is_error === true,
    "failed task result should retain content and error metadata in the parent thread"
  )
}

async function testLaterValuesErrorUpgradesCompletedSubagentMonotonically(): Promise<void> {
  const transport = new ElectronIPCTransport()
  convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "main-ai-status-upgrade",
        toolCalls: [
          {
            id: "task-status-upgrade",
            name: "task",
            args: { subagent_type: "verifier", description: "status upgrade" }
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )
  const initial = convert(
    transport,
    streamMessageEvent(
      toolMessage({
        id: "task-status-initial",
        name: "task",
        toolCallId: "task-status-upgrade",
        content: "initial result"
      }),
      { langgraph_node: "tools" }
    )
  )
  const initiallyCompleted = customEvents(initial, "subagents")[0]?.subagents as Array<
    Record<string, unknown>
  >
  const initialFinal = asRecord(
    customEvents(initial, "subagent_transcript_message")[0]?.subagentMessage
  ) as unknown as Message
  const completedAt = String(initiallyCompleted?.[0]?.completedAt)
  assert(initiallyCompleted?.[0]?.status === "completed", "initial result should complete task")

  const corrected = convert(
    transport,
    streamValuesEvent([
      toolMessage({
        id: "task-status-corrected",
        name: "task",
        toolCallId: "task-status-upgrade",
        content: "actual failure",
        status: "error"
      })
    ])
  )
  const failed = customEvents(corrected, "subagents")[0]?.subagents as Array<
    Record<string, unknown>
  >
  const correctedFinal = asRecord(
    customEvents(corrected, "subagent_transcript_message")[0]?.subagentMessage
  ) as unknown as Message
  assert(
    failed?.[0]?.status === "failed" && String(failed[0]?.completedAt) === completedAt,
    "later error evidence should upgrade completed to failed without refreshing completion time"
  )
  const correctedValuesEvent = corrected.find((event) => event.event === "values")
  const correctedValues = asRecord(correctedValuesEvent?.data)
  const correctedParentTool = (correctedValues.messages as Array<Record<string, unknown>>)?.[0]
  assert(
    correctedParentTool?.status === "error" && correctedParentTool?.is_error === true,
    "a values-only parent ToolMessage should retain its error metadata"
  )

  const staleSuccess = convert(
    transport,
    streamValuesEvent([
      toolMessage({
        id: "task-status-stale-success",
        name: "task",
        toolCallId: "task-status-upgrade",
        content: "initial result"
      })
    ])
  )
  const stillFailed = customEvents(staleSuccess, "subagents")[0]?.subagents as Array<
    Record<string, unknown>
  >
  const staleFinals = customEvents(staleSuccess, "subagent_transcript_message")
  assert(
    stillFailed?.[0]?.status === "failed",
    "a stale successful replay must not downgrade a failed subagent"
  )
  assert(
    staleFinals.length === 0,
    "a stale successful replay after failure must not emit or perturb final signatures"
  )
  const mergedFinal = mergeSubagentTranscripts({}, "task-status-upgrade", [
    initialFinal,
    correctedFinal
  ])["task-status-upgrade"]?.[0]
  assert(
    mergedFinal?.content === "actual failure" && mergedFinal.is_error === true,
    "a stale success must not replace the sticky failed final content"
  )
}

async function testFinalReplayFingerprintIncludesCompleteMiddleContent(): Promise<void> {
  const transport = new ElectronIPCTransport()
  convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "main-ai-final-fingerprint",
        toolCalls: [
          {
            id: "task-final-fingerprint",
            name: "task",
            args: { subagent_type: "verifier", description: "fingerprint final" }
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )
  const head = "H".repeat(300)
  const tail = "T".repeat(300)
  const firstContent = `${head}${"A".repeat(400)}${tail}`
  const correctedContent = `${head}${"B".repeat(400)}${tail}`
  convert(
    transport,
    streamMessageEvent(
      toolMessage({
        id: "task-final-fingerprint-first",
        name: "task",
        toolCallId: "task-final-fingerprint",
        content: firstContent
      }),
      { langgraph_node: "tools" }
    )
  )
  const corrected = convert(
    transport,
    streamValuesEvent([
      toolMessage({
        id: "task-final-fingerprint-corrected",
        name: "task",
        toolCallId: "task-final-fingerprint",
        content: correctedContent
      })
    ])
  )
  const correctedFinal = asRecord(
    customEvents(corrected, "subagent_transcript_message")[0]?.subagentMessage
  )
  assert(
    correctedFinal.content === correctedContent,
    "same-length final corrections that differ only in the middle must not be suppressed"
  )
}

async function testOwnerMetadataAttributesConcurrentSubagentsDeterministically(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const ownerKey = "cmb_subagent_owner_tool_call_id"

  convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "main-ai-owner",
        toolCalls: [
          {
            id: "task-1",
            name: "task",
            args: { subagent_type: "implementer", description: "First target" }
          },
          {
            id: "task-2",
            name: "task",
            args: { subagent_type: "verifier", description: "Second target" }
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )

  // Second-spawned subagent (task-2) emits FIRST, and its checkpoint_ns shares
  // the same task UUID a spawn-order heuristic would hand to task-1. The owner
  // hint must override that and attribute the chunk to task-2.
  const secondFirst = convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "subagent-ai-owner-b",
        toolCalls: [{ id: "inner-b", name: "list_dir", args: { path: "src" } }]
      }),
      { langgraph_checkpoint_ns: "agent:tools:shared-uuid|list_dir:1", [ownerKey]: "task-2" }
    )
  )
  const bTranscript = customEvents(secondFirst, "subagent_transcript_message")[0]
  assert(
    bTranscript?.subagentId === "task-2",
    "owner metadata should attribute the chunk to task-2 even when it streams before task-1 and shares a task UUID"
  )

  const firstSecond = convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "subagent-ai-owner-a",
        toolCalls: [{ id: "inner-a", name: "read_file", args: { file_path: "one.md" } }]
      }),
      { langgraph_checkpoint_ns: "agent:tools:shared-uuid|read_file:1", [ownerKey]: "task-1" }
    )
  )
  const aTranscript = customEvents(firstSecond, "subagent_transcript_message")[0]
  assert(
    aTranscript?.subagentId === "task-1",
    "owner metadata should attribute the later chunk to task-1 regardless of shared task UUID"
  )
  assert(
    messageEvents(secondFirst).length === 0 && messageEvents(firstSecond).length === 0,
    "owner-attributed subagent internals must not leak into the main chat stream"
  )
}

async function testSubagentIdlessContinuationChunksStitchArgsByIndex(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const ownerKey = "cmb_subagent_owner_tool_call_id"
  const ns = "tools:uuid-stream|model_request:1"

  convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "main-ai-stream",
        toolCalls: [
          {
            id: "task-1",
            name: "task",
            args: { subagent_type: "implementer", description: "Stream args" }
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )

  const streamedMsgId = "subagent-streamed-1"
  const chunk = (
    chunks: Array<{ id?: string; name?: string; args?: string; index?: number }>
  ): unknown => ({
    id: ["langchain_core", "messages", "AIMessageChunk"],
    kwargs: { id: streamedMsgId, content: "", tool_call_chunks: chunks }
  })

  // First chunk carries id+name+index; continuations carry only index + an args
  // fragment (no id/name) — exactly the real provider shape.
  convert(transport, streamMessageEvent(chunk([{ id: "inner-1", name: "ls", args: "", index: 0 }]), {
    langgraph_checkpoint_ns: ns,
    [ownerKey]: "task-1"
  }))
  convert(transport, streamMessageEvent(chunk([{ args: '{"path":', index: 0 }]), {
    langgraph_checkpoint_ns: ns,
    [ownerKey]: "task-1"
  }))
  const finalEvents = convert(
    transport,
    streamMessageEvent(chunk([{ args: '"src"}', index: 0 }]), {
      langgraph_checkpoint_ns: ns,
      [ownerKey]: "task-1"
    })
  )

  const transcript = customEvents(finalEvents, "subagent_transcript_message")[0]
  assert(transcript, "streamed id-less continuation chunks should emit a transcript update")
  const assistant = asRecord(transcript.subagentMessage)
  const toolCalls = assistant.tool_calls as Array<{
    id?: string
    name?: string
    args?: Record<string, unknown>
  }>
  assert(toolCalls?.[0]?.name === "ls", "stitched tool call should keep its name from the first chunk")
  assert(
    toolCalls?.[0]?.args?.path === "src",
    "id-less continuation chunks must stitch streamed args back by index (RAW ARGUMENTS must not stay {})"
  )
}

async function testConcurrentSubagentsStreamingIndexZeroDoNotCrossContaminate(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const ownerKey = "cmb_subagent_owner_tool_call_id"

  convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "main-ai-concurrent",
        toolCalls: [
          { id: "task-1", name: "task", args: { subagent_type: "implementer", description: "A" } },
          { id: "task-2", name: "task", args: { subagent_type: "verifier", description: "B" } }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )

  const chunkMsg = (
    msgId: string,
    chunks: Array<{ id?: string; name?: string; args?: string; index?: number }>
  ): unknown => ({
    id: ["langchain_core", "messages", "AIMessageChunk"],
    kwargs: { id: msgId, content: "", tool_call_chunks: chunks }
  })
  const nsA = "tools:uuid-a|model_request:1"
  const nsB = "tools:uuid-b|model_request:1"
  const sendA = (chunks: Parameters<typeof chunkMsg>[1]): SdkEvent[] =>
    convert(transport, streamMessageEvent(chunkMsg("msg-a", chunks), {
      langgraph_checkpoint_ns: nsA,
      [ownerKey]: "task-1"
    }))
  const sendB = (chunks: Parameters<typeof chunkMsg>[1]): SdkEvent[] =>
    convert(transport, streamMessageEvent(chunkMsg("msg-b", chunks), {
      langgraph_checkpoint_ns: nsB,
      [ownerKey]: "task-2"
    }))

  // Both subagents stream their tool call with index 0, interleaved — exactly
  // the real provider behaviour that previously corrupted both args.
  sendA([{ id: "inner-a", name: "read_file", args: "", index: 0 }])
  sendB([{ id: "inner-b", name: "glob", args: "", index: 0 }])
  sendA([{ args: '{"file_path":', index: 0 }])
  sendB([{ args: '{"pattern":', index: 0 }])
  sendA([{ args: '"a.ts"}', index: 0 }])
  const lastB = sendB([{ args: '"*.ts"}', index: 0 }])

  const lastA = sendA([{ args: "", index: 0 }]) // trailing flush for A

  const aMsg = asRecord(
    customEvents(lastA, "subagent_transcript_message").find(
      (e) => e.subagentId === "task-1"
    )?.subagentMessage as Record<string, unknown>
  )
  const bMsg = asRecord(
    customEvents(lastB, "subagent_transcript_message").find(
      (e) => e.subagentId === "task-2"
    )?.subagentMessage as Record<string, unknown>
  )
  const aCalls = aMsg.tool_calls as Array<{ name?: string; args?: Record<string, unknown> }>
  const bCalls = bMsg.tool_calls as Array<{ name?: string; args?: Record<string, unknown> }>
  assert(
    aCalls?.[0]?.name === "read_file" && aCalls?.[0]?.args?.file_path === "a.ts",
    "subagent A args must stitch independently of interleaved subagent B (index 0 collision)"
  )
  assert(
    bCalls?.[0]?.name === "glob" && bCalls?.[0]?.args?.pattern === "*.ts",
    "subagent B args must stitch independently of interleaved subagent A (index 0 collision)"
  )
}

async function testConcurrentSubagentsReusingInnerToolIdDoNotCrossContaminate(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const ownerKey = "cmb_subagent_owner_tool_call_id"

  convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "main-ai-reused-inner-id",
        toolCalls: [
          { id: "task-a", name: "task", args: { subagent_type: "implementer", description: "A" } },
          { id: "task-b", name: "task", args: { subagent_type: "verifier", description: "B" } }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )

  const chunkMsg = (
    msgId: string,
    chunks: Array<{ id?: string; name?: string; args?: string; index?: number }>
  ): unknown => ({
    id: ["langchain_core", "messages", "AIMessageChunk"],
    kwargs: { id: msgId, content: "", tool_call_chunks: chunks }
  })
  const send = (
    taskId: string,
    namespace: string,
    msgId: string,
    chunks: Parameters<typeof chunkMsg>[1]
  ): SdkEvent[] =>
    convert(transport, streamMessageEvent(chunkMsg(msgId, chunks), {
      langgraph_checkpoint_ns: namespace,
      [ownerKey]: taskId
    }))

  send("task-a", "tools:uuid-reused-a|model_request:1", "msg-reused-a", [
    { id: "inner-shared", name: "read_file", args: "", index: 0 }
  ])
  send("task-b", "tools:uuid-reused-b|model_request:1", "msg-reused-b", [
    { id: "inner-shared", name: "glob", args: "", index: 0 }
  ])
  send("task-a", "tools:uuid-reused-a|model_request:1", "msg-reused-a", [
    { args: '{"file_path":', index: 0 }
  ])
  send("task-b", "tools:uuid-reused-b|model_request:1", "msg-reused-b", [
    { args: '{"pattern":', index: 0 }
  ])
  const lastA = send("task-a", "tools:uuid-reused-a|model_request:1", "msg-reused-a", [
    { args: '"a.ts"}', index: 0 }
  ])
  const lastB = send("task-b", "tools:uuid-reused-b|model_request:1", "msg-reused-b", [
    { args: '"*.ts"}', index: 0 }
  ])

  const readCalls = (
    events: SdkEvent[],
    taskId: string
  ): Array<{ id?: string; name?: string; args?: Record<string, unknown> }> => {
    const message = asRecord(
      customEvents(events, "subagent_transcript_message").find(
        (event) => event.subagentId === taskId
      )?.subagentMessage as Record<string, unknown>
    )
    return message.tool_calls as Array<{
      id?: string
      name?: string
      args?: Record<string, unknown>
    }>
  }
  const aCalls = readCalls(lastA, "task-a")
  const bCalls = readCalls(lastB, "task-b")

  assert(
    aCalls?.[0]?.id === "inner-shared" &&
      aCalls[0].name === "read_file" &&
      aCalls[0].args?.file_path === "a.ts",
    "subagent A must retain its own args when another execution reuses the raw inner tool id"
  )
  assert(
    bCalls?.[0]?.id === "inner-shared" &&
      bCalls[0].name === "glob" &&
      bCalls[0].args?.pattern === "*.ts",
    "subagent B must retain its own args when another execution reuses the raw inner tool id"
  )
}

async function testSubagentDeltaArgsPreserveRepeatedFragments(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const ownerKey = "cmb_subagent_owner_tool_call_id"
  const ns = "tools:uuid-empty|model_request:1"

  convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "main-ai-empty",
        toolCalls: [
          { id: "task-1", name: "task", args: { subagent_type: "implementer", description: "X" } }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )

  const msgId = "subagent-empty-arg"
  const chunk = (
    chunks: Array<{ id?: string; name?: string; args?: string; index?: number }>
  ): unknown => ({
    id: ["langchain_core", "messages", "AIMessageChunk"],
    kwargs: { id: msgId, content: "", tool_call_chunks: chunks }
  })
  const send = (chunks: Parameters<typeof chunk>[0]): SdkEvent[] =>
    convert(transport, streamMessageEvent(chunk(chunks), {
      langgraph_checkpoint_ns: ns,
      [ownerKey]: "task-1"
    }))

  // Stream args {"query":""} as deltas: the two quotes of the empty-string value
  // arrive as identical consecutive fragments. They must NOT be deduped away.
  send([{ id: "inner-1", name: "search", args: "", index: 0 }])
  send([{ args: '{"query":', index: 0 }])
  send([{ args: '"', index: 0 }])
  send([{ args: '"', index: 0 }])
  const last = send([{ args: "}", index: 0 }])

  const transcript = customEvents(last, "subagent_transcript_message")[0]
  const assistant = asRecord(transcript.subagentMessage)
  const toolCalls = assistant.tool_calls as Array<{ name?: string; args?: Record<string, unknown> }>
  assert(
    toolCalls?.[0]?.name === "search" && toolCalls?.[0]?.args?.query === "",
    "repeated identical delta fragments (empty-string value quotes) must be preserved, not deduped"
  )
}

function testWorkflowSnapshotConverterSurvivesCorruptToolCalls(): void {
  // item2: a half-broken / externally edited sidecar can JSON.parse with object MESSAGES but a
  // CORRUPTED kwargs.tool_calls — either a NON-array (string/object), OR an array with bad ELEMENTS
  // (null / string). The converter must degrade gracefully, not throw in
  // hydrateToolCallsWithAccumulatedArgs's .map() (`[null]` → `null.args`) and break the whole panel.
  const transport = new ElectronIPCTransport()
  const mk = (toolCalls: unknown): unknown => ({
    id: ["langchain_core", "messages", "AIMessage"],
    kwargs: { id: "a1", content: "ok", tool_calls: toolCalls }
  })
  const cases: Array<[string, unknown]> = [
    ["non-array string", "BROKEN"],
    ["non-array object", { not: "an array" }],
    ["null element", [null]],
    ["string element", ["NOTACALL"]]
  ]
  for (const [label, toolCalls] of cases) {
    let messages: unknown
    try {
      messages = transport.convertWorkflowAgentValuesSnapshot([mk(toolCalls)], "wfagent:wf_x:0")
    } catch (error) {
      assert(false, `corrupt tool_calls (${label}) must not throw, got ${(error as Error).message}`)
    }
    assert(Array.isArray(messages), `converter returns a Message[] for ${label} (degraded, not crashed)`)
  }
  // A bogus string element must be DROPPED, not surfaced to MessageBubble as a fake tool call.
  const out = transport.convertWorkflowAgentValuesSnapshot([mk(["NOTACALL"])], "wfagent:wf_x:0")
  assert(
    !JSON.stringify(out).includes("NOTACALL"),
    "a corrupt tool-call element is dropped, not surfaced as a fake tool call"
  )

  const compactionMessages = transport.convertWorkflowAgentValuesSnapshot(
    [
      humanMessage("You are in the middle of a conversation that has been summarized.", {
        id: "workflow-summary",
        additionalKwargs: { lc_source: "summarization" }
      }),
      aiMessage({
        id: "workflow-visible-assistant",
        content: "Here is a summary of the conversation to date:\n用户要求原样输出"
      })
    ],
    "wfagent:wf_x:0"
  )
  assert(
    !compactionMessages.some((message) => message.id.includes("workflow-summary")),
    "workflow values converter should hide structurally marked summaries"
  )
  assert(
    compactionMessages.some((message) => message.id.includes("workflow-visible-assistant")),
    "workflow values converter should preserve ordinary assistant prose"
  )
}

function testSummarizationMessagesAreHiddenByMarkerOnly(): void {
  const transport = new ElectronIPCTransport()
  const markedSummaryEvents = convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "main-marked-summary",
        content: "Here is a summary of the conversation to date:\ninternal summary",
        additionalKwargs: { lc_source: "summarization" }
      })
    )
  )
  assert(
    messageEvents(markedSummaryEvents).length === 0,
    "main message stream should hide structurally marked summaries"
  )

  const visibleAssistantEvents = convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "main-visible-summary-prose",
        content: "Here is a summary of the conversation to date:\n用户要求原样输出"
      })
    )
  )
  assert(
    messageEvents(visibleAssistantEvents).length === 1,
    "main message stream should preserve matching prose without the structural marker"
  )

  const taggedPrivateSummaryEvents = convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "main-tagged-private-summary",
        content: "1. Primary Request and Intent\ninternal summary"
      }),
      { tags: [CONTEXT_COMPACTION_MODEL_TAG] }
    )
  )
  assert(
    messageEvents(taggedPrivateSummaryEvents).length === 0,
    "main message stream should hide private summarizer output by model tag"
  )
}

function testCrossRoleProviderIdCollisionSurvivesTransportConversion(): void {
  const transport = new ElectronIPCTransport()
  const converted = transport.convertWorkflowAgentValuesSnapshot(
    [
      aiMessage({
        id: "shared-provider-id",
        content: "calling tool",
        toolCalls: [{ id: "call-1", name: "read_file", args: {} }]
      }),
      toolMessage({
        id: "shared-provider-id",
        name: "read_file",
        toolCallId: "call-1",
        content: "tool result"
      })
    ],
    "wfagent:wf_collision:0"
  )

  assert(converted.length === 2, "transport should preserve both cross-role snapshot messages")
  assert(
    new Set(converted.map((message) => message.id)).size === 2,
    "transport should assign cross-role snapshot messages unique internal ids"
  )
  assert(
    converted.map((message) => message.role).join(",") === "assistant,tool",
    "transport should keep cross-role snapshot message roles"
  )
}

function testWorkflowSnapshotPreservesSameRoleProviderIdOccurrences(): void {
  const transport = new ElectronIPCTransport()
  const converted = transport.convertWorkflowAgentValuesSnapshot(
    [
      aiMessage({ id: "same-workflow-provider-id", content: "first answer" }),
      aiMessage({ id: "same-workflow-provider-id", content: "second answer" })
    ],
    "wfagent:wf_same_role:0"
  )

  assert(converted.length === 2, "workflow snapshots must keep same-role id occurrences")
  assert(
    new Set(converted.map((message) => message.id)).size === 2,
    "workflow snapshot occurrences must receive unique React/render ids"
  )
  assert(
    converted.map((message) => message.content).join("|") === "first answer|second answer",
    "workflow snapshot occurrences must not overwrite each other"
  )
}

function testMainStreamNormalizesCrossRoleIdsBeforeSdkMerge(): void {
  const transport = new ElectronIPCTransport()
  const sharedId = "main-stream-shared-provider-id"
  const assistant = firstMessage(
    convert(
      transport,
      streamMessageEvent(
        aiMessage({
          id: sharedId,
          content: "calling tool",
          toolCalls: [{ id: "call-main-collision", name: "read_file", args: {} }]
        }),
        { langgraph_node: "agent" }
      )
    )
  )
  const tool = firstMessage(
    convert(
      transport,
      streamMessageEvent(
        toolMessage({
          id: sharedId,
          name: "read_file",
          toolCallId: "call-main-collision",
          content: "tool result"
        }),
        { langgraph_node: "tools" }
      )
    )
  )

  assert(
    assistant.id !== tool.id,
    "main assistant/tool collisions must be disambiguated before the SDK merges chunks by id"
  )
  assert(assistant.id === sharedId, "the first main-stream role should keep the provider id")
  assert(
    tool.id === `${sharedId}::cmb-id-collision:tool`,
    "the later tool role should receive a stable role-scoped id"
  )

  const repeatedTool = firstMessage(
    convert(
      transport,
      streamMessageEvent(
        toolMessage({
          id: sharedId,
          name: "read_file",
          toolCallId: "call-main-collision",
          content: "tool result updated"
        }),
        { langgraph_node: "tools" }
      )
    )
  )
  assert(
    repeatedTool.id === tool.id,
    "repeated chunks for the colliding role must keep the same SDK-facing id"
  )

  const valuesEvent = convert(
    transport,
    streamValuesEvent([
      aiMessage({
        id: sharedId,
        content: "calling tool",
        toolCalls: [{ id: "call-main-collision", name: "read_file", args: {} }]
      }),
      toolMessage({
        id: sharedId,
        name: "read_file",
        toolCallId: "call-main-collision",
        content: "tool result updated"
      })
    ])
  ).find((event) => event.event === "values")
  const valuesMessages = asRecord(valuesEvent?.data).messages as Array<Record<string, unknown>>
  assert(
    valuesMessages[0]?.id === assistant.id && valuesMessages[1]?.id === tool.id,
    "the full values snapshot must preserve the SDK-facing role-scoped ids"
  )
}

function testWorkerFocusStorePreservesCrossRoleProviderIdCollision(): void {
  resetWorkerFocusStore()
  openWorkerFocusViewForTest({
    threadId: "parent-cross-role",
    workerThreadId: "worker-cross-role",
    workerId: "worker-cross-role"
  })
  useAppStore.getState().appendWorkerFocusMessages("worker-cross-role", [
    {
      id: "shared-provider-id",
      role: "assistant",
      content: "calling tool",
      created_at: new Date()
    },
    {
      id: "shared-provider-id",
      role: "tool",
      content: "tool result",
      tool_call_id: "call-1",
      created_at: new Date()
    }
  ])

  const messages = useAppStore.getState().workerFocusMessages
  assert(messages.length === 2, "worker focus should preserve both cross-role messages")
  assert(
    new Set(messages.map((message) => message.id)).size === 2,
    "worker focus should assign cross-role messages unique internal ids"
  )
  resetWorkerFocusStore()
}

function testWorkerFocusStoreNormalizesLegacyCrossRoleBaseline(): void {
  resetWorkerFocusStore()
  openWorkerFocusViewForTest({
    threadId: "parent-legacy-cross-role",
    workerThreadId: "worker-legacy-cross-role",
    workerId: "worker-legacy-cross-role"
  })
  const sharedId = "legacy-worker-shared-id"
  useAppStore.setState({
    workerFocusMessagesThreadId: "worker-legacy-cross-role",
    workerFocusMessages: [
      {
        id: sharedId,
        role: "assistant",
        content: "old assistant",
        created_at: new Date()
      },
      {
        id: sharedId,
        role: "tool",
        content: "tool result",
        tool_call_id: "legacy-call",
        created_at: new Date()
      }
    ]
  })
  useAppStore.getState().appendWorkerFocusMessages("worker-legacy-cross-role", [
    {
      id: sharedId,
      role: "assistant",
      content: "updated assistant",
      created_at: new Date()
    }
  ])

  const messages = useAppStore.getState().workerFocusMessages
  assert(messages.length === 2, "worker focus must preserve both legacy cross-role rows")
  assert(
    messages.find((message) => message.role === "assistant")?.content === "updated assistant",
    "worker focus must update the assistant instead of overwriting the tool row"
  )
  assert(
    messages.find((message) => message.role === "tool")?.content === "tool result",
    "worker focus must preserve the legacy tool result"
  )
  resetWorkerFocusStore()
}

function testWorkerFocusDoesNotMergeAssistantGrowthAcrossUserTurns(): void {
  const workerThreadId = "worker-cross-turn-text-growth"
  resetWorkerFocusStore()
  openWorkerFocusViewForTest({
    threadId: "thread-cross-turn-text-growth",
    workerId: "worker-cross-turn-text-growth",
    workerThreadId
  })
  useAppStore.getState().appendWorkerFocusMessages(
    workerThreadId,
    [
      {
        id: "worker-snapshot-0",
        role: "assistant",
        content: "repeat",
        created_at: new Date("2026-07-21T00:00:00.000Z")
      },
      {
        id: "worker-user-2",
        role: "user",
        content: "next turn",
        created_at: new Date("2026-07-21T00:00:01.000Z")
      }
    ],
    { orderedSnapshot: true }
  )
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, [
    {
      id: "worker-live-cross-turn-2",
      role: "assistant",
      content: "repeat expanded",
      created_at: new Date("2026-07-21T00:00:02.000Z")
    }
  ])

  const messages = useAppStore.getState().workerFocusMessages
  assert(messages.length === 3, "worker text replay matching must not cross a user boundary")
  assert(
    messages[0]?.content === "repeat" && messages[2]?.content === "repeat expanded",
    "new-turn assistant growth must append without rewriting the previous turn"
  )

  resetWorkerFocusStore()
  openWorkerFocusViewForTest({
    threadId: "thread-cross-turn-text-growth",
    workerId: "worker-cross-turn-text-growth",
    workerThreadId
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, [
    {
      id: `worker-turn-${workerThreadId}-2::worker-live-current`,
      role: "assistant",
      content: "current complete",
      created_at: new Date("2026-07-21T00:01:04.000Z")
    }
  ])
  useAppStore.getState().appendWorkerFocusMessages(
    workerThreadId,
    [
      {
        id: "worker-user-history-1",
        role: "user",
        content: "first prompt",
        created_at: new Date("2026-07-21T00:01:00.000Z")
      },
      {
        id: "worker-snapshot-history-1",
        role: "assistant",
        content: "old answer",
        created_at: new Date("2026-07-21T00:01:01.000Z")
      },
      {
        id: "worker-user-history-2",
        role: "user",
        content: "second prompt",
        created_at: new Date("2026-07-21T00:01:02.000Z")
      },
      {
        id: "worker-snapshot-current-2",
        role: "assistant",
        content: "current complete",
        created_at: new Date("2026-07-21T00:01:03.000Z")
      }
    ],
    { orderedSnapshot: true }
  )
  const liveThenFullValues = useAppStore.getState().workerFocusMessages
  assert(
    liveThenFullValues.length === 4,
    "a multi-turn values snapshot must merge the current live assistant only into the last turn"
  )
  assert(
    liveThenFullValues.map((message) => message.role).join(">") ===
      "user>assistant>user>assistant",
    "late full values must restore history order without duplicating the current live assistant"
  )
  resetWorkerFocusStore()
}

function testWorkerFullValuesSnapshotsKeepHistoricalIdsStableAcrossTurns(): void {
  const workerThreadId = "worker-full-values-turns"
  const transport = new ElectronIPCTransport()
  resetWorkerFocusStore()
  openWorkerFocusViewForTest({
    threadId: "thread-full-values-turns",
    workerId: "worker-full-values-turns",
    workerThreadId
  })

  const firstSnapshot = transport.convertFocusedCoordinatorWorkerIPCEvent(
    {
      ...(streamValuesEvent([
        humanMessage("question one", { id: "worker-user-one" }),
        aiMessage({ id: "worker-answer-one", content: "answer one" })
      ]) as object),
      workerTurn: 1
    } as never,
    "thread-full-values-turns"
  )
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, firstSnapshot, {
    orderedSnapshot: true
  })

  const secondSnapshot = transport.convertFocusedCoordinatorWorkerIPCEvent(
    {
      ...(streamValuesEvent([
        humanMessage("question one", { id: "worker-user-one" }),
        aiMessage({ id: "worker-answer-one", content: "answer one" }),
        humanMessage("question two", { id: "worker-user-two" }),
        aiMessage({
          id: "worker-answer-two",
          content: "answer two",
          toolCalls: [{ id: "worker-call-two", name: "read_file", args: {} }]
        }),
        toolMessage({
          id: "worker-tool-two",
          name: "read_file",
          toolCallId: "worker-call-two",
          content: "tool answer two"
        })
      ]) as object),
      workerTurn: 2
    } as never,
    "thread-full-values-turns"
  )
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, secondSnapshot, {
    orderedSnapshot: true
  })

  const messages = useAppStore.getState().workerFocusMessages
  assert(messages.length === 5, "later full values must not duplicate earlier worker turns")
  const firstSnapshotIds = firstSnapshot.map((message) => message.id).join("|")
  assert(
    secondSnapshot.slice(0, 2).map((message) => message.id).join("|") === firstSnapshotIds,
    "historical provider ids in full values snapshots must keep their original turn prefixes"
  )
  assert(
    messages[2]?.id === `worker-turn-${workerThreadId}-2::worker-user-two` &&
      messages[3]?.id === `worker-turn-${workerThreadId}-2::worker-answer-two` &&
      messages[4]?.id === `worker-turn-${workerThreadId}-2::worker-tool-two`,
    "new values messages must use the same turn-scoped ids as live provider messages"
  )

  const liveAssistant = transport.convertFocusedCoordinatorWorkerIPCEvent(
    {
      ...(streamMessageEvent(
        aiMessage({
          id: "worker-answer-two",
          content: "answer two expanded",
          toolCalls: [{ id: "worker-call-two", name: "read_file", args: {} }]
        }),
        {}
      ) as object),
      workerTurn: 2
    } as never,
    "thread-full-values-turns"
  )
  const liveTool = transport.convertFocusedCoordinatorWorkerIPCEvent(
    {
      ...(streamMessageEvent(
        toolMessage({
          id: "worker-tool-two",
          name: "read_file",
          toolCallId: "worker-call-two",
          content: "tool answer two expanded"
        }),
        {}
      ) as object),
      workerTurn: 2
    } as never,
    "thread-full-values-turns"
  )
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, [
    ...liveAssistant,
    ...liveTool
  ])
  const valuesThenLive = useAppStore.getState().workerFocusMessages
  assert(valuesThenLive.length === 5, "provider-id live updates must reuse their values rows")
  assert(
    valuesThenLive[3]?.content === "answer two expanded" &&
      valuesThenLive[4]?.content === "tool answer two expanded",
    "assistant and tool provider-id live updates must merge into the current values turn"
  )

  const reverseTransport = new ElectronIPCTransport()
  resetWorkerFocusStore()
  openWorkerFocusViewForTest({
    threadId: "thread-full-values-turns",
    workerId: "worker-full-values-turns",
    workerThreadId
  })
  const reverseLiveAssistant = reverseTransport.convertFocusedCoordinatorWorkerIPCEvent(
    {
      ...(streamMessageEvent(
        aiMessage({
          id: "worker-answer-two",
          content: "answer two expanded",
          toolCalls: [{ id: "worker-call-two", name: "read_file", args: {} }]
        }),
        {}
      ) as object),
      workerTurn: 2
    } as never,
    "thread-full-values-turns"
  )
  const reverseLiveTool = reverseTransport.convertFocusedCoordinatorWorkerIPCEvent(
    {
      ...(streamMessageEvent(
        toolMessage({
          id: "worker-tool-two",
          name: "read_file",
          toolCallId: "worker-call-two",
          content: "tool answer two expanded"
        }),
        {}
      ) as object),
      workerTurn: 2
    } as never,
    "thread-full-values-turns"
  )
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, [
    ...reverseLiveAssistant,
    ...reverseLiveTool
  ])
  const reverseValues = reverseTransport.convertFocusedCoordinatorWorkerIPCEvent(
    {
      ...(streamValuesEvent([
        humanMessage("question one", { id: "worker-user-one" }),
        aiMessage({ id: "worker-answer-one", content: "answer one" }),
        humanMessage("question two", { id: "worker-user-two" }),
        aiMessage({
          id: "worker-answer-two",
          content: "answer two",
          toolCalls: [{ id: "worker-call-two", name: "read_file", args: {} }]
        }),
        toolMessage({
          id: "worker-tool-two",
          name: "read_file",
          toolCallId: "worker-call-two",
          content: "tool answer two"
        })
      ]) as object),
      workerTurn: 2
    } as never,
    "thread-full-values-turns"
  )
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, reverseValues, {
    orderedSnapshot: true
  })
  const liveThenValues = useAppStore.getState().workerFocusMessages
  assert(liveThenValues.length === 5, "provider-id values must reuse prior live rows")
  assert(
    liveThenValues[3]?.content === "answer two expanded" &&
      liveThenValues[4]?.content === "tool answer two expanded",
    "assistant and tool provider-id values must preserve fuller prior live content"
  )

  const idlessTransport = new ElectronIPCTransport()
  resetWorkerFocusStore()
  openWorkerFocusViewForTest({
    threadId: "thread-full-values-turns",
    workerId: "worker-full-values-turns",
    workerThreadId
  })
  const idlessLiveAssistant = idlessTransport.convertFocusedCoordinatorWorkerIPCEvent(
    {
      ...(streamMessageEvent(
        aiMessage({
          content: "idless current answer",
          toolCalls: [{ id: "idless-current-call", name: "read_file", args: {} }]
        }),
        {}
      ) as object),
      workerTurn: 3
    } as never,
    "thread-full-values-turns"
  )
  const idlessLiveTool = idlessTransport.convertFocusedCoordinatorWorkerIPCEvent(
    {
      ...(streamMessageEvent(
        toolMessage({
          name: "read_file",
          toolCallId: "idless-current-call",
          content: "idless current tool result"
        }),
        {}
      ) as object),
      workerTurn: 3
    } as never,
    "thread-full-values-turns"
  )
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, [
    ...idlessLiveAssistant,
    ...idlessLiveTool
  ])
  const idlessValues = idlessTransport.convertFocusedCoordinatorWorkerIPCEvent(
    {
      ...(streamValuesEvent([
        aiMessage({
          content: "idless current answer",
          toolCalls: [{ id: "idless-current-call", name: "read_file", args: {} }]
        }),
        toolMessage({
          name: "read_file",
          toolCallId: "idless-current-call",
          content: "idless current tool result"
        })
      ]) as object),
      workerTurn: 3
    } as never,
    "thread-full-values-turns"
  )
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, idlessValues, {
    orderedSnapshot: true
  })
  const idlessLiveThenValues = useAppStore.getState().workerFocusMessages
  assert(
    idlessLiveThenValues.length === 2 &&
      idlessLiveThenValues.map((message) => message.role).join(">") === "assistant>tool",
    "idless values slices without a user must reuse current-turn live assistant and tool rows"
  )

  resetWorkerFocusStore()
  openWorkerFocusViewForTest({
    threadId: "thread-full-values-turns",
    workerId: "worker-full-values-turns",
    workerThreadId
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, [
    {
      id: "history-user-provider",
      role: "user",
      content: "history prompt",
      created_at: new Date()
    },
    {
      id: "history-assistant-provider",
      role: "assistant",
      content: "history answer",
      created_at: new Date()
    },
    {
      id: "history-tool-provider",
      role: "tool",
      tool_call_id: "history-call",
      content: "history tool result",
      created_at: new Date()
    }
  ])
  const scopedHistoryReplay = new ElectronIPCTransport().convertFocusedCoordinatorWorkerIPCEvent(
    {
      ...(streamValuesEvent([
        humanMessage("history prompt", { id: "history-user-provider" }),
        aiMessage({ id: "history-assistant-provider", content: "history answer" }),
        toolMessage({
          id: "history-tool-provider",
          name: "read_file",
          toolCallId: "history-call",
          content: "history tool result"
        })
      ]) as object),
      workerTurn: 1
    } as never,
    "thread-full-values-turns"
  )
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, scopedHistoryReplay, {
    orderedSnapshot: true
  })
  assert(
    useAppStore.getState().workerFocusMessages.length === 3,
    "turn-scoped provider replay must reuse unscoped checkpoint history rows"
  )

  resetWorkerFocusStore()
  openWorkerFocusViewForTest({
    threadId: "thread-full-values-turns",
    workerId: "worker-full-values-turns",
    workerThreadId
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, [
    {
      id: "worker-snapshot-0",
      role: "user",
      content: "fallback history prompt",
      created_at: new Date()
    },
    {
      id: "worker-snapshot-1",
      role: "assistant",
      content: "fallback history answer",
      created_at: new Date()
    },
    {
      id: "worker-snapshot-2",
      role: "tool",
      tool_call_id: "fallback-history-call",
      content: "fallback history tool result",
      created_at: new Date()
    }
  ])
  const scopedFallbackReplay = new ElectronIPCTransport().convertFocusedCoordinatorWorkerIPCEvent(
    {
      ...(streamValuesEvent([
        {
          id: ["langchain_core", "messages", "HumanMessage"],
          kwargs: { content: "fallback history prompt" }
        },
        aiMessage({ content: "fallback history answer" }),
        toolMessage({
          name: "read_file",
          toolCallId: "fallback-history-call",
          content: "fallback history tool result"
        })
      ]) as object),
      workerTurn: 1
    } as never,
    "thread-full-values-turns"
  )
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, scopedFallbackReplay, {
    orderedSnapshot: true
  })
  assert(
    useAppStore.getState().workerFocusMessages.length === 3,
    "turn-scoped fallback replay must reuse unscoped checkpoint history rows"
  )

  resetWorkerFocusStore()
  openWorkerFocusViewForTest({
    threadId: "thread-full-values-turns",
    workerId: "worker-full-values-turns",
    workerThreadId
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, [
    { id: "truncated-user-9", role: "user", content: "turn nine", created_at: new Date() },
    {
      id: "truncated-answer-9",
      role: "assistant",
      content: "answer nine",
      created_at: new Date()
    },
    { id: "truncated-user-10", role: "user", content: "turn ten", created_at: new Date() },
    {
      id: "truncated-answer-10",
      role: "assistant",
      content: "answer ten",
      created_at: new Date()
    }
  ])
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, [
    {
      id: `worker-turn-${workerThreadId}-10::truncated-answer-10`,
      role: "assistant",
      content: "answer ten expanded",
      created_at: new Date()
    }
  ])
  const truncatedHistoryReplay = useAppStore.getState().workerFocusMessages
  assert(
    truncatedHistoryReplay.length === 5 &&
      truncatedHistoryReplay[3]?.content === "answer ten" &&
      truncatedHistoryReplay.at(-1)?.content === "answer ten expanded",
    "an unscoped truncated window must not guess that a scoped replay belongs to its last turn"
  )

  resetWorkerFocusStore()
  openWorkerFocusViewForTest({
    threadId: "thread-full-values-turns",
    workerId: "worker-full-values-turns",
    workerThreadId
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, [
    { id: "reuse-user-9", role: "user", content: "turn nine", created_at: new Date() },
    { id: "reused-worker-id", role: "assistant", content: "old answer", created_at: new Date() },
    { id: "reuse-user-10", role: "user", content: "turn ten", created_at: new Date() }
  ])
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, [
    {
      id: `worker-turn-${workerThreadId}-10::reused-worker-id`,
      role: "assistant",
      content: "new answer",
      created_at: new Date()
    }
  ])
  const reusedTruncatedHistory = useAppStore.getState().workerFocusMessages
  assert(
    reusedTruncatedHistory.length === 4 &&
      reusedTruncatedHistory[1]?.content === "old answer" &&
      reusedTruncatedHistory[3]?.content === "new answer",
    "a scoped new-turn reuse must not overwrite an older raw history occurrence"
  )

  const oversizedCheckpoint = [
    humanMessage("oversized turn prompt", { id: "oversized-turn-user" }),
    ...Array.from({ length: 500 }, (_, index) =>
      aiMessage({
        id: index === 499 ? "oversized-current-answer" : `oversized-answer-${index}`,
        content: index === 499 ? "oversized current answer" : `oversized answer ${index}`
      })
    )
  ]
  const oversizedHistory = buildWorkerCheckpointHistory(oversizedCheckpoint, workerThreadId)
  assert(
    oversizedHistory.truncatedCount === 1 &&
      oversizedHistory.messages.length === 500 &&
      oversizedHistory.messages.every((message) =>
        message.id.startsWith(`worker-turn-${workerThreadId}-1::`)
      ),
    "checkpoint history must retain the absolute worker turn when its user row is clipped"
  )
  resetWorkerFocusStore()
  openWorkerFocusViewForTest({
    threadId: "thread-full-values-turns",
    workerId: "worker-full-values-turns",
    workerThreadId
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, oversizedHistory.messages, {
    orderedSnapshot: true
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, [
    {
      id: `worker-turn-${workerThreadId}-1::oversized-current-answer`,
      role: "assistant",
      content: "oversized current answer expanded",
      created_at: new Date()
    }
  ])
  const oversizedHistoryReplay = useAppStore.getState().workerFocusMessages
  assert(
    oversizedHistoryReplay.length === 500 &&
      oversizedHistoryReplay.at(-1)?.content === "oversized current answer expanded",
    "a scoped replay must reuse clipped same-turn checkpoint history without duplication"
  )

  const repeatedOccurrenceTransport = new ElectronIPCTransport()
  resetWorkerFocusStore()
  openWorkerFocusViewForTest({
    threadId: "thread-full-values-turns",
    workerId: "worker-full-values-turns",
    workerThreadId
  })
  for (const message of [
    aiMessage({
      id: "same-turn-shared",
      content: "first occurrence",
      toolCalls: [{ id: "same-turn-call", name: "read_file", args: {} }]
    }),
    toolMessage({
      id: "same-turn-tool",
      name: "read_file",
      toolCallId: "same-turn-call",
      content: "tool boundary"
    }),
    aiMessage({ id: "same-turn-shared", content: "second occurrence" })
  ]) {
    const converted = repeatedOccurrenceTransport.convertFocusedCoordinatorWorkerIPCEvent(
      {
        ...(streamMessageEvent(message, {}) as object),
        workerTurn: 1
      } as never,
      "thread-full-values-turns"
    )
    useAppStore.getState().appendWorkerFocusMessages(workerThreadId, converted)
  }
  const liveOccurrenceAssistants = useAppStore
    .getState()
    .workerFocusMessages.filter((message) => message.role === "assistant")
  assert(
    liveOccurrenceAssistants.length === 2 &&
      liveOccurrenceAssistants[0]?.content === "first occurrence" &&
      liveOccurrenceAssistants[0]?.tool_calls?.length === 1 &&
      liveOccurrenceAssistants[1]?.content === "second occurrence" &&
      !liveOccurrenceAssistants[1]?.tool_calls?.length,
    "messages-only live updates must preserve assistant occurrences across a tool boundary"
  )

  const repeatedChunkTransport = new ElectronIPCTransport()
  const firstChunk = repeatedChunkTransport.convertFocusedCoordinatorWorkerIPCEvent(
    {
      ...(streamMessageEvent(
        aiMessageChunk({
          id: "repeated-chunk-message",
          toolCallChunks: [
            {
              id: "repeated-chunk-call",
              name: "read_file",
              args: '{"file_path":"one"}'
            }
          ]
        }),
        {}
      ) as object),
      workerTurn: 1
    } as never,
    "thread-full-values-turns"
  )
  repeatedChunkTransport.convertFocusedCoordinatorWorkerIPCEvent(
    {
      ...(streamMessageEvent(
        toolMessage({
          id: "repeated-chunk-tool",
          name: "read_file",
          toolCallId: "repeated-chunk-call",
          content: "first chunk boundary"
        }),
        {}
      ) as object),
      workerTurn: 1
    } as never,
    "thread-full-values-turns"
  )
  const secondChunk = repeatedChunkTransport.convertFocusedCoordinatorWorkerIPCEvent(
    {
      ...(streamMessageEvent(
        aiMessageChunk({
          id: "repeated-chunk-message",
          toolCallChunks: [
            {
              id: "repeated-chunk-call",
              name: "read_file",
              args: '{"file_path":"two"}'
            }
          ]
        }),
        {}
      ) as object),
      workerTurn: 1
    } as never,
    "thread-full-values-turns"
  )
  const firstChunkCall = firstChunk[0]?.tool_calls?.[0]
  const secondChunkCall = secondChunk[0]?.tool_calls?.[0]
  assert(
    firstChunkCall?.args?.file_path === "one" && secondChunkCall?.args?.file_path === "two",
    "reused tool-call ids must not inherit args from an earlier assistant occurrence"
  )
  const occurrenceValues = repeatedOccurrenceTransport.convertFocusedCoordinatorWorkerIPCEvent(
    {
      ...(streamValuesEvent([
        humanMessage("same turn prompt", { id: "same-turn-user" }),
        aiMessage({
          id: "same-turn-shared",
          content: "first occurrence",
          toolCalls: [{ id: "same-turn-call", name: "read_file", args: {} }]
        }),
        toolMessage({
          id: "same-turn-tool",
          name: "read_file",
          toolCallId: "same-turn-call",
          content: "tool boundary"
        }),
        aiMessage({ id: "same-turn-shared", content: "second occurrence" })
      ]) as object),
      workerTurn: 1
    } as never,
    "thread-full-values-turns"
  )
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, occurrenceValues, {
    orderedSnapshot: true
  })
  const repeatedOccurrenceMessages = useAppStore.getState().workerFocusMessages
  const repeatedOccurrenceAssistants = repeatedOccurrenceMessages.filter(
    (message) => message.role === "assistant"
  )
  assert(
    repeatedOccurrenceAssistants.length === 2 &&
      repeatedOccurrenceAssistants[0]?.content === "first occurrence" &&
      repeatedOccurrenceAssistants[0]?.tool_calls?.length === 1 &&
      repeatedOccurrenceAssistants[1]?.content === "second occurrence" &&
      !repeatedOccurrenceAssistants[1]?.tool_calls?.length,
    "a complete values snapshot must restore repeated same-turn provider occurrences"
  )

  resetWorkerFocusStore()
  openWorkerFocusViewForTest({
    threadId: "thread-full-values-turns",
    workerId: "worker-full-values-turns",
    workerThreadId
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, [
    {
      id: `worker-turn-${workerThreadId}-1::split-shared`,
      role: "assistant",
      content: "second occurrence",
      tool_calls: [{ id: "split-call", name: "read_file", args: {} }],
      created_at: new Date()
    }
  ])
  const splitValues = new ElectronIPCTransport().convertFocusedCoordinatorWorkerIPCEvent(
    {
      ...(streamValuesEvent([
        humanMessage("split prompt", { id: "split-user" }),
        aiMessage({ id: "split-shared", content: "first occurrence" }),
        toolMessage({
          id: "split-tool",
          name: "read_file",
          toolCallId: "split-call",
          content: "split boundary"
        }),
        aiMessage({
          id: "split-shared",
          content: "second occurrence",
          toolCalls: [{ id: "split-call", name: "read_file", args: {} }]
        })
      ]) as object),
      workerTurn: 1
    } as never,
    "thread-full-values-turns"
  )
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, splitValues, {
    orderedSnapshot: true
  })
  const splitAssistants = useAppStore
    .getState()
    .workerFocusMessages.filter((message) => message.role === "assistant")
  assert(
    splitAssistants.length === 2 &&
      !splitAssistants[0]?.tool_calls?.length &&
      splitAssistants[1]?.tool_calls?.length === 1,
    "an authoritative occurrence snapshot must not leak tool calls into another occurrence"
  )

  const valuesBeforeLiveTransport = new ElectronIPCTransport()
  resetWorkerFocusStore()
  openWorkerFocusViewForTest({
    threadId: "thread-full-values-turns",
    workerId: "worker-full-values-turns",
    workerThreadId
  })
  const valuesBeforeLive = valuesBeforeLiveTransport.convertFocusedCoordinatorWorkerIPCEvent(
    {
      ...(streamValuesEvent([
        humanMessage("values before live", { id: "values-before-live-user" }),
        aiMessage({
          id: "values-before-live-shared",
          content: "first values occurrence",
          toolCalls: [{ id: "values-before-live-call", name: "read_file", args: {} }]
        }),
        toolMessage({
          id: "values-before-live-tool",
          name: "read_file",
          toolCallId: "values-before-live-call",
          content: "values tool boundary"
        })
      ]) as object),
      workerTurn: 1
    } as never,
    "thread-full-values-turns"
  )
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, valuesBeforeLive, {
    orderedSnapshot: true
  })
  const liveAfterValues = valuesBeforeLiveTransport.convertFocusedCoordinatorWorkerIPCEvent(
    {
      ...(streamMessageEvent(
        aiMessage({ id: "values-before-live-shared", content: "second live occurrence" }),
        {}
      ) as object),
      workerTurn: 1
    } as never,
    "thread-full-values-turns"
  )
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, liveAfterValues)
  const valuesBeforeLiveAssistants = useAppStore
    .getState()
    .workerFocusMessages.filter((message) => message.role === "assistant")
  assert(
    valuesBeforeLiveAssistants.length === 2 &&
      valuesBeforeLiveAssistants[0]?.content === "first values occurrence" &&
      valuesBeforeLiveAssistants[1]?.content === "second live occurrence",
    "a tool-ending values snapshot must seed occurrence identity for the next live assistant"
  )
  resetWorkerFocusStore()
}

function testWorkerOccurrenceReplayStateRegressions(): void {
  const parentThreadId = "thread-worker-replay-regressions"
  const workerThreadId = "worker-replay-regressions"
  const openFocus = (): void => {
    resetWorkerFocusStore()
    openWorkerFocusViewForTest({
      threadId: parentThreadId,
      workerId: "worker-replay-regressions",
      workerThreadId
    })
  }
  const convert = (transport: ElectronIPCTransport, event: unknown): ReturnType<
    ElectronIPCTransport["convertFocusedCoordinatorWorkerIPCEvent"]
  > => transport.convertFocusedCoordinatorWorkerIPCEvent(event as never, parentThreadId)

  openFocus()
  const multiReplayTransport = new ElectronIPCTransport()
  const multiValues = convert(multiReplayTransport, {
    ...(streamValuesEvent([
      humanMessage("multi replay", { id: "multi-replay-user" }),
      aiMessage({
        id: "multi-replay-shared",
        content: "first replay candidate",
        toolCalls: [{ id: "multi-replay-call-1", name: "read_file", args: { path: "one" } }]
      }),
      toolMessage({
        id: "multi-replay-tool-1",
        name: "read_file",
        toolCallId: "multi-replay-call-1",
        content: "one"
      }),
      aiMessage({
        id: "multi-replay-shared",
        content: "second replay candidate",
        toolCalls: [{ id: "multi-replay-call-2", name: "read_file", args: { path: "two" } }]
      }),
      toolMessage({
        id: "multi-replay-tool-2",
        name: "read_file",
        toolCallId: "multi-replay-call-2",
        content: "two"
      })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, multiValues, {
    orderedSnapshot: true
  })
  const delayedFirstReplay = convert(multiReplayTransport, {
    ...(streamMessageEvent(
      aiMessage({
        id: "multi-replay-shared",
        content: "first replay candidate expanded",
        toolCalls: [{ id: "multi-replay-call-1", name: "read_file", args: { path: "one" } }]
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, delayedFirstReplay)
  assert(
    delayedFirstReplay.length === 0,
    "a post-tool exact replay must wait for the following tool evidence"
  )
  const committedFirstReplay = convert(multiReplayTransport, {
    ...(streamMessageEvent(
      toolMessage({
        id: "multi-replay-tool-1",
        name: "read_file",
        toolCallId: "multi-replay-call-1",
        content: "one"
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, committedFirstReplay)
  const multiReplayAssistants = useAppStore
    .getState()
    .workerFocusMessages.filter((message) => message.role === "assistant")
  assert(
    multiReplayAssistants.length === 2 &&
      multiReplayAssistants[0]?.content === "first replay candidate expanded" &&
      multiReplayAssistants[1]?.content === "second replay candidate",
    "a uniquely matching delayed replay must update its earlier provider occurrence"
  )
  const partialDelayedReplay = convert(multiReplayTransport, {
    ...(streamMessageEvent(
      {
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: {
          id: "multi-replay-shared",
          content: "",
          tool_call_chunks: [
            {
              id: "multi-replay-call-2",
              name: "read_file",
              args: '{"path":"t',
              index: 0
            }
          ]
        }
      },
      {}
    ) as object),
    workerTurn: 1
  })
  assert(
    partialDelayedReplay.length === 0,
    "an unresolved replay fragment must wait for enough identity evidence"
  )
  const completedDelayedReplay = convert(multiReplayTransport, {
    ...(streamMessageEvent(
      {
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: {
          id: "multi-replay-shared",
          content: "",
          tool_call_chunks: [{ args: 'wo"}', index: 0 }]
        }
      },
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, completedDelayedReplay)
  assert(
    useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant").length === 2,
    "a completed fragmented replay must rebind to its uniquely matching old occurrence"
  )
  const newAfterReplayPin = convert(multiReplayTransport, {
    ...(streamMessageEvent(
      aiMessage({ id: "multi-replay-shared", content: "brand new answer" }),
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, newAfterReplayPin)
  const afterReplayPinAssistants = useAppStore
    .getState()
    .workerFocusMessages.filter((message) => message.role === "assistant")
  assert(
    afterReplayPinAssistants.length === 3 &&
      afterReplayPinAssistants.at(-1)?.content === "brand new answer",
    "an incompatible message after a replay pin must start a new occurrence"
  )

  openFocus()
  const prefixTransport = new ElectronIPCTransport()
  const prefixValues = convert(prefixTransport, {
    ...(streamValuesEvent([
      humanMessage("prefix replay", { id: "prefix-user" }),
      aiMessage({ id: "prefix-answer", content: "complete long answer" })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, prefixValues, {
    orderedSnapshot: true
  })
  const shortPrefixReplay = convert(prefixTransport, {
    ...(streamMessageEvent(
      {
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: { id: "prefix-answer", content: "complete " }
      },
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, shortPrefixReplay)
  assert(
    useAppStore.getState().workerFocusMessages.at(-1)?.content === "complete long answer",
    "a shorter cumulative prefix chunk must not truncate or append to a complete values answer"
  )

  openFocus()
  const dualEmissionTransport = new ElectronIPCTransport()
  for (const message of [
    aiMessage({
      id: "dual-emission-shared",
      content: "first",
      toolCalls: [{ id: "dual-emission-call-1", name: "read_file", args: {} }]
    }),
    toolMessage({
      id: "dual-emission-tool-1",
      name: "read_file",
      toolCallId: "dual-emission-call-1",
      content: "boundary"
    })
  ]) {
    useAppStore.getState().appendWorkerFocusMessages(
      workerThreadId,
      convert(dualEmissionTransport, {
        ...(streamMessageEvent(message, {}) as object),
        workerTurn: 1
      })
    )
  }
  const dualEmission = convert(dualEmissionTransport, {
    ...(streamMessageEvent(
      {
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: {
          id: "dual-emission-shared",
          content: "second",
          tool_call_chunks: [
            {
              id: "dual-emission-call-2",
              name: "read_file",
              args: '{"path":"two"}',
              index: 0
            }
          ]
        }
      },
      {}
    ) as object),
    workerTurn: 1
  })
  assert(
    dualEmission.length === 2 && dualEmission[0]?.id === dualEmission[1]?.id,
    "one chunk with text and completed tool args should emit two updates for one occurrence"
  )
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, dualEmission)
  const dualEmissionAssistants = useAppStore
    .getState()
    .workerFocusMessages.filter((message) => message.role === "assistant")
  assert(
    dualEmissionAssistants.length === 2 &&
      dualEmissionAssistants[1]?.content === "second" &&
      dualEmissionAssistants[1]?.tool_calls?.[0]?.args?.path === "two",
    "same-batch updates for one internal occurrence id must merge instead of creating occurrence 3"
  )

  openFocus()
  const valuesToolResetTransport = new ElectronIPCTransport()
  convert(valuesToolResetTransport, {
    ...(streamMessageEvent(
      aiMessageChunk({
        id: "values-reset-shared",
        toolCallChunks: [
          {
            id: "values-reset-call",
            name: "read_file",
            args: '{"file_path":"one"}'
          }
        ]
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  const resetValues = convert(valuesToolResetTransport, {
    ...(streamValuesEvent([
      humanMessage("reset values", { id: "values-reset-user" }),
      aiMessage({
        id: "values-reset-shared",
        toolCalls: [{ id: "values-reset-call", name: "read_file", args: {} }]
      }),
      toolMessage({
        id: "values-reset-tool",
        name: "read_file",
        toolCallId: "values-reset-call",
        content: "boundary"
      }),
      aiMessage({
        id: "values-reset-shared",
        toolCalls: [{ id: "values-reset-call", name: "read_file", args: {} }]
      }),
      toolMessage({
        id: "values-reset-tool-2",
        name: "read_file",
        toolCallId: "values-reset-call",
        content: "second boundary"
      })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, resetValues, {
    orderedSnapshot: true
  })
  const resetValueAssistants = resetValues.filter((message) => message.role === "assistant")
  assert(
    resetValueAssistants.length === 2 &&
      resetValueAssistants.every(
        (message) => message.tool_calls?.[0]?.args?.file_path === undefined
      ),
    "values conversion must not inject one occurrence accumulator into another occurrence"
  )
  const partialResetChunk = convert(valuesToolResetTransport, {
    ...(streamMessageEvent(
      {
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: {
          id: "values-reset-shared",
          content: "",
          tool_calls: [{ id: "values-reset-call", name: "read_file", args: {} }],
          tool_call_chunks: [
            {
              id: "values-reset-call",
              name: "read_file",
              args: '{"file_path":"t',
              index: 0
            }
          ]
        }
      },
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, partialResetChunk)
  const afterResetChunk = convert(valuesToolResetTransport, {
    ...(streamMessageEvent(
      {
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: {
          id: "values-reset-shared",
          content: "",
          tool_call_chunks: [{ args: 'wo"}', index: 0 }]
        }
      },
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, afterResetChunk)
  const afterResetAssistants = useAppStore
    .getState()
    .workerFocusMessages.filter((message) => message.role === "assistant")
  assert(
    afterResetChunk.at(-1)?.tool_calls?.[0]?.args?.file_path === "two" &&
      afterResetAssistants.length === 3 &&
      afterResetAssistants.at(-1)?.tool_calls?.[0]?.args?.file_path === "two",
    "partial evidence after a tool boundary must start a fresh occurrence with fresh args"
  )

  openFocus()
  const sparseValuesReplayTransport = new ElectronIPCTransport()
  const sparseLive = convert(sparseValuesReplayTransport, {
    ...(streamMessageEvent(
      {
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: {
          id: "sparse-values-shared",
          content: "sparse answer",
          tool_call_chunks: [
            {
              id: "sparse-values-call",
              name: "read_file",
              args: '{"file_path":"one"}',
              index: 0
            }
          ]
        }
      },
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, sparseLive)
  const sparseValues = convert(sparseValuesReplayTransport, {
    ...(streamValuesEvent([
      humanMessage("sparse values", { id: "sparse-values-user" }),
      aiMessage({
        id: "sparse-values-shared",
        content: "sparse answer",
        toolCalls: [{ id: "sparse-values-call", name: "read_file", args: {} }]
      })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, sparseValues, {
    orderedSnapshot: true
  })
  useAppStore.getState().appendWorkerFocusMessages(
    workerThreadId,
    convert(sparseValuesReplayTransport, {
      ...(streamMessageEvent(
        toolMessage({
          id: "sparse-values-tool",
          name: "read_file",
          toolCallId: "sparse-values-call",
          content: "done"
        }),
        {}
      ) as object),
      workerTurn: 1
    })
  )
  const sparseDelayedReplay = convert(sparseValuesReplayTransport, {
    ...(streamMessageEvent(
      aiMessage({
        id: "sparse-values-shared",
        content: "sparse answer",
        toolCalls: [
          { id: "sparse-values-call", name: "read_file", args: { file_path: "one" } }
        ]
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, sparseDelayedReplay)
  const sparseReplayTool = convert(sparseValuesReplayTransport, {
    ...(streamMessageEvent(
      toolMessage({
        id: "sparse-values-tool",
        name: "read_file",
        toolCallId: "sparse-values-call",
        content: "done"
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, sparseReplayTool)
  assert(
    sparseDelayedReplay.length === 0 &&
      sparseReplayTool[0]?.id === `worker-turn-${workerThreadId}-1::sparse-values-shared` &&
      useAppStore
        .getState()
        .workerFocusMessages.filter((message) => message.role === "assistant").length === 1,
    "a sparse values refresh must retain the active occurrence args for delayed replay matching"
  )

  openFocus()
  const midOccurrenceTransport = new ElectronIPCTransport()
  const joinedLive = convert(midOccurrenceTransport, {
    ...(streamMessageEvent(
      aiMessage({
        id: "joined-shared",
        content: "second joined occurrence",
        toolCalls: [{ id: "joined-call", name: "read_file", args: { path: "two" } }]
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, joinedLive)
  const joinedValues = convert(midOccurrenceTransport, {
    ...(streamValuesEvent([
      humanMessage("joined midway", { id: "joined-user" }),
      aiMessage({
        id: "joined-shared",
        content: "first joined occurrence",
        toolCalls: [{ id: "joined-call", name: "read_file", args: {} }]
      }),
      toolMessage({
        id: "joined-tool",
        name: "read_file",
        toolCallId: "joined-call",
        content: "boundary"
      }),
      aiMessage({
        id: "joined-shared",
        content: "second joined occurrence",
        toolCalls: [{ id: "joined-call", name: "read_file", args: { path: "two" } }]
      })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, joinedValues, {
    orderedSnapshot: true
  })
  const joinedAssistants = useAppStore
    .getState()
    .workerFocusMessages.filter((message) => message.role === "assistant")
  assert(
    joinedAssistants.length === 2 &&
      joinedAssistants[0]?.tool_calls?.[0]?.args?.path === undefined &&
      joinedAssistants[1]?.tool_calls?.[0]?.args?.path === "two",
    "a complete repeated-occurrence snapshot must align a preexisting live row by content"
  )

  openFocus()
  const grownOccurrenceTransport = new ElectronIPCTransport()
  useAppStore.getState().appendWorkerFocusMessages(
    workerThreadId,
    convert(grownOccurrenceTransport, {
      ...(streamMessageEvent(
        aiMessage({
          id: "grown-shared",
          content: "second expanded",
          toolCalls: [{ id: "grown-call", name: "read_file", args: { path: "two" } }]
        }),
        {}
      ) as object),
      workerTurn: 1
    })
  )
  const grownValues = convert(grownOccurrenceTransport, {
    ...(streamValuesEvent([
      humanMessage("grown midway", { id: "grown-user" }),
      aiMessage({
        id: "grown-shared",
        content: "first",
        toolCalls: [{ id: "grown-call", name: "read_file", args: {} }]
      }),
      toolMessage({
        id: "grown-tool",
        name: "read_file",
        toolCallId: "grown-call",
        content: "boundary"
      }),
      aiMessage({
        id: "grown-shared",
        content: "second",
        toolCalls: [{ id: "grown-call", name: "read_file", args: {} }]
      })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, grownValues, {
    orderedSnapshot: true
  })
  const grownAssistants = useAppStore
    .getState()
    .workerFocusMessages.filter((message) => message.role === "assistant")
  assert(
    grownAssistants.length === 2 &&
      grownAssistants[0]?.content === "first" &&
      grownAssistants[0]?.tool_calls?.[0]?.args?.path === undefined &&
      grownAssistants[1]?.content === "second expanded" &&
      grownAssistants[1]?.tool_calls?.[0]?.args?.path === "two",
    "a lagging repeated-occurrence snapshot must preserve uniquely matched live growth"
  )

  openFocus()
  const omittedCallsTransport = new ElectronIPCTransport()
  useAppStore.getState().appendWorkerFocusMessages(
    workerThreadId,
    convert(omittedCallsTransport, {
      ...(streamMessageEvent(
        aiMessage({
          id: "omitted-calls-shared",
          content: "second expanded",
          toolCalls: [
            { id: "omitted-calls-two", name: "read_file", args: { path: "two" } }
          ]
        }),
        {}
      ) as object),
      workerTurn: 1
    })
  )
  const omittedCallsValues = convert(omittedCallsTransport, {
    ...(streamValuesEvent([
      humanMessage("omitted calls midway", { id: "omitted-calls-user" }),
      aiMessage({
        id: "omitted-calls-shared",
        content: "first",
        toolCalls: [
          { id: "omitted-calls-one", name: "read_file", args: { path: "one" } }
        ]
      }),
      toolMessage({
        id: "omitted-calls-tool",
        name: "read_file",
        toolCallId: "omitted-calls-one",
        content: "boundary"
      }),
      aiMessage({ id: "omitted-calls-shared", content: "second" })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, omittedCallsValues, {
    orderedSnapshot: true
  })
  const omittedCallsAssistants = useAppStore
    .getState()
    .workerFocusMessages.filter((message) => message.role === "assistant")
  assert(
    omittedCallsAssistants.length === 2 &&
      omittedCallsAssistants[0]?.content === "first" &&
      omittedCallsAssistants[1]?.content === "second expanded" &&
      omittedCallsAssistants[1]?.tool_calls?.[0]?.id === "omitted-calls-two" &&
      omittedCallsAssistants[1]?.tool_calls?.[0]?.args?.path === "two",
    "a repeated-occurrence snapshot with omitted calls must preserve its uniquely matched live growth"
  )

  openFocus()
  const grownFinalTransport = new ElectronIPCTransport()
  useAppStore.getState().appendWorkerFocusMessages(
    workerThreadId,
    convert(grownFinalTransport, {
      ...(streamMessageEvent(
        aiMessage({ id: "grown-final-shared", content: "second final expanded" }),
        {}
      ) as object),
      workerTurn: 1
    })
  )
  const grownFinalValues = convert(grownFinalTransport, {
    ...(streamValuesEvent([
      humanMessage("grown final", { id: "grown-final-user" }),
      aiMessage({
        id: "grown-final-shared",
        content: "first final",
        toolCalls: [{ id: "grown-final-call", name: "read_file", args: {} }]
      }),
      toolMessage({
        id: "grown-final-tool",
        name: "read_file",
        toolCallId: "grown-final-call",
        content: "boundary"
      }),
      aiMessage({ id: "grown-final-shared", content: "second final" })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, grownFinalValues, {
    orderedSnapshot: true
  })
  const grownFinalAssistants = useAppStore
    .getState()
    .workerFocusMessages.filter((message) => message.role === "assistant")
  assert(
    grownFinalAssistants.length === 2 &&
      grownFinalAssistants[0]?.content === "first final" &&
      grownFinalAssistants[1]?.content === "second final expanded",
    "a no-tool final answer must reserve its compatible grown live occurrence"
  )

  openFocus()
  const exactOccurrenceOneId = `worker-turn-${workerThreadId}-1::exact-shared`
  const exactOccurrenceTwoId = `${exactOccurrenceOneId}::cmb-same-role-duplicate:assistant:2`
  useAppStore.getState().appendWorkerFocusMessages(
    workerThreadId,
    [
      {
        id: `worker-turn-${workerThreadId}-1::exact-user`,
        role: "user",
        content: "exact ids",
        created_at: new Date()
      },
      {
        id: exactOccurrenceOneId,
        role: "assistant",
        content: "first exact",
        tool_calls: [{ id: "exact-call-one", name: "read_file", args: { path: "one" } }],
        created_at: new Date()
      },
      {
        id: `worker-turn-${workerThreadId}-1::exact-tool`,
        role: "tool",
        content: "boundary",
        tool_call_id: "exact-call-one",
        name: "read_file",
        created_at: new Date()
      },
      {
        id: exactOccurrenceTwoId,
        provider_source_id: exactOccurrenceOneId,
        role: "assistant",
        content: "second exact",
        tool_calls: [{ id: "exact-call-two", name: "read_file", args: { path: "two" } }],
        created_at: new Date()
      }
    ],
    { orderedSnapshot: true }
  )
  useAppStore.getState().appendWorkerFocusMessages(
    workerThreadId,
    [
      {
        id: `worker-turn-${workerThreadId}-1::exact-user`,
        role: "user",
        content: "exact ids",
        created_at: new Date()
      },
      {
        id: exactOccurrenceOneId,
        role: "assistant",
        content: "first exact",
        tool_calls: [{ id: "exact-call-one", name: "read_file", args: { path: "one" } }],
        created_at: new Date()
      },
      {
        id: `worker-turn-${workerThreadId}-1::exact-tool`,
        role: "tool",
        content: "boundary",
        tool_call_id: "exact-call-one",
        name: "read_file",
        created_at: new Date()
      },
      {
        id: exactOccurrenceTwoId,
        provider_source_id: exactOccurrenceOneId,
        role: "assistant",
        content: "second exact",
        tool_calls: [{ id: "exact-call-two", name: "read_file", args: {} }],
        created_at: new Date()
      }
    ],
    { orderedSnapshot: true }
  )
  const exactOccurrenceAssistants = useAppStore
    .getState()
    .workerFocusMessages.filter((message) => message.role === "assistant")
  assert(
    exactOccurrenceAssistants.length === 2 &&
      new Set(exactOccurrenceAssistants.map((message) => message.id)).size === 2 &&
      exactOccurrenceAssistants[1]?.tool_calls?.[0]?.args?.path === "two",
    "an exact occurrence id must not be blocked by another reservation in the same identity"
  )

  openFocus()
  const multiCallReplayTransport = new ElectronIPCTransport()
  const multiCallValues = convert(multiCallReplayTransport, {
    ...(streamValuesEvent([
      humanMessage("multi call replay", { id: "multi-call-user" }),
      aiMessage({
        id: "multi-call-shared",
        content: "multi call answer",
        toolCalls: [
          { id: "multi-call-one", name: "read_file", args: { path: "one" } },
          { id: "multi-call-two", name: "read_file", args: { path: "two" } }
        ]
      }),
      toolMessage({
        id: "multi-call-tool-one",
        name: "read_file",
        toolCallId: "multi-call-one",
        content: "one"
      }),
      toolMessage({
        id: "multi-call-tool-two",
        name: "read_file",
        toolCallId: "multi-call-two",
        content: "two"
      })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, multiCallValues, {
    orderedSnapshot: true
  })
  const firstCompleteCall = convert(multiCallReplayTransport, {
    ...(streamMessageEvent(
      aiMessageChunk({
        id: "multi-call-shared",
        toolCallChunks: [
          { id: "multi-call-one", name: "read_file", args: '{"path":"one"}' }
        ]
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  const secondCompleteCall = convert(multiCallReplayTransport, {
    ...(streamMessageEvent(
      aiMessageChunk({
        id: "multi-call-shared",
        toolCallChunks: [
          { id: "multi-call-two", name: "read_file", args: '{"path":"two"}' }
        ]
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, secondCompleteCall)
  assert(
    firstCompleteCall.length === 0 &&
      secondCompleteCall.length === 0 &&
      useAppStore
        .getState()
        .workerFocusMessages.filter((message) => message.role === "assistant").length === 1,
    "a multi-call replay split by completed calls must remain buffered until tool evidence"
  )

  openFocus()
  const partialReplayTransport = new ElectronIPCTransport()
  const partialReplayValues = convert(partialReplayTransport, {
    ...(streamValuesEvent([
      humanMessage("partial replay", { id: "partial-replay-user" }),
      aiMessage({
        id: "partial-replay-shared",
        content: "A",
        toolCalls: [
          { id: "partial-replay-call", name: "read_file", args: { value: 1 } }
        ]
      }),
      toolMessage({
        id: "partial-replay-old-tool",
        name: "read_file",
        toolCallId: "partial-replay-call",
        content: "old"
      })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, partialReplayValues, {
    orderedSnapshot: true
  })
  const partialReplayStart = convert(partialReplayTransport, {
    ...(streamMessageEvent(
      {
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: {
          id: "partial-replay-shared",
          content: "A",
          reasoning_content: "R1",
          tool_call_chunks: [
            {
              id: "partial-replay-call",
              name: "read_file",
              args: '{"value":',
              index: 0
            }
          ]
        }
      },
      {}
    ) as object),
    workerTurn: 1
  })
  const partialReplayCompletion = convert(partialReplayTransport, {
    ...(streamMessageEvent(
      {
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: {
          id: "partial-replay-shared",
          content: "",
          tool_call_chunks: [{ args: "1}", index: 0 }]
        }
      },
      {}
    ) as object),
    workerTurn: 1
  })
  const partialReplayNewTool = convert(partialReplayTransport, {
    ...(streamMessageEvent(
      toolMessage({
        id: "partial-replay-new-tool",
        name: "read_file",
        toolCallId: "partial-replay-call",
        content: "new"
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, [
    ...partialReplayStart,
    ...partialReplayCompletion,
    ...partialReplayNewTool
  ])
  const partialReplayAssistants = useAppStore
    .getState()
    .workerFocusMessages.filter((message) => message.role === "assistant")
  assert(
    partialReplayStart.length === 0 &&
      partialReplayCompletion.length === 0 &&
      partialReplayNewTool[0]?.role === "assistant" &&
      partialReplayAssistants.length === 2 &&
      !partialReplayAssistants[0]?.reasoning &&
      partialReplayAssistants[1]?.reasoning === "R1",
    "a provisional partial call rebind must stay ambiguous until a new tool result proves the occurrence"
  )

  openFocus()
  const expandingCallTransport = new ElectronIPCTransport()
  const expandingValues = convert(expandingCallTransport, {
    ...(streamValuesEvent([
      humanMessage("expanding calls", { id: "expanding-user" }),
      aiMessage({
        id: "expanding-shared",
        content: "",
        toolCalls: [{ id: "expanding-call-one", name: "read_file", args: { path: "one" } }]
      }),
      toolMessage({
        id: "expanding-old-tool",
        name: "read_file",
        toolCallId: "expanding-call-one",
        content: "one"
      })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, expandingValues, {
    orderedSnapshot: true
  })
  useAppStore.getState().appendWorkerFocusMessages(
    workerThreadId,
    convert(expandingCallTransport, {
      ...(streamMessageEvent(
        aiMessageChunk({
          id: "expanding-shared",
          toolCallChunks: [
            { id: "expanding-call-one", name: "read_file", args: '{"path":"one"}' }
          ]
        }),
        {}
      ) as object),
      workerTurn: 1
    })
  )
  const expandingSecondCall = convert(expandingCallTransport, {
    ...(streamMessageEvent(
      aiMessageChunk({
        id: "expanding-shared",
        toolCallChunks: [
          { id: "expanding-call-two", name: "read_file", args: '{"path":"two"}' }
        ]
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, expandingSecondCall)
  const expandingAssistants = useAppStore
    .getState()
    .workerFocusMessages.filter((message) => message.role === "assistant")
  assert(
    expandingAssistants.length === 2 &&
      expandingAssistants[1]?.tool_calls?.length === 2 &&
      expandingAssistants[1]?.tool_calls?.[0]?.id === "expanding-call-one" &&
      expandingAssistants[1]?.tool_calls?.[1]?.id === "expanding-call-two",
    "a later extra call must migrate an ambiguous first call into the new occurrence"
  )

  openFocus()
  const ambiguousTextTransport = new ElectronIPCTransport()
  const ambiguousTextValues = convert(ambiguousTextTransport, {
    ...(streamValuesEvent([
      humanMessage("ambiguous text", { id: "ambiguous-text-user" }),
      aiMessage({
        id: "ambiguous-text-shared",
        content: "A",
        toolCalls: [
          { id: "ambiguous-text-call-one", name: "read_file", args: { path: "one" } }
        ]
      }),
      toolMessage({
        id: "ambiguous-text-old-tool",
        name: "read_file",
        toolCallId: "ambiguous-text-call-one",
        content: "one"
      })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, ambiguousTextValues, {
    orderedSnapshot: true
  })
  const ambiguousTextFirstFrame = convert(ambiguousTextTransport, {
    ...(streamMessageEvent(
      {
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: {
          id: "ambiguous-text-shared",
          content: "A",
          reasoning_content: "R1",
          tool_call_chunks: [
            {
              id: "ambiguous-text-call-one",
              name: "read_file",
              args: '{"path":"one"}',
              index: 0
            }
          ]
        }
      },
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, ambiguousTextFirstFrame)
  const ambiguousTextSecondFrame = convert(ambiguousTextTransport, {
    ...(streamMessageEvent(
      {
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: {
          id: "ambiguous-text-shared",
          content: "B",
          tool_calls: [
            {
              id: "ambiguous-text-call-one",
              name: "read_file",
              args: { path: "one" }
            },
            {
              id: "ambiguous-text-call-two",
              name: "read_file",
              args: { path: "two" }
            }
          ]
        }
      },
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, ambiguousTextSecondFrame)
  const ambiguousTextAssistants = useAppStore
    .getState()
    .workerFocusMessages.filter((message) => message.role === "assistant")
  assert(
    ambiguousTextFirstFrame.length === 0 &&
      ambiguousTextAssistants.length === 2 &&
      ambiguousTextAssistants[0]?.content === "A" &&
      !ambiguousTextAssistants[0]?.reasoning &&
      ambiguousTextAssistants[1]?.content === "AB" &&
      ambiguousTextAssistants[1]?.reasoning === "R1" &&
      ambiguousTextAssistants[1]?.tool_calls?.length === 2,
    "ambiguous text and reasoning must stay buffered until an extra call identifies the new occurrence"
  )

  openFocus()
  const incompatibleChunkTransport = new ElectronIPCTransport()
  const incompatibleChunkValues = convert(incompatibleChunkTransport, {
    ...(streamValuesEvent([
      humanMessage("incompatible same frame", { id: "incompatible-chunk-user" }),
      aiMessage({
        id: "incompatible-chunk-shared",
        content: "old",
        toolCalls: [
          { id: "incompatible-chunk-call-one", name: "read_file", args: { path: "one" } }
        ]
      }),
      toolMessage({
        id: "incompatible-chunk-old-tool",
        name: "read_file",
        toolCallId: "incompatible-chunk-call-one",
        content: "one"
      })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, incompatibleChunkValues, {
    orderedSnapshot: true
  })
  convert(incompatibleChunkTransport, {
    ...(streamMessageEvent(
      aiMessage({
        id: "incompatible-chunk-shared",
        content: "old",
        toolCalls: [
          { id: "incompatible-chunk-call-one", name: "read_file", args: { path: "one" } }
        ]
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  const incompatibleSameFrame = convert(incompatibleChunkTransport, {
    ...(streamMessageEvent(
      aiMessageChunk({
        id: "incompatible-chunk-shared",
        content: "brand new",
        toolCallChunks: [
          {
            id: "incompatible-chunk-call-two",
            name: "read_file",
            args: '{"path":"two"}'
          }
        ]
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, incompatibleSameFrame)
  const incompatibleChunkAssistants = useAppStore
    .getState()
    .workerFocusMessages.filter((message) => message.role === "assistant")
  assert(
    incompatibleChunkAssistants.length === 2 &&
      incompatibleChunkAssistants[1]?.content === "brand new" &&
      incompatibleChunkAssistants[1]?.tool_calls?.length === 1 &&
      incompatibleChunkAssistants[1]?.tool_calls?.[0]?.id ===
        "incompatible-chunk-call-two",
    "an incompatible text-and-call frame must not inherit the replay candidate prefix or calls"
  )

  openFocus()
  const reasoningPinTransport = new ElectronIPCTransport()
  const reasoningValues = convert(reasoningPinTransport, {
    ...(streamValuesEvent([
      humanMessage("reasoning pin", { id: "reasoning-pin-user" }),
      aiMessage({
        id: "reasoning-pin-shared",
        content: "old answer",
        toolCalls: [{ id: "reasoning-pin-call", name: "read_file", args: { path: "old" } }]
      }),
      toolMessage({
        id: "reasoning-pin-tool",
        name: "read_file",
        toolCallId: "reasoning-pin-call",
        content: "old"
      })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, reasoningValues, {
    orderedSnapshot: true
  })
  useAppStore.getState().appendWorkerFocusMessages(
    workerThreadId,
    convert(reasoningPinTransport, {
      ...(streamMessageEvent(
        aiMessage({
          id: "reasoning-pin-shared",
          content: "old answer",
          toolCalls: [
            { id: "reasoning-pin-call", name: "read_file", args: { path: "old" } }
          ]
        }),
        {}
      ) as object),
      workerTurn: 1
    })
  )
  const deferredReasoning = convert(reasoningPinTransport, {
    ...(streamMessageEvent(
      {
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: {
          id: "reasoning-pin-shared",
          content: "",
          reasoning_content: "new private reasoning"
        }
      },
      {}
    ) as object),
    workerTurn: 1
  })
  const emptyAfterDeferredReasoning = convert(reasoningPinTransport, {
    ...(streamMessageEvent(
      aiMessageChunk({ id: "reasoning-pin-shared", content: "" }),
      {}
    ) as object),
    workerTurn: 1
  })
  const answerAfterReasoning = convert(reasoningPinTransport, {
    ...(streamMessageEvent(
      aiMessage({ id: "reasoning-pin-shared", content: "brand new answer" }),
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, answerAfterReasoning)
  const reasoningAssistants = useAppStore
    .getState()
    .workerFocusMessages.filter((message) => message.role === "assistant")
  assert(
    deferredReasoning.length === 0 &&
      emptyAfterDeferredReasoning.length === 0 &&
      reasoningAssistants.length === 2 &&
      !reasoningAssistants[0]?.reasoning &&
      reasoningAssistants[1]?.reasoning === "new private reasoning",
    "reasoning before an incompatible post-replay answer must move to the new occurrence"
  )

  openFocus()
  const replayDoubleEmissionTransport = new ElectronIPCTransport()
  const replayDoubleValues = convert(replayDoubleEmissionTransport, {
    ...(streamValuesEvent([
      humanMessage("double replay", { id: "double-replay-user" }),
      aiMessage({
        id: "double-replay-shared",
        content: "old replay answer",
        toolCalls: [{ id: "double-replay-call", name: "read_file", args: { path: "one" } }]
      }),
      toolMessage({
        id: "double-replay-tool",
        name: "read_file",
        toolCallId: "double-replay-call",
        content: "one"
      })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, replayDoubleValues, {
    orderedSnapshot: true
  })
  const replayDoubleEmission = convert(replayDoubleEmissionTransport, {
    ...(streamMessageEvent(
      {
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: {
          id: "double-replay-shared",
          content: "old replay answer",
          tool_call_chunks: [
            {
              id: "double-replay-call",
              name: "read_file",
              args: '{"path":"one"}',
              index: 0
            }
          ]
        }
      },
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, replayDoubleEmission)
  const committedDoubleReplay = convert(replayDoubleEmissionTransport, {
    ...(streamMessageEvent(
      toolMessage({
        id: "double-replay-tool",
        name: "read_file",
        toolCallId: "double-replay-call",
        content: "one"
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, committedDoubleReplay)
  assert(
    replayDoubleEmission.length === 0 &&
      committedDoubleReplay[0]?.role === "assistant" &&
      useAppStore
        .getState()
        .workerFocusMessages.filter((message) => message.role === "assistant").length === 1,
    "a delayed replay with two internal updates must commit once after known tool evidence"
  )
  convert(replayDoubleEmissionTransport, {
    ...(streamMessageEvent(
      {
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: {
          id: "double-replay-shared",
          content: "old replay answer",
          tool_call_chunks: [
            {
              id: "double-replay-call",
              name: "read_file",
              args: '{"path":"one"}',
              index: 0
            }
          ]
        }
      },
      {}
    ) as object),
    workerTurn: 1
  })
  const newContentAfterReplayPin = convert(replayDoubleEmissionTransport, {
    ...(streamMessageEvent(
      aiMessage({ id: "double-replay-shared", content: "new replay answer" }),
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, newContentAfterReplayPin)
  const newCallAfterReplayPin = convert(replayDoubleEmissionTransport, {
    ...(streamMessageEvent(
      {
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: {
          id: "double-replay-shared",
          content: "",
          tool_calls: [{ id: "double-replay-call", name: "read_file", args: {} }],
          tool_call_chunks: [
            {
              id: "double-replay-call",
              name: "read_file",
              args: '{"path":"two"}',
              index: 0
            }
          ]
        }
      },
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, newCallAfterReplayPin)
  const afterPinnedCallAssistants = useAppStore
    .getState()
    .workerFocusMessages.filter((message) => message.role === "assistant")
  assert(
    afterPinnedCallAssistants.length === 2 &&
      afterPinnedCallAssistants[1]?.content === "new replay answer" &&
      afterPinnedCallAssistants[1]?.tool_calls?.[0]?.args?.path === "two",
    "a new call after replay pin incompatibility must use a fresh tool accumulator"
  )

  openFocus()
  const identicalOccurrenceTransport = new ElectronIPCTransport()
  const identicalValues = convert(identicalOccurrenceTransport, {
    ...(streamValuesEvent([
      humanMessage("identical occurrence", { id: "identical-user" }),
      aiMessage({
        id: "identical-shared",
        content: "same answer",
        toolCalls: [{ id: "identical-call", name: "read_file", args: { path: "one" } }]
      }),
      toolMessage({
        id: "identical-tool-one",
        name: "read_file",
        toolCallId: "identical-call",
        content: "one"
      })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, identicalValues, {
    orderedSnapshot: true
  })
  useAppStore.getState().appendWorkerFocusMessages(
    workerThreadId,
    convert(identicalOccurrenceTransport, {
      ...(streamMessageEvent(
        aiMessage({
          id: "identical-shared",
          content: "same answer",
          toolCalls: [
            { id: "identical-call", name: "read_file", args: { path: "one" } }
          ]
        }),
        {}
      ) as object),
      workerTurn: 1
    })
  )
  const identicalNewTool = convert(identicalOccurrenceTransport, {
    ...(streamMessageEvent(
      toolMessage({
        id: "identical-tool-two",
        name: "read_file",
        toolCallId: "identical-call",
        content: "one again"
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, identicalNewTool)
  const identicalMessages = useAppStore.getState().workerFocusMessages
  assert(
    identicalMessages.filter((message) => message.role === "assistant").length === 2 &&
      identicalMessages.filter((message) => message.role === "tool").length === 2 &&
      identicalNewTool[0]?.role === "assistant" &&
      identicalNewTool[1]?.role === "tool",
    "a new tool message must materialize an otherwise identical post-tool assistant occurrence"
  )

  openFocus()
  const reusedToolIdTransport = new ElectronIPCTransport()
  const reusedToolIdValues = convert(reusedToolIdTransport, {
    ...(streamValuesEvent([
      humanMessage("reused tool id", { id: "reused-tool-user" }),
      aiMessage({
        id: "reused-tool-shared",
        content: "same",
        toolCalls: [{ id: "reused-tool-call", name: "read_file", args: { path: "one" } }]
      }),
      toolMessage({
        id: "reused-tool-message",
        name: "read_file",
        toolCallId: "reused-tool-call",
        content: "old result"
      })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, reusedToolIdValues, {
    orderedSnapshot: true
  })
  convert(reusedToolIdTransport, {
    ...(streamMessageEvent(
      aiMessage({
        id: "reused-tool-shared",
        content: "same expanded",
        toolCalls: [{ id: "reused-tool-call", name: "read_file", args: { path: "one" } }]
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  const changedReusedTool = convert(reusedToolIdTransport, {
    ...(streamMessageEvent(
      toolMessage({
        id: "reused-tool-message",
        name: "read_file",
        toolCallId: "reused-tool-call",
        content: "new result"
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, changedReusedTool)
  assert(
    changedReusedTool[0]?.role === "assistant" &&
      changedReusedTool[0]?.content === "same expanded" &&
      useAppStore
        .getState()
        .workerFocusMessages.filter((message) => message.role === "assistant").length === 2,
    "a reused tool message id with changed payload must materialize an identical new assistant"
  )

  openFocus()
  const pendingParallelTransport = new ElectronIPCTransport()
  const pendingParallelValues = convert(pendingParallelTransport, {
    ...(streamValuesEvent([
      humanMessage("pending parallel", { id: "pending-parallel-user" }),
      aiMessage({
        id: "pending-parallel-shared",
        content: "parallel",
        toolCalls: [
          { id: "pending-parallel-call-one", name: "read_file", args: { path: "one" } },
          { id: "pending-parallel-call-two", name: "read_file", args: { path: "two" } },
          { id: "pending-parallel-call-three", name: "read_file", args: { path: "three" } }
        ]
      }),
      toolMessage({
        id: "pending-parallel-tool-one",
        name: "read_file",
        toolCallId: "pending-parallel-call-one",
        content: "one"
      })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, pendingParallelValues, {
    orderedSnapshot: true
  })
  convert(pendingParallelTransport, {
    ...(streamMessageEvent(
      aiMessage({
        id: "pending-parallel-shared",
        content: "parallel",
        toolCalls: [
          { id: "pending-parallel-call-one", name: "read_file", args: { path: "one" } },
          { id: "pending-parallel-call-two", name: "read_file", args: { path: "two" } },
          { id: "pending-parallel-call-three", name: "read_file", args: { path: "three" } }
        ]
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  const pendingSecondResult = convert(pendingParallelTransport, {
    ...(streamMessageEvent(
      toolMessage({
        id: "pending-parallel-tool-two",
        toolCallId: "pending-parallel-call-two",
        content: ""
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, pendingSecondResult)
  assert(
    useAppStore
      .getState()
      .workerFocusMessages.filter((message) => message.role === "assistant").length === 1,
    "the first result for a pending parallel call must not materialize a second assistant"
  )
  const repeatedPendingSecondResult = convert(pendingParallelTransport, {
    ...(streamMessageEvent(
      toolMessage({
        id: "pending-parallel-tool-two",
        toolCallId: "pending-parallel-call-two",
        content: ""
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  const grownPendingSecondResult = convert(pendingParallelTransport, {
    ...(streamMessageEvent(
      toolMessage({
        id: "pending-parallel-tool-two",
        name: "read_file",
        toolCallId: "pending-parallel-call-two",
        content: "partial complete",
        status: "error"
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  const reusedIdThirdResult = convert(pendingParallelTransport, {
    ...(streamMessageEvent(
      toolMessage({
        id: "pending-parallel-tool-two",
        name: "read_file",
        toolCallId: "pending-parallel-call-three",
        content: "three"
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  const pendingFirstResult = convert(pendingParallelTransport, {
    ...(streamMessageEvent(
      toolMessage({
        id: "pending-parallel-tool-one-new",
        name: "read_file",
        toolCallId: "pending-parallel-call-one",
        content: "one again"
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, pendingFirstResult)
  const pendingParallelMessages = useAppStore.getState().workerFocusMessages
  assert(
    pendingSecondResult.length === 0 &&
      repeatedPendingSecondResult.length === 0 &&
      grownPendingSecondResult.length === 0 &&
      reusedIdThirdResult.length === 0 &&
      pendingFirstResult.map((message) => message.role).join(",") ===
        "assistant,tool,tool,tool" &&
      pendingParallelMessages.filter((message) => message.role === "assistant").length === 2 &&
      pendingParallelMessages.filter((message) => message.role === "tool").length === 4,
    "pending result replay/growth must stay deferred until later evidence materializes its assistant"
  )

  openFocus()
  const deferredFinalTransport = new ElectronIPCTransport()
  const deferredFinalValues = convert(deferredFinalTransport, {
    ...(streamValuesEvent([
      humanMessage("deferred final", { id: "deferred-final-user" }),
      aiMessage({
        id: "deferred-final-shared",
        content: "parallel",
        toolCalls: [
          { id: "deferred-final-call-one", name: "read_file", args: { path: "one" } },
          { id: "deferred-final-call-two", name: "read_file", args: { path: "two" } }
        ]
      }),
      toolMessage({
        id: "deferred-final-tool-one",
        name: "read_file",
        toolCallId: "deferred-final-call-one",
        content: "one"
      })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, deferredFinalValues, {
    orderedSnapshot: true
  })
  convert(deferredFinalTransport, {
    ...(streamMessageEvent(
      aiMessage({
        id: "deferred-final-shared",
        content: "parallel",
        toolCalls: [
          { id: "deferred-final-call-one", name: "read_file", args: { path: "one" } },
          { id: "deferred-final-call-two", name: "read_file", args: { path: "two" } }
        ]
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  const deferredFinalSecondTool = convert(deferredFinalTransport, {
    ...(streamMessageEvent(
      toolMessage({
        id: "deferred-final-tool-two",
        name: "read_file",
        toolCallId: "deferred-final-call-two",
        content: "two"
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  const finalAfterDeferredTool = convert(deferredFinalTransport, {
    ...(streamMessageEvent(
      aiMessageChunk({ id: "deferred-final-shared", content: "parallel" }),
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, finalAfterDeferredTool)
  assert(
    deferredFinalSecondTool.length === 0 &&
      finalAfterDeferredTool.map((message) => message.role).join(",") ===
        "tool,assistant" &&
      useAppStore
        .getState()
        .workerFocusMessages.map((message) => message.role)
        .join(",") === "user,assistant,tool,tool,assistant",
    "a final assistant boundary must flush an old pending result before the final answer"
  )

  openFocus()
  const deferredSubsetTransport = new ElectronIPCTransport()
  const deferredSubsetValues = convert(deferredSubsetTransport, {
    ...(streamValuesEvent([
      humanMessage("deferred subset", { id: "deferred-subset-user" }),
      aiMessage({
        id: "deferred-subset-shared",
        content: "parallel",
        toolCalls: [
          { id: "deferred-subset-call-one", name: "read_file", args: { path: "one" } },
          { id: "deferred-subset-call-two", name: "read_file", args: { path: "two" } }
        ]
      }),
      toolMessage({
        id: "deferred-subset-tool-one",
        name: "read_file",
        toolCallId: "deferred-subset-call-one",
        content: "one"
      })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, deferredSubsetValues, {
    orderedSnapshot: true
  })
  convert(deferredSubsetTransport, {
    ...(streamMessageEvent(
      aiMessage({
        id: "deferred-subset-shared",
        content: "parallel",
        toolCalls: [
          { id: "deferred-subset-call-one", name: "read_file", args: { path: "one" } },
          { id: "deferred-subset-call-two", name: "read_file", args: { path: "two" } }
        ]
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  const deferredSubsetSecondTool = convert(deferredSubsetTransport, {
    ...(streamMessageEvent(
      toolMessage({
        id: "deferred-subset-tool-two",
        name: "read_file",
        toolCallId: "deferred-subset-call-two",
        content: "two"
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  const assistantAfterDeferredSubset = convert(deferredSubsetTransport, {
    ...(streamMessageEvent(
      aiMessage({
        id: "deferred-subset-shared",
        content: "parallel",
        toolCalls: [
          { id: "deferred-subset-call-one", name: "read_file", args: { path: "one" } }
        ]
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(
    workerThreadId,
    assistantAfterDeferredSubset
  )
  const deferredSubsetAssistants = useAppStore
    .getState()
    .workerFocusMessages.filter((message) => message.role === "assistant")
  assert(
    deferredSubsetSecondTool.length === 0 &&
      assistantAfterDeferredSubset.map((message) => message.role).join(",") ===
        "tool,assistant" &&
      deferredSubsetAssistants.length === 2 &&
      deferredSubsetAssistants[1]?.tool_calls?.length === 1 &&
      deferredSubsetAssistants[1]?.tool_calls?.[0]?.id ===
        "deferred-subset-call-one",
    "an explicit subset call list must start a new assistant after flushing old pending tools"
  )

  openFocus()
  const deferredHumanTransport = new ElectronIPCTransport()
  const deferredHumanValues = convert(deferredHumanTransport, {
    ...(streamValuesEvent([
      humanMessage("deferred human first", { id: "deferred-human-user-one" }),
      aiMessage({
        id: "deferred-human-shared",
        content: "parallel",
        toolCalls: [
          { id: "deferred-human-call-one", name: "read_file", args: { path: "one" } },
          { id: "deferred-human-call-two", name: "read_file", args: { path: "two" } }
        ]
      }),
      toolMessage({
        id: "deferred-human-tool-one",
        name: "read_file",
        toolCallId: "deferred-human-call-one",
        content: "one"
      })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, deferredHumanValues, {
    orderedSnapshot: true
  })
  convert(deferredHumanTransport, {
    ...(streamMessageEvent(
      aiMessage({
        id: "deferred-human-shared",
        content: "parallel",
        toolCalls: [
          { id: "deferred-human-call-one", name: "read_file", args: { path: "one" } },
          { id: "deferred-human-call-two", name: "read_file", args: { path: "two" } }
        ]
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  const deferredHumanSecondTool = convert(deferredHumanTransport, {
    ...(streamMessageEvent(
      toolMessage({
        id: "deferred-human-tool-two",
        name: "read_file",
        toolCallId: "deferred-human-call-two",
        content: "two"
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  const humanAfterDeferredTool = convert(deferredHumanTransport, {
    ...(streamMessageEvent(
      humanMessage("deferred human second", { id: "deferred-human-user-two" }),
      {}
    ) as object),
    workerTurn: 2
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, humanAfterDeferredTool)
  assert(
    deferredHumanSecondTool.length === 0 &&
      humanAfterDeferredTool.map((message) => message.role).join(",") === "tool,user" &&
      useAppStore
        .getState()
        .workerFocusMessages.map((message) => message.role)
        .join(",") === "user,assistant,tool,tool,user",
    "a human turn boundary must flush old pending tools before the next user message"
  )

  openFocus()
  const multiCandidateReplayTransport = new ElectronIPCTransport()
  const multiCandidateValues = convert(multiCandidateReplayTransport, {
    ...(streamValuesEvent([
      humanMessage("multi candidate old replay", { id: "multi-candidate-user" }),
      aiMessage({
        id: "multi-candidate-shared",
        content: "same",
        toolCalls: [{ id: "multi-candidate-call", name: "read_file", args: { path: "one" } }]
      }),
      toolMessage({
        id: "multi-candidate-tool-one",
        name: "read_file",
        toolCallId: "multi-candidate-call",
        content: "one"
      }),
      aiMessage({
        id: "multi-candidate-shared",
        content: "same",
        toolCalls: [{ id: "multi-candidate-call", name: "read_file", args: { path: "one" } }]
      }),
      toolMessage({
        id: "multi-candidate-tool-two",
        name: "read_file",
        toolCallId: "multi-candidate-call",
        content: "two"
      })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, multiCandidateValues, {
    orderedSnapshot: true
  })
  const multiCandidateReplay = convert(multiCandidateReplayTransport, {
    ...(streamMessageEvent(
      aiMessage({
        id: "multi-candidate-shared",
        content: "same",
        toolCalls: [{ id: "multi-candidate-call", name: "read_file", args: { path: "one" } }]
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  const multiCandidateOldToolReplay = convert(multiCandidateReplayTransport, {
    ...(streamMessageEvent(
      toolMessage({
        id: "multi-candidate-tool-one",
        name: "read_file",
        toolCallId: "multi-candidate-call",
        content: "one"
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, [
    ...multiCandidateReplay,
    ...multiCandidateOldToolReplay
  ])
  assert(
    multiCandidateReplay.length === 0 &&
      multiCandidateOldToolReplay.every((message) => message.role === "tool") &&
      useAppStore
        .getState()
        .workerFocusMessages.filter((message) => message.role === "assistant").length === 2,
    "a known old tool replay must discard an unresolved multi-candidate provisional occurrence"
  )

  openFocus()
  const switchedValuesTransport = new ElectronIPCTransport()
  convert(switchedValuesTransport, {
    ...(streamMessageEvent(
      aiMessageChunk({
        id: "switched-values-shared",
        content: "first",
        toolCallChunks: [
          { id: "switched-values-call", name: "read_file", args: '{"path":"one"}' }
        ]
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  const switchedValues = convert(switchedValuesTransport, {
    ...(streamValuesEvent([
      humanMessage("switch values", { id: "switched-values-user" }),
      aiMessage({
        id: "switched-values-shared",
        content: "first",
        toolCalls: [{ id: "switched-values-call", name: "read_file", args: {} }]
      }),
      toolMessage({
        id: "switched-values-tool",
        name: "read_file",
        toolCallId: "switched-values-call",
        content: "boundary"
      }),
      aiMessage({
        id: "switched-values-shared",
        content: "second",
        toolCalls: [{ id: "switched-values-call", name: "read_file", args: {} }]
      })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, switchedValues, {
    orderedSnapshot: true
  })
  const switchedLive = convert(switchedValuesTransport, {
    ...(streamMessageEvent(
      aiMessage({
        id: "switched-values-shared",
        content: "second expanded",
        toolCalls: [{ id: "switched-values-call", name: "read_file", args: {} }]
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  assert(
    switchedLive.at(-1)?.tool_calls?.[0]?.args?.path === undefined,
    "values switching to a later occurrence must clear the previous occurrence accumulator"
  )

  openFocus()
  const exactActiveTransport = new ElectronIPCTransport()
  const exactActiveHistory = convert(exactActiveTransport, {
    ...(streamValuesEvent([
      humanMessage("exact active", { id: "exact-active-user" }),
      aiMessage({
        id: "exact-active-shared",
        toolCalls: [
          { id: "exact-active-call-one", name: "read_file", args: { path: "one" } }
        ]
      }),
      toolMessage({
        id: "exact-active-tool-one",
        name: "read_file",
        toolCallId: "exact-active-call-one",
        content: "one"
      })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, exactActiveHistory, {
    orderedSnapshot: true
  })
  useAppStore.getState().appendWorkerFocusMessages(
    workerThreadId,
    convert(exactActiveTransport, {
      ...(streamMessageEvent(
        aiMessageChunk({
          id: "exact-active-shared",
          toolCallChunks: [
            { id: "exact-active-call-two", name: "read_file", args: '{"path":"two"}' }
          ]
        }),
        {}
      ) as object),
      workerTurn: 1
    })
  )
  const exactActiveValues = convert(exactActiveTransport, {
    ...(streamValuesEvent([
      humanMessage("exact active", { id: "exact-active-user" }),
      aiMessage({
        id: "exact-active-shared",
        toolCalls: [
          { id: "exact-active-call-one", name: "read_file", args: { path: "one" } }
        ]
      }),
      toolMessage({
        id: "exact-active-tool-one",
        name: "read_file",
        toolCallId: "exact-active-call-one",
        content: "one"
      }),
      aiMessage({
        id: "exact-active-shared",
        toolCalls: [{ id: "exact-active-call-two", name: "read_file", args: {} }]
      })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, exactActiveValues, {
    orderedSnapshot: true
  })
  useAppStore.getState().appendWorkerFocusMessages(
    workerThreadId,
    convert(exactActiveTransport, {
      ...(streamMessageEvent(
        toolMessage({
          id: "exact-active-tool-two",
          name: "read_file",
          toolCallId: "exact-active-call-two",
          content: "two"
        }),
        {}
      ) as object),
      workerTurn: 1
    })
  )
  const exactActiveReplay = convert(exactActiveTransport, {
    ...(streamMessageEvent(
      aiMessage({
        id: "exact-active-shared",
        toolCalls: [
          { id: "exact-active-call-two", name: "read_file", args: { path: "two" } }
        ]
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  const exactActiveReplayTool = convert(exactActiveTransport, {
    ...(streamMessageEvent(
      toolMessage({
        id: "exact-active-tool-two",
        name: "read_file",
        toolCallId: "exact-active-call-two",
        content: "two"
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  assert(
    exactActiveReplay.length === 0 &&
      exactActiveReplayTool[0]?.id ===
      `worker-turn-${workerThreadId}-1::exact-active-shared::cmb-same-role-duplicate:assistant:2`,
    "an exact active occurrence id must hydrate even when its assistant content is empty"
  )

  openFocus()
  const basePinTransport = new ElectronIPCTransport()
  const basePinValues = convert(basePinTransport, {
    ...(streamValuesEvent([
      humanMessage("base pin", { id: "base-pin-user" }),
      aiMessage({
        id: "base-pin-shared",
        toolCalls: [{ id: "base-pin-call-one", name: "read_file", args: { path: "one" } }]
      }),
      toolMessage({
        id: "base-pin-tool-one",
        name: "read_file",
        toolCallId: "base-pin-call-one",
        content: "one"
      }),
      aiMessage({
        id: "base-pin-shared",
        toolCalls: [{ id: "base-pin-call-two", name: "read_file", args: { path: "two" } }]
      }),
      toolMessage({
        id: "base-pin-tool-two",
        name: "read_file",
        toolCallId: "base-pin-call-two",
        content: "two"
      })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, basePinValues, {
    orderedSnapshot: true
  })
  convert(basePinTransport, {
    ...(streamMessageEvent(
      aiMessageChunk({
        id: "base-pin-shared",
        toolCallChunks: [
          { id: "base-pin-call-one", name: "read_file", args: '{"path":"one"}' }
        ]
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  const sparseBasePinValues = convert(basePinTransport, {
    ...(streamValuesEvent([
      humanMessage("base pin", { id: "base-pin-user" }),
      aiMessage({
        id: "base-pin-shared",
        toolCalls: [{ id: "base-pin-call-one", name: "read_file", args: {} }]
      }),
      toolMessage({
        id: "base-pin-tool-one",
        name: "read_file",
        toolCallId: "base-pin-call-one",
        content: "one"
      }),
      aiMessage({
        id: "base-pin-shared",
        toolCalls: [{ id: "base-pin-call-two", name: "read_file", args: {} }]
      }),
      toolMessage({
        id: "base-pin-tool-two",
        name: "read_file",
        toolCallId: "base-pin-call-two",
        content: "two"
      })
    ]) as object),
    workerTurn: 1
  })
  useAppStore.getState().appendWorkerFocusMessages(workerThreadId, sparseBasePinValues, {
    orderedSnapshot: true
  })
  const basePinReplay = convert(basePinTransport, {
    ...(streamMessageEvent(
      aiMessage({
        id: "base-pin-shared",
        toolCalls: [
          { id: "base-pin-call-one", name: "read_file", args: { path: "one" } }
        ]
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  const basePinToolReplay = convert(basePinTransport, {
    ...(streamMessageEvent(
      toolMessage({
        id: "base-pin-tool-one",
        name: "read_file",
        toolCallId: "base-pin-call-one",
        content: "one"
      }),
      {}
    ) as object),
    workerTurn: 1
  })
  assert(
    basePinReplay.length === 0 &&
      basePinToolReplay[0]?.id === `worker-turn-${workerThreadId}-1::base-pin-shared`,
    "a pinned base occurrence must remain the active hydration target for sparse values"
  )

  openFocus()
  const longHistoryTransport = new ElectronIPCTransport()
  const longHistoryRaw = [
    humanMessage("long history", { id: "long-history-user" }),
    ...Array.from({ length: 501 }, (_, index) =>
      aiMessage({ id: "long-history-shared", content: `answer-${index + 1}` })
    )
  ]
  const longHistory = buildWorkerCheckpointHistory(longHistoryRaw, workerThreadId)
  const longLive = convert(longHistoryTransport, {
    ...(streamValuesEvent(longHistoryRaw) as object),
    workerTurn: 1
  })
  assert(
    longHistory.truncatedCount === 2 &&
      isCompleteWorkerSnapshotCoveringHistory(longHistory.messages, longLive),
    "a complete values snapshot must be recognized as covering a truncated checkpoint suffix"
  )
  const explicitOccurrenceHistory = [
    {
      id: `worker-turn-${workerThreadId}-1::explicit-successor-shared`,
      role: "assistant" as const,
      content: "same answer",
      created_at: new Date()
    }
  ]
  const explicitOccurrenceLive = [
    {
      id:
        `worker-turn-${workerThreadId}-1::explicit-successor-shared` +
        "::cmb-same-role-duplicate:assistant:2",
      provider_source_id: `worker-turn-${workerThreadId}-1::explicit-successor-shared`,
      role: "assistant" as const,
      content: "same answer",
      created_at: new Date()
    }
  ]
  assert(
    !isCompleteWorkerSnapshotCoveringHistory(
      explicitOccurrenceHistory,
      explicitOccurrenceLive
    ),
    "an equal-length explicit next occurrence must not replace checkpoint history"
  )
  const aliasedExplicitOccurrenceLive = [
    {
      id: "worker-live-explicit-successor",
      provider_source_id: explicitOccurrenceHistory[0].id,
      provider_occurrence: 2,
      role: "assistant" as const,
      content: "same answer",
      created_at: new Date()
    }
  ]
  assert(
    !isCompleteWorkerSnapshotCoveringHistory(
      explicitOccurrenceHistory,
      aliasedExplicitOccurrenceLive
    ) &&
      isExplicitWorkerOccurrenceAfter(
        explicitOccurrenceHistory[0],
        aliasedExplicitOccurrenceLive[0]
      ),
    "persisted occurrence metadata must survive an alias without a duplicate-id marker"
  )
  assert(
    !isCompleteWorkerSnapshotCoveringHistory(explicitOccurrenceHistory, [
      ...explicitOccurrenceLive,
      {
        ...explicitOccurrenceLive[0],
        id:
          `worker-turn-${workerThreadId}-1::explicit-successor-shared` +
          "::cmb-same-role-duplicate:assistant:3"
      }
    ]),
    "multiple explicit successors must not masquerade as a longer complete snapshot"
  )
  assert(
    !isCompleteWorkerSnapshotCoveringHistory(explicitOccurrenceHistory, [
      {
        id: "explicit-successor-leading-tool",
        role: "tool",
        content: "tool result",
        tool_call_id: "explicit-successor-call",
        created_at: new Date()
      },
      explicitOccurrenceLive[0]
    ]),
    "an unrelated leading tool must not make a new occurrence cover history"
  )
  assert(
    isCompleteWorkerSnapshotCoveringHistory(
      longHistory.messages,
      longHistory.messages.map((message) => ({ ...message, content: message.content }))
    ),
    "an equal-length truncated replay must retain its global occurrence alignment"
  )

  const tailHistory = [
    {
      id: "tail-history-user",
      role: "user" as const,
      content: "tail history",
      created_at: new Date()
    },
    {
      id: "tail-history-shared",
      role: "assistant" as const,
      content: "first",
      created_at: new Date()
    },
    {
      id: "tail-history-tool",
      role: "tool" as const,
      content: "one",
      tool_call_id: "tail-history-call-one",
      created_at: new Date()
    }
  ]
  const normalizedTail = normalizeWorkerMessagesAfterHistory(tailHistory, [
    {
      id: "tail-history-shared::cmb-same-role-duplicate:assistant:2",
      provider_source_id: "tail-history-shared",
      role: "assistant",
      content: "second",
      created_at: new Date()
    },
    {
      id: "tail-history-tool::cmb-same-role-duplicate:tool:2",
      provider_source_id: "tail-history-tool",
      role: "tool",
      content: "two",
      tool_call_id: "tail-history-call-two",
      created_at: new Date()
    },
    {
      id: "tail-history-shared::cmb-same-role-duplicate:assistant:3",
      provider_source_id: "tail-history-shared",
      role: "assistant",
      content: "third",
      created_at: new Date()
    }
  ])
  assert(
    normalizedTail.map((message) => message.id).join("|") ===
      [
        "tail-history-shared::cmb-same-role-duplicate:assistant:2",
        "tail-history-tool::cmb-same-role-duplicate:tool:2",
        "tail-history-shared::cmb-same-role-duplicate:assistant:3"
      ].join("|"),
    "a replay-aligned tail must allocate every new occurrence against the full history"
  )
  const sparseGlobalHistory = [
    {
      id: "sparse-global-shared::cmb-same-role-duplicate:assistant:300",
      provider_source_id: "sparse-global-shared",
      role: "assistant" as const,
      content: "three hundred",
      created_at: new Date()
    },
    {
      id: "sparse-global-shared::cmb-same-role-duplicate:assistant:301",
      provider_source_id: "sparse-global-shared",
      role: "assistant" as const,
      content: "three hundred one",
      created_at: new Date()
    }
  ]
  const sparseGlobalSuccessor = {
    id: "sparse-global-shared::cmb-same-role-duplicate:assistant:302",
    provider_source_id: "sparse-global-shared",
    role: "assistant" as const,
    content: "three hundred two",
    created_at: new Date()
  }
  assert(
    normalizeWorkerMessagesAfterHistory(sparseGlobalHistory, [sparseGlobalSuccessor])[0]?.id ===
      sparseGlobalSuccessor.id,
    "tail rebasing must continue from the largest explicit global occurrence"
  )
  assert(
    isExplicitWorkerOccurrenceAfter(sparseGlobalHistory[1], {
      ...sparseGlobalSuccessor,
      id: "sparse-global-shared::cmb-same-role-duplicate:assistant:303"
    }),
    "a skipped explicit occurrence must still be recognized as newer than history"
  )

  const hiddenInternalHuman = (id: string) => ({
    id: ["langchain_core", "messages", "HumanMessage"],
    kwargs: {
      id,
      content: "internal notification",
      additional_kwargs: { cmb_internal_coordinator_notification: true }
    }
  })
  const internalTurnRaw = [
    hiddenInternalHuman("hidden-turn-zero"),
    humanMessage("visible turn one", { id: "visible-turn-one" }),
    aiMessage({ id: "visible-answer-one", content: "answer one" }),
    hiddenInternalHuman("hidden-turn-one"),
    humanMessage("visible turn two", { id: "visible-turn-two" }),
    aiMessage({ id: "visible-answer-two", content: "answer two" })
  ]
  const internalTurnHistory = buildWorkerCheckpointHistory(internalTurnRaw, workerThreadId)
  const internalTurnLive = convert(new ElectronIPCTransport(), {
    ...(streamValuesEvent(internalTurnRaw) as object),
    workerTurn: 2
  })
  assert(
    internalTurnHistory.messages.map((message) => message.id).join("|") ===
      internalTurnLive.map((message) => message.id).join("|"),
    "hidden internal humans must not advance checkpoint or live worker turns"
  )
  const sparseLongRaw = [
    humanMessage("sparse long history", { id: "sparse-long-user" }),
    ...Array.from({ length: 501 }, (_, index) =>
      aiMessage({
        id: "sparse-long-shared",
        content: `sparse-answer-${index + 1}`,
        toolCalls: [
          {
            id: `sparse-long-call-${index + 1}`,
            name: "read_file",
            args: { path: index + 1 }
          }
        ]
      })
    )
  ]
  const sparseLongHistory = buildWorkerCheckpointHistory(sparseLongRaw, workerThreadId)
  const sparseLongLive = convert(new ElectronIPCTransport(), {
    ...(streamValuesEvent([
      humanMessage("sparse long history", { id: "sparse-long-user" }),
      ...Array.from({ length: 501 }, (_, index) =>
        aiMessage({
          id: "sparse-long-shared",
          content: `sparse-answer-${index + 1}`,
          toolCalls: [
            { id: `sparse-long-call-${index + 1}`, name: "read_file", args: {} }
          ]
        })
      )
    ]) as object),
    workerTurn: 1
  })
  assert(
    isCompleteWorkerSnapshotCoveringHistory(sparseLongHistory.messages, sparseLongLive),
    "a sparse values snapshot must still cover its truncated checkpoint suffix"
  )
  const omittedLongCalls = sparseLongLive.map((message) =>
    message.role === "assistant" ? { ...message, tool_calls: undefined } : message
  )
  assert(
    isCompleteWorkerSnapshotCoveringHistory(
      sparseLongHistory.messages,
      omittedLongCalls
    ),
    "a values suffix that omits assistant calls must still cover checkpoint history"
  )
  const emptyLongContent = sparseLongLive.map((message) => ({ ...message, content: "" }))
  assert(
    isCompleteWorkerSnapshotCoveringHistory(
      sparseLongHistory.messages,
      emptyLongContent
    ),
    "an empty-content values suffix must still align with visible checkpoint history"
  )
  const twoCallLongHistory = sparseLongHistory.messages.map((message, index) =>
    message.role === "assistant"
      ? {
          ...message,
          tool_calls: [
            ...(message.tool_calls ?? []),
            {
              id: `sparse-long-extra-call-${index}`,
              name: "read_file",
              args: { path: `extra-${index}` }
            }
          ]
        }
      : message
  )
  assert(
    isCompleteWorkerSnapshotCoveringHistory(twoCallLongHistory, sparseLongLive),
    "a values suffix carrying only a subset of calls must align with checkpoint history"
  )
  const blockContentHistoryRaw = [
    humanMessage("block long history", { id: "block-long-user" }),
    ...Array.from({ length: 501 }, (_, index) => ({
      id: ["langchain_core", "messages", "AIMessage"],
      kwargs: {
        id: "block-long-shared",
        content: [{ type: "text", text: `block-answer-${index + 1}` }],
        tool_calls: [
          {
            id: `block-long-call-${index + 1}`,
            name: "read_file",
            args: { path: index + 1 }
          }
        ]
      }
    }))
  ]
  const blockContentHistory = buildWorkerCheckpointHistory(
    blockContentHistoryRaw,
    workerThreadId
  )
  const blockContentLive = convert(new ElectronIPCTransport(), {
    ...(streamValuesEvent([
      humanMessage("block long history", { id: "block-long-user" }),
      ...Array.from({ length: 501 }, (_, index) =>
        aiMessage({
          id: "block-long-shared",
          content: `block-answer-${index + 1}`,
          toolCalls: [
            { id: `block-long-call-${index + 1}`, name: "read_file", args: {} }
          ]
        })
      )
    ]) as object),
    workerTurn: 1
  })
  assert(
    isCompleteWorkerSnapshotCoveringHistory(
      blockContentHistory.messages,
      blockContentLive
    ) &&
      Array.isArray(
        mergeWorkerCheckpointSparseContent(
          blockContentHistory.messages[0],
          blockContentLive[2]
        )
      ),
    "block-array checkpoint history must align with string live values and retain its blocks"
  )
  const multiTurnLongRaw = [
    humanMessage("long turn one", { id: "long-turn-user-one" }),
    ...Array.from({ length: 100 }, (_, index) =>
      aiMessage({ id: "long-turn-shared-one", content: `t1-a${index + 1}` })
    ),
    humanMessage("long turn two", { id: "long-turn-user-two" }),
    ...Array.from({ length: 450 }, (_, index) =>
      aiMessage({ id: "long-turn-shared-two", content: `t2-a${index + 1}` })
    )
  ]
  const multiTurnLongHistory = buildWorkerCheckpointHistory(multiTurnLongRaw, workerThreadId)
  const multiTurnLongLive = convert(new ElectronIPCTransport(), {
    ...(streamValuesEvent(multiTurnLongRaw) as object),
    workerTurn: 2
  })
  assert(
    multiTurnLongHistory.truncatedCount === 52 &&
      isCompleteWorkerSnapshotCoveringHistory(
        multiTurnLongHistory.messages,
        multiTurnLongLive
      ),
    "a complete multi-turn values snapshot must cover a truncated history that still has users"
  )

  resetWorkerFocusStore()
  const occurrenceStoreThreadId = "worker-occurrence-store-thread"
  openWorkerFocusViewForTest({
    threadId: "worker-occurrence-parent-thread",
    workerId: "worker-occurrence-store",
    workerThreadId: occurrenceStoreThreadId
  })
  useAppStore.getState().appendWorkerFocusMessages(occurrenceStoreThreadId, [
    {
      id: "worker-live-occurrence-one",
      provider_source_id: "worker-occurrence-source",
      provider_occurrence: 1,
      role: "assistant",
      content: "same",
      created_at: new Date()
    }
  ])
  useAppStore.getState().appendWorkerFocusMessages(
    occurrenceStoreThreadId,
    [
      {
        id: "worker-snapshot-occurrence-two",
        provider_source_id: "worker-occurrence-source",
        provider_occurrence: 2,
        role: "assistant",
        content: "same",
        created_at: new Date()
      }
    ],
    { orderedSnapshot: true }
  )
  assert(
    useAppStore.getState().workerFocusMessages.length === 2,
    "ordered worker snapshots must not merge different explicit occurrences"
  )

  resetWorkerFocusStore()
  openWorkerFocusViewForTest({
    threadId: "worker-occurrence-parent-thread",
    workerId: "worker-occurrence-store",
    workerThreadId: occurrenceStoreThreadId
  })
  useAppStore.getState().appendWorkerFocusMessages(occurrenceStoreThreadId, [
    {
      id: "worker-live-occurrence-alias-one",
      provider_source_id: "worker-occurrence-alias-source",
      provider_occurrence: 1,
      role: "assistant",
      content: "old one",
      created_at: new Date()
    },
    {
      id: "worker-live-occurrence-alias-two",
      provider_source_id: "worker-occurrence-alias-source",
      provider_occurrence: 2,
      role: "assistant",
      content: "old two",
      created_at: new Date()
    }
  ])
  useAppStore.getState().appendWorkerFocusMessages(
    occurrenceStoreThreadId,
    [
      {
        id: "worker-snapshot-occurrence-alias-one",
        provider_source_id: "worker-occurrence-alias-source",
        provider_occurrence: 1,
        role: "assistant",
        content: "new alpha",
        created_at: new Date()
      },
      {
        id: "worker-snapshot-occurrence-alias-two",
        provider_source_id: "worker-occurrence-alias-source",
        provider_occurrence: 2,
        role: "assistant",
        content: "new beta",
        created_at: new Date()
      }
    ],
    { orderedSnapshot: true }
  )
  const occurrenceAliasMessages = useAppStore.getState().workerFocusMessages
  assert(
    occurrenceAliasMessages.length === 2 &&
      occurrenceAliasMessages[0]?.content === "new alpha" &&
      occurrenceAliasMessages[1]?.content === "new beta",
    "ordered worker snapshots must update matching explicit alias occurrences"
  )

  resetWorkerFocusStore()
  openWorkerFocusViewForTest({
    threadId: "worker-occurrence-parent-thread",
    workerId: "worker-occurrence-store",
    workerThreadId: occurrenceStoreThreadId
  })
  useAppStore.getState().appendWorkerFocusMessages(occurrenceStoreThreadId, [
    {
      id: "worker-snapshot-occurrence-enrichment",
      role: "assistant",
      content: "old",
      created_at: new Date()
    }
  ])
  useAppStore.getState().appendWorkerFocusMessages(
    occurrenceStoreThreadId,
    [
      {
        id: "worker-snapshot-occurrence-enrichment",
        provider_source_id: "worker-occurrence-enrichment-source",
        provider_occurrence: 2,
        role: "assistant",
        content: "new",
        created_at: new Date()
      }
    ],
    { orderedSnapshot: true }
  )
  const enrichedOccurrenceMessages = useAppStore.getState().workerFocusMessages
  assert(
    enrichedOccurrenceMessages.length === 1 &&
      enrichedOccurrenceMessages[0]?.provider_occurrence === 2 &&
      enrichedOccurrenceMessages[0]?.content === "new",
    "an exact legacy worker id must accept compatible occurrence metadata enrichment"
  )

  resetWorkerFocusStore()
  openWorkerFocusViewForTest({
    threadId: "worker-occurrence-parent-thread",
    workerId: "worker-occurrence-store",
    workerThreadId: occurrenceStoreThreadId
  })
  useAppStore.getState().appendWorkerFocusMessages(occurrenceStoreThreadId, [
    {
      id: "worker-live-occurrence-reservation",
      provider_source_id: "worker-occurrence-reservation-source",
      role: "assistant",
      content: "second",
      created_at: new Date()
    }
  ])
  useAppStore.getState().appendWorkerFocusMessages(
    occurrenceStoreThreadId,
    [
      {
        id: "worker-snapshot-occurrence-reservation-one",
        provider_source_id: "worker-occurrence-reservation-source",
        provider_occurrence: 1,
        role: "assistant",
        content: "first",
        created_at: new Date()
      },
      {
        id: "worker-snapshot-occurrence-reservation-two",
        provider_source_id: "worker-occurrence-reservation-source",
        provider_occurrence: 2,
        role: "assistant",
        content: "second",
        created_at: new Date()
      }
    ],
    { orderedSnapshot: true }
  )
  const occurrenceReservationMessages = useAppStore.getState().workerFocusMessages
  assert(
    occurrenceReservationMessages.length === 2 &&
      occurrenceReservationMessages[0]?.content === "first" &&
      occurrenceReservationMessages[1]?.content === "second" &&
      occurrenceReservationMessages[0]?.provider_occurrence === 1 &&
      occurrenceReservationMessages[1]?.provider_occurrence === 2,
    "an explicit occurrence must not steal a legacy row reserved for another snapshot entry"
  )

  resetWorkerFocusStore()
  const sparseOrderThreadId = "worker-sparse-values-order-thread"
  openWorkerFocusViewForTest({
    threadId: "worker-sparse-values-parent-thread",
    workerId: "worker-sparse-values-order",
    workerThreadId: sparseOrderThreadId
  })
  useAppStore.getState().appendWorkerFocusMessages(sparseOrderThreadId, [
    {
      id: "worker-sparse-order-user",
      role: "user",
      content: "question",
      created_at: new Date()
    },
    {
      id: "worker-sparse-order-call",
      role: "assistant",
      content: "calling",
      tool_calls: [{ id: "worker-sparse-order-tool-call", name: "read_file", args: {} }],
      created_at: new Date()
    },
    {
      id: "worker-sparse-order-tool",
      role: "tool",
      tool_call_id: "worker-sparse-order-tool-call",
      content: "result",
      created_at: new Date()
    },
    {
      id: "worker-sparse-order-final",
      role: "assistant",
      content: "old final",
      created_at: new Date()
    }
  ])
  useAppStore.getState().appendWorkerFocusMessages(
    sparseOrderThreadId,
    [
      {
        id: "worker-sparse-order-user",
        role: "user",
        content: "question",
        created_at: new Date()
      },
      {
        id: "worker-sparse-order-final",
        role: "assistant",
        content: "updated final",
        created_at: new Date()
      }
    ],
    { orderedSnapshot: true }
  )
  const sparseOrderMessages = useAppStore.getState().workerFocusMessages
  assert(
    sparseOrderMessages.map((message) => message.id).join("|") ===
      [
        "worker-sparse-order-user",
        "worker-sparse-order-call",
        "worker-sparse-order-tool",
        "worker-sparse-order-final"
      ].join("|"),
    "a sparse ordered snapshot must not move omitted call and tool rows after the final answer"
  )
  assert(
    sparseOrderMessages[3]?.content === "updated final",
    "a sparse ordered snapshot must still update its matched final answer"
  )

  resetWorkerFocusStore()
  const lowOccurrenceThreadId = "worker-low-occurrence-order-thread"
  openWorkerFocusViewForTest({
    threadId: "worker-low-occurrence-parent-thread",
    workerId: "worker-low-occurrence-order",
    workerThreadId: lowOccurrenceThreadId
  })
  useAppStore.getState().appendWorkerFocusMessages(lowOccurrenceThreadId, [
    {
      id: "worker-low-occurrence-two",
      provider_source_id: "worker-low-occurrence-source",
      provider_occurrence: 2,
      role: "assistant",
      content: "two",
      created_at: new Date()
    },
    {
      id: "worker-low-occurrence-three",
      provider_source_id: "worker-low-occurrence-source",
      provider_occurrence: 3,
      role: "assistant",
      content: "three",
      created_at: new Date()
    }
  ])
  useAppStore.getState().appendWorkerFocusMessages(
    lowOccurrenceThreadId,
    [
      {
        id: "worker-low-occurrence-one",
        provider_source_id: "worker-low-occurrence-source",
        provider_occurrence: 1,
        role: "assistant",
        content: "one",
        created_at: new Date()
      }
    ],
    { orderedSnapshot: true }
  )
  assert(
    useAppStore
      .getState()
      .workerFocusMessages.map((message) => message.content)
      .join("|") === "one|two|three",
    "a single lower worker occurrence must insert before higher same-turn occurrences"
  )

  resetWorkerFocusStore()
  const crossTurnLowOccurrenceThreadId = "worker-cross-turn-low-occurrence-thread"
  openWorkerFocusViewForTest({
    threadId: "worker-cross-turn-low-occurrence-parent",
    workerId: "worker-cross-turn-low-occurrence",
    workerThreadId: crossTurnLowOccurrenceThreadId
  })
  useAppStore.getState().appendWorkerFocusMessages(crossTurnLowOccurrenceThreadId, [
    {
      id: "worker-cross-turn-user-one",
      role: "user",
      content: "question one",
      created_at: new Date()
    },
    {
      id: "worker-cross-turn-occurrence-two",
      provider_source_id: "worker-cross-turn-occurrence-source",
      provider_occurrence: 2,
      role: "assistant",
      content: "two",
      created_at: new Date()
    },
    {
      id: "worker-cross-turn-occurrence-three",
      provider_source_id: "worker-cross-turn-occurrence-source",
      provider_occurrence: 3,
      role: "assistant",
      content: "three",
      created_at: new Date()
    },
    {
      id: "worker-cross-turn-user-two",
      role: "user",
      content: "question two",
      created_at: new Date()
    },
    {
      id: "worker-cross-turn-current",
      role: "assistant",
      content: "current",
      created_at: new Date()
    }
  ])
  useAppStore.getState().appendWorkerFocusMessages(
    crossTurnLowOccurrenceThreadId,
    [
      {
        id: "worker-cross-turn-user-one",
        role: "user",
        content: "question one",
        created_at: new Date()
      },
      {
        id: "worker-cross-turn-occurrence-one",
        provider_source_id: "worker-cross-turn-occurrence-source",
        provider_occurrence: 1,
        role: "assistant",
        content: "one",
        created_at: new Date()
      }
    ],
    { orderedSnapshot: true }
  )
  assert(
    useAppStore
      .getState()
      .workerFocusMessages.map((message) => message.content)
      .join("|") === "question one|one|two|three|question two|current",
    "an exact older user must anchor a sparse lower occurrence to its original worker turn"
  )

  resetWorkerFocusStore()
  const explicitUserOccurrenceThreadId = "worker-explicit-user-occurrence-thread"
  openWorkerFocusViewForTest({
    threadId: "worker-explicit-user-occurrence-parent",
    workerId: "worker-explicit-user-occurrence",
    workerThreadId: explicitUserOccurrenceThreadId
  })
  useAppStore.getState().appendWorkerFocusMessages(explicitUserOccurrenceThreadId, [
    {
      id: "worker-reused-user-id",
      provider_source_id: "worker-reused-user-source",
      provider_occurrence: 1,
      role: "user",
      content: "question one",
      created_at: new Date()
    },
    {
      id: "worker-explicit-user-answer-one",
      role: "assistant",
      content: "answer one",
      created_at: new Date()
    },
    {
      id: "worker-reused-user-id-two",
      provider_source_id: "worker-reused-user-source",
      provider_occurrence: 2,
      role: "user",
      content: "question two",
      created_at: new Date()
    },
    {
      id: "worker-explicit-user-answer-two",
      role: "assistant",
      content: "answer two",
      created_at: new Date()
    }
  ])
  useAppStore.getState().appendWorkerFocusMessages(
    explicitUserOccurrenceThreadId,
    [
      {
        id: "worker-reused-user-id",
        provider_source_id: "worker-reused-user-source",
        provider_occurrence: 2,
        role: "user",
        content: "question two refreshed",
        created_at: new Date()
      },
      {
        id: "worker-explicit-user-new-answer-two",
        role: "assistant",
        content: "new answer two",
        created_at: new Date()
      }
    ],
    { orderedSnapshot: true }
  )
  const explicitUserOccurrenceMessages = useAppStore.getState().workerFocusMessages
  assert(
    explicitUserOccurrenceMessages.length === 5 &&
      explicitUserOccurrenceMessages[2]?.provider_occurrence === 2 &&
      explicitUserOccurrenceMessages[2]?.content === "question two refreshed" &&
      explicitUserOccurrenceMessages[4]?.content === "new answer two" &&
      new Set(explicitUserOccurrenceMessages.map((message) => message.id)).size ===
        explicitUserOccurrenceMessages.length,
    "an explicit user occurrence must update and anchor its own worker turn without duplicate ids"
  )

  resetWorkerFocusStore()
  const reservationIdCollisionThreadId = "worker-reservation-id-collision-thread"
  openWorkerFocusViewForTest({
    threadId: "worker-reservation-id-collision-parent",
    workerId: "worker-reservation-id-collision",
    workerThreadId: reservationIdCollisionThreadId
  })
  useAppStore.getState().appendWorkerFocusMessages(reservationIdCollisionThreadId, [
    {
      id: "worker-reservation-existing",
      provider_source_id: "worker-reservation-source",
      provider_occurrence: 1,
      role: "assistant",
      content: "matching answer",
      created_at: new Date()
    },
    {
      id: "worker-reservation-occupied-id",
      provider_source_id: "worker-unrelated-source",
      provider_occurrence: 1,
      role: "assistant",
      content: "unrelated answer",
      created_at: new Date()
    }
  ])
  useAppStore.getState().appendWorkerFocusMessages(
    reservationIdCollisionThreadId,
    [
      {
        id: "worker-reservation-occupied-id",
        provider_source_id: "worker-reservation-source",
        provider_occurrence: 1,
        role: "assistant",
        content: "matching answer",
        created_at: new Date()
      },
      {
        id: "worker-reservation-second",
        provider_source_id: "worker-reservation-source",
        provider_occurrence: 2,
        role: "assistant",
        content: "new answer",
        created_at: new Date()
      }
    ],
    { orderedSnapshot: true }
  )
  const reservationIdCollisionMessages = useAppStore.getState().workerFocusMessages
  assert(
    reservationIdCollisionMessages.length === 3 &&
      reservationIdCollisionMessages[0]?.id === "worker-reservation-existing" &&
      reservationIdCollisionMessages[1]?.id === "worker-reservation-occupied-id" &&
      new Set(reservationIdCollisionMessages.map((message) => message.id)).size ===
        reservationIdCollisionMessages.length,
    "a repeated occurrence reservation must not adopt an id owned by another worker message"
  )
  resetWorkerFocusStore()
}

function testRepeatedToolCallIdsUseOccurrenceScopedResults(): void {
  const firstCallKey = getWorkerToolUiKey("reused-call-assistant-one", "reused-call", 0)
  const secondCallKey = getWorkerToolUiKey("reused-call-assistant-two", "reused-call", 0)
  const results = buildToolResultAssociations([
    {
      id: "reused-call-assistant-one",
      role: "assistant",
      content: "first call",
      tool_calls: [{ id: "reused-call", name: "read_file", args: { path: "one" } }],
      created_at: new Date()
    },
    {
      id: "reused-call-assistant-two",
      role: "assistant",
      content: "second call",
      tool_calls: [{ id: "reused-call", name: "read_file", args: { path: "two" } }],
      created_at: new Date()
    },
    {
      id: "reused-call-result-one",
      role: "tool",
      content: "result one",
      tool_call_id: "reused-call",
      created_at: new Date()
    },
    {
      id: "reused-call-result-two",
      role: "tool",
      content: "result two",
      tool_call_id: "reused-call",
      is_error: true,
      created_at: new Date()
    }
  ])

  assert(
    firstCallKey !== secondCallKey &&
      results.size === 2 &&
      results.get(firstCallKey)?.content === "result one" &&
      results.get(firstCallKey)?.is_error !== true &&
      results.get(secondCallKey)?.content === "result two" &&
      results.get(secondCallKey)?.is_error === true,
    "reused tool-call ids must associate results with transcript call occurrences in order"
  )

  const oldTurnKey = getWorkerToolUiKey("reused-turn-assistant-one", "reused-turn-call", 0)
  const currentTurnKey = getWorkerToolUiKey(
    "reused-turn-assistant-two",
    "reused-turn-call",
    0
  )
  const crossTurnResults = buildToolResultAssociations([
    {
      id: "reused-turn-user-one",
      role: "user",
      content: "first turn",
      created_at: new Date()
    },
    {
      id: "reused-turn-assistant-one",
      role: "assistant",
      content: "interrupted call",
      tool_calls: [{ id: "reused-turn-call", name: "read_file", args: { path: "old" } }],
      created_at: new Date()
    },
    {
      id: "reused-turn-user-two",
      role: "user",
      content: "second turn",
      created_at: new Date()
    },
    {
      id: "reused-turn-assistant-two",
      role: "assistant",
      content: "current call",
      tool_calls: [{ id: "reused-turn-call", name: "read_file", args: { path: "new" } }],
      created_at: new Date()
    },
    {
      id: "reused-turn-result-two",
      role: "tool",
      content: "current result",
      tool_call_id: "reused-turn-call",
      created_at: new Date()
    }
  ])
  assert(
    crossTurnResults.get(oldTurnKey) === undefined &&
      crossTurnResults.get(currentTurnKey)?.content === "current result",
    "a reused call id must prefer the latest user turn over an old interrupted call"
  )

  const unscopedCallKey = getWorkerToolUiKey(
    "mixed-scope-assistant",
    "mixed-scope-call",
    0
  )
  const mixedScopeResult = buildToolResultAssociations([
    {
      id: "mixed-scope-assistant",
      role: "assistant",
      content: "legacy live call",
      tool_calls: [{ id: "mixed-scope-call", name: "read_file", args: {} }],
      created_at: new Date()
    },
    {
      id: "worker-turn-mixed-scope-worker-1::mixed-scope-result",
      role: "tool",
      content: "scoped result",
      tool_call_id: "mixed-scope-call",
      created_at: new Date()
    }
  ])
  assert(
    mixedScopeResult.get(unscopedCallKey)?.content === "scoped result",
    "a scoped tool result must bridge to one unscoped pending call with the same raw id"
  )

  const scopedCallKey = getWorkerToolUiKey(
    "worker-turn-mixed-scope-worker-2::scoped-assistant",
    "mixed-scope-reverse-call",
    0
  )
  const reverseMixedScopeResult = buildToolResultAssociations([
    {
      id: "worker-turn-mixed-scope-worker-2::scoped-assistant",
      role: "assistant",
      content: "scoped live call",
      tool_calls: [{ id: "mixed-scope-reverse-call", name: "read_file", args: {} }],
      created_at: new Date()
    },
    {
      id: "legacy-unscoped-result",
      role: "tool",
      content: "legacy result",
      tool_call_id: "mixed-scope-reverse-call",
      created_at: new Date()
    }
  ])
  assert(
    reverseMixedScopeResult.get(scopedCallKey)?.content === "legacy result",
    "an unscoped tool result must bridge to the latest scoped pending call"
  )

  const oldMixedCallKey = getWorkerToolUiKey(
    "legacy-old-mixed-assistant",
    "mixed-latest-call",
    0
  )
  const latestMixedCallKey = getWorkerToolUiKey(
    "worker-turn-mixed-scope-worker-2::latest-mixed-assistant",
    "mixed-latest-call",
    0
  )
  const latestMixedScopeResult = buildToolResultAssociations([
    {
      id: "legacy-old-mixed-assistant",
      role: "assistant",
      content: "old interrupted call",
      tool_calls: [{ id: "mixed-latest-call", name: "read_file", args: {} }],
      created_at: new Date()
    },
    {
      id: "worker-turn-mixed-scope-worker-2::latest-mixed-assistant",
      role: "assistant",
      content: "latest call",
      tool_calls: [{ id: "mixed-latest-call", name: "read_file", args: {} }],
      created_at: new Date()
    },
    {
      id: "legacy-latest-result",
      role: "tool",
      content: "latest result",
      tool_call_id: "mixed-latest-call",
      created_at: new Date()
    }
  ])
  assert(
    latestMixedScopeResult.get(oldMixedCallKey) === undefined &&
      latestMixedScopeResult.get(latestMixedCallKey)?.content === "latest result",
    "an unscoped result must not prefer an older unscoped call over a newer scoped call"
  )

  const wrongTurnCallKey = getWorkerToolUiKey(
    "worker-turn-mixed-scope-worker-1::wrong-turn-assistant",
    "wrong-turn-call",
    0
  )
  const wrongTurnResult = buildToolResultAssociations([
    {
      id: "worker-turn-mixed-scope-worker-1::wrong-turn-assistant",
      role: "assistant",
      content: "turn one call",
      tool_calls: [{ id: "wrong-turn-call", name: "read_file", args: {} }],
      created_at: new Date()
    },
    {
      id: "worker-turn-mixed-scope-worker-2::wrong-turn-user",
      role: "user",
      content: "turn two",
      created_at: new Date()
    },
    {
      id: "worker-turn-mixed-scope-worker-2::wrong-turn-result",
      role: "tool",
      content: "turn two orphan result",
      tool_call_id: "wrong-turn-call",
      created_at: new Date()
    }
  ])
  assert(
    wrongTurnResult.get(wrongTurnCallKey) === undefined,
    "a scoped result must never fall back to a call from a different scoped turn"
  )
}

async function run(): Promise<void> {
  testSummarizationMessagesAreHiddenByMarkerOnly()
  console.log("PASS electron transport filters summarization by structural marker only")
  testWorkerFocusStorePreservesCrossRoleProviderIdCollision()
  console.log("PASS worker focus preserves cross-role provider id collisions")
  testWorkerFocusStoreNormalizesLegacyCrossRoleBaseline()
  console.log("PASS worker focus normalizes legacy cross-role baseline")
  testWorkerFocusDoesNotMergeAssistantGrowthAcrossUserTurns()
  console.log("PASS worker focus replay matching respects user turn boundaries")
  testWorkerFullValuesSnapshotsKeepHistoricalIdsStableAcrossTurns()
  console.log("PASS worker full values preserve historical ids across turns")
  testWorkerOccurrenceReplayStateRegressions()
  console.log("PASS worker occurrence replay state regressions")
  testRepeatedToolCallIdsUseOccurrenceScopedResults()
  console.log("PASS repeated tool-call ids use occurrence-scoped results")
  testCrossRoleProviderIdCollisionSurvivesTransportConversion()
  console.log("PASS electron transport preserves cross-role provider id collisions")
  testWorkflowSnapshotPreservesSameRoleProviderIdOccurrences()
  console.log("PASS electron transport preserves same-role workflow snapshot occurrences")
  testMainStreamNormalizesCrossRoleIdsBeforeSdkMerge()
  console.log("PASS electron transport normalizes cross-role ids before SDK merge")
  testWorkflowSnapshotConverterSurvivesCorruptToolCalls()
  console.log("PASS electron transport workflow converter survives corrupt tool_calls")
  await testSubagentInternalsAreHiddenButObservable()
  console.log("PASS electron transport hides subagent internals")
  await testConcurrentSubagentsStreamingIndexZeroDoNotCrossContaminate()
  console.log("PASS electron transport keeps interleaved index-0 subagent args separate")
  await testConcurrentSubagentsReusingInnerToolIdDoNotCrossContaminate()
  console.log("PASS electron transport scopes reused inner tool-call ids by subagent execution")
  await testSubagentDeltaArgsPreserveRepeatedFragments()
  console.log("PASS electron transport preserves repeated delta arg fragments")
  await testOwnerMetadataAttributesConcurrentSubagentsDeterministically()
  console.log("PASS electron transport attributes concurrent subagents via owner metadata")
  await testInnerToolIdCollisionStillAllowsRealTaskCompletion()
  console.log("PASS inner tool ID collision still allows real task completion")
  await testValuesMarksOnlyLatestHumanTurnSubagentsObservedLive()
  console.log("PASS values marks only latest-turn subagents observed live")
  await testTaskResultMessageIdsAreScopedByTaskCall()
  console.log("PASS task result message IDs are scoped by task call")
  await testReusedTaskAndResultIdsAcrossStreamsCompleteLatestExecution()
  console.log("PASS reused task and result IDs complete the latest stream execution")
  await testValuesSnapshotUsesNearestReusedTaskInvocationForResults()
  console.log("PASS values results follow the nearest reused task invocation")
  await testReusedTaskIdKeepsOldResultAndLateAssistantOnFirstExecution()
  console.log("PASS reused task IDs preserve old result and late assistant ownership")
  await testIdlessTaskAdoptsProviderParentWithoutDuplicateExecution()
  console.log("PASS id-less task adopts provider parent without duplicate execution")
  await testRestartRestoresReusedTaskIdByPersistedInvocationIdentity()
  console.log("PASS restart restores reused task IDs by persisted invocation identity")
  await testPrunedValuesClaimsLegacyExecutionByUniquePrompt()
  console.log("PASS pruned values claims legacy execution by unique prompt")
  await testSubagentIdlessContinuationChunksStitchArgsByIndex()
  console.log("PASS electron transport stitches id-less subagent arg chunks by index")
  await testPrefixedNamespaceRoutesConcurrentSubagentInternals()
  console.log("PASS electron transport routes prefixed concurrent subagent namespaces")
  await testSubagentToolCallChunksHydrateTranscriptArgs()
  console.log("PASS electron transport hydrates subagent transcript chunk args")
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
  await testLargeCoordinatorToolArgsParseOnlyAfterCompletion()
  console.log("PASS electron transport handles large streamed file arguments")
  await testCoordinatorTaskIdlessContinuationRegistersSubagent()
  console.log("PASS electron transport registers task calls completed by id-less chunks")
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
  await testMainReasoningSnapshotsCoalesceWithinThrottleWindow()
  console.log("PASS electron transport coalesces main reasoning snapshots every 50ms")
  await testMainReasoningFlushesBeforeToolBoundary()
  console.log("PASS electron transport flushes main reasoning before tool start")
  await testMainReasoningFlushesAtStreamEnd()
  console.log("PASS electron transport flushes main reasoning at stream end")
  await testQueuedSubagentSnapshotsCoalesceAndStayBounded()
  console.log("PASS electron transport coalesces bounded queued subagent snapshots")
  await testQueuedFinalCorrectionsPreserveRepairMetadata()
  console.log("PASS electron transport preserves queued final repair metadata")
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
  await testStableTranscriptHistoryDoesNotReplayAcrossStreams()
  console.log("PASS electron transport avoids stable transcript history replay across streams")
  await testInterruptedStreamDoesNotSuppressStableTranscriptRecovery()
  console.log("PASS electron transport rehydrates stable history after interruption")
  await testStableTranscriptSignaturesDoNotThrashPastOneThousand()
  console.log("PASS electron transport stable transcript signatures avoid 1000-entry thrash")
  await testSubagentThinkingStreamingAccumulation()
  console.log("PASS electron transport accumulates streamed subagent thinking")
  await testSubagentCumulativeThinkingContinuesPast16k()
  console.log("PASS electron transport keeps cumulative subagent text past 16k")
  await testSubagentReasoningOnlyStreamingIsLosslessAndSeparate()
  console.log("PASS electron transport keeps reasoning-only subagent streams lossless")
  await testSubagentPrefixRelatedTextDeltasAreNotDropped()
  console.log("PASS electron transport preserves prefix-related subagent text deltas")
  await testSubagentRepeatedTextDeltasAreNotDropped()
  console.log("PASS electron transport preserves repeated subagent text deltas")
  await testTaskResultRebasesStreamedTerminalAssistant()
  console.log("PASS electron transport rebases streamed terminal assistant on completion")
  await testConcurrentSubagentsDoNotShareProviderAccumulator()
  console.log("PASS electron transport isolates concurrent subagent provider ids")
  await testTaskFinalRepairsPersistedLiveMessageAcrossTransportReset()
  console.log("PASS electron transport repairs persisted live messages after reset")
  await testIdlessSubagentAssistantTurnsSplitAtToolResult()
  console.log("PASS electron transport splits id-less subagent turns at tool results")
  await testFailedTaskResultBackfillsVisibleDiagnostic()
  console.log("PASS electron transport backfills failed task diagnostics")
  await testLaterValuesErrorUpgradesCompletedSubagentMonotonically()
  console.log("PASS electron transport keeps subagent terminal status monotonic")
  await testFinalReplayFingerprintIncludesCompleteMiddleContent()
  console.log("PASS electron transport fingerprints complete final content")
}

async function testInnerToolIdCollisionStillAllowsRealTaskCompletion(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const ownerKey = "cmb_subagent_owner_tool_call_id"
  const sharedId = "task-and-inner-shared"
  convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "parent-collision",
        toolCalls: [
          {
            id: sharedId,
            name: "task",
            args: { subagent_type: "verifier", description: "collision task" }
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )
  const ns = "agent:tools:collision-task-uuid|read_file:1"
  convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "child-collision-ai",
        toolCalls: [{ id: sharedId, name: "read_file", args: { path: "a.ts" } }]
      }),
      { langgraph_checkpoint_ns: ns, [ownerKey]: sharedId }
    )
  )
  const childResult = convert(
    transport,
    streamMessageEvent(
      toolMessage({
        id: "child-collision-result",
        name: "read_file",
        toolCallId: sharedId,
        content: "child data"
      }),
      { langgraph_checkpoint_ns: ns, [ownerKey]: sharedId }
    )
  )
  assert(
    messageEvents(childResult).length === 0,
    "an explicitly owned inner ToolMessage must not leak into the parent transcript"
  )

  const namelessInnerResult = convert(
    transport,
    streamMessageEvent(
      toolMessage({
        id: "nameless-inner-collision-result",
        toolCallId: sharedId,
        content: "nameless child data"
      }),
      { langgraph_checkpoint_ns: ns }
    )
  )
  assert(
    messageEvents(namelessInnerResult).length === 0 &&
      customEvents(namelessInnerResult, "subagent_transcript_message").every(
        (event) => asRecord(event.subagentMessage).id !== `subagent-final-${sharedId}`
      ),
    "a nameless inner result with namespace evidence must not complete the parent"
  )

  const parentResult = convert(
    transport,
    streamMessageEvent(
      toolMessage({
        id: "parent-collision-result",
        name: "task",
        toolCallId: sharedId,
        content: "parent complete"
      }),
      { langgraph_node: "tools", langgraph_checkpoint_ns: ns }
    )
  )
  const subagents = customEvents(parentResult, "subagents")[0]?.subagents as Array<
    Record<string, unknown>
  >
  const final = customEvents(parentResult, "subagent_transcript_message").find(
    (event) => asRecord(event.subagentMessage).id === `subagent-final-${sharedId}`
  )
  assert(
    subagents?.find((subagent) => subagent.id === sharedId)?.status === "completed",
    "a root task ToolMessage must still complete the parent after an inner raw-ID collision"
  )
  assert(
    final?.subagentId === sharedId &&
      asRecord(final.subagentMessage).content === "parent complete",
    "the real parent completion should produce the stable final transcript row"
  )
}

async function testValuesMarksOnlyLatestHumanTurnSubagentsObservedLive(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const oldTaskId = "historical-values-task"
  const currentTaskId = "current-values-task"
  const values = convert(
    transport,
    streamValuesEvent([
      aiMessage({
        id: "historical-parent",
        toolCalls: [
          {
            id: oldTaskId,
            name: "task",
            args: { subagent_type: "verifier", description: "historical task" }
          }
        ]
      }),
      humanMessage("current turn", { id: "current-human" }),
      aiMessage({
        id: "current-parent",
        toolCalls: [
          {
            id: currentTaskId,
            name: "task",
            args: { subagent_type: "verifier", description: "current task" }
          }
        ]
      })
    ])
  )
  const subagents = customEvents(values, "subagents").at(-1)?.subagents as
    | Array<Record<string, unknown>>
    | undefined
  assert(
    subagents?.find((subagent) => subagent.toolCallId === oldTaskId)?.observedLive !== true,
    "a historical values-only task before the latest HumanMessage must stay non-live"
  )
  assert(
    subagents?.find((subagent) => subagent.toolCallId === currentTaskId)?.observedLive === true,
    "a task after the latest HumanMessage must carry current-turn live evidence"
  )
}

async function testTaskResultMessageIdsAreScopedByTaskCall(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const register = (parentId: string, taskId: string): void => {
    convert(
      transport,
      streamMessageEvent(
        aiMessage({
          id: parentId,
          toolCalls: [
            {
              id: taskId,
              name: "task",
              args: { subagent_type: "verifier", description: taskId }
            }
          ]
        }),
        { langgraph_node: "agent" }
      )
    )
  }
  register("parent-result-a", "task-result-a")
  convert(
    transport,
    streamMessageEvent(
      toolMessage({
        id: "provider-reused-result-id",
        name: "task",
        toolCallId: "task-result-a",
        content: "result A"
      }),
      { langgraph_node: "tools" }
    )
  )
  register("parent-result-b", "task-result-b")
  const second = convert(
    transport,
    streamMessageEvent(
      toolMessage({
        id: "provider-reused-result-id",
        name: "task",
        toolCallId: "task-result-b",
        content: "result B"
      }),
      { langgraph_node: "tools" }
    )
  )
  const subagents = customEvents(second, "subagents")[0]?.subagents as Array<
    Record<string, unknown>
  >
  const final = customEvents(second, "subagent_transcript_message").find(
    (event) => event.subagentId === "task-result-b"
  )
  assert(
    subagents?.find((subagent) => subagent.id === "task-result-b")?.status === "completed",
    "the same provider result message ID under a different task call must complete task B"
  )
  assert(
    asRecord(final?.subagentMessage).content === "result B",
    "task B must not be routed to task A's result-message mapping"
  )
}

async function testReusedTaskAndResultIdsAcrossStreamsCompleteLatestExecution(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const rawTaskId = "task-result-reused-across-streams"
  const resultMessageId = "result-reused-across-streams"
  const register = (parentId: string, description: string): SdkEvent[] =>
    convert(
      transport,
      streamMessageEvent(
        aiMessage({
          id: parentId,
          toolCalls: [
            {
              id: rawTaskId,
              name: "task",
              args: { subagent_type: "verifier", description }
            }
          ]
        }),
        { langgraph_node: "agent" }
      )
    )

  const sharedParentId = "parent-result-reused-across-streams"
  const firstRegistration = register(sharedParentId, "identical stream task")
  const firstExecutionId = String(
    (customEvents(firstRegistration, "subagents")[0]?.subagents as Array<
      Record<string, unknown>
    >)?.find((subagent) => subagent.toolCallId === rawTaskId)?.id
  )
  convert(
    transport,
    streamMessageEvent(
      toolMessage({
        id: resultMessageId,
        name: "task",
        toolCallId: rawTaskId,
        content: "identical provider result"
      }),
      { langgraph_node: "tools" }
    )
  )

  // Entering the next transport lifecycle clears active executions but keeps
  // replay identities. The generator need not run for this boundary assertion.
  await transport.stream({
    input: { messages: [{ type: "human", content: "next stream" }] },
    config: { configurable: { thread_id: "thread-123", agent_mode: "normal" } },
    signal: new AbortController().signal
  } as never)

  const secondRegistration = register(sharedParentId, "identical stream task")
  const secondExecution = (
    customEvents(secondRegistration, "subagents")[0]?.subagents as Array<
      Record<string, unknown>
    >
  )?.find(
    (subagent) => subagent.toolCallId === rawTaskId && subagent.status === "running"
  )
  assert(secondExecution?.id, "the second stream should register a new active execution")
  assert(
    secondExecution.id !== firstExecutionId,
    "reusing parent/task IDs across streams must allocate a distinct transcript bucket"
  )

  const earlyInterior = convert(
    transport,
    streamMessageEvent(aiMessageChunk({ id: "same-stream-child", content: "new interior" }), {
      langgraph_checkpoint_ns: "agent:tools:new-stream-task-uuid|model:1",
      cmb_subagent_owner_tool_call_id: rawTaskId
    })
  )
  assert(
    customEvents(earlyInterior, "subagent_transcript_message")[0]?.subagentId ===
      secondExecution.id,
    "interior output before values reconciliation must stay in the new stream bucket"
  )

  convert(
    transport,
    streamValuesEvent([
      aiMessage({
        id: sharedParentId,
        toolCalls: [
          {
            id: rawTaskId,
            name: "task",
            args: { subagent_type: "verifier", description: "identical stream task" }
          }
        ]
      })
    ])
  )

  const secondResult = convert(
    transport,
    streamMessageEvent(
      toolMessage({
        id: resultMessageId,
        name: "task",
        toolCallId: rawTaskId,
        content: "identical provider result"
      }),
      { langgraph_node: "tools" }
    )
  )
  const subagents = customEvents(secondResult, "subagents")[0]?.subagents as Array<
    Record<string, unknown>
  >
  const final = customEvents(secondResult, "subagent_transcript_message").find(
    (event) => event.subagentId === secondExecution.id
  )
  assert(
    subagents?.find((subagent) => subagent.id === secondExecution.id)?.status === "completed",
    "a stale cross-stream result mapping must not leave the latest execution running"
  )
  assert(
    asRecord(final?.subagentMessage).content === "identical provider result",
    "the reused provider result must finalize the latest stream execution"
  )
}

async function testValuesSnapshotUsesNearestReusedTaskInvocationForResults(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const rawTaskId = "task-result-reused-in-values"
  const resultMessageId = "result-reused-in-values"
  const events = convert(
    transport,
    streamValuesEvent([
      aiMessage({
        id: "parent-values-result-one",
        toolCalls: [
          {
            id: rawTaskId,
            name: "task",
            args: { subagent_type: "verifier", description: "first values invocation" }
          }
        ]
      }),
      toolMessage({
        id: resultMessageId,
        name: "task",
        toolCallId: rawTaskId,
        content: "identical values result"
      }),
      aiMessage({
        id: "parent-values-result-two",
        toolCalls: [
          {
            id: rawTaskId,
            name: "task",
            args: { subagent_type: "verifier", description: "second values invocation" }
          }
        ]
      }),
      toolMessage({
        id: resultMessageId,
        name: "task",
        toolCallId: rawTaskId,
        content: "identical values result"
      })
    ])
  )
  const subagents = customEvents(events, "subagents")[0]?.subagents as Array<
    Record<string, unknown>
  >
  const executions = subagents?.filter((subagent) => subagent.toolCallId === rawTaskId) ?? []
  assert(
    executions.length === 2 && executions.every((subagent) => subagent.status === "completed"),
    "each reused task occurrence in a values snapshot must receive its nearest result"
  )
  const finalExecutionIds = new Set(
    customEvents(events, "subagent_transcript_message")
      .filter((event) => asRecord(event.subagentMessage).content === "identical values result")
      .map((event) => String(event.subagentId))
  )
  assert(
    executions.every((subagent) => finalExecutionIds.has(String(subagent.id))),
    "identical reused values results must finalize both logical executions"
  )
}

async function testReusedTaskIdKeepsOldResultAndLateAssistantOnFirstExecution(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const ownerKey = "cmb_subagent_owner_tool_call_id"
  const rawTaskId = "shared-task-reuse"
  convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "parent-reuse-1",
        toolCalls: [
          {
            id: rawTaskId,
            name: "task",
            args: { subagent_type: "verifier", description: "first execution" }
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )
  const oldNs = "agent:tools:old-task-uuid|model:1"
  convert(
    transport,
    streamMessageEvent(aiMessageChunk({ id: "old-child-ai", content: "old start" }), {
      langgraph_checkpoint_ns: oldNs,
      [ownerKey]: rawTaskId
    })
  )
  convert(
    transport,
    streamMessageEvent(
      toolMessage({
        id: "old-parent-result",
        name: "task",
        toolCallId: rawTaskId,
        content: "old final"
      }),
      { langgraph_node: "tools" }
    )
  )
  const secondRegistration = convert(
    transport,
    streamMessageEvent(
      aiMessage({
        id: "parent-reuse-2",
        toolCalls: [
          {
            id: rawTaskId,
            name: "task",
            args: { subagent_type: "verifier", description: "second execution" }
          }
        ]
      }),
      { langgraph_node: "agent" }
    )
  )
  const registered = customEvents(secondRegistration, "subagents")[0]?.subagents as Array<
    Record<string, unknown>
  >
  const secondExecution = registered.find(
    (subagent) => subagent.toolCallId === rawTaskId && subagent.id !== rawTaskId
  )
  assert(secondExecution?.status === "running", "the reused raw task ID should create execution 2")

  const replay = convert(
    transport,
    streamMessageEvent(
      toolMessage({
        id: "old-parent-result",
        name: "task",
        toolCallId: rawTaskId,
        content: "old final"
      }),
      { langgraph_node: "tools" }
    )
  )
  const replayState = customEvents(replay, "subagents")[0]?.subagents as
    | Array<Record<string, unknown>>
    | undefined
  assert(
    !replayState ||
      replayState.find((subagent) => subagent.id === secondExecution?.id)?.status === "running",
    "replaying execution 1's result must not complete execution 2"
  )

  const late = convert(
    transport,
    streamMessageEvent(aiMessageChunk({ id: "old-child-ai", content: " late" }), {
      langgraph_checkpoint_ns: oldNs,
      [ownerKey]: rawTaskId
    })
  )
  const lateTranscript = customEvents(late, "subagent_transcript_message")[0]
  assert(
    lateTranscript?.subagentId === rawTaskId,
    "a checkpoint UUID pinned before raw task-ID reuse must keep late assistant text on execution 1"
  )
}

async function testIdlessTaskAdoptsProviderParentWithoutDuplicateExecution(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const taskCall = {
    id: "task-idless-provider",
    name: "task",
    args: { subagent_type: "verifier", description: "same invocation" }
  }
  convert(
    transport,
    streamMessageEvent(aiMessage({ toolCalls: [taskCall] }), { langgraph_node: "agent" })
  )
  const values = convert(
    transport,
    streamValuesEvent([aiMessage({ id: "provider-parent-adopted", toolCalls: [taskCall] })])
  )
  const subagents = customEvents(values, "subagents")[0]?.subagents as Array<
    Record<string, unknown>
  >
  const promptPatch = customEvents(values, "subagent_transcript_message").find(
    (event) => event.subagentId === taskCall.id
  )
  assert(
    subagents?.filter((subagent) => subagent.toolCallId === taskCall.id).length === 1,
    "id-less live registration and provider-ID values must resolve to one execution"
  )
  assert(
    String(asRecord(promptPatch?.subagentMessage).subagent_invocation_scope).startsWith(
      "task-v1-"
    ),
    "values reconciliation should patch the prompt with the shared checkpoint identity"
  )
}

async function testRestartRestoresReusedTaskIdByPersistedInvocationIdentity(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const rawTaskId = "restart-reused-task"
  const firstTask = {
    id: rawTaskId,
    name: "task",
    args: { subagent_type: "implementer", description: "first persisted invocation" }
  }
  const secondTask = {
    id: rawTaskId,
    name: "task",
    args: { subagent_type: "verifier", description: "second persisted invocation" }
  }
  const firstScope = buildSubagentTaskInvocationIdentity({
    parentMessageId: "provider-parent-first",
    parentOccurrence: 1,
    parentContent: "",
    parentToolCalls: [firstTask],
    taskToolCallId: rawTaskId,
    taskToolCallIndex: 0,
    taskArgs: firstTask.args
  })
  const secondScope = buildSubagentTaskInvocationIdentity({
    parentMessageId: "provider-parent-second",
    parentOccurrence: 1,
    parentContent: "",
    parentToolCalls: [secondTask],
    taskToolCallId: rawTaskId,
    taskToolCallIndex: 0,
    taskArgs: secondTask.args
  })
  const secondExecutionId = `${rawTaskId}::invocation-old-fallback-parent`
  const prompt = (executionId: string, content: string, scope: string): Message => ({
    id: `subagent-prompt-${executionId}`,
    role: "user",
    content,
    content_priority: 1,
    subagent_tool_call_id: rawTaskId,
    subagent_invocation_scope: scope,
    created_at: new Date("2026-01-01T00:00:00.000Z")
  })
  transport.seedSubagentTranscriptBaseline("thread-123", {
    [rawTaskId]: [prompt(rawTaskId, "first persisted invocation", firstScope)],
    [secondExecutionId]: [
      prompt(secondExecutionId, "second persisted invocation", secondScope)
    ]
  })

  const values = convert(
    transport,
    streamValuesEvent([
      aiMessage({ id: "provider-parent-first", toolCalls: [firstTask] }),
      aiMessage({ id: "provider-parent-second", toolCalls: [secondTask] })
    ])
  )
  const snapshots = customEvents(values, "subagents")
  const subagents = snapshots.at(-1)?.subagents as Array<Record<string, unknown>> | undefined
  const promptEvents = customEvents(values, "subagent_transcript_message").filter(
    (event) => asRecord(event.subagentMessage).role === "user"
  )

  assert(
    subagents?.some((subagent) => subagent.id === rawTaskId) &&
      subagents.some((subagent) => subagent.id === secondExecutionId) &&
      subagents.length === 2,
    "restart recovery must reclaim both persisted buckets when a raw task id was reused"
  )
  assert(
    promptEvents.length === 0,
    "exact task-v1 identity matches must not create duplicate prompt rows after restart"
  )
}

async function testPrunedValuesClaimsLegacyExecutionByUniquePrompt(): Promise<void> {
  const transport = new ElectronIPCTransport()
  const rawTaskId = "legacy-pruned-task"
  const legacy = (executionId: string, prompt: string): Message => ({
    id: `subagent-prompt-${executionId}`,
    role: "user",
    content: prompt,
    created_at: new Date("2026-01-01T00:00:00.000Z")
  })
  transport.seedSubagentTranscriptBaseline("thread-123", {
    [rawTaskId]: [legacy(rawTaskId, "old first prompt")],
    [`${rawTaskId}::execution-2`]: [
      legacy(`${rawTaskId}::execution-2`, "new retained prompt")
    ]
  })
  const values = convert(
    transport,
    streamValuesEvent([
      aiMessage({
        id: "retained-parent",
        toolCalls: [
          {
            id: rawTaskId,
            name: "task",
            args: { subagent_type: "verifier", description: "new retained prompt" }
          }
        ]
      })
    ])
  )
  const subagents = customEvents(values, "subagents")[0]?.subagents as Array<
    Record<string, unknown>
  >
  assert(
    subagents?.[0]?.id === `${rawTaskId}::execution-2`,
    "a pruned snapshot must claim the uniquely matching legacy prompt, not the first raw bucket"
  )
  const promptPatch = customEvents(values, "subagent_transcript_message")[0]
  assert(
    promptPatch?.subagentId === `${rawTaskId}::execution-2`,
    "legacy metadata repair must target the retained execution without overwriting execution 1"
  )
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
