import { describe, expect, it } from "vitest"
import {
  createChatScrollState,
  isChatScrollDetached,
  mergeChatScrollEffects,
  shouldFollowChatOutput,
  transitionChatScroll,
  type ChatScrollEvent,
  type ChatScrollState
} from "./chat-scroll-controller"

function apply(state: ChatScrollState, event: ChatScrollEvent): ChatScrollState {
  return transitionChatScroll(state, event).state
}

function readyAtBottom(threadId = "thread-1"): ChatScrollState {
  let state = createChatScrollState(threadId)
  state = apply(state, { type: "DATA_READY", messageCount: 10 })
  return apply(state, { type: "BOTTOM_CONFIRMED" })
}

describe("chat scroll controller", () => {
  it("keeps a strong bottom-settle intent when a weak stream update arrives in the same frame", () => {
    const returnToBottom = {
      type: "scroll-to-bottom",
      reason: "return-to-bottom",
      generation: 4
    } as const
    const contentGrowth = {
      type: "scroll-to-bottom",
      reason: "content-grown",
      generation: 4
    } as const

    expect(mergeChatScrollEffects(returnToBottom, contentGrowth)).toBe(returnToBottom)
  })

  it("replaces an old pending bottom command when a new generation starts", () => {
    const oldInitialPosition = {
      type: "scroll-to-bottom",
      reason: "initial-position",
      generation: 7
    } as const
    const newContentGrowth = {
      type: "scroll-to-bottom",
      reason: "content-grown",
      generation: 8
    } as const

    expect(mergeChatScrollEffects(oldInitialPosition, newContentGrowth)).toBe(newContentGrowth)
  })

  it("resets all per-thread state and rejects stale generation callbacks", () => {
    let state = readyAtBottom("old-thread")
    state = apply(state, { type: "USER_DETACH", source: "user-input" })
    state = apply(state, { type: "CONTENT_APPENDED" })

    const reset = transitionChatScroll(state, {
      type: "THREAD_RESET",
      threadId: "new-thread"
    })

    expect(reset.effects).toEqual([])
    expect(reset.state).toMatchObject({
      threadId: "new-thread",
      generation: 1,
      mode: "initializing",
      dataReady: false,
      hasMessages: false,
      hasUnread: false,
      unreadCount: 0
    })

    const stale = transitionChatScroll(reset.state, {
      type: "BOTTOM_CONFIRMED",
      generation: 0
    })
    expect(stale.state).toBe(reset.state)
    expect(stale.effects).toEqual([])
  })

  it("requests an initial bottom position and only follows after confirmation", () => {
    const initial = createChatScrollState("thread-1")
    const premature = transitionChatScroll(initial, { type: "BOTTOM_CONFIRMED" })
    expect(premature.state).toBe(initial)

    const ready = transitionChatScroll(initial, { type: "DATA_READY", messageCount: 25 })

    expect(ready.state).toMatchObject({
      mode: "initializing",
      dataReady: true,
      hasMessages: true,
      programmaticScrollGuard: true
    })
    expect(ready.effects).toEqual([
      { type: "scroll-to-bottom", reason: "initial-position", generation: 0 }
    ])
    expect(shouldFollowChatOutput(ready.state)).toBe(true)

    const passiveDetach = transitionChatScroll(ready.state, {
      type: "USER_DETACH",
      source: "scroll-event"
    })
    expect(passiveDetach.state).toBe(ready.state)

    const confirmed = transitionChatScroll(ready.state, { type: "BOTTOM_CONFIRMED" })
    expect(confirmed.state).toMatchObject({
      mode: "following",
      programmaticScrollGuard: false
    })
  })

  it("finishes initialization without scrolling for an empty conversation", () => {
    const ready = transitionChatScroll(createChatScrollState(), {
      type: "DATA_READY",
      messageCount: 0
    })

    expect(ready.effects).toEqual([])
    expect(ready.state.mode).toBe("following")
    expect(ready.state.hasMessages).toBe(false)
  })

  it("follows appended and growing content while attached to the bottom", () => {
    const state = readyAtBottom()
    const appended = transitionChatScroll(state, { type: "CONTENT_APPENDED" })
    const grown = transitionChatScroll(appended.state, { type: "CONTENT_GROWN" })

    expect(appended.effects[0]).toMatchObject({
      type: "scroll-to-bottom",
      reason: "content-appended"
    })
    expect(grown.effects[0]).toMatchObject({
      type: "scroll-to-bottom",
      reason: "content-grown"
    })
    expect(grown.state.hasUnread).toBe(false)
  })

  it("preserves history position and records unread content after user detaches", () => {
    let state = readyAtBottom()
    state = apply(state, { type: "USER_DETACH", source: "user-input" })

    const appended = transitionChatScroll(state, {
      type: "CONTENT_APPENDED",
      unreadMessages: 2
    })
    const grown = transitionChatScroll(appended.state, { type: "CONTENT_GROWN" })

    expect(appended.effects).toEqual([])
    expect(grown.effects).toEqual([])
    expect(grown.state).toMatchObject({
      mode: "detached",
      hasUnread: true,
      unreadCount: 2
    })
    expect(isChatScrollDetached(grown.state)).toBe(true)
    expect(shouldFollowChatOutput(grown.state)).toBe(false)
  })

  it("lets explicit user input override the programmatic scroll guard", () => {
    let state = readyAtBottom()
    state = apply(state, { type: "PROGRAMMATIC_SCROLL_BEGIN" })

    const passive = transitionChatScroll(state, {
      type: "USER_DETACH",
      source: "scroll-event"
    })
    expect(passive.state.mode).toBe("following")

    const explicit = transitionChatScroll(state, {
      type: "USER_DETACH",
      source: "user-input"
    })
    expect(explicit.state).toMatchObject({
      mode: "detached",
      programmaticScrollGuard: false
    })

    const ended = apply(passive.state, { type: "PROGRAMMATIC_SCROLL_END" })
    const afterGuard = apply(ended, {
      type: "USER_DETACH",
      source: "scroll-event"
    })
    expect(afterGuard.mode).toBe("detached")
  })

  it("returns to the bottom and clears unread only after the position is confirmed", () => {
    let state = readyAtBottom()
    state = apply(state, { type: "USER_DETACH", source: "user-input" })
    state = apply(state, { type: "CONTENT_APPENDED" })

    const returned = transitionChatScroll(state, { type: "RETURN_TO_BOTTOM" })
    expect(returned.state).toMatchObject({
      mode: "following",
      hasUnread: true,
      unreadCount: 1,
      programmaticScrollGuard: true
    })
    expect(returned.effects[0]).toMatchObject({
      type: "scroll-to-bottom",
      reason: "return-to-bottom"
    })

    const confirmed = apply(returned.state, { type: "BOTTOM_CONFIRMED" })
    expect(confirmed).toMatchObject({
      hasUnread: false,
      unreadCount: 0,
      programmaticScrollGuard: false
    })
  })

  it("keeps detached intent and unread state across anchor restoration", () => {
    let state = readyAtBottom()
    state = apply(state, { type: "USER_DETACH", source: "user-input" })
    state = apply(state, { type: "RESTORE_BEGIN" })
    state = apply(state, { type: "CONTENT_APPENDED" })

    const transientBottom = apply(state, { type: "BOTTOM_CONFIRMED" })
    expect(transientBottom.mode).toBe("restoring")
    expect(transientBottom.hasUnread).toBe(true)

    const restored = transitionChatScroll(transientBottom, { type: "RESTORE_END" })
    expect(restored.effects).toEqual([])
    expect(restored.state).toMatchObject({
      mode: "detached",
      hasUnread: true,
      unreadCount: 1,
      restoreDepth: 0,
      restoreMode: null
    })
  })

  it("defers following content until restoration completes", () => {
    let state = readyAtBottom()
    state = apply(state, { type: "RESTORE_BEGIN" })

    const duringRestore = transitionChatScroll(state, { type: "CONTENT_GROWN" })
    expect(duringRestore.effects).toEqual([])
    expect(duringRestore.state.pendingFollowAfterRestore).toBe(true)

    const restored = transitionChatScroll(duringRestore.state, { type: "RESTORE_END" })
    expect(restored.state.mode).toBe("following")
    expect(restored.effects[0]).toMatchObject({
      type: "scroll-to-bottom",
      reason: "restore-complete"
    })
  })

  it("supports nested restoration and defers a return-to-bottom request", () => {
    let state = readyAtBottom()
    state = apply(state, { type: "USER_DETACH", source: "user-input" })
    state = apply(state, { type: "CONTENT_APPENDED" })
    state = apply(state, { type: "RESTORE_BEGIN" })
    state = apply(state, { type: "RESTORE_BEGIN" })

    const requested = transitionChatScroll(state, { type: "RETURN_TO_BOTTOM" })
    expect(requested.effects).toEqual([])
    expect(requested.state).toMatchObject({
      mode: "restoring",
      restoreMode: "following",
      restoreDepth: 2,
      hasUnread: true
    })

    const innerEnd = transitionChatScroll(requested.state, { type: "RESTORE_END" })
    expect(innerEnd.state.restoreDepth).toBe(1)
    expect(innerEnd.effects).toEqual([])

    const outerEnd = transitionChatScroll(innerEnd.state, { type: "RESTORE_END" })
    expect(outerEnd.state.mode).toBe("following")
    expect(outerEnd.effects[0]).toMatchObject({
      type: "scroll-to-bottom",
      reason: "restore-complete"
    })
  })

  it("restores the detached affordance when a requested bottom scroll cannot settle", () => {
    let state = readyAtBottom()
    state = apply(state, { type: "USER_DETACH", source: "user-input" })
    state = apply(state, { type: "CONTENT_APPENDED" })
    state = apply(state, { type: "RETURN_TO_BOTTOM" })

    const failed = apply(state, { type: "SCROLL_TO_BOTTOM_FAILED" })
    expect(failed).toMatchObject({
      mode: "detached",
      hasUnread: true,
      unreadCount: 1,
      programmaticScrollGuard: false
    })
  })

  it("exposes a retry affordance when initial positioning cannot settle", () => {
    const ready = transitionChatScroll(createChatScrollState("thread-1"), {
      type: "DATA_READY",
      messageCount: 25
    }).state

    const failed = apply(ready, { type: "SCROLL_TO_BOTTOM_FAILED" })
    expect(failed).toMatchObject({
      mode: "detached",
      dataReady: true,
      hasMessages: true,
      programmaticScrollGuard: false
    })
  })

  it("can clear unread state independently", () => {
    let state = readyAtBottom()
    state = apply(state, { type: "USER_DETACH", source: "user-input" })
    state = apply(state, { type: "CONTENT_APPENDED" })
    state = apply(state, { type: "CLEAR_UNREAD" })

    expect(state).toMatchObject({
      mode: "detached",
      hasUnread: false,
      unreadCount: 0
    })
  })
})
