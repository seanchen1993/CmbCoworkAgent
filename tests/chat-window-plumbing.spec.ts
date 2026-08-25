import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

async function main(): Promise<void> {
  const [
    container,
    virtualList,
    navigator,
    search,
    scrollToBottomButton,
    threadProjectionCache
  ] = await Promise.all([
    readFile(
      resolve(__dirname, "../src/renderer/src/components/chat/ChatContainer.tsx"),
      "utf8"
    ),
    readFile(
      resolve(__dirname, "../src/renderer/src/components/chat/ChatMessageVirtualList.tsx"),
      "utf8"
    ),
    readFile(
      resolve(__dirname, "../src/renderer/src/components/chat/ChatScrollNavigator.tsx"),
      "utf8"
    ),
    readFile(
      resolve(__dirname, "../src/renderer/src/components/chat/ChatSearchOverlay.tsx"),
      "utf8"
    ),
    readFile(
      resolve(__dirname, "../src/renderer/src/components/chat/ChatScrollToBottomButton.tsx"),
      "utf8"
    ),
    readFile(
      resolve(__dirname, "../src/renderer/src/lib/chat-thread-projection-cache.ts"),
      "utf8"
    )
  ])

  assert.match(container, /const displayMessageProjection = projectChatMessages\(/)
  assert.match(container, /getThreadDisplayBaseline\(threadMessages, messagesContentVersion\)/)
  assert.match(container, /threadProjectionRuntime\.projectVisibleMessageIndexes\(/)
  assert.match(threadProjectionCache, /mergeVisibleChatMessageIndexes\(/)
  assert.match(container, /historyMessageTotal - historyLoadedMessageCount/)
  assert.match(container, /onLoadEarlierHistoryPage=\{loadEarlierHistoryPage\}/)
  assert.match(container, /contentVersion=\{displayMessagesContentVersion\}/)
  assert.doesNotMatch(container, /deriveChatMessageWindowRows\(/)
  assert.doesNotMatch(container, /messageWindow/)
  assert.match(
    container,
    /threadProjectionRuntime\.projectToolDerivationMessages\(\s*displayMessages,\s*displayMessageProjection\.changedMessages,\s*displayMessagesStructureVersion/
  )
  assert.match(threadProjectionCache, /createIncrementalToolDerivationProjector/)
  assert.doesNotMatch(container, /useStableToolDerivationMessages\(displayMessages\)/)

  assert.match(virtualList, /CHAT_MESSAGE_VIRTUALIZATION_THRESHOLD = 100/)
  assert.match(virtualList, /const DETACHED_HOOK_LOG_WINDOW_SIZE = 80/)
  assert.match(virtualList, /data-chat-history-boundary="older"/)
  assert.match(virtualList, /data=\{visibleMessageIndexes\}/)
  assert.match(virtualList, /rangeChanged=\{handleVirtualRangeChanged\}/)
  assert.match(
    virtualList,
    /const handleVirtualRangeChanged[\s\S]*navigatorVirtualRangeRef\.current = resolveChatScrollVirtualRangeSnapshot/
  )
  assert.match(navigator, /userMessageRefs\.current\.keys\(\)/)
  assert.match(virtualList, /increaseViewportBy=\{\{ top: 600, bottom: 900 \}\}/)
  assert.match(virtualList, /React\.memo\(ChatMessageRowImpl, areChatMessageRowPropsEqual\)/)
  assert.match(container, /pendingDurableHistoryAnchorRef/)
  assert.match(container, /if \(!target && anchor\.attempt === 0 && visibleIndex !== undefined\)/)
  assert.match(container, /pendingDurableHistoryAnchorRef\.current = null[\s\S]*RESTORE_END/)
  assert.match(
    container,
    /const cancelPendingHistoryAnchorFromUserGesture[\s\S]*generation: anchor\.generation/,
    "wheel, touch, and keyboard input must cancel an active history-anchor restore"
  )
  assert.ok(
    (container.match(/cancelPendingHistoryAnchorFromUserGesture\(\)/g) ?? []).length >= 6,
    "all wheel, touch, and keyboard directions must cancel an active history-anchor restore"
  )
  assert.match(container, /virtuosoRef\.current\?\.scrollToIndex/)

  assert.match(navigator, /CHAT_SCROLL_MARKER_WINDOW_SIZE = 120/)
  assert.match(navigator, /const ChatScrollMarkerRail = memo\(/)
  assert.match(navigator, /renderedQuestionIndexes/)
  assert.match(navigator, /for \(const messageId of userMessageRefs\.current\.keys\(\)\)/)
  assert.doesNotMatch(
    navigator,
    /userMessageIds\.flatMap/,
    "ordinary window updates must not scan every historical question"
  )
  assert.match(navigator, /if \(!mountedTarget && scrollToMessageByIdRef\.current\)/)
  assert.match(navigator, /if \(!targetElement\) onRevealMessageRef\.current\(messageId\)/)

  assert.match(search, /createChatSearchMatcher\(CHAT_SEARCH_RESULT_LIMIT \+ 1\)/)
  assert.match(container, /searchDurableMessages=\{searchDurableMessages\}/)
  assert.match(container, /CHAT_LOCAL_SEARCH_CORPUS_TEXT_LIMIT/)
  assert.match(search, /onRevealMessage\(match\.messageId\)/)
  assert.match(search, /querySelectorAll<HTMLElement>\("\[data-chat-message-id\]"\)/)

  assert.match(container, /transitionChatScroll\(current, event\)/)
  assert.match(container, /initialTopMostItemIndex=/)
  assert.match(container, /scrollToIndex\(\{\s*index: lastVisibleIndex,\s*align: "end"/)
  assert.doesNotMatch(container, /Number\.MAX_SAFE_INTEGER/)
  assert.doesNotMatch(container, /bottomDistance <= 200/)
  assert.match(container, /data-scroll-area-scrollbar/)
  assert.match(container, /downwardUserScrollIntentUntilRef/)
  assert.match(container, /scrollbarUserIntentActiveRef/)
  assert.match(scrollToBottomButton, /hasUnread: boolean/)
  assert.match(scrollToBottomButton, /unreadCount: number/)
  assert.doesNotMatch(scrollToBottomButton, /ResizeObserver|requestAnimationFrame/)

  console.log("chat window plumbing contracts passed")
}

void main()
