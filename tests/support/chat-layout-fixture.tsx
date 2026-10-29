import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import {
  ChatMessageVirtualList,
  type ChatMessageVirtualListProps
} from "../../src/renderer/src/components/chat/ChatMessageVirtualList"
import type { Message } from "../../src/renderer/src/types"
import {
  advanceMessageAttempts,
  publishMessageDiscard
} from "../../src/renderer/src/lib/message-discard-events"

const noop = () => {}
const viewport = document.getElementById("viewport") as HTMLDivElement
const root = createRoot(document.getElementById("root")!)
let following = false
let followFrame = 0
let messages: Message[] = Array.from({ length: 200 }, (_, index) => ({
  id: `message-${index}`,
  role: index < 198 ? (["user", "assistant", "system"] as const)[index % 3] : "assistant",
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
        ? {
            ...message,
            content: "",
            tool_calls: undefined,
            reasoning: "持续思考的内容。\n\n".repeat(tick * 10)
          }
        : message
    )
    render()
  },
  token(tick: number) {
    messages = messages.map((message, index) =>
      index === 199 ? { ...message, reasoning: "思考。".repeat(tick) } : message
    )
    props.contentVersion++
    render()
  },
  discardUnrelated() {
    const ids = new Set(Array.from({ length: 501 }, (_, index) => `unrelated-${index}`))
    const attempts = advanceMessageAttempts(props.messageAttempts, ids)
    publishMessageDiscard(props.threadId, ids, attempts.revision)
    render()
    props.messageAttempts = attempts
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
  },
  tool() {
    messages = messages.map((message, index) =>
      index === 199
        ? { ...message, tool_calls: [{ id: "layout-tool", name: "read_file", args: {} }] }
        : message
    )
    render()
  },
  retry(batched: boolean, overflow = false) {
    const discarded = messages[199]
    const restart = () => {
      const ids = new Set([discarded.id])
      if (overflow) for (let index = 0; index < 500; index++) ids.add(`overflow-${index}`)
      const attempts = advanceMessageAttempts(props.messageAttempts, ids)
      publishMessageDiscard(props.threadId, ids, attempts.revision)
      // 强制旧正文在新消息快照进入前再提交一次，模拟 Virtuoso 旧回调。
      messages = messages.map((message, index) =>
        index === 199
          ? { ...message, reasoning: `${message.reasoning}\n旧 attempt 的追加思考。` }
          : message
      )
      props.contentVersion++
      render()
      props.messageAttempts = attempts
      messages = messages.slice(0, 199)
      props.visibleMessageIndexes = messages.map((_, index) => index)
      if (!batched) render()
      messages.push({ ...discarded, content: "", tool_calls: undefined, reasoning: "重试思考。" })
      props.visibleMessageIndexes = messages.map((_, index) => index)
      props.contentVersion++
      props.isLoading = true
      if (batched) root.render(<ChatMessageVirtualList {...props} messages={messages} />)
      else render()
    }
    if (batched) flushSync(restart)
    else restart()
  }
}
Object.assign(window, { chatLayoutFixture: fixture })
render()
