import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  resolveChatMessageVirtualInitialLocation,
  shouldVirtualizeChatMessageList,
  type ChatMessageVirtualInitialLocation
} from "./ChatMessageVirtualList"
import {
  createChatScrollState,
  transitionChatScroll,
  type ChatScrollEffect,
  type ChatScrollEvent,
  type ChatScrollState
} from "../../../../shared/chat-scroll-controller"

function dispatch(
  state: ChatScrollState,
  event: ChatScrollEvent
): { state: ChatScrollState; effects: ChatScrollEffect[] } {
  return transitionChatScroll(state, event)
}

function attachedState(messageCount = 10): ChatScrollState {
  const ready = dispatch(createChatScrollState("thread-1"), {
    type: "DATA_READY",
    messageCount
  }).state
  return dispatch(ready, { type: "BOTTOM_CONFIRMED" }).state
}

describe("chat scroll regression scenarios", () => {
  it("does not accept BOTTOM_CONFIRMED before the active thread data is ready", () => {
    const initial = createChatScrollState("thread-1")

    const premature = dispatch(initial, { type: "BOTTOM_CONFIRMED" })

    expect(premature.effects).toEqual([])
    expect(premature.state).toBe(initial)
    expect(premature.state).toMatchObject({
      mode: "initializing",
      dataReady: false,
      programmaticScrollGuard: false
    })
  })

  it("uses the LAST/end initial contract when an initially empty thread receives a message", () => {
    const initialLocation: ChatMessageVirtualInitialLocation = {
      index: "LAST",
      align: "end",
      behavior: "auto"
    }
    const emptyReady = dispatch(createChatScrollState("thread-1"), {
      type: "DATA_READY",
      messageCount: 0
    })

    expect(emptyReady.state.mode).toBe("following")
    expect(emptyReady.effects).toEqual([])
    expect(resolveChatMessageVirtualInitialLocation(initialLocation, 0)).toBeUndefined()
    expect(resolveChatMessageVirtualInitialLocation(initialLocation, 1)).toEqual(initialLocation)

    const firstMessage = dispatch(emptyReady.state, {
      type: "CONTENT_APPENDED",
      unreadMessages: 1
    })
    expect(firstMessage.effects).toEqual([
      { type: "scroll-to-bottom", reason: "content-appended", generation: 0 }
    ])
  })

  it.each([1, 99, 100, 101])(
    "keeps one virtual-list implementation at %i visible messages",
    (messageCount) => {
      expect(shouldVirtualizeChatMessageList(messageCount)).toBe(true)
    }
  )

  it("does not emit scroll effects for a detached streaming response", () => {
    let state = dispatch(attachedState(), {
      type: "USER_DETACH",
      source: "user-input"
    }).state
    const appended = dispatch(state, { type: "CONTENT_APPENDED", unreadMessages: 1 })
    state = appended.state

    expect(appended.effects).toEqual([])
    for (let token = 0; token < 100; token += 1) {
      const grown = dispatch(state, { type: "CONTENT_GROWN" })
      expect(grown.effects).toEqual([])
      state = grown.state
    }

    expect(state).toMatchObject({
      mode: "detached",
      hasUnread: true,
      unreadCount: 1,
      programmaticScrollGuard: false
    })
  })

  it("keeps unread until RETURN_TO_BOTTOM is confirmed and emits one guarded command", () => {
    let state = dispatch(attachedState(), {
      type: "USER_DETACH",
      source: "user-input"
    }).state
    state = dispatch(state, { type: "CONTENT_APPENDED", unreadMessages: 3 }).state

    const returned = dispatch(state, { type: "RETURN_TO_BOTTOM" })

    expect(returned.state).toMatchObject({
      mode: "following",
      hasUnread: true,
      unreadCount: 3,
      programmaticScrollGuard: true
    })
    expect(returned.effects).toEqual([
      { type: "scroll-to-bottom", reason: "return-to-bottom", generation: 0 }
    ])
    const confirmed = dispatch(returned.state, { type: "BOTTOM_CONFIRMED" })
    expect(confirmed.state).toMatchObject({ hasUnread: false, unreadCount: 0 })
  })

  it("preserves detached intent and unread state through history restoration", () => {
    let state = dispatch(attachedState(), {
      type: "USER_DETACH",
      source: "user-input"
    }).state
    state = dispatch(state, { type: "CONTENT_APPENDED", unreadMessages: 2 }).state
    state = dispatch(state, { type: "RESTORE_BEGIN" }).state

    const heightGrowth = dispatch(state, { type: "CONTENT_GROWN" })
    const transientBottom = dispatch(heightGrowth.state, { type: "BOTTOM_CONFIRMED" })
    const restored = dispatch(transientBottom.state, { type: "RESTORE_END" })

    expect(heightGrowth.effects).toEqual([])
    expect(transientBottom.effects).toEqual([])
    expect(restored.effects).toEqual([])
    expect(restored.state).toMatchObject({
      mode: "detached",
      hasUnread: true,
      unreadCount: 2,
      restoreDepth: 0,
      restoreMode: null
    })
  })

  it("defers attached height growth until history restoration has completed", () => {
    const restoring = dispatch(attachedState(), { type: "RESTORE_BEGIN" }).state
    const heightGrowth = dispatch(restoring, { type: "CONTENT_GROWN" })

    expect(heightGrowth.effects).toEqual([])
    expect(heightGrowth.state).toMatchObject({
      mode: "restoring",
      restoreMode: "following",
      pendingFollowAfterRestore: true
    })

    const restored = dispatch(heightGrowth.state, { type: "RESTORE_END" })
    expect(restored.state.mode).toBe("following")
    expect(restored.effects).toEqual([
      { type: "scroll-to-bottom", reason: "restore-complete", generation: 0 }
    ])
  })
})

describe("chat scroll source contracts", () => {
  const containerSource = readFileSync(
    fileURLToPath(
      new URL("./ChatContainer.tsx", import.meta.url)
    ),
    "utf8"
  )
  const buttonSource = readFileSync(
    fileURLToPath(
      new URL(
        "./ChatScrollToBottomButton.tsx",
        import.meta.url
      )
    ),
    "utf8"
  )

  it("has no legacy maximum-scroll or 200px token writer", () => {
    expect(containerSource).not.toContain("Number.MAX_SAFE_INTEGER")
    expect(containerSource).not.toMatch(/bottomDistance\s*<=\s*200/)
    expect(containerSource).not.toContain("chatAutoScrollTriggerKey")
    expect(containerSource).toMatch(
      /scrollToIndex\(\{\s*index:\s*lastVisibleIndex,\s*align:\s*"end"/
    )
  })

  it("keeps viewport observation out of the return-to-bottom button", () => {
    expect(buttonSource).not.toMatch(
      /ResizeObserver|requestAnimationFrame|addEventListener|getViewport/
    )
    expect(buttonSource).toMatch(/visible:\s*boolean/)
    expect(buttonSource).toMatch(/hasUnread:\s*boolean/)
    expect(buttonSource).toMatch(/unreadCount:\s*number/)
  })
})
