/**
 * Regression tests for subagent tool-call count observability wiring.
 *
 * Run:
 *   npx tsx tests/subagent-tool-call-count-observability.spec.ts
 */

import { readFileSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { tool } from "@langchain/core/tools"
import { Command } from "@langchain/langgraph"
import { z } from "zod"
import {
  ACTION_STATIONARITY_OWNER_CONFIG_KEY,
  SUBAGENT_OWNER_METADATA_KEY,
  SUBAGENT_SUMMARIZATION_OWNER_CONFIG_KEY,
  wrapTaskToolWithOwnerMetadata
} from "../src/main/agent/runtime.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assertIncludes(source: string, expected: string, message: string): void {
  assert(source.includes(expected), `${message}: expected to find ${expected}`)
}

function assertNotIncludes(source: string, unexpected: string, message: string): void {
  assert(!source.includes(unexpected), `${message}: did not expect to find ${unexpected}`)
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const readSource = (relativePath: string): string =>
  readFileSync(join(__dirname, relativePath), "utf8").replace(/\r\n/g, "\n")
const runtimeSource = readSource("../src/main/agent/runtime.ts")
const workflowSubagentSource = readSource("../src/main/agent/workflow/subagent.ts")
const traceCollectorSource = readSource("../src/main/agent/trace/collector.ts")
const soloTaskTraceSource = readSource("../src/main/agent/trace/solo-task.ts")
const agentIpcSource = readSource("../src/main/ipc/agent.ts")
const chatContainerSource = readSource(
  "../src/renderer/src/components/chat/ChatContainer.tsx"
)
const adoptionTrackerSource = readSource("../src/main/services/adoption-tracker.ts")

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
    "return extractWorkflowNormalizedToolCalls(snapshot).length",
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
  assertIncludes(
    workflowSubagentSource,
    "export function extractWorkflowTraceToolDetails",
    "workflow subagent should recover detailed tool calls from its final snapshot"
  )
  assertIncludes(
    workflowSubagentSource,
    "tracer.addToolNode({",
    "workflow subagent should persist tool names and inputs as trace nodes"
  )
  assertIncludes(
    workflowSubagentSource,
    "tracer.addToolResultNode({",
    "workflow subagent should persist matched tool results as trace nodes"
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
  assertIncludes(
    workflowSubagentSource,
    "new WorkerValuesSnapshotAccumulator(request.prompt",
    "workflow subagent should keep one values accumulator per attempt"
  )
  assertIncludes(
    workflowSubagentSource,
    'valuesSnapshotAccumulator.createContext("values", snapshot)',
    "workflow subagent should reuse its values accumulator across cumulative snapshots"
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
    "recordWorkflowTraceToolDetails(tracerToFinish, traceSnapshot)",
    "workflow tool-detail extraction should run as background trace preparation"
  )
  assertIncludes(
    traceCollectorSource,
    "runTraceSideEffect(`${scope} pre-finish`, beforeFinish)",
    "background trace preparation should be isolated from trace completion"
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

function testSoloTaskTracePartitioning(): void {
  assertIncludes(
    runtimeSource,
    "configurable: {",
    "Solo task owner id should propagate into subagent middleware runtime config"
  )
  assertIncludes(
    runtimeSource,
    'soloTaskTraceManager?.finishTask(ownerId, "success", sanitizedResult)',
    "Solo task trace should finish alongside the owning task invocation"
  )
  assertIncludes(
    soloTaskTraceSource,
    'traceKind: "subagent"',
    "Solo task should create a linked subagent trace"
  )
  assertIncludes(
    soloTaskTraceSource,
    "finishTraceInBackground",
    "Solo task trace persistence should remain non-blocking"
  )
  assertIncludes(
    agentIpcSource,
    "!isCapturedSoloTaskMessage",
    "root trace steps should exclude child events only after child capture is active"
  )
  assertIncludes(
    agentIpcSource,
    "_soloTaskToolCallIds.has(toolCallId)",
    "root trace tool results should exclude task-subagent interior calls"
  )

  const runtimeAccountingIndex = agentIpcSource.indexOf("const usageForRunAccounting")
  const childTracePartitionIndex = agentIpcSource.indexOf(
    "if (isAI && isSoloTaskAiMessage)",
    runtimeAccountingIndex
  )
  assert(
    runtimeAccountingIndex >= 0 && childTracePartitionIndex > runtimeAccountingIndex,
    "runtime token accounting should happen before child/root trace partitioning"
  )

  const finalMessagesStart = agentIpcSource.indexOf("const finalMsgs =")
  const finalMessagesEnd = agentIpcSource.indexOf("const last =", finalMessagesStart)
  assert(
    finalMessagesStart >= 0 && finalMessagesEnd > finalMessagesStart,
    "final response selector should be present"
  )
  assertNotIncludes(
    agentIpcSource.slice(finalMessagesStart, finalMessagesEnd),
    "_soloTaskAiMessageIds",
    "trace partitioning must not alter the runtime final-response selector"
  )
}

function testIdlessTaskStationarityOwnerWiring(): void {
  assertIncludes(
    runtimeSource,
    "normalizeId(config?.toolCall?.id) ?? normalizeId(config?.toolCallId)",
    "task invocation should fall back when the primary tool-call id is blank"
  )
  assertIncludes(
    runtimeSource,
    "stationarity: `idless-task-${idlessTaskInvocationSequence}`",
    "an id-less task invocation should receive a unique stationarity owner"
  )
  assertIncludes(
    runtimeSource,
    "[ACTION_STATIONARITY_OWNER_CONFIG_KEY]: invocationOwner.stationarity",
    "the invocation-specific owner should reach subagent stationarity runtime config"
  )
  assertIncludes(
    runtimeSource,
    "[SUBAGENT_SUMMARIZATION_OWNER_CONFIG_KEY]: invocationOwner.stationarity",
    "the invocation-specific owner should isolate subagent summarization state"
  )
}

function testSubagentStationarityHaltBypassesToolRecovery(): void {
  assertIncludes(
    runtimeSource,
    "if (getActionStationarityHaltError(error)) return null",
    "a task-subagent stationarity halt must bypass recoverable tool-error conversion"
  )
  const toolErrorMiddlewareStart = runtimeSource.indexOf('name: "toolErrorCatch"')
  const earlyStationarityRethrow = runtimeSource.indexOf(
    "if (getActionStationarityHaltError(error)) throw error",
    toolErrorMiddlewareStart
  )
  const failureSignalIndex = runtimeSource.indexOf(
    "if (onToolFailureSignal && toolCallId",
    toolErrorMiddlewareStart
  )
  assert(
    toolErrorMiddlewareStart >= 0 &&
      earlyStationarityRethrow > toolErrorMiddlewareStart &&
      failureSignalIndex > earlyStationarityRethrow,
    "a task-subagent stationarity halt must propagate before failure-fuse accounting"
  )
}

async function testTaskWrapperPreservesStationarityOwnerConfig(): Promise<void> {
  const capturedConfigs: Array<Record<string, unknown>> = []
  const rawTask = tool(
    async (_input, config) => {
      capturedConfigs.push(config as unknown as Record<string, unknown>)
      return "ok"
    },
    {
      name: "task",
      description: "fake task",
      schema: z.object({ description: z.string() })
    }
  )
  const wrappedTask = wrapTaskToolWithOwnerMetadata(rawTask)

  await wrappedTask.invoke({ description: "first" })
  await wrappedTask.invoke({ description: "second" })

  const firstConfigurable = capturedConfigs[0]?.configurable as Record<string, unknown> | undefined
  const secondConfigurable = capturedConfigs[1]?.configurable as Record<string, unknown> | undefined
  const firstOwner = firstConfigurable?.[ACTION_STATIONARITY_OWNER_CONFIG_KEY]
  const secondOwner = secondConfigurable?.[ACTION_STATIONARITY_OWNER_CONFIG_KEY]
  assert(
    typeof firstOwner === "string" && firstOwner.startsWith("idless-task-"),
    "an id-less wrapped task should receive an internal stationarity owner"
  )
  assert(
    typeof secondOwner === "string" && secondOwner !== firstOwner,
    "separate id-less wrapped task invocations should receive different owners"
  )
  assert(
    !(
      SUBAGENT_OWNER_METADATA_KEY in
      ((capturedConfigs[0]?.metadata as Record<string, unknown> | undefined) ?? {})
    ),
    "an internal id-less owner must not be exposed as renderer metadata"
  )

  await wrappedTask.invoke({
    name: "task",
    args: { description: "explicit" },
    id: "task-real-id",
    type: "tool_call"
  })
  const explicitConfig = capturedConfigs[2]
  const explicitConfigurable = explicitConfig?.configurable as Record<string, unknown> | undefined
  const explicitMetadata = explicitConfig?.metadata as Record<string, unknown> | undefined
  assert(
    explicitConfigurable?.[ACTION_STATIONARITY_OWNER_CONFIG_KEY] === "task-real-id",
    "a real task id should remain the stationarity owner"
  )
  assert(
    explicitMetadata?.[SUBAGENT_OWNER_METADATA_KEY] === "task-real-id",
    "a real task id should remain available for renderer attribution"
  )
  assert(
    explicitConfigurable?.[SUBAGENT_SUMMARIZATION_OWNER_CONFIG_KEY] === "task-real-id",
    "a real task id should scope its own summarization lifecycle"
  )
}

async function testTaskWrapperDoesNotReturnSubagentSummarizationState(): Promise<void> {
  const rawTask = tool(
    async () =>
      new Command({
        update: {
          _summarizationEvent: { cutoffIndex: 4 },
          _summarizationSessionId: "child-session",
          _cmbSummarizationOwner: "task-real-id",
          stableResult: "keep this"
        }
      }),
    {
      name: "task",
      description: "fake task",
      schema: z.object({ description: z.string() })
    }
  )
  const wrappedTask = wrapTaskToolWithOwnerMetadata(rawTask)
  const result = await wrappedTask.invoke({
    name: "task",
    args: { description: "explicit" },
    id: "task-real-id",
    type: "tool_call"
  })

  assert(result instanceof Command, "wrapped task should preserve the task Command contract")
  const update = result.update as Record<string, unknown>
  assert(update.stableResult === "keep this", "unrelated child state should remain intact")
  assert(
    !("_summarizationEvent" in update) &&
      !("_summarizationSessionId" in update) &&
      !("_cmbSummarizationOwner" in update),
    "a child summarization lifecycle must not overwrite parent summarization state"
  )
}

function testGuardNoticesAreNotPresentedAsHooks(): void {
  assertIncludes(
    chatContainerSource,
    'event.startsWith("Tool-call loop")',
    "tool-call stationarity should have a dedicated notice branch"
  )
  assertIncludes(
    chatContainerSource,
    'title: "重复工具调用熔断已停止本轮"',
    "tool-call stationarity should not be labelled as a Hook"
  )
}

function testLoopGuardEmergencySwitchCoversAllRuntimeEntryPoints(): void {
  assertIncludes(
    runtimeSource,
    "const loopGuardsEnabled = areAgentLoopGuardsEnabled()",
    "main and task-subagent middleware should share the emergency switch"
  )
  assertIncludes(
    runtimeSource,
    "...(loopGuardsEnabled",
    "disabled guards should be omitted instead of running in observe mode"
  )
}

function testDetachedRuntimeLoopGuardLifecycle(): void {
  assertIncludes(
    runtimeSource,
    "actionStationarityTurnId = hookTurnId",
    "ordinary runtimes should preserve the existing foreground logical-turn behavior"
  )
  assertIncludes(
    runtimeSource,
    "actionStationarityTurnId: workerActionStationarityTurnId",
    "background coordinator workers should use an independent loop-guard lifecycle"
  )
  assertIncludes(
    runtimeSource,
    "clearActionStationarityTurn(workerInput.workerThreadId, workerActionStationarityTurnId)",
    "background coordinator workers should clean their own loop-guard state"
  )
  assertIncludes(
    runtimeSource,
    "actionStationarityTurnId: subagentOptions.threadId",
    "workflow leaf agents should use their own attempt lifecycle"
  )
  assertIncludes(
    runtimeSource,
    "clearActionStationarityTurn(workflowThreadId, workflowThreadId)",
    "workflow leaf agents should clean their own loop-guard state"
  )
}

async function run(): Promise<void> {
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
  testSoloTaskTracePartitioning()
  console.log("PASS Solo task child/root trace partitioning")
  testIdlessTaskStationarityOwnerWiring()
  console.log("PASS id-less task stationarity owner wiring")
  testSubagentStationarityHaltBypassesToolRecovery()
  console.log("PASS task-subagent stationarity halt propagation wiring")
  await testTaskWrapperPreservesStationarityOwnerConfig()
  console.log("PASS task wrapper stationarity owner propagation")
  await testTaskWrapperDoesNotReturnSubagentSummarizationState()
  console.log("PASS task wrapper isolates child summarization state")
  testGuardNoticesAreNotPresentedAsHooks()
  console.log("PASS guard notices use dedicated non-Hook presentation")
  testLoopGuardEmergencySwitchCoversAllRuntimeEntryPoints()
  console.log("PASS loop guard emergency switch wiring")
  testDetachedRuntimeLoopGuardLifecycle()
  console.log("PASS detached loop-guard lifecycle wiring")
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
