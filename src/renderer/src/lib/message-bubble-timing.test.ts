import { describe, expect, it } from "vitest"
import type { Message } from "@/types"
import {
  buildMessageBubbleTimingMeta,
  formatMessageTimeLabel,
  getAssistantStartTime
} from "./message-bubble-timing"
import { createMessageBubbleTimingProjector } from "./message-bubble-timing"
import { createChatMessageProjector } from "./chat-message-projection"

function message(id: string, role: Message["role"], createdAt: Date): Message {
  return { id, role, content: id, created_at: createdAt }
}

it("updates 10k snapshot rows' streaming tail body and end time without reading historical rows", () => {
  const rows = Array.from({ length: 10000 }, (_, index) => message(String(index),
    index % 2 ? "assistant" : "user", new Date(index * 1000)))
  let protectedPrefix = false
  const messages = new Proxy(rows, { get(target, key, receiver) {
    if (protectedPrefix && (key === Symbol.iterator || (typeof key === "string" &&
      /^\d+$/.test(key) && Number(key) < 9999))) throw Error("historical timing rescan")
    return Reflect.get(target, key, receiver)
  } })
  const project = createMessageBubbleTimingProjector()
  const base = { messages, structureVersion: 1, indexById: new Map<string, number>() }
  project({ ...base, contentVersion: 1, changedMessages: rows })
  protectedPrefix = true
  for (let chunk = 0; chunk < 100; chunk++) {
    rows[9999] = { ...rows[9999], content: "snapshot body " + chunk,
      end_at: new Date(10000000 + chunk) }
    const result = project({ ...base, contentVersion: chunk + 2, changedMessages: [rows[9999]] })
    expect(result).toEqual(buildMessageBubbleTimingMeta(rows))
  }
})

it("matches the complete oracle through same-object dates, invalid fallbacks and duplicate IDs", () => {
  const rows = [message("same-user", "user", new Date(NaN)),
    message("same-assistant", "assistant", new Date(1000)),
    message("same-user", "user", new Date(2000)),
    message("same-assistant", "assistant", new Date(3000))]
  const project = createMessageBubbleTimingProjector()
  let version = 0
  const check = (changedMessages: Message[]) => expect(project({ messages: rows,
    structureVersion: 1, contentVersion: ++version, changedMessages,
    indexById: new Map(rows.map((item, index) => [item.id, index])) }))
    .toEqual(buildMessageBubbleTimingMeta(rows))
  check(rows)
  rows[0].created_at.setTime(100); check([rows[0]])
  rows[3].end_at = new Date(5000); check([rows[3]])
  rows[3].end_at.setTime(6000); check([rows[3]])
  rows[2].created_at.setTime(NaN); check([rows[2]])
  rows[0].created_at.setTime(NaN); check([rows[0]])
  rows[0].start_at = new Date(500); check([rows[0]])
  rows[2].end_at = new Date(3500); check([rows[2]])
  rows[3].created_at.setTime(NaN); rows[3].end_at = undefined; check([rows[3]])
  rows[0].start_at = undefined; check([rows[0]])
  rows[3].start_at = new Date(7000); check([rows[3]])
})

it("consumes actual projection same-reference changed slots without corrupting older changed snapshots", () => {
  const baseline = [message("user", "user", new Date(1000))]
  const tail = message("assistant", "assistant", new Date(2000))
  const projectMessages = createChatMessageProjector(), projectTiming = createMessageBubbleTimingProjector()
  const first = projectMessages(baseline, [tail], undefined, 0,
    { contentVersion: 1, structureVersion: 1, changedMessages: [tail] })
  const firstChanged = first.changedMessages.slice()
  projectTiming(first)
  tail.end_at = new Date(4000)
  const second = projectMessages(baseline, [tail], undefined, 0,
    { contentVersion: 2, structureVersion: 1, changedMessages: [tail] })
  expect(second.contentVersion).toBeGreaterThan(first.contentVersion)
  expect(second.structureVersion).toBe(first.structureVersion)
  expect(second.changedMessages).toEqual([tail])
  expect(first.changedMessages).toEqual(firstChanged)
  expect(first.changedMessages).not.toBe(first.messages)
  expect(projectTiming(second)).toEqual(buildMessageBubbleTimingMeta(second.messages))
  tail.end_at.setTime(5000)
  const third = projectMessages(baseline, [tail], undefined, 0,
    { contentVersion: 3, structureVersion: 1, changedMessages: [tail] })
  expect(projectTiming(third).assistantDurationMsById.get("assistant")).toBe(4000)
})

it("conservatively rebuilds timing when a content revision omits changed slots", () => {
  const rows = [message("u", "user", new Date(0)), message("a", "assistant", new Date(10))]
  const project = createMessageBubbleTimingProjector()
  const base = { messages: rows, structureVersion: 1, indexById: new Map<string, number>() }
  project({ ...base, contentVersion: 1, changedMessages: rows })
  rows[1].end_at = new Date(20)
  expect(project({ ...base, contentVersion: 2, changedMessages: [] }))
    .toEqual(buildMessageBubbleTimingMeta(rows))
})

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
