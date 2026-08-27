import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { Message } from "@/types"
import {
  resolveChatMessageVirtualInitialLocation,
  shouldVirtualizeChatMessageList,
  type ChatMessageVirtualInitialLocation
} from "./ChatMessageVirtualList"
import {
  createChatScrollSessionStore,
  restoreChatScrollSessionState,
  type ChatScrollSession
} from "./chat-scroll-session-store"
import {
  createChatScrollState,
  transitionChatScroll,
  type ChatScrollEffect,
  type ChatScrollEvent,
  type ChatScrollState
} from "../../../../shared/chat-scroll-controller"
import {
  chatScrollTailMessageIdentity,
  classifyChatScrollTailChange
} from "@/lib/chat-scroll-tail-change"

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

function detachedSession(threadId: string, unreadCount = 0): ChatScrollSession {
  let state = dispatch(createChatScrollState(threadId), {
    type: "DATA_READY",
    messageCount: 20
  }).state
  state = dispatch(state, { type: "BOTTOM_CONFIRMED" }).state
  state = dispatch(state, { type: "USER_DETACH", source: "user-input" }).state
  if (unreadCount > 0) {
    state = dispatch(state, { type: "CONTENT_APPENDED", unreadMessages: unreadCount }).state
  }
  return {
    state,
    anchor: { messageId: `${threadId}-m-8`, offsetFromViewportTop: 17 },
    contentSnapshot: {
      threadId,
      visibleCount: 20,
      lastMessageId: `${threadId}-m-19`,
      lastMessageIdentity: `assistant\u0000${threadId}-m-19\u00001`,
      loadedMessageCount: 20,
      contentVersion: 1,
      structureVersion: 1
    }
  }
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

describe("chat scroll session restoration", () => {
  it("persists return-to-bottom intent before a delayed latest-page reload can finish", async () => {
    const store = createChatScrollSessionStore(2)
    const detached = detachedSession("thread-a", 3)
    const following = dispatch(detached.state, { type: "RETURN_TO_BOTTOM" }).state
    const view = store.open("thread-a")
    let resolveLatest!: () => void
    const delayedLatest = new Promise<void>((resolve) => {
      resolveLatest = resolve
    })

    // Mirrors click -> file-tab unmount: the synchronous following intent is what cleanup saves.
    store.save(view.lease, { ...detached, state: following, anchor: null })
    resolveLatest()
    await delayedLatest

    expect(store.open("thread-a").session).toMatchObject({
      state: { mode: "following", unreadCount: 3 },
      anchor: null
    })
  })

  it("retains a pending gap reveal through a file-tab remount", () => {
    const store = createChatScrollSessionStore(2)
    const firstView = store.open("thread-a")
    store.save(firstView.lease, detachedSession("thread-a"))
    store.setPendingRevealMessageId(firstView.lease, "thread-a-reloaded-gap-page")

    const remountedView = store.open("thread-a")
    expect(remountedView.session?.state.mode).toBe("detached")
    expect(remountedView.pendingRevealMessageId).toBe(
      "thread-a-reloaded-gap-page"
    )

    store.setPendingRevealMessageId(remountedView.lease, null)
    expect(store.getPendingRevealMessageId(remountedView.lease)).toBeNull()
  })

  it("restores A after A -> B -> A without leaking B state", () => {
    const store = createChatScrollSessionStore(4)
    store.save(store.open("thread-a").lease, detachedSession("thread-a", 3))
    store.save(store.open("thread-b").lease, detachedSession("thread-b", 1))

    expect(store.open("thread-a").session).toMatchObject({
      state: { threadId: "thread-a", mode: "detached", unreadCount: 3 },
      anchor: { messageId: "thread-a-m-8", offsetFromViewportTop: 17 },
      contentSnapshot: { lastMessageId: "thread-a-m-19", visibleCount: 20 }
    })
    expect(store.open("thread-b").session).toMatchObject({
      state: { threadId: "thread-b", mode: "detached", unreadCount: 1 },
      anchor: { messageId: "thread-b-m-8" }
    })
  })

  it("normalizes an interrupted restore and advances its async generation", () => {
    const detached = detachedSession("thread-a", 2)
    const restoring = dispatch(detached.state, { type: "RESTORE_BEGIN" }).state

    const resumed = restoreChatScrollSessionState({ ...detached, state: restoring }, "thread-a")

    expect(resumed.state).toMatchObject({
      threadId: "thread-a",
      generation: restoring.generation + 1,
      mode: "detached",
      restoreDepth: 0,
      restoreMode: null,
      programmaticScrollGuard: false,
      unreadCount: 2
    })
    expect(resumed.anchor).toEqual(detached.anchor)
  })

  it("bounds retained sessions and returns defensive snapshots", () => {
    const store = createChatScrollSessionStore(2)
    store.save(store.open("thread-a").lease, detachedSession("thread-a"))
    store.save(store.open("thread-b").lease, detachedSession("thread-b"))
    const firstRestore = store.open("thread-a").session
    expect(firstRestore).not.toBeNull()
    if (firstRestore) firstRestore.state.unreadCount = 99

    store.save(store.open("thread-c").lease, detachedSession("thread-c"))

    expect(store.open("thread-b").session).toBeNull()
    expect(store.open("thread-a").session?.state.unreadCount).toBe(0)
    expect(store.size()).toBe(2)
  })

  it("does not let an unmount save resurrect a deleted same-id session", () => {
    const store = createChatScrollSessionStore(2)
    const oldView = store.open("thread-a")
    store.save(oldView.lease, detachedSession("thread-a", 4))
    store.setPendingRevealMessageId(oldView.lease, "old-message")

    store.delete("thread-a")
    const replacementView = store.open("thread-a")
    expect(replacementView.session).toBeNull()
    expect(replacementView.pendingRevealMessageId).toBeNull()
    // React cleanup can run after the backend deletion has already completed.
    store.save(oldView.lease, detachedSession("thread-a", 9))
    store.setPendingRevealMessageId(oldView.lease, "stale-reveal")

    expect(store.getPendingRevealMessageId(replacementView.lease)).toBeNull()

    // The recreated view can now establish an independent session.
    store.save(replacementView.lease, detachedSession("thread-a", 1))
    expect(store.open("thread-a").session?.state.unreadCount).toBe(1)
  })

  it("counts messages that arrived while a detached chat view was unmounted", () => {
    const store = createChatScrollSessionStore(2)
    store.save(store.open("thread-a").lease, detachedSession("thread-a", 2))
    const restored = store.open("thread-a").session
    expect(restored).not.toBeNull()
    if (!restored?.contentSnapshot) return

    const messages = Array.from({ length: 22 }, (_, index): Message => ({
      id: `thread-a-m-${index}`,
      role: "assistant",
      content: `message ${index}`,
      created_at: new Date(index)
    }))
    const visibleMessageIndexes = messages.map((_message, index) => index)
    const visibleMessageIndexById = new Map(
      messages.map((message, index) => [message.id, index])
    )
    const tail = messages.at(-1)
    const change = classifyChatScrollTailChange({
      previous: restored.contentSnapshot,
      current: {
        visibleCount: messages.length,
        lastMessageId: tail?.id ?? null,
        lastMessageIdentity: chatScrollTailMessageIdentity(tail),
        loadedMessageCount: messages.length
      },
      displayMessages: messages,
      visibleMessageIndexes,
      visibleMessageIndexById
    })
    const updated = dispatch(restored.state, {
      type: "CONTENT_APPENDED",
      unreadMessages: change.unreadMessageCount
    }).state

    expect(change).toMatchObject({ appendedMessageCount: 2, unreadMessageCount: 2 })
    expect(updated).toMatchObject({ mode: "detached", unreadCount: 4, hasUnread: true })
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

  it("persists scroll intent and an anchor outside the keyed ChatContainer lifetime", () => {
    expect(containerSource).toMatch(/chatScrollSessionStore\.open\(threadId\)/)
    expect(containerSource).toMatch(/chatScrollSessionLeaseRef/)
    expect(containerSource).toMatch(
      /chatScrollSessionStore\.save\(sessionLease, \{[\s\S]*state,[\s\S]*anchor,[\s\S]*contentSnapshot:/
    )
    expect(containerSource).toMatch(/pendingChatSessionAnchorRef/)
    expect(containerSource).not.toContain('type: "THREAD_RESET"')
  })
})
