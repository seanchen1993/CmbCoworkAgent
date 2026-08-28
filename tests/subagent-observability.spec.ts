/**
 * Lightweight contract tests for subagent observability wiring.
 *
 * Run:
 *   npx -y tsx tests/subagent-observability.spec.ts
 */

import { readFile } from "fs/promises"
import { join, resolve } from "path"

const PROJECT_ROOT = resolve(__dirname, "..")

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

function assertIncludes(value: string, expected: string, label: string): void {
  assert(value.includes(expected), `${label}: expected to include "${expected}"`)
}

function assertNotIncludes(value: string, unexpected: string, label: string): void {
  assert(!value.includes(unexpected), `${label}: expected not to include "${unexpected}"`)
}

function assertMatches(value: string, pattern: RegExp, label: string): void {
  assert(pattern.test(value), `${label}: expected to match ${pattern}`)
}

function assertSourceOrder(value: string, first: string, second: string, label: string): void {
  const firstIndex = value.indexOf(first)
  const secondIndex = value.indexOf(second)
  assert(firstIndex >= 0, `${label}: expected to include first marker "${first}"`)
  assert(secondIndex >= 0, `${label}: expected to include second marker "${second}"`)
  assert(firstIndex < secondIndex, `${label}: expected "${first}" before "${second}"`)
}

async function readProjectFile(path: string): Promise<string> {
  // Normalize CRLF -> LF so multi-line source-guard assertions (which use \n)
  // match regardless of the checkout's line endings on Windows.
  return (await readFile(join(PROJECT_ROOT, path), "utf8")).replace(/\r\n/g, "\n")
}

async function testTransportCountsHiddenSubagentTools(): Promise<void> {
  const transport = await readProjectFile("src/renderer/src/lib/electron-transport.ts")

  assertIncludes(transport, "private subagentToolCallIds", "transport tracks subagent tool IDs")
  assertIncludes(
    transport,
    "this.subagentToolCallIds.clear()",
    "transport resets subagent tool IDs per stream"
  )
  assertIncludes(
    transport,
    "yield this.createSubagentToolCountEvent()",
    "transport emits a zero-count reset event"
  )
  assertIncludes(
    transport,
    "this.processSubagentToolCalls(\n              subagentToolCallId,",
    "transport counts hidden subagent tools with execution-scoped ownership"
  )
  assertIncludes(transport, 'type: "subagent_tool_count"', "transport emits aggregate count event")
  assertIncludes(transport, 'type: "subagent_log_reset"', "transport resets subagent logs per run")
  assertIncludes(transport, 'type: "subagent_log_entry"', "transport emits subagent log entries")
  assertIncludes(
    transport,
    'type: "subagent_transcript_message"',
    "transport emits full subagent transcript messages"
  )
  assertIncludes(
    transport,
    "private subagentToolOwnerIds",
    "transport tracks ownership for late subagent tool results"
  )
  assertIncludes(transport, 'kind: "tool_result"', "transport logs hidden subagent tool results")
  assertIncludes(transport, 'status: "waiting"', "transport marks tool calls as waiting")
  assertIncludes(transport, 'status: "completed"', "transport marks tool results as completed")
  assertIncludes(transport, "formatSubagentToolArgs", "transport captures subagent tool args")
  assertIncludes(
    transport,
    "this.hasRunningSubagent()",
    "transport only treats tool-node events as subagent activity while a subagent is running"
  )
  assertIncludes(
    transport,
    "isKnownSubagentToolCall",
    "transport still updates known subagent tool results after subagent completion"
  )
  assertIncludes(
    transport,
    "this.subagentToolLogEntryIds.has(scopedToolCallId)",
    "transport matches late tool results by execution-scoped tool call identity"
  )
  assertIncludes(
    transport,
    "!isTaskResultMessage",
    "transport excludes the parent task result from subagent internals"
  )
}

async function testThreadStateStoresAggregateToolCount(): Promise<void> {
  const threadContext = await readProjectFile("src/renderer/src/lib/thread-context.tsx")
  const threadHydration = await readProjectFile("src/renderer/src/lib/thread-hydration.ts")
  const threadStateHelpers = await readProjectFile("src/renderer/src/lib/thread-state-helpers.ts")
  const subagentTranscripts = await readProjectFile("src/renderer/src/lib/subagent-transcripts.ts")
  const subagentTranscriptStorage = await readProjectFile(
    "src/shared/subagent-transcript-storage.ts"
  )
  const subagentState = await readProjectFile("src/renderer/src/lib/subagent-state.ts")
  const streamConverter = await readProjectFile("src/main/agent/stream-converter.ts")
  const threadIpc = await readProjectFile("src/main/ipc/threads.ts")
  const preload = await readProjectFile("src/preload/index.ts")

  assertIncludes(
    threadContext,
    "subagentToolCallCount: number",
    "thread state exposes aggregate count"
  )
  assertIncludes(
    threadContext,
    "subagentInternalLogs: SubagentInternalLogEntry[]",
    "thread state exposes internal logs"
  )
  assertIncludes(
    threadContext,
    "subagentTranscripts: Record<string, Message[]>",
    "thread state exposes full subagent transcripts"
  )
  assertIncludes(
    threadContext,
    "coordinatorWorkers: CoordinatorWorkerView[]",
    "thread state exposes coordinator workers"
  )
  assertIncludes(
    threadStateHelpers,
    'status?: "waiting" | "completed"',
    "thread state helper tracks tool status"
  )
  assertIncludes(threadStateHelpers, "result?: string", "thread state helper tracks tool result")
  assertIncludes(
    threadContext,
    "subagentToolCallCount: 0",
    "thread state defaults aggregate count to zero"
  )
  assertIncludes(
    threadContext,
    "subagentInternalLogs: []",
    "thread state defaults internal logs to empty"
  )
  assertIncludes(
    threadContext,
    "subagentTranscripts: {}",
    "thread state defaults subagent transcripts to empty"
  )
  assertIncludes(
    threadContext,
    "coordinatorWorkers: []",
    "thread state defaults coordinator workers to empty"
  )
  assertIncludes(
    threadContext,
    'case "subagent_tool_count"',
    "thread context handles aggregate count event"
  )
  assertIncludes(
    threadContext,
    'case "subagent_log_entry"',
    "thread context handles internal log events"
  )
  assertIncludes(
    threadContext,
    'case "subagent_transcript_message"',
    "thread context handles full subagent transcript events"
  )
  assertIncludes(
    threadContext,
    "upsertTranscriptMessages",
    "thread context merges subagent transcript updates"
  )
  assertIncludes(
    threadContext,
    "subagentTranscriptsRef",
    "thread context keeps a synchronous subagent transcript ref to avoid batched update loss"
  )
  assertIncludes(
    subagentTranscriptStorage,
    'SUBAGENT_TRANSCRIPTS_THREAD_VALUE_KEY = "subagentTranscripts"',
    "shared transcript storage defines the compact manifest key"
  )
  assertIncludes(
    subagentTranscripts,
    "getSubagentTranscriptsFromThreadValues",
    "subagent transcript helper restores persisted transcripts"
  )
  assertIncludes(
    subagentTranscripts,
    "serializeSubagentTranscripts",
    "subagent transcript helper serializes transcripts before persistence"
  )
  assertIncludes(
    subagentTranscripts,
    "mergeTranscriptToolCalls",
    "subagent transcript helper merges assistant tool calls by id"
  )
  assertIncludes(
    threadContext,
    "scheduleSubagentTranscriptsPersist",
    "thread context debounces subagent transcript persistence"
  )
  assertIncludes(
    threadContext,
    "window.api.threads.persistSubagentTranscripts(",
    "thread context persists transcript snapshots through the dedicated sidecar API"
  )
  assertIncludes(
    threadContext,
    "subagentTranscriptDirtyIdsRef",
    "thread context persists only the subagents that changed since the last persist"
  )
  assertIncludes(
    threadContext,
    "persistedSubagentTranscripts = getSubagentTranscriptsFromThreadValues(",
    "thread context reads persisted transcripts while loading history"
  )
  assertIncludes(
    threadContext,
    "subagentTranscriptBaselineReady: false",
    "thread state starts with transcript baseline conversion disabled"
  )
  assertIncludes(
    threadContext,
    "if (!state?.subagentTranscriptBaselineReady) return null",
    "thread context mounts the stream transport only after transcript hydration"
  )
  assertSourceOrder(
    threadContext,
    "seededTransport.seedSubagentTranscriptBaseline",
    "const stream = useStream<DeepAgent>",
    "thread stream holder seeds the baseline before subscribing to live events"
  )
  assertIncludes(
    threadContext,
    "scheduleSubagentTranscriptHydrationRetry(threadId, loadGeneration, foregroundToken)",
    "thread context retries failed transcript hydration instead of treating it as empty"
  )
  assertIncludes(
    threadContext,
    "if (!threadStatesRef.current[threadId]?.subagentTranscriptBaselineReady) return",
    "thread context refuses live-only transcript persistence before hydration succeeds"
  )
  assertIncludes(
    threadContext,
    "threadHistoryLoadGenerationRef.current[threadId] === loadGeneration",
    "thread history and hydration commits are fenced by a per-thread request generation"
  )
  assertIncludes(
    threadContext,
    "subagentTranscriptPersistChainsRef.current[threadId]",
    "thread context keeps at most one transcript write in flight"
  )
  assertIncludes(
    threadContext,
    "subagentTranscriptPendingMessagesRef.current[threadId]",
    "thread context coalesces message-level transcript deltas behind the write chain"
  )
  assertIncludes(
    threadContext,
    "selectSubagentTranscriptPersistFollowUp({",
    "failed writes cannot be restarted by the success-only follow-up drain"
  )
  assertNotIncludes(
    threadContext,
    "retryCount > 3",
    "terminal transcript persistence must not become permanently stranded after four failures"
  )
  assertIncludes(
    threadContext,
    "getSubagentTranscriptPersistRetrySchedule(retryCount)",
    "transcript persistence delegates retries to the shared bounded policy"
  )
  assertIncludes(
    threadHydration,
    "Math.min(30_000, 500 * 2 ** Math.min(normalizedCount, 6))",
    "the shared retry policy caps transcript persistence backoff at 30 seconds"
  )
  assertIncludes(
    threadHydration,
    "SUBAGENT_TRANSCRIPT_PERSIST_MAX_AUTO_RETRIES = 6",
    "transcript persistence retries have a finite automatic retry budget"
  )
  assertSourceOrder(
    threadContext,
    "if (!threadStatesRef.current[threadId]?.subagentTranscriptBaselineReady) return",
    "delete subagentTranscriptDirtyIdsRef.current[threadId]",
    "debounce must not consume dirty transcript ids before hydration is ready"
  )
  assertIncludes(
    threadContext,
    "restoreSubagentsFromTranscripts(",
    "hydrated transcript buckets rebuild historical subagent cards"
  )
  assertIncludes(
    threadIpc,
    "thread_values: threadValuesWithoutSubagentTranscripts(row.thread_values)",
    "generic thread mutation responses do not clone transcript manifests"
  )
  const compactTranscriptHandlerStart = threadIpc.indexOf(
    'ipcMain.handle("threads:getSubagentTranscripts"'
  )
  const focusedTranscriptHandlerStart = threadIpc.indexOf(
    '"threads:getSubagentTranscript"',
    compactTranscriptHandlerStart + 1
  )
  assert(
    compactTranscriptHandlerStart >= 0 && focusedTranscriptHandlerStart > compactTranscriptHandlerStart,
    "thread IPC should expose separate compact and focused transcript handlers"
  )
  const compactTranscriptHandler = threadIpc.slice(
    compactTranscriptHandlerStart,
    focusedTranscriptHandlerStart
  )
  assertIncludes(
    compactTranscriptHandler,
    "readSubagentTranscriptStartupInWorker(threadId",
    "history startup projects the bounded row-backed transcript index off the main thread"
  )
  assertIncludes(
    compactTranscriptHandler,
    "ensureSubagentTranscriptRows(threadId)",
    "history startup atomically migrates the one legacy inline sidecar"
  )
  assertNotIncludes(
    compactTranscriptHandler,
    "hydrateSubagentTranscriptManifests",
    "history startup must not hydrate every large transcript blob"
  )
  assertNotIncludes(
    compactTranscriptHandler,
    "getThreadSubagentStartupManifests(threadId)",
    "history startup must not project the complete transcript index on the main thread"
  )
  assertIncludes(
    threadIpc.slice(focusedTranscriptHandlerStart),
    "rowBackedSubagentTranscriptPage(threadId, subagentId, before)",
    "focused transcript IPC selects a bounded row page before hydration"
  )
  assertIncludes(
    threadIpc.slice(focusedTranscriptHandlerStart),
    "hydrateSubagentTranscriptManifestPage(page)",
    "focused transcript IPC hydrates only the selected bounded page"
  )
  assertIncludes(
    preload,
    'ipcRenderer.invoke("threads:getSubagentTranscript", { threadId, subagentId, before })',
    "preload exposes the focused transcript hydration channel"
  )
  assertIncludes(
    threadContext,
    "clearSchedulerStreamingForThread",
    "thread context clears all scheduler stream accumulators for a thread"
  )
  assertIncludes(
    threadContext,
    "const subagentKeys = schedulerSubagentStreamKeysRef.current[threadId]",
    "thread context targets its registered subagent accumulator keys during cleanup"
  )
  assertIncludes(
    threadContext,
    "for (const key of subagentKeys) delete schedulerStreamingRef.current[key]",
    "thread context removes registered subagent accumulator keys during cleanup"
  )
  assertIncludes(
    threadContext,
    "finalizeRunningSubagentsForStoppedStream",
    "thread context finalizes running subagents when the parent stream stops"
  )
  assertIncludes(
    threadContext,
    'status: "cancelled" as const',
    "thread context marks still-running subagents as cancelled on parent stop"
  )
  assertIncludes(
    threadContext,
    "mergeSubagentSnapshotWithHistory(",
    "thread context routes incoming snapshots through terminal-state reconciliation"
  )
  assertIncludes(
    subagentState,
    "resolveIncomingSubagentStatus({",
    "subagent state prevents late stale snapshots from restoring running"
  )
  assertIncludes(
    subagentState,
    "isTerminalSubagentStatus(input.existingStatus)",
    "subagent state preserves terminal statuses over stale running snapshots"
  )
  assertIncludes(
    streamConverter,
    "isError?: boolean",
    "scheduler stream converter exposes tool-message error state"
  )
  assertIncludes(
    streamConverter,
    "...(isToolMessageError(kwargs) ? { isError: true } : {})",
    "scheduler stream converter forwards failed subagent tool results"
  )
  assertIncludes(
    threadContext,
    'case "coordinator_workers"',
    "thread context handles coordinator worker events"
  )
  assertIncludes(
    threadContext,
    "mergeCoordinatorWorkers(prev.coordinatorWorkers, data.workers!, {",
    "thread context merges authoritative coordinator worker snapshots"
  )
  assertIncludes(
    threadContext,
    "mergeCoordinatorWorkers(prev.coordinatorWorkers, [data.worker!])",
    "thread context merges incremental coordinator worker deltas"
  )
  assertIncludes(
    threadContext,
    "if (data.notification && !data.suppressNotificationAutoRun)",
    "thread context can ignore user-cancelled worker notifications for coordinator auto-resume while still updating the panel"
  )
  assertIncludes(
    threadContext,
    "requestCoordinatorWorkers(threadId, false)",
    "thread context refreshes coordinator workers outside the active stream without registering stale update callbacks"
  )
  assertIncludes(
    threadContext,
    "window.api.agent.getCoordinatorWorkers(threadId, { subscribeUpdates: subscribe })",
    "the shared worker request cache must preserve snapshot versus subscription semantics"
  )
  assertIncludes(
    threadContext,
    "unbindCoordinatorWorkers(previousThreadId)",
    "thread context unsubscribes worker update callbacks when the active thread changes"
  )
  assertIncludes(
    threadContext,
    "requestCoordinatorWorkers(currentThreadId, true)",
    "thread context subscribes worker updates only for the active thread"
  )
  assertIncludes(
    threadContext,
    "Failed to restore coordinator workers:",
    "thread context restores coordinator workers when loading a thread"
  )
  assertIncludes(
    threadContext,
    "const hasRunningWorker = workers.some(",
    "thread context polls unresolved coordinator threads, not just strictly running workers"
  )
  assertIncludes(
    threadContext,
    'worker.status === "running"',
    "thread context treats running coordinator workers as unresolved work"
  )
  assertIncludes(
    threadContext,
    "worker.notification_acknowledged === false &&",
    "thread context treats only unsuppressed unacknowledged terminal coordinator notifications as unresolved from running workers"
  )
  assertIncludes(
    threadContext,
    "initializedThreadsRef.current.has(threadId)",
    "thread context does not keep background polling alive for cold unresolved coordinator threads that cannot auto-run yet"
  )
  assertIncludes(
    threadContext,
    "!isThreadMetadataExplicitNormalMode(threadId) ||",
    "thread context drops unresolved terminal notifications out of background polling when explicit normal mode suppresses coordinator auto-runs"
  )
  assertIncludes(
    threadContext,
    "coordinatorWorkersEqual(prev.coordinatorWorkers, merged)",
    "thread context avoids redundant worker refresh state writes"
  )
  assertIncludes(
    threadContext,
    "updateKeys.length === 0 ||",
    "thread context should not allocate a new thread state for empty updates"
  )
  assertIncludes(
    threadContext,
    "!updateKeys.some((key) => !Object.is(current[key], updates[key]))",
    "thread context should skip state updates when values are unchanged"
  )
  assertIncludes(
    threadStateHelpers,
    "safeTimestamp",
    "thread state helper sorts coordinator workers with invalid timestamp guards"
  )
  assertIncludes(
    threadContext,
    "upsertSubagentLogEntry(prev.subagentInternalLogs, data.entry!)",
    "thread context updates existing tool log entries"
  )
  assertIncludes(
    threadStateHelpers,
    "limitSubagentLogs",
    "thread state helper caps internal log entries"
  )
  assertIncludes(
    threadContext,
    "Math.max(0, Math.floor(data.count!))",
    "thread context normalizes aggregate count"
  )
}

async function testRightPanelDisplaysAndAutoOpens(): Promise<void> {
  const rightPanel = await readProjectFile("src/renderer/src/components/panels/RightPanel.tsx")

  assertIncludes(rightPanel, "runningSubagentIdsRef", "right panel tracks newly running subagents")
  assertIncludes(
    rightPanel,
    "runningCoordinatorWorkerRunKeysRef",
    "right panel tracks newly running coordinator worker runs"
  )
  assertNotIncludes(
    rightPanel,
    "runningCoordinatorWorkerIdsRef",
    "right panel no longer keys coordinator auto-open only by worker id"
  )
  assertIncludes(rightPanel, "setAgentsOpen(true)", "right panel auto-opens agents section")
  assertIncludes(
    rightPanel,
    "worker.turns ?? 0",
    "right panel includes worker turn count in coordinator run key detection"
  )
  assertIncludes(
    rightPanel,
    "worker.last_started_at ?? worker.created_at",
    "right panel treats continue_worker restarts as a fresh run for auto-open"
  )
  assertIncludes(
    rightPanel,
    "const hasNewRunning = Array.from(runningKeys).some(",
    "right panel compares coordinator running keys against the previous snapshot"
  )
  assertIncludes(
    rightPanel,
    "runningCoordinatorWorkerRunKeysRef.current = runningKeys",
    "right panel stores the latest coordinator run keys after auto-open checks"
  )
  assertIncludes(
    rightPanel,
    "CoordinatorWorkerCard",
    "right panel renders coordinator worker cards"
  )
  assertIncludes(
    rightPanel,
    "worker.tool_call_count",
    "right panel shows coordinator worker tool count"
  )
  assertIncludes(
    rightPanel,
    "worker.last_tool_name",
    "right panel shows coordinator worker last tool"
  )
  assertIncludes(
    rightPanel,
    'workload === "verify" ? "验证"',
    "right panel labels coordinator verifier workload"
  )
  assertIncludes(
    rightPanel,
    "Number.isFinite(ms)",
    "right panel guards invalid worker elapsed time"
  )
  assertIncludes(
    rightPanel,
    "const durationMs = isRunning",
    "right panel computes running worker duration from local time"
  )
  assertIncludes(
    rightPanel,
    "deriveCoordinatorWorkerCompletedAtMs",
    "right panel freezes completed worker timing at the worker's actual completion point"
  )
  assertIncludes(
    rightPanel,
    "const [sharedNowMs, setSharedNowMs] = useState(() => Date.now())",
    "right panel uses a shared clock for live activity cards"
  )
  assertIncludes(
    rightPanel,
    "nowMs={sharedNowMs}",
    "right panel passes the shared clock into live activity cards"
  )
  assertIncludes(rightPanel, "safeDateMs", "right panel guards invalid worker timestamps")
  assertNotIncludes(
    rightPanel,
    "SubagentCurrentToolCard",
    "right panel no longer renders the redundant aggregate subagent tool-status card"
  )
  assertNotIncludes(
    rightPanel,
    "hasSubagentToolActivity",
    "right panel no longer shows a separate subagent current-tool activity box"
  )
  assertNotIncludes(
    rightPanel,
    "const timer = window.setInterval(() => setNowMs(Date.now()), 1000)\n    return () => window.clearInterval(timer)\n  }, [isRunning])",
    "coordinator worker cards no longer spin up per-card timers"
  )
  assertNotIncludes(
    rightPanel,
    "const timer = window.setInterval(() => setNowMs(Date.now()), 1000)\n    return () => window.clearInterval(timer)\n  }, [hasRunningSubagent])",
    "current tool card no longer spins up its own timer"
  )
  assertNotIncludes(
    rightPanel,
    "useRef(Date.now())",
    "right panel no longer snapshots completion timing by calling Date.now during render"
  )
  assertNotIncludes(
    rightPanel,
    "hasRunningSubagent && currentLog?.createdAt",
    "right panel no longer computes aggregate subagent activity timing"
  )
  assertNotIncludes(
    rightPanel,
    "子代理执行中",
    "right panel removes redundant subagent activity label"
  )
  assertNotIncludes(
    rightPanel,
    "子代理整理中",
    "right panel removes redundant subagent thinking label"
  )
  assertNotIncludes(rightPanel, "等待下一步", "right panel removes aggregate subagent step label")
  assertNotIncludes(
    rightPanel,
    "summarizeSubagentToolInput",
    "right panel removes aggregate subagent tool input summarizer"
  )
  assertNotIncludes(
    rightPanel,
    "summarizeSubagentToolResult",
    "right panel removes aggregate subagent tool result summarizer"
  )
  assertNotIncludes(
    rightPanel,
    "等待工具返回，若长时间停留说明卡在当前工具",
    "right panel removes aggregate subagent waiting explanation"
  )
  assertNotIncludes(
    rightPanel,
    "工具已返回，等待子代理继续",
    "right panel removes aggregate subagent model-waiting explanation"
  )
  assertNotIncludes(rightPanel, "未收到返回", "right panel removes aggregate missing-result label")
  assertNotIncludes(
    rightPanel,
    "子代理已结束，但该工具返回事件未收到",
    "right panel removes aggregate stale missing-result explanation"
  )
  assertIncludes(
    rightPanel,
    "formatCompactElapsed",
    "right panel shows elapsed time since last tool activity"
  )
  assertIncludes(
    rightPanel,
    "openWorkerFocusView({",
    "right panel wires coordinator worker cards to the tool-flow focus view"
  )
  assertIncludes(rightPanel, "打开工具流", "right panel exposes a tool-flow entrypoint")
  assertIncludes(
    rightPanel,
    "<SubagentCard key={agent.id} subagent={agent} threadId={threadId} />",
    "right panel passes the panel thread id into subagent cards"
  )
  assertIncludes(
    rightPanel,
    "查看消息、工具参数和执行结果",
    "right panel explains the worker tool-flow drawer content"
  )

  const subagentPanel = await readProjectFile(
    "src/renderer/src/components/panels/SubagentPanel.tsx"
  )
  const appStore = await readProjectFile("src/renderer/src/lib/store.ts")
  const app = await readProjectFile("src/renderer/src/App.tsx")
  const subagentStreamPanel = await readProjectFile(
    "src/renderer/src/components/chat/SubagentStreamPanel.tsx"
  )

  assertIncludes(subagentPanel, "打开完整记录", "subagent card exposes full transcript entrypoint")
  assertNotIncludes(
    subagentPanel,
    "getSubagentTranscriptDisplayStats",
    "subagent card no longer renders a transcript entry count"
  )
  assertNotIncludes(
    subagentPanel,
    "} 条",
    "subagent card should not display a transcript message count badge"
  )
  assertIncludes(
    subagentPanel,
    "openSubagentFocusView",
    "subagent card opens the focused transcript view"
  )
  assertIncludes(
    appStore,
    "subagentFocusView: SubagentFocusView | null",
    "store tracks focused subagent view"
  )
  assertIncludes(app, "<SubagentStreamPanel />", "app renders the subagent transcript split panel")
  assertIncludes(
    subagentStreamPanel,
    "子代理完整记录",
    "subagent transcript panel has a dedicated header"
  )
  assertIncludes(
    subagentStreamPanel,
    "MessageBubble",
    "subagent transcript panel reuses chat message rendering"
  )
  assertIncludes(
    subagentStreamPanel,
    ".getSubagentTranscript(focus.threadId, focus.subagentId)",
    "subagent transcript panel lazily hydrates only the opened record"
  )
  assertIncludes(
    subagentStreamPanel,
    "hydratedTranscript?.focusKey !== focusedSubagentKey",
    "subagent transcript panel ignores a stale focused hydration response"
  )
  assertIncludes(
    subagentStreamPanel,
    "currentSubagent?.status ??",
    "subagent transcript panel prefers live subagent status over the opening snapshot"
  )
  assertIncludes(
    subagentStreamPanel,
    "const parentIsRunning = focusedStream.isLoading || scheduledTaskLoading",
    "subagent transcript panel checks the parent run before showing a live status"
  )
  assertIncludes(
    subagentStreamPanel,
    'const isRunning = effectiveStatus === "running" && parentIsRunning',
    "subagent transcript panel cannot keep spinning after the parent run stops"
  )
  assertIncludes(
    subagentStreamPanel,
    "isAtBottomRef",
    "subagent transcript panel tracks whether the user is already at the bottom"
  )
  assertIncludes(
    subagentStreamPanel,
    'viewport.addEventListener("scroll", updateIsAtBottom',
    "subagent transcript panel updates the auto-scroll guard from user scrolling"
  )
  assertIncludes(
    subagentStreamPanel,
    "if (!viewport || !isAtBottomRef.current) return",
    "subagent transcript panel only auto-scrolls while the user is pinned to the bottom"
  )
  assertIncludes(
    subagentStreamPanel,
    "hasUserAfterHeadByIndex",
    "subagent transcript panel precomputes user-after flags instead of scanning per message"
  )
  assertNotIncludes(
    subagentStreamPanel,
    "messages.slice(index + 1).some",
    "subagent transcript panel avoids quadratic user-after scans"
  )
  assertNotIncludes(
    subagentStreamPanel,
    'currentSubagent?.status === "running" || subagentFocusView?.status === "running"',
    "subagent transcript panel should not keep showing running from stale focus status"
  )
}

async function testSidebarKeepsThreadLoadingWhileWorkerRuns(): Promise<void> {
  const sidebar = await readProjectFile("src/renderer/src/components/sidebar/ThreadSidebar.tsx")
  const deletionHelper = await readProjectFile(
    "src/renderer/src/lib/thread-group-deletion.ts"
  )
  const harnessBoard = await readProjectFile(
    "src/renderer/src/components/harness-board/HarnessBoardView.tsx"
  )

  assertIncludes(
    sidebar,
    "hasRunningCoordinatorWorker",
    "sidebar derives loading state from coordinator workers"
  )
  assertIncludes(
    sidebar,
    "threadSummary?.hasRunningCoordinatorWorker",
    "sidebar reads the O(1) coordinator-worker summary instead of scanning workers"
  )
  assertMatches(
    sidebar,
    /const\s+isLoading\s*=\s*\(allStreamLoadingStates\[thread\.thread_id\]\s*\?\?\s*false\)\s*\|\|\s*hasRunningCoordinatorWorker\s*\|\|\s*Boolean\(threadSummary\?\.workflowRunning\)/u,
    "sidebar keeps spinner active after main stream completes while worker is running"
  )
  assertMatches(
    harnessBoard,
    /const\s+isLoading\s*=\s*\(allStreamLoadingStates\[thread\.thread_id\]\s*\?\?\s*false\)\s*\|\|\s*threadState\?\.workflowRunning\s*===\s*true/u,
    "project-mode sidebar keeps spinner active while a dynamic workflow is running"
  )
  assertMatches(
    harnessBoard,
    /const\s+hasRunningFeatureSession\s*=\s*featureSessionThreadIds\.some\([\s\S]*?allStreamLoadingStates\[threadId\]\s*===\s*true[\s\S]*?allThreadStates\[threadId\]\?\.workflowRunning\s*===\s*true/u,
    "project-mode stage animation remains active while a dynamic workflow is running"
  )
  assertIncludes(
    sidebar,
    "deleteThreadGroupSequentially([threadToDelete.thread_id]",
    "sidebar routes single deletion through the shared committed-deletion helper"
  )
  assertSourceOrder(
    deletionHelper,
    "await handlers.deleteThread(threadId)",
    "handlers.cleanupThread(threadId)",
    "the shared deletion helper tears down renderer state only after backend deletion succeeds"
  )
}

async function testWorkerToolFlowPreservesToolErrorStatus(): Promise<void> {
  const transport = await readProjectFile("src/renderer/src/lib/electron-transport.ts")
  const workerStreamPanel = await readProjectFile(
    "src/renderer/src/components/chat/WorkerStreamPanel.tsx"
  )
  const workerCheckpointHistory = await readProjectFile(
    "src/renderer/src/lib/worker-checkpoint-history.ts"
  )
  const rendererTypes = await readProjectFile("src/renderer/src/types.ts")

  assertIncludes(
    transport,
    "const isError = this.isToolMessageError(kwargs)",
    "focused worker transport derives tool error state from provider payloads"
  )
  assertIncludes(
    transport,
    "...(kwargs.status && { status: kwargs.status })",
    "focused worker transport forwards tool execution status to the worker panel"
  )
  assertIncludes(
    transport,
    "...(isError && { is_error: true })",
    "focused worker transport forwards failed tool results as is_error"
  )
  assertIncludes(
    workerStreamPanel,
    "(live.status ?? existing.status)",
    "worker stream panel preserves tool status while merging live and checkpoint messages"
  )
  assertIncludes(
    workerStreamPanel,
    "(live.is_error ?? existing.is_error)",
    "worker stream panel preserves tool error flags while merging live and checkpoint messages"
  )
  assertIncludes(
    workerCheckpointHistory,
    "export const MAX_WORKER_HISTORY_MESSAGES = 500",
    "worker checkpoint helper bounds history restore to a recent message window"
  )
  assertIncludes(
    workerCheckpointHistory,
    "indexedMessages[index].absoluteIndex >= startIndex",
    "worker checkpoint helper restores only the recent message window when history is large"
  )
  assertIncludes(
    workerCheckpointHistory,
    'message.is_error === true ||',
    "worker checkpoint helper preserves explicit tool error flags"
  )
  assertIncludes(
    workerCheckpointHistory,
    'toolStatus === "error"',
    "worker checkpoint helper also derives tool errors from provider status"
  )
  assertIncludes(
    rendererTypes,
    "status?: string",
    "renderer message type exposes provider tool status for worker tool-flow messages"
  )
  assertIncludes(
    rendererTypes,
    "is_error?: boolean",
    "renderer message type exposes tool failure state for worker tool-flow messages"
  )
}

async function run(): Promise<void> {
  await testTransportCountsHiddenSubagentTools()
  console.log("PASS subagent transport aggregate tool count")
  await testThreadStateStoresAggregateToolCount()
  console.log("PASS subagent thread state aggregate tool count")
  await testRightPanelDisplaysAndAutoOpens()
  console.log("PASS subagent right panel observability")
  await testSidebarKeepsThreadLoadingWhileWorkerRuns()
  console.log("PASS sidebar coordinator worker loading state")
  await testWorkerToolFlowPreservesToolErrorStatus()
  console.log("PASS worker tool flow error status wiring")
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
