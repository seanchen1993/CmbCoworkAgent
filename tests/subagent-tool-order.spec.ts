/** Regression tests for parallel subagent tool order, matching, and persistence. */
import assert from "node:assert/strict"
import { ElectronIPCTransport } from "../src/renderer/src/lib/electron-transport"
import {
  mergeSubagentTranscripts,
  reconcileTranscriptToolCallsWithResults,
  serializeSubagentTranscripts,
  getSubagentTranscriptsFromThreadValues
} from "../src/renderer/src/lib/subagent-transcripts"
import type { Message } from "../src/renderer/src/types"

let failures = 0
function check(name: string, run: () => void): void {
  try {
    run()
    console.log(`PASS ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}: ${String(error)}`)
  }
}

const calls = [
  { id: "call-a", name: "read_file", args: { path: "a.txt" } },
  { id: "call-b", name: "read_file", args: { path: "b.txt" } }
]
const assistant: Message = {
  id: "assistant",
  role: "assistant",
  content: "",
  tool_calls: calls,
  created_at: new Date()
}
const result = (id: string): Message => ({
  id: `result-${id}`,
  role: "tool",
  name: "read_file",
  content: id,
  tool_call_id: id,
  created_at: new Date()
})

check("parallel B result must not remove still-pending A", () => {
  const output = reconcileTranscriptToolCallsWithResults([assistant, result("call-b")])
  assert.deepEqual(output[0].tool_calls, calls)
})

check("parallel A result must not rewrite pending B to A", () => {
  const output = reconcileTranscriptToolCallsWithResults([assistant, result("call-a")])
  assert.deepEqual(output[0].tool_calls, calls)
})

check("all parallel results preserve both calls", () => {
  const output = reconcileTranscriptToolCallsWithResults([
    assistant,
    result("call-b"),
    result("call-a")
  ])
  assert.deepEqual(output[0].tool_calls, calls)
})

check("every partial result subset preserves same-name calls in either return order", () => {
  const parallelCalls = Array.from({ length: 4 }, (_, index) => ({
    id: `parallel-${index}`,
    name: "read_file",
    args: { path: `${index}.txt` }
  }))
  for (let mask = 0; mask < 16; mask += 1) {
    const results = parallelCalls
      .filter((_, index) => mask & (1 << index))
      .map((call) => result(call.id))
    for (const ordered of [results, [...results].reverse()]) {
      const output = reconcileTranscriptToolCallsWithResults([
        { ...assistant, tool_calls: parallelCalls },
        ...ordered
      ])
      assert.deepEqual(output[0].tool_calls, parallelCalls)
      assert.deepEqual(reconcileTranscriptToolCallsWithResults(output), output)
    }
  }
})

check("ambiguous legacy same-name calls must not bind by result arrival order", () => {
  const output = reconcileTranscriptToolCallsWithResults([
    assistant,
    result("legacy-b"),
    result("legacy-a")
  ])
  assert.deepEqual(output[0].tool_calls, calls)
})

check("unique legacy fallback cannot steal a later exact call's result", () => {
  const output = reconcileTranscriptToolCallsWithResults([
    assistant,
    result("call-b"),
    result("legacy-a")
  ])
  assert.deepEqual(
    output[0].tool_calls?.map((call) => call.id),
    ["legacy-a", "call-b"]
  )
  assert.deepEqual(
    output[0].tool_calls?.map((call) => call.args),
    calls.map((call) => call.args)
  )
})

check("unrelated result names must not be paired by their array position", () => {
  const output = reconcileTranscriptToolCallsWithResults([
    { ...assistant, tool_calls: [calls[0]] },
    { ...result("unrelated"), name: "grep" }
  ])
  assert.deepEqual(output[0].tool_calls, [calls[0]])
})

check(
  "cumulative call order corrects earlier arrivals while sparse updates retain omitted calls",
  () => {
    let transcripts = mergeSubagentTranscripts({}, "order", [
      {
        ...assistant,
        tool_calls: [calls[1], calls[0]]
      }
    ])
    transcripts = mergeSubagentTranscripts(transcripts, "order", [
      {
        ...assistant,
        tool_calls: [calls[0]]
      }
    ])
    assert.deepEqual(transcripts.order[0].tool_calls, [calls[1], calls[0]])
    transcripts = mergeSubagentTranscripts(transcripts, "order", [assistant])
    assert.deepEqual(transcripts.order[0].tool_calls, calls)
  }
)

for (const arrival of ["normal", "reversed", "late-index-zero"] as const) {
  check(
    `chunk-only parallel calls retain index order after snapshot and reload (${arrival})`,
    () => {
      const transport = new ElectronIPCTransport() as unknown as {
        convertToSDKEvents(
          event: unknown,
          threadId: string
        ): Array<{
          event: string
          data: { type?: string; subagentId?: string; subagentMessage?: Message }
        }>
      }
      let transcripts: Record<string, Message[]> = {}
      const send = (kind: string, kwargs: Record<string, unknown>, subagent = true): void => {
        const events = transport.convertToSDKEvents(
          {
            type: "stream",
            mode: "messages",
            data: [
              { id: ["langchain_core", "messages", kind], kwargs },
              subagent
                ? {
                    langgraph_checkpoint_ns: "tools:runtime-task|model:1",
                    cmb_subagent_owner_tool_call_id: "task-order"
                  }
                : { langgraph_node: "agent" }
            ]
          },
          "audit-thread"
        )
        for (const event of events) {
          const data = event.data
          if (
            event.event === "custom" &&
            data.type === "subagent_transcript_message" &&
            data.subagentId &&
            data.subagentMessage
          ) {
            transcripts = mergeSubagentTranscripts(transcripts, data.subagentId, [
              data.subagentMessage
            ])
          }
        }
      }
      send(
        "AIMessage",
        {
          id: "main",
          content: "",
          tool_calls: [
            {
              id: "task-order",
              name: "task",
              args: { description: "audit", subagent_type: "general-purpose" }
            }
          ]
        },
        false
      )
      const firstChunks = [
        { id: "call-a", name: "read_file", index: 0, args: '{"path":"a' },
        { id: "call-b", name: "read_file", index: 1, args: '{"path":"b.txt"}' }
      ]
      send("AIMessageChunk", {
        id: "inner",
        content: "",
        tool_call_chunks:
          arrival === "normal"
            ? firstChunks
            : arrival === "reversed"
              ? [...firstChunks].reverse()
              : [firstChunks[1]]
      })
      if (arrival === "late-index-zero") {
        send("AIMessageChunk", { id: "inner", content: "", tool_call_chunks: [firstChunks[0]] })
      }
      const getCalls = () =>
        transcripts["task-order"].find((message) => message.tool_calls?.length)?.tool_calls
      assert.deepEqual(
        getCalls()?.map((call) => call.id),
        ["call-a", "call-b"]
      )
      assert.deepEqual(getCalls()?.[0].args, {})
      send("AIMessageChunk", {
        id: "inner",
        content: "",
        tool_call_chunks: [{ index: 0, args: '.txt"}' }]
      })
      send("AIMessage", { id: "inner", content: "", tool_calls: calls })
      assert.deepEqual(getCalls(), calls)
      const restored = getSubagentTranscriptsFromThreadValues({
        subagentTranscripts: serializeSubagentTranscripts(transcripts)
      })
      const restoredCalls = restored["task-order"].find(
        (message) => message.tool_calls?.length
      )?.tool_calls
      assert.deepEqual(
        restoredCalls?.map((call) => call.id),
        ["call-a", "call-b"]
      )
    }
  )
}

process.exitCode = failures ? 1 : 0
