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
const traceCollectorSource = readFileSync(
  join(__dirname, "../src/main/agent/trace/collector.ts"),
  "utf8"
)
const adoptionTrackerSource = readFileSync(
  join(__dirname, "../src/main/services/adoption-tracker.ts"),
  "utf8"
)

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

function testSubagentAdoptionAttributionWiring(): void {
  assertIncludes(
    runtimeSource,
    "harnessFeature: traceContext.harnessFeature",
    "coordinator worker should inherit project-mode context from the root trace"
  )
  assertIncludes(
    workflowSubagentSource,
    "harnessFeature: parent.harnessFeature",
    "workflow subagent should inherit project-mode context from the root trace"
  )
  assertIncludes(
    runtimeSource,
    "setAdoptionContext(workerInput.workerThreadId, { usedSkills, skillSource })",
    "coordinator worker should publish observed Skills to adoption context"
  )
  assertIncludes(
    workflowSubagentSource,
    "setAdoptionContext(threadId, { usedSkills, skillSource })",
    "workflow subagent should publish observed Skills to adoption context"
  )
  assertIncludes(
    workflowSubagentSource,
    "observeSkillUsageFromStream(",
    "workflow subagent should observe Skill reads from cumulative values snapshots"
  )
}

function testSubagentTraceSidecarIsolation(): void {
  assertIncludes(
    runtimeSource,
    "workerTracer = createTraceCollectorSafely(",
    "coordinator worker should tolerate trace construction failure"
  )
  assertIncludes(
    workflowSubagentSource,
    "return createTraceCollectorSafely(",
    "workflow subagent should tolerate trace construction failure"
  )
  assertIncludes(
    runtimeSource,
    'runTraceSideEffect("CoordinatorWorker Skill observer"',
    "coordinator Skill observation should not affect worker execution"
  )
  assertIncludes(
    workflowSubagentSource,
    'runTraceSideEffect("Workflow Skill observer"',
    "workflow Skill observation should not affect subagent execution"
  )
  assertIncludes(
    runtimeSource,
    "finishTraceInBackground(",
    "coordinator trace completion should run in the background"
  )
  assertIncludes(
    workflowSubagentSource,
    'finishTraceInBackground(tracerToFinish, traceOutcome, traceError, "Workflow")',
    "workflow trace completion should run in the background"
  )
  assert(
    !runtimeSource.includes("await workerTracer.finish("),
    "coordinator completion must not await child trace persistence"
  )
  assert(
    !workflowSubagentSource.includes("await tracer.finish("),
    "workflow completion must not await child trace persistence"
  )
  assertIncludes(
    traceCollectorSource,
    "clearAdoptionContext(this.threadId, this.traceId)",
    "background trace completion should conditionally clear only its own context"
  )
  assertIncludes(
    traceCollectorSource,
    "clearAdoptionContext(this.threadId)\n      setAdoptionContext(this.threadId",
    "a new trace should replace stale adoption context before publishing its own fields"
  )
  assertIncludes(
    adoptionTrackerSource,
    "threadContexts.get(threadId)?.traceId !== expectedTraceId",
    "a stale child trace must not clear a newer continuation context"
  )
}

function run(): void {
  testCoordinatorWorkerWritesToolCallCount()
  console.log("PASS coordinator worker toolCallCount wiring")
  testWorkflowSubagentWritesToolCallCount()
  console.log("PASS workflow subagent toolCallCount wiring")
  testTraceCollectorUsesToolCallCountMetadata()
  console.log("PASS trace collector toolCallCount metadata aggregation")
  testSubagentAdoptionAttributionWiring()
  console.log("PASS subagent adoption attribution wiring")
  testSubagentTraceSidecarIsolation()
  console.log("PASS subagent trace sidecar isolation")
}

run()
