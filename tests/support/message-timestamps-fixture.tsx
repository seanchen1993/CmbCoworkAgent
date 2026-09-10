import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import {
  ChatMessageVirtualList,
  type ChatMessageVirtualListProps
} from "../../src/renderer/src/components/chat/ChatMessageVirtualList"
import { buildMessageBubbleTimingMeta } from "../../src/renderer/src/lib/message-bubble-timing"
import { applyThemePreference } from "../../src/renderer/src/lib/theme-preference"
import type { Message } from "../../src/renderer/src/types"

declare global {
  interface Window {
    timestampFormats: number
    actions: [string, string][]
    fixture: {
      repaint(): void
      endUpdate(): void
      startUpdate(): void
      stream(): void
      longUser(): void
      invalid(): void
      large(): void
      theme: typeof applyThemePreference
    }
  }
}

window.timestampFormats = 0
window.actions = []
const at = (minute: number) => new Date(2026, 8, 10, 14, minute)
let messages: Message[] = [
  { id: "user", role: "user", content: "帮我分析一下本周项目进展。", created_at: at(32) },
  {
    id: "assistant",
    role: "assistant",
    content:
      "本周已完成需求确认和主要功能开发。\n\n接下来重点验证历史消息加载、搜索定位和流式回复是否正常。",
    created_at: at(32),
    start_at: at(32),
    end_at: new Date(+at(32) + 18000)
  }
]
const root = createRoot(document.getElementById("root")!)
const noop = () => {}
const baseProps: Omit<
  ChatMessageVirtualListProps,
  "messages" | "visibleMessageIndexes" | "assistantDurationMsById" | "userSendTimeLabelById"
> = {
  lastUserMessageIndex: 0,
  contentVersion: 0,
  historyHasMore: false,
  historyPageLoading: false,
  historyRemainingCount: 0,
  onLoadEarlierHistoryPage: noop,
  historyGapBeforeMessageId: null,
  canLoadReleasedHistory: false,
  onLoadReleasedHistoryWindow: noop,
  onRestoreLatestHistoryWindow: noop,
  hookLoggingEnabled: false,
  hookLogBucketByTurnId: new Map(),
  detachedHookLogBuckets: [],
  contentMessageRefs: { current: new Map() },
  setMessageRef: () => noop,
  isLoading: false,
  toolResults: new Map(),
  toolCallStates: new Map(),
  pendingApprovalToolCallKeys: new Set(),
  pendingApproval: null,
  autoApproveGitPush: false,
  onApprovalDecision: noop,
  onEditUserMessage: (message) => window.actions.push(["edit", message.id]),
  onSetGoalFromMessage: (text) => window.actions.push(["goal", text]),
  onForkFromMessage: (message) => window.actions.push(["fork", message.id]),
  forkingMessageId: null,
  onOpenHookLogBucket: noop,
  threadId: "timestamp-fixture",
  customScrollParent: document.getElementById("viewport") as HTMLDivElement,
  virtuosoRef: { current: null },
  navigatorVirtualRangeRef: { current: null },
  initialTopMostItemIndex: { index: "LAST", align: "end", behavior: "auto" },
  onInitialVirtualItemsRendered: noop,
  onContentHeightChanged: noop,
  onAtBottomStateChange: noop,
  footer: null
}
let timing = buildMessageBubbleTimingMeta(messages)
function render() {
  flushSync(() =>
    root.render(
      <ChatMessageVirtualList
        {...baseProps}
        {...timing}
        messages={messages}
        visibleMessageIndexes={messages.map((_, i) => i)}
      />
    )
  )
}
window.fixture = {
  repaint() {
    messages = messages.map((m) => ({ ...m, created_at: new Date(+m.created_at) }))
    render()
  },
  endUpdate() {
    messages = messages.map((m) => (m.role === "assistant" ? { ...m, end_at: at(40) } : m))
    render()
  },
  startUpdate() {
    messages = messages.map((m) => (m.role === "assistant" ? { ...m, start_at: at(35) } : m))
    render()
  },
  stream() {
    messages = messages.map((m) =>
      m.role === "assistant" ? { ...m, content: String(m.content) + "\n\n继续处理中。" } : m
    )
    baseProps.isLoading = true
    render()
  },
  longUser() {
    messages = messages.map((m) =>
      m.role === "user" ? { ...m, content: "这是一条需要折叠的较长消息。\n".repeat(35) } : m
    )
    render()
  },
  invalid() {
    messages = messages.map((m) => ({
      ...m,
      created_at: new Date(NaN),
      start_at: undefined,
      end_at: undefined
    }))
    timing = buildMessageBubbleTimingMeta(messages)
    render()
  },
  large() {
    messages = Array.from({ length: 2000 }, (_, i) => ({
      id: String(i),
      role: i % 2 ? "assistant" : "user",
      content: "历史消息 " + i,
      created_at: at(32),
      start_at: at(32)
    }))
    baseProps.isLoading = false
    timing = buildMessageBubbleTimingMeta(messages)
    render()
  },
  theme: applyThemePreference
}
applyThemePreference("nord-light")
render()
