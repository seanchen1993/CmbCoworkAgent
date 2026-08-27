import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const virtuosoProbe = vi.hoisted(() => ({
  latestProps: null as Record<string, unknown> | null,
  renderCount: 0
}))

vi.mock("react-virtuoso", () => ({
  Virtuoso: (props: Record<string, unknown>) => {
    virtuosoProbe.latestProps = props
    virtuosoProbe.renderCount += 1
    return null
  }
}))

vi.mock("lucide-react", () => ({
  ChevronDown: () => null,
  Loader2: () => null
}))

vi.mock("@/lib/message-render-stability", () => ({
  areMessageRenderFieldsEqual: () => true,
  areMessageToolRenderInputsEqual: () => true
}))

vi.mock("./HookLogViews", () => ({
  HookLogChip: () => null
}))

vi.mock("./MessageBubble", () => ({
  MessageBubble: () => null
}))

import {
  ChatMessageVirtualList,
  type ChatMessageVirtualListProps
} from "./ChatMessageVirtualList"
import { ChatScrollToBottomButton } from "./ChatScrollToBottomButton"
import {
  createChatScrollState,
  isChatScrollDetached,
  shouldFollowChatOutput,
  transitionChatScroll,
  type ChatScrollEffect,
  type ChatScrollEvent,
  type ChatScrollState
} from "../../../../shared/chat-scroll-controller"

interface CapturedVirtuosoProps {
  data: readonly number[]
  initialTopMostItemIndex?: {
    index: number | "LAST"
    align?: "start" | "center" | "end"
    behavior?: "auto" | "smooth"
  }
  itemsRendered: () => void
  atBottomStateChange: (atBottom: boolean) => void
  totalListHeightChanged: () => void
}

class ChatScrollRuntimeHarness {
  state: ChatScrollState = createChatScrollState("thread-runtime")
  readonly scrollCommands: ChatScrollEffect[] = []

  dispatch(event: ChatScrollEvent): void {
    const transition = transitionChatScroll(this.state, event)
    this.state = transition.state
    this.scrollCommands.push(...transition.effects)
  }

  dataReady(messageCount: number): void {
    this.dispatch({ type: "DATA_READY", messageCount })
  }

  contentHeightChanged(): void {
    if (!shouldFollowChatOutput(this.state)) return
    this.dispatch({ type: "CONTENT_GROWN", generation: this.state.generation })
  }

  atBottomStateChanged(atBottom: boolean): void {
    // Mirrors ChatContainer: Virtuoso's transient false notification is observational only.
    if (atBottom && !isChatScrollDetached(this.state)) {
      this.dispatch({ type: "BOTTOM_CONFIRMED" })
    }
  }

  returnToBottom(): void {
    this.dispatch({ type: "RETURN_TO_BOTTOM" })
  }
}

function makeMessages(messageCount: number): ChatMessageVirtualListProps["messages"] {
  return Array.from({ length: messageCount }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message body ${index}`
  })) as ChatMessageVirtualListProps["messages"]
}

function makeVirtualListProps(
  messageCount: number,
  runtime: ChatScrollRuntimeHarness
): ChatMessageVirtualListProps {
  const messages = makeMessages(messageCount)
  return {
    messages,
    visibleMessageIndexes: messages.map((_message, index) => index),
    lastUserMessageIndex: messageCount > 0 ? messageCount - 1 : -1,
    contentVersion: 0,
    historyHasMore: false,
    historyPageLoading: false,
    historyRemainingCount: 0,
    onLoadEarlierHistoryPage: vi.fn(),
    historyGapBeforeMessageId: null,
    canLoadReleasedHistory: false,
    onLoadReleasedHistoryWindow: vi.fn(),
    onRestoreLatestHistoryWindow: vi.fn(),
    hookLoggingEnabled: false,
    hookLogBucketByTurnId: new Map(),
    detachedHookLogBuckets: [],
    contentMessageRefs: {
      current: new Map()
    } as ChatMessageVirtualListProps["contentMessageRefs"],
    setMessageRef: () => () => undefined,
    isLoading: false,
    toolResults: new Map(),
    toolCallStates: new Map(),
    pendingApprovalToolCallKeys: new Set(),
    pendingApproval: null,
    autoApproveGitPush: false,
    onApprovalDecision: vi.fn(),
    onEditUserMessage: vi.fn(),
    onSetGoalFromMessage: vi.fn(),
    onForkFromMessage: vi.fn(),
    forkingMessageId: null,
    onOpenHookLogBucket: vi.fn(),
    threadId: "thread-runtime",
    assistantDurationMsById: new Map(),
    userSendTimeLabelById: new Map(),
    customScrollParent: {} as HTMLDivElement,
    virtuosoRef: {
      current: null
    } as ChatMessageVirtualListProps["virtuosoRef"],
    navigatorVirtualRangeRef: { current: null },
    initialTopMostItemIndex: { index: "LAST", align: "end", behavior: "auto" },
    onInitialVirtualItemsRendered: () => runtime.dataReady(messageCount),
    onContentHeightChanged: () => runtime.contentHeightChanged(),
    onAtBottomStateChange: (atBottom) => runtime.atBottomStateChanged(atBottom),
    footer: null
  }
}

function renderVirtualList(
  messageCount: number,
  runtime: ChatScrollRuntimeHarness
): CapturedVirtuosoProps | null {
  virtuosoProbe.latestProps = null
  renderToStaticMarkup(
    React.createElement(ChatMessageVirtualList, makeVirtualListProps(messageCount, runtime))
  )
  return virtuosoProbe.latestProps as unknown as CapturedVirtuosoProps | null
}

function clickReturnToBottom(runtime: ChatScrollRuntimeHarness): void {
  const button = ChatScrollToBottomButton({
    visible: true,
    hasUnread: runtime.state.hasUnread,
    unreadCount: runtime.state.unreadCount,
    onScrollToBottom: () => runtime.returnToBottom()
  })
  expect(React.isValidElement(button)).toBe(true)
  const onClick = (button as React.ReactElement<{ onClick: () => void }>).props.onClick
  onClick()
}

function hydrateAndConfirmBottom(runtime: ChatScrollRuntimeHarness): CapturedVirtuosoProps {
  const virtuoso = renderVirtualList(500, runtime)
  expect(virtuoso).not.toBeNull()
  virtuoso?.itemsRendered()
  virtuoso?.atBottomStateChange(true)
  expect(runtime.state.mode).toBe("following")
  return virtuoso as CapturedVirtuosoProps
}

describe("chat scroll render/runtime harness", () => {
  beforeEach(() => {
    virtuosoProbe.latestProps = null
    virtuosoProbe.renderCount = 0
  })

  it("hydrates 0 to 500 rows at LAST and survives out-of-order layout callbacks", async () => {
    const runtime = new ChatScrollRuntimeHarness()

    expect(renderVirtualList(0, runtime)).toBeNull()
    expect(runtime.state).toMatchObject({ mode: "initializing", dataReady: false })

    await Promise.resolve()
    const virtuoso = renderVirtualList(500, runtime)
    expect(virtuoso).not.toBeNull()
    expect(virtuoso?.data).toHaveLength(500)
    expect(virtuoso?.initialTopMostItemIndex).toEqual({
      index: "LAST",
      align: "end",
      behavior: "auto"
    })

    // Virtuoso can report a transient non-bottom state and a height change before items mount.
    virtuoso?.atBottomStateChange(false)
    virtuoso?.totalListHeightChanged()
    expect(runtime.scrollCommands).toEqual([])

    virtuoso?.itemsRendered()
    expect(runtime.state).toMatchObject({
      mode: "initializing",
      dataReady: true,
      programmaticScrollGuard: true
    })
    expect(runtime.scrollCommands).toEqual([
      { type: "scroll-to-bottom", reason: "initial-position", generation: 0 }
    ])

    virtuoso?.atBottomStateChange(false)
    virtuoso?.totalListHeightChanged()
    expect(runtime.state.mode).toBe("initializing")
    expect(runtime.scrollCommands.at(-1)).toMatchObject({
      type: "scroll-to-bottom",
      reason: "initial-position"
    })

    virtuoso?.atBottomStateChange(true)
    expect(runtime.state).toMatchObject({
      mode: "following",
      programmaticScrollGuard: false
    })
  })

  it("emits no scroll command for 100 append/height events after explicit detach", () => {
    const runtime = new ChatScrollRuntimeHarness()
    const virtuoso = hydrateAndConfirmBottom(runtime)
    runtime.dispatch({ type: "USER_DETACH", source: "user-input" })
    const commandCountAtDetach = runtime.scrollCommands.length

    for (let eventIndex = 0; eventIndex < 100; eventIndex += 1) {
      if (eventIndex % 2 === 0) {
        runtime.dispatch({ type: "CONTENT_APPENDED", unreadMessages: 1 })
      } else {
        virtuoso.totalListHeightChanged()
      }
      virtuoso.atBottomStateChange(false)
    }

    // A late row collapse can make Virtuoso report bottom without user intent. It must not clear
    // the detached state or unread marker.
    virtuoso.atBottomStateChange(true)

    expect(runtime.scrollCommands).toHaveLength(commandCountAtDetach)
    expect(runtime.state).toMatchObject({
      mode: "detached",
      hasUnread: true,
      unreadCount: 50,
      programmaticScrollGuard: false
    })
  })

  it("keeps unread on a failed button scroll and clears it only after confirmation", () => {
    const runtime = new ChatScrollRuntimeHarness()
    const virtuoso = hydrateAndConfirmBottom(runtime)
    runtime.dispatch({ type: "USER_DETACH", source: "user-input" })
    runtime.dispatch({ type: "CONTENT_APPENDED", unreadMessages: 3 })
    const commandCountBeforeClick = runtime.scrollCommands.length

    clickReturnToBottom(runtime)
    expect(runtime.scrollCommands).toHaveLength(commandCountBeforeClick + 1)
    expect(runtime.scrollCommands.at(-1)).toMatchObject({
      type: "scroll-to-bottom",
      reason: "return-to-bottom"
    })
    expect(runtime.state).toMatchObject({
      mode: "following",
      hasUnread: true,
      unreadCount: 3,
      programmaticScrollGuard: true
    })

    virtuoso.atBottomStateChange(false)
    runtime.dispatch({ type: "SCROLL_TO_BOTTOM_FAILED" })
    expect(runtime.state).toMatchObject({
      mode: "detached",
      hasUnread: true,
      unreadCount: 3,
      programmaticScrollGuard: false
    })

    clickReturnToBottom(runtime)
    expect(runtime.state.hasUnread).toBe(true)
    virtuoso.atBottomStateChange(true)
    expect(runtime.state).toMatchObject({
      mode: "following",
      hasUnread: false,
      unreadCount: 0,
      programmaticScrollGuard: false
    })
  })
})
