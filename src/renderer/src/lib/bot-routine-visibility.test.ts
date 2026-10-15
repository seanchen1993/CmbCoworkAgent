import { describe, expect, it } from "vitest"
import type { Message } from "@/types"
import type { BotMessageOrigin } from "../../../shared/bots/contracts"
import { quietBotTurnMessageIds } from "./bot-routine-visibility"

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
