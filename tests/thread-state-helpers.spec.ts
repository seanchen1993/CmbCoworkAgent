/**
 * Unit tests for renderer thread-state helper behavior.
 *
 * Run:
 *   npx -y tsx tests/thread-state-helpers.spec.ts
 */

import {
  MAX_COORDINATOR_WORKERS_IN_THREAD_STATE,
  coordinatorWorkersEqual,
  hasSubagentToolActivity,
  mergeCoordinatorWorkers,
  safeTimestamp,
  upsertSubagentLogEntry,
  type CoordinatorWorkerView,
  type SubagentInternalLogEntry
} from "../src/renderer/src/lib/thread-state-helpers.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function worker(
  input: Partial<CoordinatorWorkerView> & { worker_id: string }
): CoordinatorWorkerView {
  return {
    worker_id: input.worker_id,
    worker_thread_id: input.worker_thread_id ?? `${input.worker_id}-thread`,
    parent_thread_id: input.parent_thread_id ?? "thread-123",
    role: input.role ?? "implementer",
    workload: input.workload ?? (input.role === "verifier" ? "verify" : "write"),
    description: input.description ?? "Worker task",
    status: input.status ?? "running",
    turns: input.turns ?? 1,
    created_at: input.created_at ?? "2026-04-28T10:00:00.000Z",
    updated_at: input.updated_at ?? "2026-04-28T10:00:00.000Z",
    tool_call_count: input.tool_call_count ?? 0,
    last_event: input.last_event ?? "Worker started.",
    ...input
  }
}

function logEntry(
  input: Partial<SubagentInternalLogEntry> & { id: string }
): SubagentInternalLogEntry {
  return {
    id: input.id,
    kind: input.kind ?? "tool_call",
    title: input.title ?? "调用工具：read_file",
    content: input.content ?? "input",
    createdAt: input.createdAt ?? "2026-04-28T10:00:00.000Z",
    ...input
  }
}

async function testSubagentLogUpsertPreservesUsefulFields(): Promise<void> {
  const first = logEntry({
    id: "log-1",
    title: "调用工具：read_file",
    content: '{"file_path":"README.md"}',
    status: "waiting",
    toolName: "read_file"
  })
  const updated = logEntry({
    id: "log-1",
    kind: "tool_result",
    title: "",
    content: "",
    result: "ok",
    status: "completed"
  })

  const logs = upsertSubagentLogEntry([first], updated)
  assert(logs.length === 1, "same log id should update in place")
  assert(logs[0].kind === "tool_result", "updated log should keep latest kind")
  assert(logs[0].title === "调用工具：read_file", "empty update title should not erase old title")
  assert(
    logs[0].content === '{"file_path":"README.md"}',
    "empty update content should not erase old input summary"
  )
  assert(logs[0].result === "ok", "updated log should include tool result")
  assert(logs[0].status === "completed", "updated log should include completed status")
  assert(logs[0].toolName === "read_file", "empty update toolName should preserve old tool name")
}

async function testSubagentLogCapKeepsNewestEntries(): Promise<void> {
  const logs = Array.from({ length: 25 }, (_, index) =>
    logEntry({
      id: `log-${index}`,
      content: `content-${index}`,
      createdAt: `2026-04-28T10:00:${String(index).padStart(2, "0")}.000Z`
    })
  ).reduce<SubagentInternalLogEntry[]>(
    (current, entry) => upsertSubagentLogEntry(current, entry),
    []
  )

  assert(logs.length === 20, "subagent logs should be capped at 20 entries")
  assert(logs[0].id === "log-5", "cap should drop oldest entries")
  assert(logs[19].id === "log-24", "cap should keep newest entry")
}

async function testSubagentLogCapRetainsThinkingUnderToolBurst(): Promise<void> {
  // 40 tool entries followed by a couple of thinking entries: assistant entries
  // must survive even when far more recent tool entries exist.
  const toolEntries = Array.from({ length: 40 }, (_, index) =>
    logEntry({ id: `tool-${index}`, kind: "tool_call" })
  )
  const thinkingEntries = [
    logEntry({ id: "think-1", kind: "assistant", content: "early reasoning" }),
    logEntry({ id: "think-2", kind: "assistant", content: "later reasoning" })
  ]
  const logs = [...toolEntries, ...thinkingEntries].reduce<SubagentInternalLogEntry[]>(
    (current, entry) => upsertSubagentLogEntry(current, entry),
    []
  )

  const retainedThinking = logs.filter((entry) => entry.kind === "assistant")
  assert(retainedThinking.length === 2, "both thinking entries should survive a tool burst")
  assert(logs.length <= 32, "overall log should stay bounded (recent tools + thinking)")
}

async function testSubagentToolActivityPredicate(): Promise<void> {
  const thinkingOnly = [logEntry({ id: "a-1", kind: "assistant", content: "thinking..." })]
  assert(
    hasSubagentToolActivity(0, thinkingOnly) === false,
    "assistant-only logs should not render the current-tool card"
  )
  assert(
    hasSubagentToolActivity(0, [logEntry({ id: "t-1", kind: "tool_call" })]) === true,
    "a tool_call log should render the current-tool card"
  )
  assert(
    hasSubagentToolActivity(1, thinkingOnly) === true,
    "a positive tool count should render the current-tool card"
  )
  assert(
    hasSubagentToolActivity(0, []) === false,
    "no logs and no tool count should not render the current-tool card"
  )
}

async function testCoordinatorWorkerMergeAndSort(): Promise<void> {
  const existing = [
    worker({
      worker_id: "worker-a",
      status: "running",
      updated_at: "not-a-date",
      summary: "old summary"
    }),
    worker({
      worker_id: "worker-b",
      status: "running",
      updated_at: "2026-04-28T10:00:00.000Z"
    })
  ]
  const incoming = [
    worker({
      worker_id: "worker-a",
      status: "completed",
      updated_at: "2026-04-28T10:05:00.000Z",
      tool_call_count: 3
    }),
    worker({
      worker_id: "worker-c",
      role: "verifier",
      workload: "verify",
      updated_at: "2026-04-28T10:03:00.000Z"
    })
  ]

  const merged = mergeCoordinatorWorkers(existing, incoming)
  assert(merged.length === 3, "worker merge should upsert by worker_id")
  assert(merged[0].worker_id === "worker-a", "newer worker should sort first")
  assert(merged[0].status === "completed", "incoming worker should replace status")
  assert(merged[0].tool_call_count === 3, "incoming worker should replace tool count")
  assert(merged[1].worker_id === "worker-c", "new worker should be inserted in timestamp order")
  assert(merged[2].worker_id === "worker-b", "older worker should sort later")
}

async function testCoordinatorWorkerAuthoritativeMergeRemovesMissingWorkers(): Promise<void> {
  const existing = [
    worker({ worker_id: "worker-a", status: "running" }),
    worker({ worker_id: "worker-b", status: "completed" })
  ]

  const updated = mergeCoordinatorWorkers(
    existing,
    [worker({ worker_id: "worker-b", status: "completed", summary: "kept" })],
    { authoritative: true }
  )

  assert(updated.length === 1, "authoritative worker updates should replace stale worker state")
  assert(updated[0].worker_id === "worker-b", "authoritative update should keep incoming worker")
  assert(updated[0].summary === "kept", "authoritative update should preserve incoming fields")

  const cleared = mergeCoordinatorWorkers(existing, [], { authoritative: true })
  assert(cleared.length === 0, "authoritative empty worker update should clear renderer workers")
}

async function testCoordinatorWorkerMergeCapsTerminalHistory(): Promise<void> {
  const incoming = Array.from({ length: MAX_COORDINATOR_WORKERS_IN_THREAD_STATE + 8 }, (_, index) =>
    worker({
      worker_id: `terminal-${index}`,
      status: "completed",
      updated_at: `2026-04-28T10:${String(index).padStart(2, "0")}:00.000Z`
    })
  )
  incoming.push(
    worker({
      worker_id: "running-a",
      status: "running",
      updated_at: "2026-04-28T11:00:00.000Z"
    })
  )

  const merged = mergeCoordinatorWorkers([], incoming)

  assert(
    merged.some((item) => item.worker_id === "running-a"),
    "worker merge should always preserve running coordinator workers"
  )
  assert(
    merged.length === MAX_COORDINATOR_WORKERS_IN_THREAD_STATE,
    "worker merge should cap terminal coordinator history kept in renderer state"
  )
  assert(
    !merged.some((item) => item.worker_id === "terminal-0"),
    "worker merge should drop the oldest terminal workers first"
  )
}

async function testCoordinatorWorkerMergeCapsRunningOverflow(): Promise<void> {
  const incoming = Array.from({ length: MAX_COORDINATOR_WORKERS_IN_THREAD_STATE + 5 }, (_, index) =>
    worker({
      worker_id: `running-${index}`,
      status: "running",
      updated_at: `2026-04-28T10:${String(index).padStart(2, "0")}:00.000Z`
    })
  )

  const merged = mergeCoordinatorWorkers([], incoming)

  assert(
    merged.length === MAX_COORDINATOR_WORKERS_IN_THREAD_STATE,
    "worker merge should cap running worker overflow in renderer state"
  )
  assert(
    !merged.some((item) => item.worker_id === "running-0"),
    "worker merge should drop the oldest running overflow first"
  )
}

async function testCoordinatorWorkerEqualityIgnoresRunningDuration(): Promise<void> {
  const left = [
    worker({
      worker_id: "worker-running",
      status: "running",
      duration_ms: 1000,
      updated_at: "2026-04-28T10:00:00.000Z"
    })
  ]
  const right = [
    worker({
      worker_id: "worker-running",
      status: "running",
      duration_ms: 2000,
      updated_at: "2026-04-28T10:00:00.000Z"
    })
  ]

  assert(
    coordinatorWorkersEqual(left, right),
    "running worker equality should ignore volatile duration_ms"
  )
  assert(
    !coordinatorWorkersEqual(left, [
      worker({
        worker_id: "worker-running",
        status: "running",
        duration_ms: 2000,
        updated_at: "2026-04-28T10:00:01.000Z"
      })
    ]),
    "running worker equality should still detect real state changes"
  )
}

async function testCoordinatorWorkerEqualityIgnoresOnlyVolatileRunningDuration(): Promise<void> {
  const left = [
    worker({
      worker_id: "worker-running",
      status: "running",
      duration_ms: 1000,
      tool_call_count: 3,
      updated_at: "2026-04-28T10:00:00.000Z"
    }),
    worker({
      worker_id: "worker-done",
      status: "completed",
      duration_ms: 8000,
      summary: "done",
      updated_at: "2026-04-28T10:01:00.000Z"
    })
  ]
  const right = [
    worker({
      worker_id: "worker-running",
      status: "running",
      duration_ms: 30_000,
      tool_call_count: 3,
      updated_at: "2026-04-28T10:00:00.000Z"
    }),
    worker({
      worker_id: "worker-done",
      status: "completed",
      duration_ms: 8000,
      summary: "done",
      updated_at: "2026-04-28T10:01:00.000Z"
    })
  ]

  assert(
    coordinatorWorkersEqual(left, right),
    "mixed worker equality should ignore only volatile running duration changes"
  )

  assert(
    !coordinatorWorkersEqual(left, [
      right[0],
      worker({
        worker_id: "worker-done",
        status: "completed",
        duration_ms: 9000,
        summary: "done",
        updated_at: "2026-04-28T10:01:00.000Z"
      })
    ]),
    "mixed worker equality should still detect terminal duration changes"
  )

  assert(
    !coordinatorWorkersEqual(left, [
      worker({
        worker_id: "worker-running",
        status: "running",
        duration_ms: 30_000,
        tool_call_count: 4,
        updated_at: "2026-04-28T10:00:00.000Z"
      }),
      right[1]
    ]),
    "mixed worker equality should still detect running worker progress changes"
  )
}

async function testCoordinatorWorkerEqualityKeepsTerminalDuration(): Promise<void> {
  const left = [
    worker({
      worker_id: "worker-done",
      status: "completed",
      duration_ms: 1000
    })
  ]
  const right = [
    worker({
      worker_id: "worker-done",
      status: "completed",
      duration_ms: 2000
    })
  ]

  assert(
    !coordinatorWorkersEqual(left, right),
    "terminal worker equality should keep duration_ms because it is no longer volatile"
  )
}

async function testSafeTimestamp(): Promise<void> {
  assert(safeTimestamp(undefined) === 0, "undefined timestamp should be safe")
  assert(safeTimestamp("not-a-date") === 0, "invalid timestamp should be safe")
  assert(
    safeTimestamp("2026-04-28T10:00:00.000Z") > 0,
    "valid timestamp should produce a sortable value"
  )
}

async function run(): Promise<void> {
  await testSubagentLogUpsertPreservesUsefulFields()
  console.log("PASS thread state helper log upsert")
  await testSubagentLogCapKeepsNewestEntries()
  console.log("PASS thread state helper log cap")
  await testSubagentLogCapRetainsThinkingUnderToolBurst()
  console.log("PASS thread state helper retains thinking under tool burst")
  await testSubagentToolActivityPredicate()
  console.log("PASS thread state helper subagent tool activity predicate")
  await testCoordinatorWorkerMergeAndSort()
  console.log("PASS thread state helper worker merge")
  await testCoordinatorWorkerAuthoritativeMergeRemovesMissingWorkers()
  console.log("PASS thread state helper authoritative worker merge")
  await testCoordinatorWorkerMergeCapsTerminalHistory()
  console.log("PASS thread state helper worker history cap")
  await testCoordinatorWorkerMergeCapsRunningOverflow()
  console.log("PASS thread state helper running worker cap")
  await testCoordinatorWorkerEqualityIgnoresRunningDuration()
  console.log("PASS thread state helper running worker equality")
  await testCoordinatorWorkerEqualityIgnoresOnlyVolatileRunningDuration()
  console.log("PASS thread state helper mixed worker equality")
  await testCoordinatorWorkerEqualityKeepsTerminalDuration()
  console.log("PASS thread state helper terminal worker equality")
  await testSafeTimestamp()
  console.log("PASS thread state helper safe timestamp")
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
