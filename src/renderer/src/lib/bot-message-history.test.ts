import { expect, it } from "vitest"
import type { BotMessage } from "../../../shared/bot-types"
import {
  BOT_MESSAGE_RESIDENT_LIMIT,
  boundBotMessageWindow,
  estimateBotMessageBytes,
  mergeBotMessagePage,
  mergeBotReactionStates
} from "./bot-message-history"

const messages = (start: number, count: number): BotMessage[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `message-${start + index}`,
    sequence: start + index,
    conversationId: "conversation",
    sender: "user",
    botId: null,
    text: String(start + index),
    runId: null,
    replyTo: null,
    createdAt: start + index,
    attachments: []
  }))

it("preserves earlier pages across overlapping refreshes with no duplicate identities", () => {
  const before = messages(1, 150)
  const merged = mergeBotMessagePage(before, messages(60, 100), true)
  expect(merged.reset).toBe(false)
  expect(merged.messages).toHaveLength(159)
  expect(merged.messages[0]).toBe(before[0])
  expect(merged.messages.at(-1)?.sequence).toBe(159)
})

it("refreshes reactions on older messages and never replaces a newer response with stale page data", () => {
  const existing = messages(1, 220)
  const reactionState = {
    messageId: existing[0].id,
    revision: 3,
    reactions: [{ emoji: "👍", by: "me" }]
  }
  const updated = mergeBotReactionStates(existing, [reactionState])
  expect(updated[0].reactionState).toEqual(reactionState)
  expect(updated[1]).toBe(existing[1])
  expect(mergeBotMessagePage(updated, messages(1, 100), false).messages[0].reactionState).toEqual(
    reactionState
  )
  expect(
    mergeBotReactionStates(updated, [{ ...reactionState, revision: 2, reactions: [] }])[0]
  ).toBe(updated[0])
  expect(
    mergeBotReactionStates(updated, [{ ...reactionState, revision: 4, reactions: [] }])[0]
      .reactionState?.reactions
  ).toEqual([])
})

it("does not hide an unknown history gap after reconnecting to more than a page of new messages", () => {
  const merged = mergeBotMessagePage(messages(1, 100), messages(220, 100), true)
  expect(merged.reset).toBe(true)
  expect(merged.messages).toHaveLength(100)
  expect(merged.messages[0].sequence).toBe(220)
  const earlier = mergeBotMessagePage(merged.messages, messages(120, 100), false)
  expect(earlier.messages).toHaveLength(200)
  expect(earlier.messages[0].sequence).toBe(120)
})

it("keeps ordering when an older response arrives after a new message", () => {
  const merged = mergeBotMessagePage(messages(20, 105), messages(10, 100), true)
  expect(merged.reset).toBe(false)
  expect(merged.messages[0].sequence).toBe(10)
  expect(merged.messages.at(-1)?.sequence).toBe(124)
})

it("bounds a long live transcript and retains a reloadable contiguous newest window", () => {
  const existing = messages(1, BOT_MESSAGE_RESIDENT_LIMIT)
  const merged = mergeBotMessagePage(existing, messages(1402, 100), true)
  expect(merged.messages).toHaveLength(BOT_MESSAGE_RESIDENT_LIMIT)
  expect(merged.messages[0].sequence).toBe(2)
  expect(merged.messages.at(-1)?.sequence).toBe(1501)
  expect(merged.removedOlder).toBe(true)
  expect(merged.removedNewer).toBe(false)
})

it("releases the opposite end when paging older and newer, without leaving an internal gap", () => {
  const older = mergeBotMessagePage(messages(101, 1500), messages(1, 100), false, {
    direction: "older"
  })
  expect(older.messages.map((message) => message.sequence)).toEqual(
    Array.from({ length: 1500 }, (_, index) => index + 1)
  )
  expect(older.removedNewer).toBe(true)
  const newer = mergeBotMessagePage(older.messages, messages(1501, 100), false, {
    direction: "newer"
  })
  expect(newer.messages.map((message) => message.sequence)).toEqual(
    Array.from({ length: 1500 }, (_, index) => index + 101)
  )
  expect(newer.removedOlder).toBe(true)
})

it("counts UTF-16 strings and attachment/reference metadata in the resident byte budget", () => {
  const rows = messages(1, 3).map((message) => ({
    ...message,
    attachments: ["附件".repeat(1000)],
    entityReferences: [{ kind: "bot" as const, id: "bot", name: "引用".repeat(1000) }]
  }))
  expect(estimateBotMessageBytes(rows[0])).toBeGreaterThan(8000)
  const budget = estimateBotMessageBytes(rows[0]) + estimateBotMessageBytes(rows[1])
  const older = boundBotMessageWindow(rows, { direction: "older", maximumBytes: budget })
  expect(older.messages).toEqual(rows.slice(0, 2))
  expect(older.removedNewer).toBe(true)
  const newer = boundBotMessageWindow(rows, { direction: "newer", maximumBytes: budget })
  expect(newer.messages).toEqual(rows.slice(1))
  expect(newer.removedOlder).toBe(true)
})

it("keeps one oversize message accessible and includes a quoted target when trimming its page", () => {
  const rows = messages(1, 5)
  rows[2] = { ...rows[2], text: "x".repeat(10000) }
  const target = boundBotMessageWindow(rows, {
    direction: "target",
    targetId: rows[2].id,
    maximumBytes: 100
  })
  expect(target.messages).toEqual([rows[2]])
  expect(target.removedOlder).toBe(true)
  expect(target.removedNewer).toBe(true)
  expect(boundBotMessageWindow(rows, { direction: "newer", maximumMessages: 1 }).messages).toEqual([
    rows[4]
  ])
})

it("fills the opposite side of a target when its first neighbor exceeds the byte budget", () => {
  const rows = messages(1, 4)
  rows[0] = { ...rows[0], text: "x".repeat(10000) }
  const budget = rows
    .slice(1)
    .reduce((bytes, message) => bytes + estimateBotMessageBytes(message), 0)
  const window = boundBotMessageWindow(rows, {
    direction: "target",
    targetId: rows[1].id,
    maximumBytes: budget
  })
  expect(window.messages).toEqual(rows.slice(1))
  expect(window.removedOlder).toBe(true)
  expect(window.removedNewer).toBe(false)
})

it("defers a latest append that would evict the position being read", () => {
  const existing = messages(1, 1500)
  const incoming = messages(1402, 100)
  incoming[0] = {
    ...incoming[0],
    reactionState: { messageId: incoming[0].id, revision: 3, reactions: [] }
  }
  const merged = mergeBotMessagePage(existing, incoming, true, { followTail: false })
  expect(merged.messages.map((message) => message.id)).toEqual(
    existing.map((message) => message.id)
  )
  expect(merged.messages[0]).toBe(existing[0])
  expect(merged.messages[1401].reactionState?.revision).toBe(3)
  expect(merged.removedOlder).toBe(false)
  expect(merged.deferredLatest).toBe(true)
})

it("preserves a detached window across a long disconnection and exposes forward paging", () => {
  const existing = messages(1, 100)
  const merged = mergeBotMessagePage(existing, messages(220, 100), true, { followTail: false })
  expect(merged.reset).toBe(false)
  expect(merged.deferredLatest).toBe(true)
  expect(merged.messages).toEqual(existing)
})

it("does not discard newer reactions or branch read revisions while reloading a released page", () => {
  const [original] = messages(1, 1)
  const readState = {
    revision: 7,
    lastReadSequence: 2,
    latestSequence: 2,
    unreadCount: 0,
    firstUnreadSequence: null,
    manuallyUnread: false
  }
  const newer = {
    ...original,
    reactionState: { messageId: original.id, revision: 6, reactions: [] },
    threadSummary: { rootId: original.id, count: 1, readState }
  }
  const stale = {
    ...original,
    reactionState: { messageId: original.id, revision: 4, reactions: [] },
    threadSummary: { rootId: original.id, count: 2, readState: { ...readState, revision: 5 } }
  }
  const [merged] = mergeBotMessagePage([newer], [stale], false).messages
  expect(merged.reactionState?.revision).toBe(6)
  expect(merged.threadSummary?.count).toBe(2)
  expect(merged.threadSummary?.readState.revision).toBe(7)
})
