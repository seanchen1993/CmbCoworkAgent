import assert from "node:assert/strict"
import { StreamConverter } from "../src/main/agent/stream-converter"
import { createStreamDataSerializer } from "../src/main/ipc/stream-data-serialization"
import { ElectronIPCTransport } from "../src/renderer/src/lib/electron-transport"
import { useAppStore } from "../src/renderer/src/lib/store"

type SdkEvent = { event: string; data: unknown }
type TestableTransport = {
  convertToSDKEvents: (
    event: unknown,
    threadId: string,
    agentMode?: "normal" | "coordinator" | "workflow"
  ) => SdkEvent[]
  activeSubagents: Map<string, unknown>
  subagentExecutionIdByInvocation: Map<string, string>
  currentMappedSubagentExecutionIds: Set<string>
  subagentExecutionIdsByToolCallId: Map<string, string[]>
  subagentTaskResultExecutionIdByIdentity: Map<string, string>
  subagentPromptInvocationIdentityByExecutionId: Map<string, string>
  runningSubagentIds: Set<string>
  subagentStreamGeneration: number
  setSubagentInvocationMapping: (invocationKey: string, executionId: string) => boolean
  adoptMainAssistantMessageIdAlias: (fromId: string, toId: string) => void
  pruneSubagentExecutionIndexes: () => void
}

function convert(
  transport: ElectronIPCTransport,
  data: unknown,
  options: { valuesSnapshotKind?: "full" | "append" | "tail" } = {}
): SdkEvent[] {
  const mode = Array.isArray(data) ? "messages" : "values"
  return (transport as unknown as TestableTransport).convertToSDKEvents(
    { type: "stream", mode, data, ...options },
    "wire-thread",
    "normal"
  )
}

function assistantChunk(input: {
  id: string
  content?: string
  reasoning?: string
  toolCallChunks?: Array<Record<string, unknown>>
  toolCalls?: Array<Record<string, unknown>>
}): unknown[] {
  return [
    {
      id: ["langchain_core", "messages", "AIMessageChunk"],
      kwargs: {
        id: input.id,
        content: input.content ?? "",
        additional_kwargs: input.reasoning
          ? { reasoning_content: input.reasoning }
          : {},
        ...(input.toolCallChunks ? { tool_call_chunks: input.toolCallChunks } : {}),
        ...(input.toolCalls ? { tool_calls: input.toolCalls } : {})
      }
    },
    { langgraph_node: "agent" }
  ]
}

function messagePayloads(events: SdkEvent[]): Array<Record<string, unknown>> {
  return events.flatMap((event) => {
    if (event.event !== "messages" || !Array.isArray(event.data)) return []
    const message = event.data[0]
    return message && typeof message === "object" && !Array.isArray(message)
      ? [message as Record<string, unknown>]
      : []
  })
}

function customPayloads(events: SdkEvent[], type: string): Array<Record<string, unknown>> {
  return events.flatMap((event) => {
    if (event.event !== "custom" || !event.data || typeof event.data !== "object") return []
    const data = event.data as Record<string, unknown>
    return data.type === type ? [data] : []
  })
}

function testForegroundCumulativeWireProjection(): void {
  const serializer = createStreamDataSerializer()
  const transport = new ElectronIPCTransport()
  const emittedContent: string[] = []
  let finalReasoning = ""
  let finalToolArgs: unknown
  let cumulativeContent = ""
  let cumulativeReasoning = ""
  let cumulativeToolArgs = ""

  for (let frame = 0; frame < 1_000; frame += 1) {
    cumulativeContent += "c".repeat(120)
    cumulativeReasoning += "r".repeat(120)
    cumulativeToolArgs += frame === 0 ? `{"payload":"${"t".repeat(108)}` : "t".repeat(120)
    if (frame === 999) cumulativeToolArgs += '"}'
    const serialized = serializer(
      "messages",
      assistantChunk({
        id: "wire-main",
        content: cumulativeContent,
        reasoning: cumulativeReasoning,
        toolCallChunks: [
          {
            ...(frame === 0 ? { id: "wire-tool", name: "write_file" } : {}),
            index: 0,
            args: cumulativeToolArgs
          }
        ]
      })
    )
    for (const message of messagePayloads(convert(transport, serialized.data))) {
      if (typeof message.content === "string") emittedContent.push(message.content)
      if (typeof message.reasoning === "string") finalReasoning = message.reasoning
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      const firstTool = toolCalls[0] as { args?: { payload?: unknown } } | undefined
      if (firstTool?.args?.payload !== undefined) finalToolArgs = firstTool.args.payload
    }
  }

  assert.equal(emittedContent.join(""), cumulativeContent)
  assert.equal(finalReasoning, cumulativeReasoning)
  assert.equal(finalToolArgs, "t".repeat(cumulativeToolArgs.length - 14))
}

function testDeltaRepeatsAndRewriteFallback(): void {
  const deltaSerializer = createStreamDataSerializer()
  const deltaTransport = new ElectronIPCTransport()
  const emitted: string[] = []
  for (const content of ["ha", "!", "ha", "ha"]) {
    const serialized = deltaSerializer(
      "messages",
      assistantChunk({ id: "wire-repeat", content })
    )
    emitted.push(
      ...messagePayloads(convert(deltaTransport, serialized.data)).flatMap((message) =>
        typeof message.content === "string" ? [message.content] : []
      )
    )
  }
  assert.equal(emitted.join(""), "ha!haha")

  const snapshotSerializer = createStreamDataSerializer()
  const snapshotTransport = new ElectronIPCTransport()
  for (const content of ["stable-prefix", "stable-prefix-tail"]) {
    convert(
      snapshotTransport,
      snapshotSerializer("messages", assistantChunk({ id: "wire-rewrite", content })).data
    )
  }
  const rewriteEvents = convert(
    snapshotTransport,
    snapshotSerializer(
      "messages",
      assistantChunk({ id: "wire-rewrite", content: "rewritten-result" })
    ).data
  )
  const snapshot = customPayloads(rewriteEvents, "coordinator_ai_snapshot_message")[0]
  assert.equal(
    (snapshot?.assistantMessage as { content?: unknown } | undefined)?.content,
    "rewritten-result"
  )
}

function testToolArgsDeltaCumulativeAndRollbackModes(): void {
  const deltaSerializer = createStreamDataSerializer()
  const deltaTransport = new ElectronIPCTransport()
  let deltaValue: unknown
  for (const args of ['{"value":"', "ha", "ha", '"}']) {
    const serialized = deltaSerializer(
      "messages",
      assistantChunk({
        id: "wire-tool-delta",
        toolCallChunks: [{ id: "wire-tool-delta-call", name: "write_file", index: 0, args }]
      })
    )
    for (const message of messagePayloads(convert(deltaTransport, serialized.data))) {
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      deltaValue = (toolCalls[0] as { args?: { value?: unknown } } | undefined)?.args?.value
    }
  }
  assert.equal(deltaValue, "haha")

  const snapshotSerializer = createStreamDataSerializer()
  const snapshotTransport = new ElectronIPCTransport()
  for (const args of ['{"value":"', '{"value":"old"}']) {
    convert(
      snapshotTransport,
      snapshotSerializer(
        "messages",
        assistantChunk({
          id: "wire-tool-snapshot",
          toolCallChunks: [
            { id: "wire-tool-snapshot-call", name: "write_file", index: 0, args }
          ]
        })
      ).data
    )
  }
  const replacement = snapshotSerializer(
    "messages",
    assistantChunk({
      id: "wire-tool-snapshot",
      toolCallChunks: [
        {
          id: "wire-tool-snapshot-call",
          name: "write_file",
          index: 0,
          args: '{"value":"new"}'
        }
      ]
    })
  )
  const replacementChunk = (
    replacement.data as [
      { kwargs: { tool_call_chunks: Array<Record<string, unknown>> } },
      Record<string, unknown>
    ]
  )[0].kwargs.tool_call_chunks[0]
  assert.equal(replacementChunk.cmb_stream_tool_call_args_mode, "snapshot")

  const replacementMessages = messagePayloads(convert(snapshotTransport, replacement.data))
  const replacementCalls = replacementMessages.at(-1)?.tool_calls
  assert.equal(
    (Array.isArray(replacementCalls)
      ? (replacementCalls[0] as { args?: { value?: unknown } } | undefined)?.args?.value
      : undefined),
    "new"
  )

  convert(
    snapshotTransport,
    snapshotSerializer(
      "messages",
      assistantChunk({
        id: "wire-tool-snapshot",
        toolCallChunks: [
          { id: "wire-tool-snapshot-call", name: "write_file", index: 0, args: "" }
        ]
      })
    ).data
  )
  const afterEmptyRollback = messagePayloads(
    convert(
      snapshotTransport,
      snapshotSerializer(
        "messages",
        assistantChunk({
          id: "wire-tool-snapshot",
          toolCallChunks: [
            {
              id: "wire-tool-snapshot-call",
              name: "write_file",
              index: 0,
              args: '{"value":"after-empty"}'
            }
          ]
        })
      ).data
    )
  )
  assert.equal(
    (
      afterEmptyRollback.at(-1)?.tool_calls as
        | Array<{ args?: { value?: unknown } }>
        | undefined
    )?.[0]?.args?.value,
    "after-empty"
  )

  const backgroundSerializer = createStreamDataSerializer()
  const backgroundConverter = new StreamConverter("wire-tool-background-snapshot")
  const backgroundArgs = [
    '{"value":"',
    '{"value":"old"}',
    '{"value":"new"}',
    "",
    '{"value":"after-empty"}'
  ]
  let backgroundReplacement: unknown
  for (const args of backgroundArgs) {
    const serialized = backgroundSerializer(
      "messages",
      assistantChunk({
        id: "wire-tool-background-snapshot",
        toolCallChunks: [
          { id: "wire-tool-background-call", name: "write_file", index: 0, args }
        ]
      })
    )
    for (const event of backgroundConverter.processChunk("messages", serialized.data)) {
      if (event.type !== "message-delta" || !Array.isArray(event.toolCalls)) continue
      backgroundReplacement = (
        event.toolCalls[0] as { args?: { value?: unknown } } | undefined
      )?.args?.value
    }
  }
  assert.equal(backgroundReplacement, "after-empty")
}

function testBackgroundAndFocusedWorkerProjection(): void {
  const backgroundSerializer = createStreamDataSerializer()
  const converter = new StreamConverter("cumulative-background")
  const deltas: string[] = []
  const reasoningDeltas: string[] = []
  let cumulative = ""
  let cumulativeReasoning = ""
  let cumulativeToolArgs = ""
  let backgroundToolValue: unknown
  for (let frame = 0; frame < 1_000; frame += 1) {
    cumulative += "b".repeat(120)
    cumulativeReasoning += "q".repeat(120)
    cumulativeToolArgs += frame === 0 ? `{"payload":"${"z".repeat(108)}` : "z".repeat(120)
    if (frame === 999) cumulativeToolArgs += '"}'
    const serialized = backgroundSerializer(
      "messages",
      assistantChunk({
        id: "background-main",
        content: cumulative,
        reasoning: cumulativeReasoning,
        toolCallChunks: [
          {
            ...(frame === 0 ? { id: "background-tool", name: "write_file" } : {}),
            index: 0,
            args: cumulativeToolArgs
          }
        ]
      })
    )
    for (const event of converter.processChunk("messages", serialized.data)) {
      if (event.type !== "message-delta") continue
      deltas.push(event.content)
      if (event.reasoning) reasoningDeltas.push(event.reasoning)
      const calls = Array.isArray(event.toolCalls) ? event.toolCalls : []
      backgroundToolValue = (calls[0] as { args?: { payload?: unknown } } | undefined)?.args
        ?.payload
    }
  }
  assert.equal(deltas.join(""), cumulative)
  assert.equal(reasoningDeltas.join(""), cumulativeReasoning)
  assert.equal(backgroundToolValue, "z".repeat(cumulativeToolArgs.length - 14))

  const workerThreadId = "wire-thread__worker__focused"
  useAppStore.setState({
    workerFocusView: null,
    workerFocusMessagesThreadId: null,
    workerFocusMessages: []
  })
  useAppStore.getState().openWorkerFocusView({
    threadId: "wire-thread",
    workerId: "focused",
    workerThreadId,
    role: "implementer",
    description: "verify cumulative wire"
  })
  try {
    const workerSerializer = createStreamDataSerializer()
    const workerTransport = new ElectronIPCTransport()
    let workerCumulative = ""
    let workerReasoning = ""
    let workerToolArgs = ""
    let latestWorkerContent: unknown
    let latestWorkerReasoning: unknown
    let latestWorkerToolValue: unknown
    for (let frame = 0; frame < 1_000; frame += 1) {
      workerCumulative += "w".repeat(120)
      workerReasoning += "k".repeat(120)
      workerToolArgs += frame === 0 ? `{"payload":"${"v".repeat(108)}` : "v".repeat(120)
      if (frame === 999) workerToolArgs += '"}'
      const serialized = workerSerializer(
        "messages",
        assistantChunk({
          id: "worker-provider",
          content: workerCumulative,
          reasoning: workerReasoning,
          toolCallChunks: [
            {
              ...(frame === 0 ? { id: "worker-tool", name: "write_file" } : {}),
              index: 0,
              args: workerToolArgs
            }
          ]
        })
      )
      const messages = workerTransport.convertFocusedCoordinatorWorkerIPCEvent(
        {
          type: "stream",
          mode: "messages",
          data: serialized.data,
          workerTurn: 1
        },
        "wire-thread"
      )
      latestWorkerContent = messages.at(-1)?.content
      latestWorkerReasoning = messages.at(-1)?.reasoning
      latestWorkerToolValue = messages.at(-1)?.tool_calls?.[0]?.args?.payload
    }
    assert.equal(latestWorkerContent, workerCumulative)
    assert.equal(latestWorkerReasoning, workerReasoning)
    assert.equal(latestWorkerToolValue, "v".repeat(workerToolArgs.length - 14))
  } finally {
    useAppStore.getState().closeWorkerFocusView()
  }
}

function taskCall(index: number): Record<string, unknown> {
  return {
    id: `history-task-${index}`,
    name: "task",
    args: { subagent_type: "implementer", description: `worker ${index}` }
  }
}

function testSubagentValuesDoNotBroadcastHistoryPerFrame(): void {
  const transport = new ElectronIPCTransport()
  const tasks = Array.from({ length: 2_000 }, (_, index) => taskCall(index))
  const restored = convert(transport, {
    messages: [
      {
        id: ["langchain_core", "messages", "AIMessage"],
        kwargs: { id: "history-parent", content: "", tool_calls: tasks }
      }
    ]
  })
  const restoredSnapshots = customPayloads(restored, "subagents")
  assert.equal(restoredSnapshots.length, 1)
  assert.equal((restoredSnapshots[0].subagents as unknown[]).length, 2_000)

  const internals = transport as unknown as TestableTransport
  assert.ok(internals.subagentExecutionIdByInvocation.size <= 2_000)
  assert.ok(internals.currentMappedSubagentExecutionIds.size <= 2_000)
  assert.ok(internals.subagentExecutionIdsByToolCallId.size <= 2_000)
  assert.ok(internals.subagentTaskResultExecutionIdByIdentity.size <= 2_000)
  assert.ok(internals.subagentPromptInvocationIdentityByExecutionId.size <= 2_000)

  internals.setSubagentInvocationMapping(
    JSON.stringify(["history-task-1999", "old-provider-parent"]),
    "history-task-1999"
  )
  const originalValues = internals.activeSubagents.values
  const invocationMappings = internals.subagentExecutionIdByInvocation
  const originalMappingValues = invocationMappings.values
  const originalMappingEntries = invocationMappings.entries
  const originalMappingIterator = invocationMappings[Symbol.iterator]
  Object.defineProperty(internals.activeSubagents, "values", {
    configurable: true,
    value(): never {
      throw new Error("ordinary frames must not enumerate the complete subagent map")
    }
  })
  Object.defineProperties(invocationMappings, {
    values: {
      configurable: true,
      value(): never {
        throw new Error("values frames must use the current mapped execution set")
      }
    },
    entries: {
      configurable: true,
      value(): never {
        throw new Error("message aliases must use the parent invocation reverse index")
      }
    },
    [Symbol.iterator]: {
      configurable: true,
      value(): never {
        throw new Error("ordinary values must not iterate lifetime invocation mappings")
      }
    }
  })
  try {
    internals.adoptMainAssistantMessageIdAlias("old-provider-parent", "new-provider-parent")
    assert.equal(
      invocationMappings.get(JSON.stringify(["history-task-1999", "new-provider-parent"])),
      "history-task-1999"
    )
    for (let frame = 0; frame < 1_000; frame += 1) {
      const valuesEvents = convert(transport, {
        messages: [
          {
            id: ["langchain_core", "messages", "AIMessage"],
            kwargs: { id: "plain-values", content: `frame-${frame}` }
          }
        ]
      })
      assert.equal(customPayloads(valuesEvents, "subagents").length, 0)

      const interiorEvents = convert(
        transport,
        assistantChunk({ id: "history-interior", content: `token-${frame}` }).map(
          (value, index) =>
            index === 1
              ? {
                  langgraph_checkpoint_ns: "agent:tools:history",
                  cmb_subagent_owner_tool_call_id: "history-task-1999"
                }
              : value
        )
      )
      assert.equal(customPayloads(interiorEvents, "subagents").length, 0)
    }
  } finally {
    Object.defineProperty(internals.activeSubagents, "values", {
      configurable: true,
      value: originalValues
    })
    Object.defineProperties(invocationMappings, {
      values: { configurable: true, value: originalMappingValues },
      entries: { configurable: true, value: originalMappingEntries },
      [Symbol.iterator]: { configurable: true, value: originalMappingIterator }
    })
  }

  const toolEvents = convert(
    transport,
    assistantChunk({
      id: "history-interior",
      toolCalls: [{ id: "inner-read", name: "read_file", args: {} }]
    }).map((value, index) =>
      index === 1
        ? {
            langgraph_checkpoint_ns: "agent:tools:history",
            cmb_subagent_owner_tool_call_id: "history-task-1999"
          }
        : value
    )
  )
  assert.equal(customPayloads(toolEvents, "subagents").length, 0)
  assert.equal(customPayloads(toolEvents, "subagent_delta").length, 1)

  const terminalEvents = convert(
    transport,
    {
      messages: [
        {
          id: ["langchain_core", "messages", "ToolMessage"],
          kwargs: {
            id: "history-result",
            type: "tool",
            name: "task",
            tool_call_id: "history-task-1999",
            content: "done"
          }
        }
      ]
    },
    { valuesSnapshotKind: "tail" }
  )
  const terminalSnapshots = customPayloads(terminalEvents, "subagents")
  assert.equal(terminalSnapshots.length, 1)
  const completed = (terminalSnapshots[0].subagents as Array<{ id: string; status: string }>).find(
    (subagent) => subagent.id === "history-task-1999"
  )
  assert.equal(completed?.status, "completed")

  // A resumed generation may still need the immediately preceding identity
  // mappings. Once a later generation is established, old non-seeded indexes
  // are removed coherently instead of accumulating for the holder's lifetime.
  internals.runningSubagentIds.clear()
  internals.subagentStreamGeneration = 1
  internals.pruneSubagentExecutionIndexes()
  assert.ok(internals.subagentExecutionIdByInvocation.size <= 2_000)
  internals.subagentStreamGeneration = 2
  internals.pruneSubagentExecutionIndexes()
  assert.equal(internals.subagentExecutionIdByInvocation.size, 0)
  assert.equal(internals.currentMappedSubagentExecutionIds.size, 0)
  assert.equal(internals.subagentExecutionIdsByToolCallId.size, 0)
  assert.equal(internals.subagentTaskResultExecutionIdByIdentity.size, 0)
  assert.equal(internals.subagentPromptInvocationIdentityByExecutionId.size, 0)
}

testForegroundCumulativeWireProjection()
testDeltaRepeatsAndRewriteFallback()
testToolArgsDeltaCumulativeAndRollbackModes()
testBackgroundAndFocusedWorkerProjection()
testSubagentValuesDoNotBroadcastHistoryPerFrame()
console.log("cumulative stream wire tests passed")
