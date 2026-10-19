import { describe, expect, it } from "vitest"
import type { Message } from "@/types"
import type { BotMessageOrigin } from "../../../shared/bots/contracts"
import {
  mergeBotMessageOrigins,
  quietBotTurnMessageIds,
  hiddenBotTaskMessageIds
} from "./bot-routine-visibility"

const source: BotMessageOrigin = {
  id: "task",
  requestId: "scheduled",
  origin: { kind: "schedule", scheduleId: "routine" },
  state: "completed"
}
const turn: Message[] = [
  { id: "scheduled", role: "user", content: "例行任务：检查", created_at: new Date(0) },
  {
    id: "check",
    role: "assistant",
    content: "",
    created_at: new Date(1),
    tool_calls: [{ id: "tool", name: "read_file", args: {} }]
  },
  {
    id: "tool-result",
    role: "tool",
    content: "unchanged",
    tool_call_id: "tool",
    created_at: new Date(2)
  },
  {
    id: "final",
    role: "assistant",
    content: "<think>Checked</think>BOT_ROUTINE_SILENT",
    created_at: new Date(3)
  }
]
describe("quiet Bot routine visibility", () => {
  it("hides durable Host continuation boundaries before source lookup without hiding user text or assistant output", () => {
    const id = `bot-continuation:task:${"a".repeat(64)}`
    const internal: Message = { id, role: "user", content: "续办后台任务", created_at: new Date(0) }
    const messages: Message[] = [
      internal,
      { ...internal, id: "ordinary", content: id },
      { ...internal, id: "bot-continuation:malformed" },
      { ...internal, id: "answer", role: "assistant", content: "Result" }
    ]
    expect([...hiddenBotTaskMessageIds(messages, new Map())]).toEqual([id])
    const continuation = { ...source, requestId: id }
    const scheduled = [
      turn[0],
      turn[1],
      { ...turn[3], id: "paused", content: "Paused" },
      internal,
      turn[3]
    ]
    expect([
      ...hiddenBotTaskMessageIds(scheduled, mergeBotMessageOrigins([continuation], [source]))
    ]).toEqual(scheduled.map((m) => m.id))
  })
  const continued: Message[] = [
    ...turn.slice(0, 3),
    { id: "private", role: "user", content: "Private correction", created_at: new Date(4) },
    { id: "private-answer", role: "assistant", content: "43", created_at: new Date(5) },
    { id: "continuation", role: "user", content: "Internal continuation", created_at: new Date(6) },
    { ...turn[3], created_at: new Date(7) }
  ]
  const alias = { ...source, requestId: "continuation" }
  it("updates a continuation from its original live task without replacing either transcript identity", () => {
    const origins = mergeBotMessageOrigins([{ ...alias, state: "running" }], [source])
    expect(origins.get("continuation")).toEqual(alias)
    expect(origins.get("scheduled")).toEqual(source)
    const hidden = quietBotTurnMessageIds(continued, origins)
    expect([...hidden]).toEqual(["scheduled", "check", "tool-result", "continuation", "final"])
    expect(hidden.has("private")).toBe(false)
    expect(hidden.has("private-answer")).toBe(false)
  })
  it("keeps all routine fragments visible when the continuation has news, fails or awaits completion", () => {
    for (const state of [
      "running",
      "waiting_user",
      "queued",
      "failed",
      "interrupted",
      "cancelled"
    ] as const) {
      const origins = mergeBotMessageOrigins([alias], [{ ...source, state }])
      expect(quietBotTurnMessageIds(continued, origins).size).toBe(0)
    }
    const news = continued.map((message) =>
      message.id === "final" ? { ...message, content: "Found a change" } : message
    )
    expect(quietBotTurnMessageIds(news, mergeBotMessageOrigins([alias], [source])).size).toBe(0)
  })
  it("does not hide a routine's earlier system error or an unverified continuation", () => {
    const error: Message = {
      id: "error",
      role: "system",
      content: "Execution failed",
      created_at: new Date(3)
    }
    expect(
      quietBotTurnMessageIds(
        [...continued.slice(0, 3), error, ...continued.slice(3)],
        mergeBotMessageOrigins([alias], [source])
      ).size
    ).toBe(0)
    expect(quietBotTurnMessageIds(continued, mergeBotMessageOrigins([], [source])).size).toBe(0)
    const ordinary = { ...alias, id: "user-task", origin: { kind: "user" as const } }
    expect(
      quietBotTurnMessageIds(continued, mergeBotMessageOrigins([ordinary], [source])).size
    ).toBe(0)
  })
  it("hides only a durably completed routine and retains the next direct user turn", () => {
    const messages: Message[] = [
      ...turn,
      { id: "user-next", role: "user", content: "Hello", created_at: new Date(4) }
    ]
    expect([...quietBotTurnMessageIds(messages, new Map([[source.requestId, source]]))]).toEqual(
      turn.map((message) => message.id)
    )
  })
  it("keeps unverified, failed, interrupted and literal user markers visible", () => {
    expect(quietBotTurnMessageIds(turn, new Map()).size).toBe(0)
    for (const state of ["running", "waiting_user", "failed", "interrupted", "cancelled"] as const)
      expect(
        quietBotTurnMessageIds(turn, new Map([[source.requestId, { ...source, state }]])).size
      ).toBe(0)
    expect(
      quietBotTurnMessageIds(
        turn,
        new Map([[source.requestId, { ...source, origin: { kind: "user" } }]])
      ).size
    ).toBe(0)
  })
  it("does not suppress results appended to the marker or a partial history window", () => {
    const messages = turn.map((message) =>
      message.id === "final"
        ? { ...message, content: "BOT_ROUTINE_SILENT\nFound an exception" }
        : message
    )
    expect(quietBotTurnMessageIds(messages, new Map([[source.requestId, source]])).size).toBe(0)
    expect(quietBotTurnMessageIds(turn.slice(1), new Map([[source.requestId, source]])).size).toBe(
      0
    )
  })
})
