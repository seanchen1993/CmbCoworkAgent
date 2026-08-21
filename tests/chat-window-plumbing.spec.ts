import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

async function main(): Promise<void> {
  const [container, navigator, search, scrollToBottomButton, windowHelper] = await Promise.all([
    readFile(
      resolve(__dirname, "../src/renderer/src/components/chat/ChatContainer.tsx"),
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
    readFile(resolve(__dirname, "../src/renderer/src/lib/chat-message-window.ts"), "utf8")
  ])

  assert.match(windowHelper, /CHAT_MESSAGE_WINDOW_SIZE = 240/)
  assert.match(windowHelper, /CHAT_MESSAGE_WINDOW_SHIFT = 80/)
  assert.match(container, /const displayMessageProjection = projectChatMessages\(/)
  assert.match(container, /getThreadDisplayBaseline\(threadMessages, messagesContentVersion\)/)
  assert.match(container, /deriveChatMessageWindowRows\(/)
  assert.match(container, /const DETACHED_HOOK_LOG_WINDOW_SIZE = 80/)
  assert.match(container, /data-chat-history-boundary="older"/)
  assert.match(container, /historyMessageTotal - historyLoadedMessageCount/)
  assert.match(container, /onLoadEarlierHistoryPage=\{loadEarlierHistoryPage\}/)
  assert.match(
    container,
    /useStableToolDerivationMessages\(\s*displayMessages,\s*displayMessageProjection\.changedMessages,\s*displayMessagesStructureVersion/
  )
  assert.match(container, /createIncrementalToolDerivationProjector/)
  assert.doesNotMatch(container, /useStableToolDerivationMessages\(displayMessages\)/)

  const listStart = container.indexOf("const ChatMessageList = React.memo")
  const listEnd = container.indexOf("function SystemPromptPreviewButton", listStart)
  assert.ok(listStart >= 0 && listEnd > listStart)
  const listSource = container.slice(listStart, listEnd)
  assert.match(listSource, /windowRows\.map\(/)
  assert.doesNotMatch(
    listSource,
    /messages\.map\(/,
    "ChatMessageList must never mount the complete transcript"
  )

  assert.match(container, /if \(!messageWindowAtTail\) \{\s*scrollToConversationBottom\(\)/)
  assert.match(container, /pendingWindowAnchorRef/)

  assert.match(navigator, /const markerWindowSize = 120/)
  assert.match(navigator, /renderedQuestionIndexes/)
  assert.match(navigator, /for \(const messageId of renderedMessageIds\)/)
  assert.doesNotMatch(
    navigator,
    /userMessageIds\.flatMap/,
    "ordinary window updates must not scan every historical question"
  )
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
