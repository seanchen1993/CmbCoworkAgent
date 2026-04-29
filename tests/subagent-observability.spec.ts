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
  assertIncludes(threadContext, 'status?: "waiting" | "completed"', "thread state tracks tool status")
  assertIncludes(threadContext, "result?: string", "thread state tracks tool result")
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
    "upsertSubagentLogEntry(prev.subagentInternalLogs, data.entry!)",
    "thread context updates existing tool log entries"
  )
  assertIncludes(threadContext, ".slice(-20)", "thread context caps internal log entries")
  assertIncludes(
    threadContext,
    "Math.max(0, Math.floor(data.count!))",
    "thread context normalizes aggregate count"
  )
}

async function testRightPanelDisplaysAndAutoOpens(): Promise<void> {
  const rightPanel = await readProjectFile("src/renderer/src/components/panels/RightPanel.tsx")

  assertIncludes(rightPanel, "runningSubagentIdsRef", "right panel tracks newly running subagents")
  assertIncludes(rightPanel, "setAgentsOpen(true)", "right panel auto-opens agents section")
  assertIncludes(rightPanel, "subagentToolCallCount", "right panel reads aggregate tool count")
  assertIncludes(
    rightPanel,
    "SubagentCurrentToolCard",
    "right panel renders current tool card"
  )
  assertIncludes(rightPanel, "toolCallCount={subagentToolCallCount}", "right panel merges count into current tool card")
  assertIncludes(rightPanel, "hasRunningSubagent={hasRunningSubagent}", "right panel passes subagent running state")
  assertIncludes(rightPanel, "子代理执行中", "right panel labels running subagent activity")
  assertIncludes(rightPanel, "子代理整理中", "right panel labels post-tool model work")
  assertIncludes(rightPanel, "等待下一步", "right panel shows waiting for next subagent step")
  assertIncludes(rightPanel, "summarizeSubagentToolInput", "right panel summarizes tool input")
  assertIncludes(rightPanel, "summarizeSubagentToolResult", "right panel summarizes tool result")
  assertIncludes(rightPanel, "等待工具返回，若长时间停留说明卡在当前工具", "right panel explains tool waiting state")
  assertIncludes(rightPanel, "工具已返回，等待子代理继续", "right panel explains model waiting state after tool return")
  assertIncludes(rightPanel, "未收到返回", "right panel labels missing late tool result")
  assertIncludes(rightPanel, "子代理已结束，但该工具返回事件未收到", "right panel explains stale missing result")
  assertIncludes(rightPanel, "formatCompactElapsed", "right panel shows elapsed time since last tool activity")
}

async function run(): Promise<void> {
  await testTransportCountsHiddenSubagentTools()
  console.log("PASS subagent transport aggregate tool count")
  await testThreadStateStoresAggregateToolCount()
  console.log("PASS subagent thread state aggregate tool count")
  await testRightPanelDisplaysAndAutoOpens()
  console.log("PASS subagent right panel observability")
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
