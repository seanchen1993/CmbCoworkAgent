/**
 * Regression contracts for user-interrupted fork boundaries and action placement.
 *
 * Run:
 *   npx tsx tests/fork-interruption.spec.ts
 */

import assert from "assert"
import { readFile } from "fs/promises"
import { resolve } from "path"

const PROJECT_ROOT = resolve(__dirname, "..")

async function readProjectFile(path: string): Promise<string> {
  return (await readFile(resolve(PROJECT_ROOT, path), "utf8")).replace(/\r\n/g, "\n")
}

async function testAbortPathsMarkStableForkBoundary(): Promise<void> {
  const source = await readProjectFile("src/main/ipc/agent.ts")
  const interruptedMarkerCalls =
    source.match(/source: "agent_run_interrupted"/g)?.length ?? 0

  assert.equal(
    interruptedMarkerCalls,
    4,
    "normal and throwing invoke aborts plus resume and interrupt aborts must retain markers"
  )
  assert.match(
    source,
    /const outcome = source === "agent_run_interrupted" \? "interrupted" : "completed"/,
    "fork boundary metadata must distinguish interrupted runs"
  )
  assert.match(
    source,
    /if \(hasPendingApprovalForThread\(threadId\)\) return[\s\S]*checkpointHasInterrupt\(tuple\.checkpoint\)/,
    "interrupted boundaries must preserve approval and graph-interrupt safety gates"
  )
  assert.match(
    source,
    /if \(\(tuple\.pendingWrites\?\.length \?\? 0\) > 0 && source !== "agent_run_interrupted"\) return/,
    "user-stopped tool runs may retain abandoned pending writes while completed runs may not"
  )
}

async function testAssistantActionsRenderAfterTools(): Promise<void> {
  const source = await readProjectFile("src/renderer/src/components/chat/MessageBubble.tsx")
  const toolListIndex = source.indexOf("{hasToolCalls && (")
  const forkActionIndex = source.indexOf('aria-label="从这里 fork"')

  assert(toolListIndex >= 0, "assistant tool list should exist")
  assert(forkActionIndex >= 0, "assistant fork action should exist")
  assert(
    toolListIndex < forkActionIndex,
    "assistant actions must render after tool execution boxes"
  )
  assert.match(
    source,
    /const shouldShowAssistantActions =[\s\S]*Boolean\(content \|\| hasToolCalls\)/,
    "assistant actions must still render for tool-only assistant messages"
  )
  assert.match(
    source,
    /\{shouldShowAssistantActions && \(/,
    "assistant action row should not be gated directly on text content"
  )
}

async function testForkabilityAllowsInterruptedPendingWritesOnly(): Promise<void> {
  const source = await readProjectFile("src/shared/checkpoint-forkability.ts")
  assert.match(
    source,
    /function isUserInterruptedForkBoundary\([\s\S]*agent_run_interrupted[\s\S]*outcome[\s\S]*interrupted/,
    "forkability must recognize explicit user-interrupted fork boundaries"
  )
  assert.match(
    source,
    /if \(hasPendingWrites && !isUserInterruptedForkBoundary\(marker\)\)/,
    "pending writes should only be allowed for user-interrupted fork boundaries"
  )
}

async function testForkWaitsForAbortingRunToSettle(): Promise<void> {
  const agentSource = await readProjectFile("src/main/ipc/agent.ts")
  const threadsSource = await readProjectFile("src/main/ipc/threads.ts")

  assert.match(
    agentSource,
    /export function isActiveAgentRunAborting\(threadId: string\): boolean \{[\s\S]*signal\.aborted === true/,
    "agent IPC should expose whether an active run is already aborting"
  )
  assert.match(
    agentSource,
    /export async function waitForActiveAgentRunToSettle\([\s\S]*waitForReplacedRunToSettle\(threadId\)/,
    "fork checks should be able to wait for an aborting run's final checkpoint cleanup"
  )
  assert.match(
    threadsSource,
    /if \(hasActiveAgentRun\(threadId\)\) \{[\s\S]*!isActiveAgentRunAborting\(threadId\)[\s\S]*waitForActiveAgentRunToSettle\(threadId\)[\s\S]*return true[\s\S]*\}/,
    "fork busy checks should wait only for aborting active runs and keep true running sessions blocked"
  )
}

async function testMessageForkStateIsScopedToActiveThread(): Promise<void> {
  const source = await readProjectFile("src/renderer/src/components/chat/ChatContainer.tsx")

  assert.match(
    source,
    /const currentThreadIdRef = useRef\(threadId\)[\s\S]*currentThreadIdRef\.current = threadId/,
    "message fork confirmation should track the active rendered thread id"
  )
  assert.match(
    source,
    /const messageForkRequestIdRef = useRef\(0\)/,
    "message fork checkpoint resolution should be cancelable when the thread changes"
  )
  assert.match(
    source,
    /useEffect\(\(\) => \{[\s\S]*messageForkRequestIdRef\.current \+= 1[\s\S]*setMessageForkTarget\(null\)[\s\S]*setForkingMessageId\(null\)[\s\S]*\}, \[threadId\]\)/,
    "switching threads must discard stale message fork dialogs and in-flight spinners"
  )
  assert.match(
    source,
    /messageForkRequestIdRef\.current !== requestId \|\|[\s\S]*currentThreadIdRef\.current !== sourceThreadId/,
    "stale async message-fork checkpoint responses must be ignored after navigation"
  )
  assert.match(
    source,
    /messageForkTarget\.sourceThreadId !== currentThreadIdRef\.current[\s\S]*当前会话已切换，请回到目标会话后重新点击 fork/,
    "confirming a stale message fork dialog must not fork a previous thread"
  )
}

async function testMessageForkThreadSwitchBoundaries(): Promise<void> {
  const source = await readProjectFile("src/renderer/src/components/chat/ChatContainer.tsx")

  assert.match(
    source,
    /const sourceThreadId = threadId[\s\S]*resolveForkCheckpointForMessage\(\{[\s\S]*threadId: sourceThreadId/,
    "message fork should capture the source thread before awaiting checkpoint resolution"
  )
  assert.match(
    source,
    /finally \{[\s\S]*if \(messageForkRequestIdRef\.current === requestId\) \{[\s\S]*setForkingMessageId\(null\)/,
    "stale message-fork requests must not clear the active thread's spinner in finally"
  )
  assert.match(
    source,
    /const resetMessageForkDialog = useCallback\(\(\): void => \{[\s\S]*messageForkRequestIdRef\.current \+= 1[\s\S]*setForkDestinationMode\("local"\)[\s\S]*setForkWorkspacePath\(null\)[\s\S]*setSelectingForkWorkspace\(false\)/,
    "manual message-fork reset should invalidate in-flight work and clear workspace selection state"
  )
  assert.match(
    source,
    /useEffect\(\(\) => \{[\s\S]*messageForkRequestIdRef\.current \+= 1[\s\S]*setMessageForkTarget\(null\)[\s\S]*setForkingMessageId\(null\)[\s\S]*setForkDestinationMode\("local"\)[\s\S]*setForkWorkspacePath\(null\)[\s\S]*setSelectingForkWorkspace\(false\)[\s\S]*\}, \[threadId\]\)/,
    "thread switches should invalidate fork dialogs, spinners, destination mode, and workspace picker state"
  )
  assert.match(
    source,
    /messageForkTarget\.sourceThreadId !== currentThreadIdRef\.current[\s\S]*resetMessageForkDialog\(\)[\s\S]*sourceThreadId: messageForkTarget\.sourceThreadId/,
    "confirming fork should reject stale dialogs before using the captured source thread id"
  )
}

async function testStoppedStreamSyncsDurableTranscript(): Promise<void> {
  const source = await readProjectFile("src/renderer/src/lib/thread-context.tsx")

  assert.match(
    source,
    /syncPersistedThreadMessagesAfterStreamStop[\s\S]*window\.api\.threads\.getMessages\(threadId\)/,
    "stopped streams should reconcile the UI transcript with durable thread_messages"
  )
  assert.match(
    source,
    /for \(const delayMs of \[50, 350\]\)/,
    "stopped stream durable sync should retry after the main-process terminal flush window"
  )
  assert.match(
    source,
    /syncPersistedThreadMessagesAfterStreamStop[\s\S]*streamDataRef\.current\[threadId\]\?\.isLoading[\s\S]*return/,
    "durable sync must not overwrite a new in-flight run"
  )
  assert.match(
    source,
    /if \(data\.isLoading && !wasLoading\) \{[\s\S]*durableTranscriptSyncSeqRef\.current\[threadId\]/,
    "starting a new stream should cancel any delayed durable transcript sync from the previous turn"
  )
  assert.match(
    source,
    /reconcileMessageDisplayOrder\(merged, liveOrderHint\)/,
    "durable sync must use the final stream snapshot to avoid appending late tool calls after final answers"
  )
  assert.match(
    source,
    /if \(wasLoading \|\| options\.finalizeCachedSnapshot\) \{[\s\S]*syncPersistedThreadMessagesAfterStreamStop\(threadId, data\.messages\)/,
    "durable sync should run when a normal or cached stream stops"
  )
}

async function testDurableSyncThreadLifecycleBoundaries(): Promise<void> {
  const source = await readProjectFile("src/renderer/src/lib/thread-context.tsx")
  const lifecycleChecks = source.match(/initializedThreadsRef\.current\.has\(threadId\)/g)?.length ?? 0

  assert(
    lifecycleChecks >= 4,
    "durable transcript sync should repeatedly verify the thread is still initialized"
  )
  assert.match(
    source,
    /for \(const delayMs of \[50, 350\]\)[\s\S]*durableTranscriptSyncSeqRef\.current\[threadId\] !== seq[\s\S]*window\.api\.threads\.getMessages\(threadId\)[\s\S]*durableTranscriptSyncSeqRef\.current\[threadId\] !== seq/,
    "durable transcript sync should fence both before and after async DB reads"
  )
  assert.match(
    source,
    /setThreadStates\(\(prev\) => \{[\s\S]*initializedThreadsRef\.current\.has\(threadId\)[\s\S]*streamDataRef\.current\[threadId\]\?\.isLoading[\s\S]*return prev/,
    "durable transcript sync should re-check lifecycle and loading state inside the state update"
  )
  assert.match(
    source,
    /if \(data\.isLoading && !wasLoading\) \{[\s\S]*durableTranscriptSyncSeqRef\.current\[threadId\]/,
    "starting a new stream on the same thread should cancel stale durable transcript syncs"
  )
  assert.match(
    source,
    /delete durableTranscriptSyncSeqRef\.current\[threadId\]/,
    "thread cleanup should drop durable transcript sync sequence state"
  )
}

async function testTerminalAndCancelledRunsFlushDurableTranscript(): Promise<void> {
  const source = await readProjectFile("src/main/ipc/agent.ts")

  assert.match(
    source,
    /function isTerminalStreamPayload[\s\S]*type === "done"[\s\S]*type === "error"/,
    "terminal stream payload detection must include errors, not only normal done events"
  )
  assert.match(
    source,
    /function safeSendToWindow[\s\S]*isTerminalStreamPayload\(payload\)[\s\S]*flushPendingStreamTranscriptMessages\(threadId\)/,
    "terminal stream events should flush pending durable transcript before renderer sync can read it"
  )
  assert.match(
    source,
    /controller\.abort\(\)[\s\S]{0,240}flushPendingStreamTranscriptMessages\(threadId\)/,
    "user cancellation should flush already queued transcript chunks immediately after aborting"
  )

  const cleanupFlushes =
    source.match(
      /flushPendingStreamTranscriptMessages\(threadId\)[\s\S]{0,1200}resolve(?:Active|Resume|Interrupt)RunSettled\(\)/g
    )?.length ?? 0
  assert(
    cleanupFlushes >= 3,
    "invoke, resume, and interrupt finally cleanup should flush transcript before marking the run settled"
  )
}

async function main(): Promise<void> {
  await testAbortPathsMarkStableForkBoundary()
  await testAssistantActionsRenderAfterTools()
  await testForkabilityAllowsInterruptedPendingWritesOnly()
  await testForkWaitsForAbortingRunToSettle()
  await testMessageForkStateIsScopedToActiveThread()
  await testMessageForkThreadSwitchBoundaries()
  await testStoppedStreamSyncsDurableTranscript()
  await testDurableSyncThreadLifecycleBoundaries()
  await testTerminalAndCancelledRunsFlushDurableTranscript()
  console.log("fork interruption regression tests passed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
