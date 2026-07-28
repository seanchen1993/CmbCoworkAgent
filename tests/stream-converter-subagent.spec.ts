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

type SubagentSnapshot = Array<{
  id: string
  toolCallId?: string
  status?: string
}>

function latestSubagents(events: ReturnType<StreamConverter["processChunk"]>): SubagentSnapshot {
  const snapshots = events.flatMap((event) => {
    if (event.type !== "custom" || event.data.type !== "subagents") return []
    return Array.isArray(event.data.subagents)
      ? [event.data.subagents as SubagentSnapshot]
      : []
  })
  return snapshots[snapshots.length - 1] ?? []
}

function transcriptMessages(
  events: ReturnType<StreamConverter["processChunk"]>
): Array<Record<string, unknown>> {
  return events.flatMap((event) => {
    if (event.type !== "custom" || event.data.type !== "subagent_transcript_message") return []
    const message = event.data.subagentMessage
    return message && typeof message === "object" && !Array.isArray(message)
      ? [message as Record<string, unknown>]
      : []
  })
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
  ownerHint?: string
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
    {
      langgraph_checkpoint_ns: input.checkpointNs,
      ...(input.ownerHint && { cmb_subagent_owner_tool_call_id: input.ownerHint })
    }
  ]
}

async function testSubagentToolErrorsAreForwarded(): Promise<void> {
  const converter = new StreamConverter("tool-error-run")

  const registration = converter.processChunk(
    "messages",
    aiMessage("main-ai", [
      {
        id: "task-1",
        name: "task",
        args: { subagent_type: "implementer", description: "inspect failure" }
      }
    ])
  )
  const executionId = latestSubagents(registration).find(
    (subagent) => subagent.toolCallId === "task-1"
  )?.id
  assert(executionId, "task-1 should register a logical execution")

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
  assert(toolEvent?.subagentId === executionId, "tool-message should target the logical execution")
  assert(toolEvent?.isError === true, "failed subagent tool result should preserve isError")
}

async function testPrefixedNamespaceRoutesConcurrentSubagents(): Promise<void> {
  const converter = new StreamConverter("concurrent-run")

  const registration = converter.processChunk(
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
  const registered = latestSubagents(registration)
  const firstExecutionId = registered.find((subagent) => subagent.toolCallId === "task-1")?.id
  const secondExecutionId = registered.find((subagent) => subagent.toolCallId === "task-2")?.id
  assert(firstExecutionId && secondExecutionId, "both concurrent tasks should register")

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
  assert(
    firstToolEvent?.subagentId === firstExecutionId,
    "first runtime task uuid should map to task-1's execution"
  )

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
    secondToolEvent?.subagentId === secondExecutionId,
    "second runtime task uuid should map to the next running execution"
  )
}

async function testSubagentToolCallChunksAreForwarded(): Promise<void> {
  const converter = new StreamConverter("chunk-run")

  const registration = converter.processChunk(
    "messages",
    aiMessage("main-ai", [
      {
        id: "task-1",
        name: "task",
        args: { subagent_type: "implementer", description: "stream chunks" }
      }
    ])
  )
  const executionId = latestSubagents(registration).find(
    (subagent) => subagent.toolCallId === "task-1"
  )?.id
  assert(executionId, "chunk test task should register an execution")

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
  assert(
    assistantEvent?.subagentId === executionId,
    "chunked tool call should target the logical execution"
  )
  const toolCalls = assistantEvent?.toolCalls as
    | Array<{ id?: string; name?: string; args?: Record<string, unknown> }>
    | undefined
  assert(toolCalls?.[0]?.name === "read_file", "chunked tool call should preserve tool name")
  assert(
    toolCalls?.[0]?.args?.file_path === "README.md",
    "chunked tool call should hydrate full JSON args"
  )
}

async function testReusedTaskIdsAreScopedAcrossRunsAndResults(): Promise<void> {
  const rawTaskId = "scheduler-reused-task"
  const taskCall = {
    id: rawTaskId,
    name: "task",
    args: { subagent_type: "implementer", description: "same provider invocation" }
  }
  const firstConverter = new StreamConverter("scheduler-run-one")
  const firstRegistration = firstConverter.processChunk(
    "messages",
    aiMessage("scheduler-reused-parent", [taskCall])
  )
  const firstExecutionId = latestSubagents(firstRegistration)[0]?.id
  assert(firstExecutionId, "the first scheduler run should register an execution")
  firstConverter.processChunk(
    "messages",
    toolMessage({
      id: "scheduler-reused-result",
      toolCallId: rawTaskId,
      name: "task",
      content: "identical result",
      checkpointNs: "agent"
    })
  )

  const secondConverter = new StreamConverter("scheduler-run-two")
  const secondRegistration = secondConverter.processChunk(
    "messages",
    aiMessage("scheduler-reused-parent", [taskCall])
  )
  const secondExecutionId = latestSubagents(secondRegistration)[0]?.id
  assert(secondExecutionId, "the second scheduler run should register an execution")
  assert(
    secondExecutionId !== firstExecutionId,
    "separate scheduler runs must not merge reused raw task IDs into one transcript bucket"
  )
  const secondCompletion = secondConverter.processChunk(
    "messages",
    toolMessage({
      id: "scheduler-reused-result",
      toolCallId: rawTaskId,
      name: "task",
      content: "identical result",
      checkpointNs: "agent"
    })
  )
  assert(
    latestSubagents(secondCompletion).find((subagent) => subagent.id === secondExecutionId)
      ?.status === "completed",
    "a reused result ID in a later scheduler run must complete that run's execution"
  )

  const sameRunConverter = new StreamConverter("scheduler-same-run")
  const sameRunFirst = sameRunConverter.processChunk(
    "messages",
    aiMessage("scheduler-parent-one", [taskCall])
  )
  const sameRunFirstId = latestSubagents(sameRunFirst)[0]?.id
  const oldCheckpointNs = "agent:tools:scheduler-old-task-uuid|read_file:1"
  sameRunConverter.processChunk(
    "messages",
    toolMessage({
      id: "same-run-old-inner",
      toolCallId: "same-run-old-inner-call",
      name: "read_file",
      content: "old inner",
      checkpointNs: oldCheckpointNs,
      ownerHint: rawTaskId
    })
  )
  sameRunConverter.processChunk(
    "messages",
    toolMessage({
      id: "same-run-result",
      toolCallId: rawTaskId,
      name: "task",
      content: "first result",
      checkpointNs: "agent"
    })
  )
  const sameRunSecond = sameRunConverter.processChunk(
    "messages",
    aiMessage("scheduler-parent-two", [taskCall])
  )
  const sameRunSecondId = latestSubagents(sameRunSecond).find(
    (subagent) => subagent.status === "running"
  )?.id
  assert(
    sameRunFirstId && sameRunSecondId && sameRunSecondId !== sameRunFirstId,
    "one scheduler run must allocate a new execution when a later parent reuses the task ID"
  )
  const lateOldInterior = sameRunConverter.processChunk(
    "messages",
    toolMessage({
      id: "same-run-old-inner-late",
      toolCallId: "same-run-old-inner-call-late",
      name: "read_file",
      content: "late old inner",
      checkpointNs: oldCheckpointNs,
      ownerHint: rawTaskId
    })
  )
  assert(
    lateOldInterior.find((event) => event.type === "tool-message")?.subagentId ===
      sameRunFirstId,
    "a checkpoint UUID pinned before task-ID reuse must keep late scheduler internals on execution 1"
  )
  const replay = sameRunConverter.processChunk(
    "messages",
    toolMessage({
      id: "same-run-result",
      toolCallId: rawTaskId,
      name: "task",
      content: "first result",
      checkpointNs: "agent"
    })
  )
  assert(
    latestSubagents(replay).every(
      (subagent) => subagent.id !== sameRunSecondId || subagent.status === "running"
    ),
    "replaying the first result must not complete the reused task's second execution"
  )
  const secondResult = sameRunConverter.processChunk(
    "messages",
    toolMessage({
      id: "same-run-result",
      toolCallId: rawTaskId,
      name: "task",
      content: "second result",
      checkpointNs: "agent"
    })
  )
  assert(
    latestSubagents(secondResult).find((subagent) => subagent.id === sameRunSecondId)?.status ===
      "completed",
    "the distinct second result must complete the reused task's second execution"
  )
}

async function testMessagesThenValuesReuseOneSchedulerExecution(): Promise<void> {
  const converter = new StreamConverter("messages-values-run")
  const taskCall = {
    id: "messages-values-task",
    name: "task",
    args: { subagent_type: "implementer", description: "hydrate once" }
  }
  const messagesRegistration = converter.processChunk(
    "messages",
    aiMessage("messages-values-parent", [taskCall])
  )
  const executionId = latestSubagents(messagesRegistration)[0]?.id
  assert(executionId, "messages mode should register the scheduler execution")

  const valuesEvents = converter.processChunk("values", {
    messages: [
      {
        id: ["langchain_core", "messages", "AIMessage"],
        kwargs: {
          id: "messages-values-parent",
          content: "parent text grew before the values snapshot",
          tool_calls: [
            taskCall,
            { id: "later-main-tool", name: "read_file", args: { path: "README.md" } }
          ]
        }
      }
    ]
  })
  const executions = latestSubagents(valuesEvents).filter(
    (subagent) => subagent.toolCallId === taskCall.id
  )
  assert(
    executions.length === 1 && executions[0]?.id === executionId,
    "a growing parent snapshot must reuse the task execution registered by messages mode"
  )
  const valuesPrompt = transcriptMessages(valuesEvents).find(
    (message) => message.id === `subagent-prompt-${executionId}`
  )
  assert(
    typeof valuesPrompt?.subagent_invocation_scope === "string" &&
      valuesPrompt.subagent_invocation_scope.startsWith("task-v1-"),
    "values mode should upgrade the stable prompt with its persisted invocation scope"
  )
  const repeatedValuesEvents = converter.processChunk("values", {
    messages: [
      {
        id: ["langchain_core", "messages", "AIMessage"],
        kwargs: {
          id: "messages-values-parent",
          content: "parent text grew before the values snapshot",
          tool_calls: [
            taskCall,
            { id: "later-main-tool", name: "read_file", args: { path: "README.md" } }
          ]
        }
      }
    ]
  })
  assert(
    transcriptMessages(repeatedValuesEvents).every(
      (message) => message.id !== `subagent-prompt-${executionId}`
    ),
    "repeated identical values snapshots must not re-emit the stable prompt"
  )
}

async function testHydratingTaskArgsKeepsOneSchedulerExecution(): Promise<void> {
  const converter = new StreamConverter("hydrating-task-args-run")
  const parentId = "hydrating-task-parent"
  const rawTaskId = "hydrating-task-id"
  const first = converter.processChunk(
    "messages",
    aiMessage(parentId, [{ id: rawTaskId, name: "task", args: {} }])
  )
  const executionId = latestSubagents(first)[0]?.id
  assert(executionId, "empty task args should register one provisional execution")

  const hydratedTaskCall = {
    id: rawTaskId,
    name: "task",
    args: { subagent_type: "implementer", description: "work", prompt: "do the work" }
  }
  const hydrated = converter.processChunk("messages", aiMessage(parentId, [hydratedTaskCall]))
  const hydratedExecutions = latestSubagents(hydrated).filter(
    (subagent) => subagent.toolCallId === rawTaskId
  )
  assert(
    hydratedExecutions.length === 1 && hydratedExecutions[0]?.id === executionId,
    "hydrating task args on the same parent/id must update the existing execution"
  )
  assert(
    transcriptMessages(hydrated).filter(
      (message) => message.id === `subagent-prompt-${executionId}`
    ).length === 1,
    "the first complete prompt should be emitted once after args hydrate"
  )

  const values = converter.processChunk("values", {
    messages: [
      {
        id: ["langchain_core", "messages", "AIMessage"],
        kwargs: { id: parentId, content: "", tool_calls: [hydratedTaskCall] }
      }
    ]
  })
  assert(
    latestSubagents(values).filter((subagent) => subagent.toolCallId === rawTaskId).length === 1,
    "the later values snapshot must still expose only the same logical execution"
  )
}

async function testSameParentAndTaskIdsStartNewSchedulerOccurrenceAfterCompletion(): Promise<void> {
  const converter = new StreamConverter("same-parent-occurrence-run")
  const parentId = "same-parent-occurrence"
  const taskCall = {
    id: "same-parent-task",
    name: "task",
    args: { subagent_type: "implementer", description: "identical invocation metadata" }
  }
  const first = converter.processChunk("messages", aiMessage(parentId, [taskCall]))
  const firstExecutionId = latestSubagents(first)[0]?.id
  assert(firstExecutionId, "the first same-parent occurrence should register")
  converter.processChunk(
    "messages",
    toolMessage({
      id: "same-parent-result-one",
      toolCallId: taskCall.id,
      name: "task",
      content: "first completion",
      checkpointNs: "agent"
    })
  )

  const second = converter.processChunk("messages", aiMessage(parentId, [taskCall]))
  const secondExecutionId = latestSubagents(second).find(
    (subagent) => subagent.toolCallId === taskCall.id && subagent.status === "running"
  )?.id
  assert(
    secondExecutionId && secondExecutionId !== firstExecutionId,
    "a terminal task followed by the same parent/task IDs must start a new live occurrence"
  )

  const values = converter.processChunk("values", {
    messages: [
      {
        id: ["langchain_core", "messages", "AIMessage"],
        kwargs: { id: parentId, content: "", tool_calls: [taskCall] }
      },
      {
        id: ["langchain_core", "messages", "ToolMessage"],
        kwargs: {
          id: "same-parent-result-one",
          name: "task",
          tool_call_id: taskCall.id,
          content: "first completion"
        }
      },
      {
        id: ["langchain_core", "messages", "AIMessage"],
        kwargs: { id: parentId, content: "", tool_calls: [taskCall] }
      }
    ]
  })
  const occurrences = latestSubagents(values).filter(
    (subagent) => subagent.toolCallId === taskCall.id
  )
  assert(
    occurrences.length === 2 &&
      occurrences.some((subagent) => subagent.id === secondExecutionId),
    "values reconciliation must retain both canonical same-parent occurrences"
  )
}

async function testSchedulerFinalTranscriptAndTerminalCorrection(): Promise<void> {
  const converter = new StreamConverter("scheduler-final-run")
  const registration = converter.processChunk(
    "messages",
    aiMessage("scheduler-final-parent", [
      {
        id: "scheduler-final-task",
        name: "task",
        args: { subagent_type: "implementer", prompt: "produce a final" }
      }
    ])
  )
  const executionId = latestSubagents(registration)[0]?.id
  assert(executionId, "scheduler final test should register an execution")

  const success = converter.processChunk(
    "messages",
    toolMessage({
      id: "scheduler-final-result",
      toolCallId: "scheduler-final-task",
      name: "task",
      content: "complete answer",
      checkpointNs: "agent:tools:parent-task-result"
    })
  )
  assert(
    transcriptMessages(success).some(
      (message) =>
        message.id === `subagent-final-${executionId}` && message.content === "complete answer"
    ),
    "a parent task result must be recorded as the stable final even with a tools namespace"
  )

  const correctedError = converter.processChunk(
    "messages",
    toolMessage({
      id: "scheduler-final-result",
      toolCallId: "scheduler-final-task",
      name: "task",
      content: "late failure",
      status: "error",
      checkpointNs: "agent"
    })
  )
  assert(
    latestSubagents(correctedError).find((subagent) => subagent.id === executionId)?.status ===
      "failed",
    "a later authoritative error should correct a completed scheduler execution"
  )
  assert(
    transcriptMessages(correctedError).some(
      (message) => message.id === `subagent-final-${executionId}` && message.is_error === true
    ),
    "the corrected error should update the same stable final transcript row"
  )

  const staleSuccess = converter.processChunk(
    "messages",
    toolMessage({
      id: "scheduler-final-result-replay",
      toolCallId: "scheduler-final-task",
      name: "task",
      content: "stale success",
      checkpointNs: "agent"
    })
  )
  assert(
    latestSubagents(staleSuccess).every(
      (subagent) => subagent.id !== executionId || subagent.status === "failed"
    ),
    "a stale success must not downgrade the failed scheduler terminal state"
  )
  assert(
    transcriptMessages(staleSuccess).every(
      (message) => message.id !== `subagent-final-${executionId}`
    ),
    "a stale success must not overwrite the failed stable final"
  )
}

async function run(): Promise<void> {
  await testSubagentToolErrorsAreForwarded()
  console.log("PASS stream converter forwards subagent tool errors")
  await testPrefixedNamespaceRoutesConcurrentSubagents()
  console.log("PASS stream converter routes prefixed concurrent subagent namespaces")
  await testSubagentToolCallChunksAreForwarded()
  console.log("PASS stream converter forwards subagent tool-call chunks")
  await testReusedTaskIdsAreScopedAcrossRunsAndResults()
  console.log("PASS stream converter scopes reused task and result IDs")
  await testMessagesThenValuesReuseOneSchedulerExecution()
  console.log("PASS stream converter reuses one execution across messages and values")
  await testHydratingTaskArgsKeepsOneSchedulerExecution()
  console.log("PASS stream converter keeps one execution while task args hydrate")
  await testSameParentAndTaskIdsStartNewSchedulerOccurrenceAfterCompletion()
  console.log("PASS stream converter scopes exact same parent/task occurrences")
  await testSchedulerFinalTranscriptAndTerminalCorrection()
  console.log("PASS stream converter persists stable finals and terminal corrections")
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
