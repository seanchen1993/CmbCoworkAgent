/**
 * Cross-layer contracts for thread-aware stream display backpressure and the
 * chat timeline virtualization boundary.
 *
 * Run:
 *   npx tsx tests/thread-stream-display-performance.spec.ts
 */

import { readFileSync } from "fs"
import { join, resolve } from "path"

const PROJECT_ROOT = resolve(__dirname, "..")

function read(relativePath: string): string {
  return readFileSync(join(PROJECT_ROOT, relativePath), "utf8").replace(/\r\n/g, "\n")
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assertIncludes(value: string, expected: string, label: string): void {
  assert(value.includes(expected), `${label}: expected to include ${JSON.stringify(expected)}`)
}

function assertSourceOrder(value: string, before: string, after: string, label: string): void {
  const beforeIndex = value.indexOf(before)
  const afterIndex = value.indexOf(after)
  assert(beforeIndex >= 0, `${label}: missing ${JSON.stringify(before)}`)
  assert(afterIndex >= 0, `${label}: missing ${JSON.stringify(after)}`)
  assert(
    beforeIndex < afterIndex,
    `${label}: expected ${JSON.stringify(before)} before ${JSON.stringify(after)}`
  )
}

const agentIpc = read("src/main/ipc/agent.ts")
const displayGate = read("src/main/ipc/agent-stream-display-gate.ts")
const preload = read("src/preload/index.ts")
const threadContext = read("src/renderer/src/lib/thread-context.tsx")
const chat = read("src/renderer/src/components/chat/ChatContainer.tsx")
const timeline = read("src/renderer/src/components/chat/ChatTimeline.tsx")
const chatTimelineScroll = read("src/renderer/src/components/chat/useChatTimelineScroll.ts")
const scrollToBottomButton = read("src/renderer/src/components/chat/ChatScrollToBottomButton.tsx")

function testBackgroundChunksAreDisplayGatedAfterPersistence(): void {
  const functionStart = agentIpc.indexOf("function persistAndForwardPhysicalRunStreamChunk(")
  const functionBody = agentIpc.slice(functionStart, functionStart + 1800)
  assert(functionStart >= 0, "stream forwarding helper exists")
  assertSourceOrder(
    functionBody,
    "persistStreamTranscriptChunk",
    "agentStreamDisplayGate.remember",
    "a stream chunk is persisted before its display snapshot is retained"
  )
  assertSourceOrder(
    functionBody,
    "agentStreamDisplayGate.remember",
    "if (agentStreamDisplayGate.shouldSendImmediately(window, threadId))",
    "background delivery is gated only after the latest renderer snapshot is retained"
  )
  assertIncludes(
    functionBody,
    'type: "stream"',
    "the display gate preserves the existing renderer stream event format"
  )
}

function testForegroundRecoveryUsesAuthoritativeValuesSnapshots(): void {
  assertIncludes(
    agentIpc,
    'import { AgentStreamDisplayGate } from "./agent-stream-display-gate"',
    "main depends on the isolated display gate"
  )
  assertIncludes(
    displayGate,
    'const valuesSnapshot = snapshotsByMode.get("values")',
    "foreground recovery prefers a complete values snapshot"
  )
  assertIncludes(
    displayGate,
    "if (!this.options.isThreadRunActive(threadId)) return false",
    "completed runs do not replay stale live snapshots"
  )
  assertIncludes(
    agentIpc,
    '"agent:set-stream-display-interest"',
    "main exposes the display-only interest IPC"
  )
  assertIncludes(
    preload,
    "setStreamDisplayInterest:",
    "preload exposes stream display interest without changing normal stream APIs"
  )
}

function testThreadSwitchAndVisibilityDriveInterest(): void {
  assertIncludes(
    threadContext,
    '.setStreamDisplayInterest(previousThreadId, "background")',
    "switching away from a thread pauses its renderer display stream"
  )
  assertIncludes(
    threadContext,
    'document.visibilityState === "visible" ? "foreground" : "hidden"',
    "hidden windows stop requesting foreground display delivery"
  )
  assertIncludes(
    threadContext,
    'document.addEventListener("visibilitychange", updateStreamDisplayInterest)',
    "visibility changes update the main-process display interest"
  )
  assertIncludes(
    threadContext,
    "Failed to mark newly initialized background thread",
    "threads initialized outside the selected chat are immediately background-gated"
  )
}

function testForegroundTokensAreFrameCoalesced(): void {
  const holderStart = threadContext.indexOf("function ThreadStreamHolder(")
  const holderBody = threadContext.slice(holderStart, holderStart + 8_000)
  assert(holderStart >= 0, "thread stream holder exists")
  assertIncludes(
    holderBody,
    "const pendingStreamUpdateRef",
    "foreground tokens retain only the latest renderer snapshot"
  )
  assertIncludes(
    holderBody,
    "requestAnimationFrame(() => {",
    "foreground token updates are committed at most once per animation frame"
  )
  assertIncludes(
    holderBody,
    "const immediate = loadingChanged || !hasSyncedStreamRef.current",
    "initial and terminal loading transitions flush without a frame delay"
  )
  assert(
    !holderBody.includes("}, [scheduleStreamUpdate, stream])"),
    "the SDK stream wrapper identity does not bypass frame coalescing"
  )
}

function testLongChatsUseDynamicVirtualRows(): void {
  assertIncludes(
    timeline,
    "export const VIRTUAL_CHAT_TIMELINE_THRESHOLD = 80",
    "long-chat virtualization has an explicit threshold"
  )
  assertIncludes(
    timeline,
    "useDynamicRowHeight",
    "virtual chat rows measure Markdown and tool cards dynamically"
  )
  assertIncludes(
    timeline,
    "key: threadId",
    "streaming row appends keep existing dynamic row measurements stable"
  )
  assertIncludes(
    timeline,
    "completionScrollTopRef",
    "finishing a response preserves the position of users reading history"
  )
  assert(
    !timeline.includes("viewport.scrollTop = viewport.scrollHeight"),
    "virtual end scrolling does not synchronously read and write scroll geometry"
  )
  assertIncludes(
    timeline,
    "scrollToLastRow()",
    "virtual end scrolling mounts the tail row before using the end anchor"
  )
  assertIncludes(
    scrollToBottomButton,
    "if (visible) return",
    "the scroll-to-bottom indicator stops observing streamed content while it is already visible"
  )
  assertIncludes(
    chat,
    "const historyDisplayMessages = useMemo",
    "history-only display work is separated from live tail updates"
  )
  assertIncludes(
    chat,
    "const isVirtualizedChat =",
    "chat chooses the virtual path only for long non-searching transcripts"
  )
  assertIncludes(
    chat,
    "<VirtualChatTimeline",
    "the long-chat render path mounts the virtual timeline"
  )
  assertIncludes(
    timeline,
    "onResize={handleListResize}",
    "the isolated timeline corrects initial placement after the list viewport is measured"
  )
  assertIncludes(
    timeline,
    "queueInitialScrollCorrection()",
    "dynamic row-height updates schedule bounded initial-tail corrections"
  )
  assertIncludes(
    timeline,
    'document.addEventListener("visibilitychange", handleVisibilityChange)',
    "initial tail correction resumes after a hidden window becomes visible"
  )
  assert(
    !timeline.includes("pendingAssistantScrollFromMessageIdRef"),
    "a completed assistant response never forces users reading history back to the bottom"
  )
  assertIncludes(
    timeline,
    "useImperativeHandle",
    "the timeline exposes only viewport and message-navigation capabilities"
  )
  assertIncludes(
    chat,
    "ref={virtualTimelineRef}",
    "ChatContainer holds the timeline capability rather than react-window internals"
  )
  assertIncludes(
    chat,
    "useChatTimelineScroll({",
    "ChatContainer delegates timeline scrolling to an isolated hook"
  )
  assertIncludes(
    chatTimelineScroll,
    "pendingUserMessageScrollRef",
    "sending records one user-message anchor instead of following every stream chunk"
  )
  assertIncludes(
    chatTimelineScroll,
    "pending.threadId !== threadId",
    "a previous thread's pending scroll cannot affect the active thread"
  )
  assertIncludes(
    chat,
    "<ChatTimelineTail",
    "the chat container composes an isolated tail instead of duplicating tail rendering"
  )
  assertIncludes(
    chat,
    'from "./ChatTimeline"',
    "ChatContainer composes the isolated timeline instead of owning list internals"
  )
}

function main(): void {
  const tests = [
    testBackgroundChunksAreDisplayGatedAfterPersistence,
    testForegroundRecoveryUsesAuthoritativeValuesSnapshots,
    testThreadSwitchAndVisibilityDriveInterest,
    testForegroundTokensAreFrameCoalesced,
    testLongChatsUseDynamicVirtualRows
  ]
  for (const test of tests) {
    test()
    console.log(`✓ ${test.name}`)
  }
  console.log(`\n${tests.length} passed`)
}

main()
