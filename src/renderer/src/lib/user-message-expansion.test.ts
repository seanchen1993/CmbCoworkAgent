import { describe, expect, it } from "vitest"
import {
  readUserMessageExpansion,
  rememberUserMessageExpansion,
  UserMessageExpansionStore,
  userMessageContentKey,
  userMessageExpansionKey
} from "../components/chat/user-message-expansion-context"

describe("explicit user message expansion survives virtual row recycling", () => {
  it("starts collapsed without storing default choices and restores explicit open and close choices", () => {
    const choices = new UserMessageExpansionStore()
    const key = userMessageExpansionKey("thread", "message")
    const contentKey = userMessageContentKey("Long user message".repeat(100))
    expect(readUserMessageExpansion(choices, key, contentKey)).toEqual({
      generation: 0,
      expanded: false,
      explicit: false
    })
    expect(choices.size).toBe(0)
    rememberUserMessageExpansion(choices, key, { generation: 0, contentKey, expanded: true })
    expect(readUserMessageExpansion(choices, key, contentKey).expanded).toBe(true)
    rememberUserMessageExpansion(choices, key, { generation: 0, contentKey, expanded: false })
    expect(readUserMessageExpansion(choices, key, contentKey)).toEqual({
      generation: 0,
      expanded: false,
      explicit: true
    })
  })

  it("keeps thread and message identities separate even when IDs contain separators", () => {
    const choices = new UserMessageExpansionStore()
    const key = userMessageExpansionKey("one:two", "three")
    const other = userMessageExpansionKey("one", "two:three")
    const contentKey = userMessageContentKey("same content")
    expect(key).not.toBe(other)
    rememberUserMessageExpansion(choices, key, { generation: 0, contentKey, expanded: true })
    expect(readUserMessageExpansion(choices, other, contentKey).expanded).toBe(false)
    expect(
      readUserMessageExpansion(new UserMessageExpansionStore(), key, contentKey).expanded
    ).toBe(false)
  })

  it("collapses edited content including changes in the middle of a long message", () => {
    const choices = new UserMessageExpansionStore()
    const key = userMessageExpansionKey("thread", "message")
    const prefix = "Shared beginning".repeat(1000)
    const suffix = "Shared ending".repeat(1000)
    const contentKey = userMessageContentKey(`${prefix}Original${suffix}`)
    const editedKey = userMessageContentKey(`${prefix}Modified${suffix}`)
    expect(editedKey).not.toBe(contentKey)
    expect(contentKey.length).toBeLessThan(80)
    rememberUserMessageExpansion(choices, key, { generation: 0, contentKey, expanded: true })
    expect(readUserMessageExpansion(choices, key, editedKey).expanded).toBe(false)
    const blocks = [
      { type: "text", text: "One" },
      { type: "text", text: "Two" }
    ]
    expect(userMessageContentKey(blocks)).toBe(userMessageContentKey(structuredClone(blocks)))
    expect(userMessageContentKey(blocks)).not.toBe(userMessageContentKey("OneTwo"))
  })

  it("discards only the removed message and prevents stale attempt callbacks from restoring it", () => {
    const choices = new UserMessageExpansionStore()
    const key = userMessageExpansionKey("thread", "retry")
    const history = userMessageExpansionKey("thread", "history")
    const otherThread = userMessageExpansionKey("other", "retry")
    const contentKey = userMessageContentKey("Content")
    const original = { generation: 0, contentKey, expanded: true }
    for (const message of [key, history, otherThread])
      rememberUserMessageExpansion(choices, message, original)
    choices.discardMessages("thread", new Set(["retry"]), 1)
    rememberUserMessageExpansion(choices, key, original, 0)
    expect(choices.has(key)).toBe(false)
    expect(choices.has(history)).toBe(true)
    expect(choices.has(otherThread)).toBe(true)
    expect(readUserMessageExpansion(choices, key, contentKey, 1, 1).expanded).toBe(false)
    rememberUserMessageExpansion(choices, key, { ...original, generation: 1 }, 1)
    rememberUserMessageExpansion(choices, key, original, 0)
    expect(choices.get(key)?.generation).toBe(1)
    expect(readUserMessageExpansion(choices, key, contentKey, 0, 0).expanded).toBe(false)
  })

  it("retains an existing choice when its bounded attempt record expires without borrowing future state", () => {
    const choices = new UserMessageExpansionStore()
    const key = userMessageExpansionKey("thread", "message")
    const contentKey = userMessageContentKey("Content")
    rememberUserMessageExpansion(choices, key, { generation: 5, contentKey, expanded: true }, 5)
    expect(readUserMessageExpansion(choices, key, contentKey, 0, 600).expanded).toBe(true)
    expect(readUserMessageExpansion(choices, key, contentKey, 0, 4).expanded).toBe(false)
    expect(readUserMessageExpansion(choices, key, contentKey, 6, 6).expanded).toBe(false)
  })

  it("bounds explicit choices and evicts the least recently remembered entry", () => {
    const choices = new UserMessageExpansionStore()
    const contentKey = userMessageContentKey("Content")
    const choice = { generation: 0, contentKey, expanded: true }
    for (let index = 0; index < 500; index++)
      rememberUserMessageExpansion(choices, String(index), choice)
    rememberUserMessageExpansion(choices, "0", choice)
    rememberUserMessageExpansion(choices, "500", choice)
    expect(choices.size).toBe(500)
    expect(choices.has("0")).toBe(true)
    expect(choices.has("1")).toBe(false)
    for (let index = 501; index < 10000; index++)
      rememberUserMessageExpansion(choices, String(index), choice)
    expect(choices.size).toBe(500)
    expect(choices.has("9499")).toBe(false)
    expect(choices.has("9500")).toBe(true)
  })
})
