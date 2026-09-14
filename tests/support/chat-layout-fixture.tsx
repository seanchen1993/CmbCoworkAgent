import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import {
  ChatMessageVirtualList,
  type ChatMessageVirtualListProps
} from "../../src/renderer/src/components/chat/ChatMessageVirtualList"
import type { Message } from "../../src/renderer/src/types"

const noop = () => {}
const viewport = document.getElementById("viewport") as HTMLDivElement
const root = createRoot(document.getElementById("root")!)
let following = false
let followFrame = 0
let messages: Message[] = Array.from({ length: 200 }, (_, index) => ({
  id: `message-${index}`,
  role: "assistant",
  created_at: new Date(2026, 8, 14),
  content: `消息 ${index}：用于检查滚动位置与实际行高。\n\n第二段内容。`,
  reasoning:
    index === 198 ? "长思考内容，检查展开后虚拟列表是否仍然稳定。\n\n".repeat(150) : undefined
}))
const props: ChatMessageVirtualListProps = {
  messages,
  visibleMessageIndexes: messages.map((_, index) => index),
  lastUserMessageIndex: -1,
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
  onEditUserMessage: noop,
  onSetGoalFromMessage: noop,
  onForkFromMessage: noop,
  forkingMessageId: null,
  onOpenHookLogBucket: noop,
  threadId: "chat-layout",
  assistantDurationMsById: new Map(),
  userSendTimeLabelById: new Map(),
  customScrollParent: viewport,
  virtuosoRef: { current: null },
  navigatorVirtualRangeRef: { current: null },
  initialTopMostItemIndex: { index: "LAST", align: "end" },
  onInitialVirtualItemsRendered: noop,
  onContentHeightChanged: () => {
    if (!following || followFrame) return
    followFrame = requestAnimationFrame(() => {
      followFrame = 0
      if (following) viewport.scrollTo({ top: viewport.scrollHeight, behavior: "auto" })
    })
  },
  onAtBottomStateChange: noop,
  footer: <div style={{ height: 48 }}>消息列表尾部</div>
}
function render() {
  flushSync(() => root.render(<ChatMessageVirtualList {...props} messages={messages} />))
}
const fixture = {
  seek(index: number) {
    following = false
    props.virtuosoRef.current?.scrollToIndex({ index, align: "start", behavior: "auto" })
  },
  stream(tick: number) {
    props.isLoading = true
    props.contentVersion++
    messages = messages.map((message, index) =>
      index === 199
        ? { ...message, content: "", reasoning: "持续思考的内容。\n\n".repeat(tick * 10) }
        : message
    )
    render()
  },
  follow() {
    following = true
    viewport.scrollTop = viewport.scrollHeight
  },
  complete() {
    props.isLoading = false
    render()
  },
  resetAutomatic() {
    props.threadId = `automatic-reasoning-${props.contentVersion}`
    fixture.stream(4)
  },
  repaint() {
    props.contentVersion++
    render()
  },
  answer() {
    messages = messages.map((message, index) =>
      index === 199 ? { ...message, content: "思考结束，开始回答。" } : message
    )
    render()
  }
}
Object.assign(window, { chatLayoutFixture: fixture })
render()
