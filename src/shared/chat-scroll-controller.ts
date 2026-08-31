export type ChatScrollMode = "initializing" | "following" | "detached" | "restoring"

type RestorableChatScrollMode = Exclude<ChatScrollMode, "restoring">

export interface ChatScrollState {
  threadId: string | null
  generation: number
  mode: ChatScrollMode
  dataReady: boolean
  hasMessages: boolean
  hasUnread: boolean
  unreadCount: number
  programmaticScrollGuard: boolean
  restoreDepth: number
  restoreMode: RestorableChatScrollMode | null
  pendingFollowAfterRestore: boolean
}

export type ChatScrollToBottomReason =
  | "initial-position"
  | "content-appended"
  | "content-grown"
  | "return-to-bottom"
  | "restore-complete"

export interface ChatScrollToBottomEffect {
  type: "scroll-to-bottom"
  reason: ChatScrollToBottomReason
  generation: number
}

export type ChatScrollEffect = ChatScrollToBottomEffect

function chatScrollEffectPriority(effect: ChatScrollEffect): number {
  switch (effect.reason) {
    case "return-to-bottom":
      return 5
    case "initial-position":
      return 4
    case "restore-complete":
      return 3
    case "content-appended":
      return 2
    case "content-grown":
      return 1
  }
}

export function mergeChatScrollEffects(
  current: ChatScrollEffect | null,
  incoming: ChatScrollEffect
): ChatScrollEffect {
  if (!current || current.generation !== incoming.generation) return incoming
  return chatScrollEffectPriority(incoming) >= chatScrollEffectPriority(current)
    ? incoming
    : current
}

export interface ChatScrollTransition {
  state: ChatScrollState
  effects: ChatScrollEffect[]
}

type GenerationScopedEvent = { generation?: number }

export type ChatScrollEvent =
  | { type: "THREAD_RESET"; threadId: string | null }
  | (GenerationScopedEvent & { type: "DATA_READY"; messageCount: number })
  | (GenerationScopedEvent & { type: "BOTTOM_CONFIRMED" })
  | (GenerationScopedEvent & {
      type: "USER_DETACH"
      source: "user-input" | "scroll-event" | "layout"
    })
  | (GenerationScopedEvent & { type: "CONTENT_APPENDED"; unreadMessages?: number })
  | (GenerationScopedEvent & { type: "CONTENT_GROWN" })
  | (GenerationScopedEvent & { type: "RETURN_TO_BOTTOM" })
  | (GenerationScopedEvent & { type: "RESTORE_BEGIN" })
  | (GenerationScopedEvent & { type: "RESTORE_END" })
  | (GenerationScopedEvent & { type: "CLEAR_UNREAD" })
  | (GenerationScopedEvent & { type: "PROGRAMMATIC_SCROLL_BEGIN" })
  | (GenerationScopedEvent & { type: "PROGRAMMATIC_SCROLL_END" })
  | (GenerationScopedEvent & { type: "SCROLL_TO_BOTTOM_FAILED" })

export function createChatScrollState(threadId: string | null = null): ChatScrollState {
  return {
    threadId,
    generation: 0,
    mode: "initializing",
    dataReady: false,
    hasMessages: false,
    hasUnread: false,
    unreadCount: 0,
    programmaticScrollGuard: false,
    restoreDepth: 0,
    restoreMode: null,
    pendingFollowAfterRestore: false
  }
}

function noEffects(state: ChatScrollState): ChatScrollTransition {
  return { state, effects: [] }
}

function requestBottom(
  state: ChatScrollState,
  reason: ChatScrollToBottomReason
): ChatScrollTransition {
  return {
    state: { ...state, programmaticScrollGuard: true },
    effects: [{ type: "scroll-to-bottom", reason, generation: state.generation }]
  }
}

function clearUnread(state: ChatScrollState): ChatScrollState {
  if (!state.hasUnread && state.unreadCount === 0) return state
  return { ...state, hasUnread: false, unreadCount: 0 }
}

function addUnread(state: ChatScrollState, unreadMessages: number): ChatScrollState {
  const increment = Number.isFinite(unreadMessages) ? Math.max(0, Math.floor(unreadMessages)) : 1

  if (increment === 0) return state

  return {
    ...state,
    hasUnread: true,
    unreadCount: state.unreadCount + increment
  }
}

function markUnread(state: ChatScrollState): ChatScrollState {
  if (state.hasUnread) return state
  return { ...state, hasUnread: true }
}

function effectiveRestoreMode(state: ChatScrollState): RestorableChatScrollMode {
  return state.restoreMode ?? "detached"
}

function handleContentChange(
  state: ChatScrollState,
  kind: "appended" | "grown",
  unreadMessages = 1
): ChatScrollTransition {
  const withMessages = state.hasMessages ? state : { ...state, hasMessages: true }

  if (withMessages.mode === "following") {
    return requestBottom(withMessages, kind === "appended" ? "content-appended" : "content-grown")
  }

  if (withMessages.mode === "initializing") {
    if (!withMessages.dataReady) return noEffects(withMessages)
    return requestBottom(withMessages, "initial-position")
  }

  if (withMessages.mode === "detached") {
    return noEffects(
      kind === "appended" ? addUnread(withMessages, unreadMessages) : markUnread(withMessages)
    )
  }

  if (effectiveRestoreMode(withMessages) === "detached") {
    return noEffects(
      kind === "appended" ? addUnread(withMessages, unreadMessages) : markUnread(withMessages)
    )
  }

  return noEffects({ ...withMessages, pendingFollowAfterRestore: true })
}

function isStaleEvent(state: ChatScrollState, event: ChatScrollEvent): boolean {
  return (
    event.type !== "THREAD_RESET" &&
    event.generation !== undefined &&
    event.generation !== state.generation
  )
}

export function transitionChatScroll(
  state: ChatScrollState,
  event: ChatScrollEvent
): ChatScrollTransition {
  if (isStaleEvent(state, event)) return noEffects(state)

  switch (event.type) {
    case "THREAD_RESET":
      return noEffects({
        ...createChatScrollState(event.threadId),
        generation: state.generation + 1
      })

    case "DATA_READY": {
      const hasMessages = state.hasMessages || event.messageCount > 0
      const nextState = { ...state, dataReady: true, hasMessages }

      if (state.mode === "restoring") return noEffects(nextState)
      if (state.mode !== "initializing") return noEffects(nextState)
      if (hasMessages) return requestBottom(nextState, "initial-position")

      return noEffects({ ...nextState, mode: "following" })
    }

    case "BOTTOM_CONFIRMED":
      if (state.mode === "restoring") return noEffects(state)
      if (state.mode === "initializing" && !state.dataReady) return noEffects(state)
      return noEffects({
        ...clearUnread(state),
        mode: "following",
        programmaticScrollGuard: false
      })

    case "USER_DETACH": {
      if (event.source === "layout") return noEffects(state)
      if (event.source === "scroll-event" && state.programmaticScrollGuard) {
        return noEffects(state)
      }
      if (event.source === "scroll-event" && state.mode === "initializing") {
        return noEffects(state)
      }
      if (event.source === "scroll-event" && state.mode === "restoring") {
        return noEffects(state)
      }

      if (state.mode === "restoring") {
        return noEffects({
          ...state,
          restoreMode: "detached",
          pendingFollowAfterRestore: false,
          programmaticScrollGuard: false
        })
      }

      return noEffects({
        ...state,
        mode: "detached",
        programmaticScrollGuard: false
      })
    }

    case "CONTENT_APPENDED":
      return handleContentChange(state, "appended", event.unreadMessages)

    case "CONTENT_GROWN":
      return handleContentChange(state, "grown")

    case "RETURN_TO_BOTTOM": {
      if (state.mode === "restoring") {
        return noEffects({
          ...state,
          restoreMode: "following",
          pendingFollowAfterRestore: true
        })
      }

      return requestBottom({ ...state, mode: "following" }, "return-to-bottom")
    }

    case "RESTORE_BEGIN":
      if (state.mode === "restoring") {
        return noEffects({ ...state, restoreDepth: state.restoreDepth + 1 })
      }
      return noEffects({
        ...state,
        mode: "restoring",
        restoreDepth: 1,
        restoreMode: state.mode,
        pendingFollowAfterRestore: false,
        programmaticScrollGuard: false
      })

    case "RESTORE_END": {
      if (state.mode !== "restoring") return noEffects(state)
      if (state.restoreDepth > 1) {
        return noEffects({ ...state, restoreDepth: state.restoreDepth - 1 })
      }

      const restoredMode = effectiveRestoreMode(state)
      const nextState: ChatScrollState = {
        ...state,
        mode: restoredMode,
        restoreDepth: 0,
        restoreMode: null,
        pendingFollowAfterRestore: false
      }

      if (restoredMode === "initializing") {
        if (!nextState.dataReady) return noEffects(nextState)
        if (!nextState.hasMessages) {
          return noEffects({ ...nextState, mode: "following" })
        }
        return requestBottom(nextState, "initial-position")
      }

      if (restoredMode === "following" && state.pendingFollowAfterRestore) {
        return requestBottom(nextState, "restore-complete")
      }

      return noEffects(nextState)
    }

    case "CLEAR_UNREAD":
      return noEffects(clearUnread(state))

    case "PROGRAMMATIC_SCROLL_BEGIN":
      return noEffects({ ...state, programmaticScrollGuard: true })

    case "PROGRAMMATIC_SCROLL_END":
      return noEffects({ ...state, programmaticScrollGuard: false })

    case "SCROLL_TO_BOTTOM_FAILED":
      return noEffects({
        ...state,
        mode: "detached",
        programmaticScrollGuard: false
      })
  }
}

export function shouldFollowChatOutput(state: ChatScrollState): boolean {
  return state.mode === "following" || (state.mode === "initializing" && state.dataReady)
}

export function isChatScrollDetached(state: ChatScrollState): boolean {
  return (
    state.mode === "detached" ||
    (state.mode === "restoring" && effectiveRestoreMode(state) === "detached")
  )
}
