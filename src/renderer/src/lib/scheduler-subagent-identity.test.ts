import { describe, expect, it } from "vitest"
import { StreamConverter } from "../../../main/agent/stream-converter"
import { createStreamDataSerializer } from "../../../main/ipc/stream-data-serialization"
import { projectSchedulerSubagentMessage, upsertTranscriptMessages } from "./subagent-transcripts"
import type { Message } from "../types"

describe("scheduler subagent provider identity", () => {
  it("keeps actual converter same-ID assistant/tool cycles separate", () => {
    const converter = new StreamConverter("identity-cycle")
    const serialize = createStreamDataSerializer()
    converter.processChunk("messages", [
      {
        id: ["AIMessage"],
        kwargs: {
          id: "main",
          content: "",
          tool_calls: [
            {
              id: "task",
              name: "task",
              args: { description: "cycle", subagent_type: "general-purpose" }
            }
          ]
        }
      },
      {}
    ])
    const tracker: Parameters<typeof projectSchedulerSubagentMessage>[0] = { currentMsgId: null }
    let messages: Message[] = []
    for (const cycle of [1, 2]) {
      const frames: Array<[string, Record<string, unknown>]> = [
        [
          "AIMessage",
          {
            id: "shared",
            content: `cycle-${cycle}`,
            tool_calls: [{ id: `call-${cycle}`, name: "read_file", args: { path: `${cycle}.txt` } }]
          }
        ],
        [
          "ToolMessage",
          {
            id: "shared",
            content: `result-${cycle}`,
            tool_call_id: `call-${cycle}`,
            name: "read_file"
          }
        ]
      ]
      for (const [kind, kwargs] of frames) {
        const packet = serialize("messages", [
          { id: [kind], kwargs },
          { checkpoint_ns: "agent:tools:task", cmb_subagent_owner_tool_call_id: "task" }
        ])
        for (const event of converter.processChunk("messages", packet.data)) {
          if (event.type === "message-delta")
            messages = upsertTranscriptMessages(messages, [
              projectSchedulerSubagentMessage(
                tracker,
                { ...event, toolCalls: event.toolCalls as Message["tool_calls"] },
                messages
              )
            ])
          else if (event.type === "tool-message")
            messages = upsertTranscriptMessages(messages, [
              {
                id: event.id,
                role: "tool",
                content: event.content,
                tool_call_id: event.toolCallId,
                created_at: new Date()
              }
            ])
        }
      }
    }
    expect(messages.map((message) => message.content)).toEqual([
      "cycle-1",
      "result-1",
      "cycle-2",
      "result-2"
    ])
    expect(new Set(messages.map((message) => message.id)).size).toBe(4)
    expect(messages[0].tool_calls?.map((call) => call.id)).toEqual(["call-1"])
    expect(messages[2].tool_calls?.map((call) => call.id)).toEqual(["call-2"])
  })

  it("does not split ordinary continuation, repeated snapshots or late previous results", () => {
    const tracker: Parameters<typeof projectSchedulerSubagentMessage>[0] = { currentMsgId: null }
    let messages: Message[] = []
    const project = (content: string, callId: string, snapshot = false) => {
      const message = projectSchedulerSubagentMessage(
        tracker,
        {
          id: "same",
          content,
          contentMode: snapshot ? "snapshot" : "delta",
          toolCalls: [{ id: callId, name: "echo", args: {} }]
        },
        messages
      )
      messages = upsertTranscriptMessages(messages, [message])
      return message
    }
    const first = project("first", "call1", true)
    messages = upsertTranscriptMessages(messages, [
      { id: "t1", role: "tool", content: "one", tool_call_id: "call1", created_at: new Date() }
    ])
    expect(project("first", "call1", true).id).toBe(first.id)
    const second = project("second", "call2", true)
    expect(second.id).not.toBe(first.id)
    expect(project("second", "call2", true).id).toBe(second.id)
    messages = [
      ...messages,
      {
        id: "late",
        role: "tool",
        content: "old result",
        tool_call_id: "call1",
        created_at: new Date()
      }
    ]
    expect(project(" tail", "call2").id).toBe(second.id)
    expect(messages.find((message) => message.id === second.id)?.content).toBe("second tail")
  })

  it("does not rescan a long transcript for stable per-token identity", () => {
    const tracker: Parameters<typeof projectSchedulerSubagentMessage>[0] = { currentMsgId: null }
    const rows: Message[] = Array.from({ length: 2_000 }, (_, index) => ({
      id: `old-${index}`,
      role: "assistant",
      content: "old",
      created_at: new Date()
    }))
    const initial = projectSchedulerSubagentMessage(tracker, { id: "live", content: "start" }, rows)
    rows.push(initial)
    let reads = 0
    const baseline = new Proxy(rows, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) reads++
        return Reflect.get(target, property, receiver)
      }
    })
    for (let index = 0; index < 100; index++)
      projectSchedulerSubagentMessage(tracker, { id: "live", content: "x" }, baseline)
    expect(reads).toBeLessThanOrEqual(100)
  })

  it("learns completed calls from hydration before a same-ID next cycle", () => {
    const tracker: Parameters<typeof projectSchedulerSubagentMessage>[0] = { currentMsgId: null }
    const first = projectSchedulerSubagentMessage(tracker, { id: "same", content: "first" }, [])
    let messages = upsertTranscriptMessages(
      [first],
      [{ ...first, tool_calls: [{ id: "hydrated-call", name: "echo", args: {} }] }]
    )
    messages = upsertTranscriptMessages(messages, [
      {
        id: "result",
        role: "tool",
        content: "result",
        tool_call_id: "hydrated-call",
        created_at: new Date()
      }
    ])
    const second = projectSchedulerSubagentMessage(
      tracker,
      { id: "same", content: "second" },
      messages
    )
    expect(second.id).not.toBe(first.id)
    expect(second.content).toBe("second")
    expect(second.tool_calls).toBeUndefined()
  })

  it("a tool snapshot replay followed by no-call tokens creates only one next cycle", () => {
    const tracker: Parameters<typeof projectSchedulerSubagentMessage>[0] = { currentMsgId: null }
    const event = {
      id: "same",
      content: "first",
      contentMode: "snapshot" as const,
      toolCalls: [{ id: "call", name: "echo", args: {} }]
    }
    const first = projectSchedulerSubagentMessage(tracker, event, [])
    let messages = upsertTranscriptMessages(
      [first],
      [
        {
          id: "result",
          role: "tool",
          content: "result",
          tool_call_id: "call",
          created_at: new Date()
        }
      ]
    )
    expect(projectSchedulerSubagentMessage(tracker, event, messages).id).toBe(first.id)
    const second = projectSchedulerSubagentMessage(
      tracker,
      { id: "same", content: "next" },
      messages
    )
    messages = upsertTranscriptMessages(messages, [second])
    const continued = projectSchedulerSubagentMessage(
      tracker,
      { id: "same", content: " tail" },
      messages
    )
    expect(second.id).not.toBe(first.id)
    expect(continued.id).toBe(second.id)
    expect(continued.content).toBe("next tail")
  })
})
