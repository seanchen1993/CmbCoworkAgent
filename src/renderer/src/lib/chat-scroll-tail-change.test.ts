import { describe, expect, it } from "vitest"
import type { Message } from "../types"
import {
  chatScrollTailMessageIdentity,
  classifyChatScrollTailChange,
  shouldMarkChatTailContentGrowth,
  type ChatScrollTailSnapshot
} from "./chat-scroll-tail-change"

function message(
  id: string,
  role: Message["role"],
  providerSourceId?: string,
  providerOccurrence?: number
): Message {
  return {
    id,
    role,
    content: "",
    created_at: new Date(0),
    ...(providerSourceId ? { provider_source_id: providerSourceId } : {}),
    ...(providerOccurrence !== undefined ? { provider_occurrence: providerOccurrence } : {})
  }
}

function snapshot(
  messages: readonly Message[],
  visibleMessageIndexes: readonly number[],
  loadedMessageCount = messages.length
): ChatScrollTailSnapshot {
  const lastMessageIndex = visibleMessageIndexes.at(-1)
  const lastMessage =
    lastMessageIndex === undefined ? undefined : messages[lastMessageIndex]
  return {
    visibleCount: visibleMessageIndexes.length,
    lastMessageId: lastMessage?.id ?? null,
    lastMessageIdentity: chatScrollTailMessageIdentity(lastMessage),
    loadedMessageCount
  }
}

function exactVisibleIndexMap(
  messages: readonly Message[],
  visibleMessageIndexes: readonly number[]
): ReadonlyMap<string, number> {
  const result = new Map<string, number>()
  visibleMessageIndexes.forEach((messageIndex, visibleIndex) => {
    const item = messages[messageIndex]
    if (item) result.set(item.id, visibleIndex)
  })
  return result
}

describe("classifyChatScrollTailChange", () => {
  it("does not classify a durable history prepend as appended output", () => {
    const previousMessages = [message("a", "user"), message("b", "assistant")]
    const previousIndexes = [0, 1]
    const currentMessages = [message("older", "assistant"), ...previousMessages]
    const currentIndexes = [0, 1, 2]

    expect(
      classifyChatScrollTailChange({
        previous: snapshot(previousMessages, previousIndexes),
        current: snapshot(currentMessages, currentIndexes),
        displayMessages: currentMessages,
        visibleMessageIndexes: currentIndexes,
        visibleMessageIndexById: exactVisibleIndexMap(currentMessages, currentIndexes)
      })
    ).toEqual({
      appendedMessageCount: 0,
      unreadMessageCount: 0,
      tailChanged: false,
      regressed: false
    })
  })

  it("counts only the true tail delta when a prepend and append arrive together", () => {
    const previousMessages = [message("a", "user"), message("b", "assistant")]
    const previousIndexes = [0, 1]
    const currentMessages = [
      message("older", "assistant"),
      ...previousMessages,
      message("c", "assistant"),
      message("d", "tool")
    ]
    const currentIndexes = [0, 1, 2, 3, 4]

    expect(
      classifyChatScrollTailChange({
        previous: snapshot(previousMessages, previousIndexes),
        current: snapshot(currentMessages, currentIndexes),
        displayMessages: currentMessages,
        visibleMessageIndexes: currentIndexes,
        visibleMessageIndexById: exactVisibleIndexMap(currentMessages, currentIndexes)
      })
    ).toEqual({ appendedMessageCount: 2, unreadMessageCount: 2, tailChanged: true, regressed: false })
  })

  it("uses provider identity to avoid duplicating a re-keyed tail", () => {
    const previousMessages = [
      message("user", "user"),
      message("assistant-provisional", "assistant", "provider-assistant", 1)
    ]
    const previousIndexes = [0, 1]
    const currentMessages = [
      message("user", "user"),
      message("assistant-stable", "assistant", "provider-assistant", 1),
      message("tool-result", "tool", "provider-tool", 1)
    ]
    const currentIndexes = [0, 1, 2]

    expect(
      classifyChatScrollTailChange({
        previous: snapshot(previousMessages, previousIndexes),
        current: snapshot(currentMessages, currentIndexes),
        displayMessages: currentMessages,
        visibleMessageIndexes: currentIndexes,
        visibleMessageIndexById: exactVisibleIndexMap(currentMessages, currentIndexes)
      })
    ).toEqual({ appendedMessageCount: 1, unreadMessageCount: 1, tailChanged: true, regressed: false })
  })

  it("matches a fallback id with its later provider-source promotion", () => {
    const previousMessages = [message("provider-assistant", "assistant")]
    const currentMessages = [
      message("assistant-stable", "assistant", "provider-assistant", 1)
    ]

    expect(
      classifyChatScrollTailChange({
        previous: snapshot(previousMessages, [0]),
        current: snapshot(currentMessages, [0]),
        displayMessages: currentMessages,
        visibleMessageIndexes: [0],
        visibleMessageIndexById: exactVisibleIndexMap(currentMessages, [0])
      })
    ).toEqual({ appendedMessageCount: 0, unreadMessageCount: 0, tailChanged: false, regressed: false })
  })

  it("classifies an optimistic user row as appended but not unread", () => {
    const previousMessages = [message("assistant", "assistant")]
    const currentMessages = [...previousMessages, message("optimistic-user", "user")]

    expect(
      classifyChatScrollTailChange({
        previous: snapshot(previousMessages, [0]),
        current: snapshot(currentMessages, [0, 1]),
        displayMessages: currentMessages,
        visibleMessageIndexes: [0, 1],
        visibleMessageIndexById: exactVisibleIndexMap(currentMessages, [0, 1])
      })
    ).toEqual({ appendedMessageCount: 1, unreadMessageCount: 0, tailChanged: true, regressed: false })
  })

  it("counts assistant and tool rows as unread", () => {
    const previousMessages = [message("user", "user")]
    const currentMessages = [
      ...previousMessages,
      message("assistant", "assistant"),
      message("tool", "tool")
    ]

    expect(
      classifyChatScrollTailChange({
        previous: snapshot(previousMessages, [0]),
        current: snapshot(currentMessages, [0, 1, 2]),
        displayMessages: currentMessages,
        visibleMessageIndexes: [0, 1, 2],
        visibleMessageIndexById: exactVisibleIndexMap(currentMessages, [0, 1, 2])
      })
    ).toEqual({ appendedMessageCount: 2, unreadMessageCount: 2, tailChanged: true, regressed: false })
  })

  it("does not confuse a reused cross-role id with the previous tail", () => {
    const previousMessages = [message("shared", "assistant")]
    const currentMessages = [
      ...previousMessages,
      message("shared", "tool"),
      message("new-assistant", "assistant")
    ]

    expect(
      classifyChatScrollTailChange({
        previous: snapshot(previousMessages, [0]),
        current: snapshot(currentMessages, [0, 1, 2]),
        displayMessages: currentMessages,
        visibleMessageIndexes: [0, 1, 2],
        visibleMessageIndexById: exactVisibleIndexMap(currentMessages, [0, 1, 2])
      })
    ).toEqual({ appendedMessageCount: 2, unreadMessageCount: 2, tailChanged: true, regressed: false })
  })

  it("does not read a 10k history prefix for a stable-tail content token", () => {
    const tail = message("assistant", "assistant", "provider-assistant", 1)
    const stableSnapshot: ChatScrollTailSnapshot = {
      visibleCount: 10_000,
      lastMessageId: tail.id,
      lastMessageIdentity: chatScrollTailMessageIdentity(tail),
      loadedMessageCount: 10_000
    }
    const unreadableMessages = new Proxy([] as Message[], {
      get: () => {
        throw new Error("stable content must not read displayMessages")
      }
    })
    const unreadableIndexes = new Proxy([] as number[], {
      get: () => {
        throw new Error("stable content must not read visibleMessageIndexes")
      }
    })
    const unreadableExactMap = {
      get: () => {
        throw new Error("stable content must not query the exact id map")
      }
    } as unknown as ReadonlyMap<string, number>

    expect(
      classifyChatScrollTailChange({
        previous: stableSnapshot,
        current: { ...stableSnapshot },
        displayMessages: unreadableMessages,
        visibleMessageIndexes: unreadableIndexes,
        visibleMessageIndexById: unreadableExactMap
      })
    ).toEqual({ appendedMessageCount: 0, unreadMessageCount: 0, tailChanged: false, regressed: false })
  })

  it("classifies removal of a failed optimistic user tail as a regression, not unread output", () => {
    const currentMessages = [message("assistant", "assistant")]
    const previousMessages = [...currentMessages, message("optimistic-user", "user")]

    const change = classifyChatScrollTailChange({
      previous: snapshot(previousMessages, [0, 1]),
      current: snapshot(currentMessages, [0]),
      displayMessages: currentMessages,
      visibleMessageIndexes: [0],
      visibleMessageIndexById: exactVisibleIndexMap(currentMessages, [0])
    })
    expect(change).toEqual({
      appendedMessageCount: 0,
      unreadMessageCount: 0,
      tailChanged: true,
      regressed: true
    })
    expect(
      shouldMarkChatTailContentGrowth({
        change,
        currentTail: currentMessages[0],
        contentVersionChanged: true,
        structureVersionChanged: true,
        changedTail: true
      })
    ).toBe(false)
  })

  it("does not mark the user's own tail reconciliation as unread content growth", () => {
    const userTail = message("optimistic-user", "user")
    const change = {
      appendedMessageCount: 0,
      unreadMessageCount: 0,
      tailChanged: true,
      regressed: false
    }

    expect(
      shouldMarkChatTailContentGrowth({
        change,
        currentTail: userTail,
        contentVersionChanged: true,
        structureVersionChanged: false,
        changedTail: true
      })
    ).toBe(false)
    expect(
      shouldMarkChatTailContentGrowth({
        change,
        currentTail: message("assistant", "assistant"),
        contentVersionChanged: true,
        structureVersionChanged: false,
        changedTail: true
      })
    ).toBe(true)
  })

  it("does not turn a history prepend's full changed list into unread tail growth", () => {
    const change = {
      appendedMessageCount: 0,
      unreadMessageCount: 0,
      tailChanged: false,
      regressed: false
    }

    expect(
      shouldMarkChatTailContentGrowth({
        change,
        currentTail: message("assistant", "assistant"),
        contentVersionChanged: true,
        structureVersionChanged: true,
        changedTail: true
      })
    ).toBe(false)
  })
})
