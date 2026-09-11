import { describe, expect, it } from "vitest"
import type { Message } from "@/types"
import {
  buildMessageBubbleTimingMeta,
  formatMessageTimeLabel,
  getAssistantStartTime
} from "./message-bubble-timing"

function message(id: string, role: Message["role"], createdAt: Date): Message {
  return { id, role, content: id, created_at: createdAt }
}

describe("message bubble timestamps", () => {
  it("shows the full local date and zero-padded 24-hour time across year boundaries", () => {
    expect(formatMessageTimeLabel(new Date(2025, 11, 31, 23, 59).getTime())).toBe(
      "2025-12-31 23:59"
    )
    expect(formatMessageTimeLabel(new Date(2026, 0, 1, 0, 5).getTime())).toBe("2026-01-01 00:05")
    expect(formatMessageTimeLabel(new Date(2024, 1, 29, 9, 7).getTime())).toBe("2024-02-29 09:07")
  })

  it("omits invalid times instead of displaying Invalid Date or the current time", () => {
    expect(formatMessageTimeLabel(Number.NaN)).toBeNull()
    expect(formatMessageTimeLabel(Number.POSITIVE_INFINITY)).toBeNull()
    expect(formatMessageTimeLabel(9e15)).toBeNull()
    const invalid = message("invalid", "user", new Date(Number.NaN))
    expect(buildMessageBubbleTimingMeta([invalid]).userSendTimeLabelById.size).toBe(0)
    expect(getAssistantStartTime({ ...invalid, role: "assistant" })).toBeNull()
  })

  it("preserves the user timestamp fallback order and accepts restored ISO dates", () => {
    const created = new Date(2026, 8, 10, 14, 32)
    const started = new Date(2026, 8, 10, 14, 33)
    const ended = new Date(2026, 8, 10, 14, 34)
    const original = {
      ...message("original", "user", created),
      start_at: started,
      end_at: ended
    }
    const restored = {
      ...original,
      id: "restored",
      created_at: created.toISOString() as unknown as Date
    }
    const fallback = { ...original, id: "fallback", created_at: new Date(Number.NaN) }
    const endOnly = { ...fallback, id: "end-only", start_at: undefined }
    const labels = buildMessageBubbleTimingMeta([
      original,
      restored,
      fallback,
      endOnly
    ]).userSendTimeLabelById
    expect([...labels.values()]).toEqual([
      "2026-09-10 14:32",
      "2026-09-10 14:32",
      "2026-09-10 14:33",
      "2026-09-10 14:34"
    ])
  })

  it("keeps assistant start time stable as completion time advances", () => {
    const started = new Date(2026, 8, 10, 14, 32)
    const assistant = {
      ...message("assistant", "assistant", new Date(2026, 8, 10, 14, 33)),
      start_at: started
    }
    expect(getAssistantStartTime(assistant)).toBe(started.getTime())
    expect(getAssistantStartTime({ ...assistant, end_at: new Date(2026, 8, 10, 14, 40) })).toBe(
      started.getTime()
    )
    expect(getAssistantStartTime({ ...assistant, start_at: new Date(Number.NaN) })).toBe(
      assistant.created_at.getTime()
    )
    expect(getAssistantStartTime({ ...assistant, role: "tool" })).toBeNull()
    expect(getAssistantStartTime({ ...assistant, role: "user" })).toBeNull()
  })

  it("preserves turn duration across tool calls, multiple replies and the next user turn", () => {
    const base = new Date(2026, 8, 10, 23, 59, 50).getTime()
    const at = (seconds: number): Date => new Date(base + seconds * 1000)
    const messages: Message[] = [
      message("user-1", "user", at(0)),
      message("assistant-1", "assistant", at(1)),
      message("tool", "tool", at(5)),
      { ...message("assistant-2", "assistant", at(10)), end_at: at(20) },
      message("user-2", "user", at(30)),
      { ...message("assistant-3", "assistant", at(31)), end_at: at(35) }
    ]
    const timing = buildMessageBubbleTimingMeta(messages)
    expect([...timing.assistantDurationMsById]).toEqual([
      ["assistant-1", 20_000],
      ["assistant-3", 5_000]
    ])
    expect([...timing.userSendTimeLabelById]).toEqual([
      ["user-1", "2026-09-10 23:59"],
      ["user-2", "2026-09-11 00:00"]
    ])
  })
})
