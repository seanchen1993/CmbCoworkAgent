/**
 * Regression tests for subagent tool-call count observability wiring.
 *
 * Run:
 *   npx tsx tests/subagent-tool-call-count-observability.spec.ts
 */

import { readFileSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assertIncludes(source: string, expected: string, message: string): void {
  assert(source.includes(expected), `${message}: expected to find ${expected}`)
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const runtimeSource = readFileSync(join(__dirname, "../src/main/agent/runtime.ts"), "utf8")
const workflowSubagentSource = readFileSync(
  join(__dirname, "../src/main/agent/workflow/subagent.ts"),
  "utf8"
)
const traceCollectorSource = readFileSync(join(__dirname, "../src/main/agent/trace/collector.ts"), "utf8")

function testCoordinatorWorkerWritesToolCallCount(): void {
  assertIncludes(
    runtimeSource,
    "let workerToolCallCount = 0",
    "coordinator worker should initialize a per-run tool-call counter"
  )
  assertIncludes(
    runtimeSource,
    "workerToolCallCount += 1",
    "coordinator worker should count each observed tool_call event"
  )
  assertIncludes(
    runtimeSource,
    "toolCallCount: workerToolCallCount",
    "coordinator worker terminal trace node should expose toolCallCount metadata"
  )
  assertIncludes(
    runtimeSource,
    "!workerTraceTerminalRecorded && workerToolCallCount > 0",
    "coordinator worker should preserve tool-call count when a worker fails or is cancelled"
  )
}

function testWorkflowSubagentWritesToolCallCount(): void {
  assertIncludes(
    workflowSubagentSource,
    "const toolCallCount = extractWorkflowToolCallCount(snapshot)",
    "workflow subagent should derive tool-call count from the final snapshot"
  )
  assertIncludes(
    workflowSubagentSource,
    "for (const call of messageNormalizedToolCalls(message))",
    "workflow subagent should count actionable tool calls rather than invalid/raw artifacts"
  )
  assertIncludes(
    workflowSubagentSource,
    "toolCallCount,",
    "workflow subagent terminal trace nodes should expose toolCallCount metadata"
  )
  assertIncludes(
    workflowSubagentSource,
    "latestSnapshot = snapshot",
    "workflow subagent should retain the latest values snapshot for failure accounting"
  )
  assertIncludes(
    workflowSubagentSource,
    "!traceTerminalRecorded && toolCallCount > 0",
    "workflow subagent should preserve tool-call count when it fails or is cancelled"
  )
}

function testTraceCollectorUsesToolCallCountMetadata(): void {
  assertIncludes(
    traceCollectorSource,
    "const metadataToolCallCounts = this.nodes.reduce",
    "trace collector should read explicit metadata tool-call counts"
  )
  assertIncludes(
    traceCollectorSource,
    "metadataToolCalls, metadataToolCallCounts",
    "trace collector totalToolCalls should include explicit metadata counts"
  )
}

function run(): void {
  testCoordinatorWorkerWritesToolCallCount()
  console.log("PASS coordinator worker toolCallCount wiring")
  testWorkflowSubagentWritesToolCallCount()
  console.log("PASS workflow subagent toolCallCount wiring")
  testTraceCollectorUsesToolCallCountMetadata()
  console.log("PASS trace collector toolCallCount metadata aggregation")
}

run()
