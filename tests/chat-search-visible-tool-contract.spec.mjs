import { readFileSync } from "fs"
import { strict as assert } from "assert"

const chatContainerSource = readFileSync(
  "src/renderer/src/components/chat/ChatContainer.tsx",
  "utf8"
)
const messageBubbleSource = readFileSync(
  "src/renderer/src/components/chat/MessageBubble.tsx",
  "utf8"
)
const toolRendererSource = readFileSync(
  "src/renderer/src/components/chat/ToolCallRenderer.tsx",
  "utf8"
)
const markdownSource = readFileSync(
  "src/renderer/src/components/chat/StreamingMarkdown.tsx",
  "utf8"
)
const searchOverlaySource = readFileSync(
  "src/renderer/src/components/chat/ChatSearchOverlay.tsx",
  "utf8"
)

const searchDocumentStart = chatContainerSource.indexOf("const buildSearchDocument")
const searchDocumentEnd = chatContainerSource.indexOf(
  "const stableSearchDocumentsRef",
  searchDocumentStart
)
assert.ok(searchDocumentStart >= 0 && searchDocumentEnd > searchDocumentStart)
const searchDocumentSource = chatContainerSource.slice(searchDocumentStart, searchDocumentEnd)

assert.match(searchDocumentSource, /parts\.push\(getCollapsedToolCallSummary\(toolCall\)\)/)
assert.doesNotMatch(searchDocumentSource, /toolResults\.get/)
assert.doesNotMatch(searchDocumentSource, /parts\.push\(toolCall\.name, toolCall\.args\)/)
assert.doesNotMatch(searchDocumentSource, /parts\.push\(message\.reasoning\)/)
assert.doesNotMatch(searchDocumentSource, /parts\.push\(hookLogBucket\.entries\)/)
assert.match(searchDocumentSource, /projectVisibleChatSearchContent/)
assert.match(searchDocumentSource, /normalizeVisibleReasoningText\(message\.reasoning\)/)
assert.match(searchDocumentSource, /stripThinkBlocksForDisplay\(displayContent\)/)
assert.match(searchDocumentSource, /stripThinkBlocksForDisplay\(block\.text\)/)
assert.match(chatContainerSource, /cached\.contentVersion !== messagesContentVersion/)
assert.doesNotMatch(
  chatContainerSource,
  /cached\.contentVersion !== displayMessagesContentVersion/
)
assert.match(chatContainerSource, /displayMessageProjection\.changedMessages/)
assert.match(chatContainerSource, /nextDocuments\[cachedDocumentIndex\] = nextDocument/)
assert.match(chatContainerSource, /const nextDocuments = \[\.\.\.cached\.documents\]/)
assert.match(chatContainerSource, /cached\.documents = nextDocuments/)
assert.match(chatContainerSource, /requiresRebuild = true/)
assert.match(chatContainerSource, /nextDocuments\.shift\(\)/)
assert.match(
  messageBubbleSource,
  /const summary = getCollapsedToolCallSummary\(resolvedToolCall\)/
)
assert.match(messageBubbleSource, /searchableSummary=\{summary\}/)
assert.match(toolRendererSource, /data-chat-search-text=\{searchableSummary \? true : undefined\}/)
assert.doesNotMatch(markdownSource, /data-chat-search-expand-markdown/)
assert.doesNotMatch(searchOverlaySource, /prepareMarkdownForSearchHighlight/)
assert.match(markdownSource, /data-chat-search-ignore/)
assert.match(messageBubbleSource, /data-chat-search-expand-user-content/)
assert.ok((messageBubbleSource.match(/data-chat-search-text/g) ?? []).length >= 5)
assert.match(
  messageBubbleSource,
  /data-chat-search-text\s+className="liquid-glass-notice__body/
)

console.log("chat search visible tool summary contract: ok")
