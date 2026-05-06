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

function assertSourceOrder(value: string, first: string, second: string, label: string): void {
  const firstIndex = value.indexOf(first)
  const secondIndex = value.indexOf(second)
  assert(firstIndex >= 0, `${label}: expected to include first marker "${first}"`)
  assert(secondIndex >= 0, `${label}: expected to include second marker "${second}"`)
  assert(firstIndex < secondIndex, `${label}: expected "${first}" before "${second}"`)
}

async function readProjectFile(path: string): Promise<string> {
  return readFile(join(PROJECT_ROOT, path), "utf8")
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
    "processSubagentToolCalls(kwargs.tool_calls, kwargs.tool_call_chunks)",
    "transport counts hidden subagent tool calls"
  )
  assertIncludes(transport, 'type: "subagent_tool_count"', "transport emits aggregate count event")
  assertIncludes(transport, 'type: "subagent_log_reset"', "transport resets subagent logs per run")
  assertIncludes(transport, 'type: "subagent_log_entry"', "transport emits subagent log entries")
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
    "this.subagentToolLogEntryIds.has(kwargs.tool_call_id)",
    "transport matches late tool results by known subagent tool call ID"
  )
  assertIncludes(
    transport,
    "!isTaskResultMessage",
    "transport excludes the parent task result from subagent internals"
  )
}

async function testThreadStateStoresAggregateToolCount(): Promise<void> {
  const threadContext = await readProjectFile("src/renderer/src/lib/thread-context.tsx")
  const threadStateHelpers = await readProjectFile("src/renderer/src/lib/thread-state-helpers.ts")

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
    "getCoordinatorWorkers(threadId)",
    "thread context refreshes coordinator workers outside the active stream"
  )
  assertIncludes(
    threadContext,
    "Failed to load coordinator workers",
    "thread context restores coordinator workers when loading a thread"
  )
  assertIncludes(
    threadContext,
    'const hasRunningWorker = state.coordinatorWorkers.some((worker) => worker.status === "running")',
    "thread context polls unresolved coordinator threads, not just strictly running workers"
  )
  assertIncludes(
    threadContext,
    'worker.notification_acknowledged === false\n            && worker.suppress_notification_auto_run !== true',
    "thread context treats only unsuppressed unacknowledged terminal coordinator notifications as unresolved from running workers"
  )
  assertIncludes(
    threadContext,
    "if (!initializedThreadsRef.current.has(threadId)) return false",
    "thread context does not keep background polling alive for cold unresolved coordinator threads that cannot auto-run yet"
  )
  assertIncludes(
    threadContext,
    "if (isThreadMetadataExplicitNormalMode(threadId) && !isEnvironmentCoordinatorMode)",
    "thread context drops unresolved terminal notifications out of background polling when explicit normal mode suppresses coordinator auto-runs"
  )
  assertIncludes(
    threadContext,
    "coordinatorWorkersEqual(prev.coordinatorWorkers, merged)",
    "thread context avoids redundant worker refresh state writes"
  )
  assertIncludes(
    threadContext,
    "if (updateKeys.length === 0) return prev",
    "thread context should not allocate a new thread state for empty updates"
  )
  assertIncludes(
    threadContext,
    "Object.is(currentState[key], updates[key])",
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
  assertIncludes(threadStateHelpers, ".slice(-20)", "thread state helper caps internal log entries")
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
    "runningCoordinatorWorkerIdsRef",
    "right panel tracks newly running coordinator workers"
  )
  assertIncludes(rightPanel, "setAgentsOpen(true)", "right panel auto-opens agents section")
  assertIncludes(rightPanel, "subagentToolCallCount", "right panel reads aggregate tool count")
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
  assertIncludes(rightPanel, "SubagentCurrentToolCard", "right panel renders current tool card")
  assertIncludes(
    rightPanel,
    "toolCallCount={subagentToolCallCount}",
    "right panel merges count into current tool card"
  )
  assertIncludes(
    rightPanel,
    "hasRunningSubagent={hasRunningSubagent}",
    "right panel passes subagent running state"
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
  assertIncludes(
    rightPanel,
    "hasRunningSubagent && currentLog?.createdAt",
    "current tool card only derives live elapsed time while the subagent is still running"
  )
  assertIncludes(rightPanel, "子代理执行中", "right panel labels running subagent activity")
  assertIncludes(rightPanel, "子代理整理中", "right panel labels post-tool model work")
  assertIncludes(rightPanel, "等待下一步", "right panel shows waiting for next subagent step")
  assertIncludes(rightPanel, "summarizeSubagentToolInput", "right panel summarizes tool input")
  assertIncludes(rightPanel, "summarizeSubagentToolResult", "right panel summarizes tool result")
  assertIncludes(
    rightPanel,
    "等待工具返回，若长时间停留说明卡在当前工具",
    "right panel explains tool waiting state"
  )
  assertIncludes(
    rightPanel,
    "工具已返回，等待子代理继续",
    "right panel explains model waiting state after tool return"
  )
  assertIncludes(rightPanel, "未收到返回", "right panel labels missing late tool result")
  assertIncludes(
    rightPanel,
    "子代理已结束，但该工具返回事件未收到",
    "right panel explains stale missing result"
  )
  assertIncludes(
    rightPanel,
    "formatCompactElapsed",
    "right panel shows elapsed time since last tool activity"
  )
}

async function testSidebarKeepsThreadLoadingWhileWorkerRuns(): Promise<void> {
  const sidebar = await readProjectFile("src/renderer/src/components/sidebar/ThreadSidebar.tsx")

  assertIncludes(
    sidebar,
    "hasRunningCoordinatorWorker",
    "sidebar derives loading state from coordinator workers"
  )
  assertIncludes(
    sidebar,
    'worker.status === "running"',
    "sidebar checks for running coordinator workers"
  )
  assertIncludes(
    sidebar,
    "(allStreamLoadingStates[thread.thread_id] ?? false) || hasRunningCoordinatorWorker",
    "sidebar keeps spinner active after main stream completes while worker is running"
  )
  assertSourceOrder(
    sidebar,
    "await deleteThread(thread.thread_id)",
    "cleanupThread(thread.thread_id)",
    "sidebar only tears down thread context after backend deletion succeeds"
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
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
