import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

async function main(): Promise<void> {
  const [container, virtualList, navigator, search, scrollToBottomButton] = await Promise.all([
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
    )
  ])

  assert.match(container, /const displayMessageProjection = projectChatMessages\(/)
  assert.match(container, /getThreadDisplayBaseline\(threadMessages, messagesContentVersion\)/)
  assert.match(container, /mergeVisibleChatMessageIndexes\(/)
  assert.match(container, /historyMessageTotal - historyLoadedMessageCount/)
  assert.match(container, /onLoadEarlierHistoryPage=\{loadEarlierHistoryPage\}/)
  assert.match(container, /contentVersion=\{displayMessagesContentVersion\}/)
  assert.doesNotMatch(container, /deriveChatMessageWindowRows\(/)
  assert.doesNotMatch(container, /messageWindow/)
  assert.match(
    container,
    /useStableToolDerivationMessages\(\s*displayMessages,\s*displayMessageProjection\.changedMessages,\s*displayMessagesStructureVersion/
  )
  assert.match(container, /createIncrementalToolDerivationProjector/)
  assert.doesNotMatch(container, /useStableToolDerivationMessages\(displayMessages\)/)

  assert.match(virtualList, /CHAT_MESSAGE_VIRTUALIZATION_THRESHOLD = 100/)
  assert.match(virtualList, /const DETACHED_HOOK_LOG_WINDOW_SIZE = 80/)
  assert.match(virtualList, /data-chat-history-boundary="older"/)
  assert.match(virtualList, /data=\{visibleMessageIndexes\}/)
  assert.match(virtualList, /rangeChanged=/)
  assert.match(virtualList, /increaseViewportBy=\{\{ top: 600, bottom: 900 \}\}/)
  assert.match(virtualList, /React\.memo\(ChatMessageRowImpl, areChatMessageRowPropsEqual\)/)
  assert.match(container, /pendingDurableHistoryAnchorRef/)
  assert.match(container, /virtuosoRef\.current\?\.scrollToIndex/)

  assert.match(navigator, /const markerWindowSize = 120/)
  assert.match(navigator, /renderedQuestionIndexes/)
  assert.match(navigator, /for \(const messageId of renderedMessageIds\)/)
  assert.doesNotMatch(
    navigator,
    /userMessageIds\.flatMap/,
    "ordinary window updates must not scan every historical question"
  )
  assert.match(navigator, /if \(!mountedTarget && scrollToMessageById\)/)
  assert.match(navigator, /if \(!targetElement\) onRevealMessage\(messageId\)/)

  assert.match(search, /createChatSearchMatcher\(\)/)
  assert.match(search, /onRevealMessage\(match\.messageId\)/)
  assert.match(search, /querySelectorAll<HTMLElement>\("\[data-chat-message-id\]"\)/)

  assert.match(
    scrollToBottomButton,
    /attachAttempts\s*>=\s*MAX_VIEWPORT_ATTACH_FRAMES/,
    "a missing Radix viewport must not leave an unbounded animation-frame retry loop"
  )

  console.log("chat window plumbing contracts passed")
}

void main()
