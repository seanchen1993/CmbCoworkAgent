/**
 * Characterization contract for the existing desktop agent execution path.
 *
 * This suite intentionally tests source shape instead of launching Electron or
 * a model.  The desktop handler is a large stateful orchestration boundary; the
 * assertions below freeze the ownership, preparation, Runtime and cleanup
 * ordering that the unified-bot work must preserve while shared stateless
 * pieces are extracted in later PRs.
 *
 * Run:
 *   npx tsx tests/desktop-agent-invoke-characterization.spec.ts
 */

import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const PROJECT_ROOT = resolve(__dirname, "..")

function read(relativePath: string): string {
  return readFileSync(join(PROJECT_ROOT, relativePath), "utf8").replace(/\r\n/g, "\n")
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertIncludes(source: string, expected: string, label: string): void {
  assert(source.includes(expected), `${label}: missing ${JSON.stringify(expected)}`)
}

function assertNotIncludes(source: string, expected: string, label: string): void {
  assert(!source.includes(expected), `${label}: unexpectedly includes ${JSON.stringify(expected)}`)
}

function assertOccurrences(source: string, needle: string, expected: number, label: string): void {
  const actual = source.split(needle).length - 1
  assert(actual === expected, `${label}: expected ${expected} occurrences, got ${actual}`)
}

function assertSourceOrder(source: string, markers: string[], label: string): void {
  let previous = -1
  for (const marker of markers) {
    const current = source.indexOf(marker)
    assert(current >= 0, `${label}: missing ${JSON.stringify(marker)}`)
    assert(current > previous, `${label}: ${JSON.stringify(marker)} is out of order`)
    previous = current
  }
}

function sliceBetween(source: string, start: string, end: string, label: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert(startIndex >= 0, `${label}: missing start marker ${JSON.stringify(start)}`)
  assert(endIndex > startIndex, `${label}: missing end marker ${JSON.stringify(end)}`)
  return source.slice(startIndex, endIndex)
}

const agentIpc = read("src/main/ipc/agent.ts")
const runtime = read("src/main/agent/runtime.ts")
const standardTurn = read("src/main/agent/standard-thread-turn.ts")
const sandboxIpc = read("src/main/ipc/sandbox.ts")
const approvalBroker = read("src/main/agent/approval-decision-broker.ts")

const invoke = sliceBetween(
  agentIpc,
  "// Handle agent invocation with streaming",
  "// Handle agent resume (after interrupt approval/rejection via useStream)",
  "agent:invoke handler"
)
const resume = sliceBetween(
  agentIpc,
  "// Handle agent resume (after interrupt approval/rejection via useStream)",
  "// Handle HITL interrupt response",
  "agent:resume handler"
)
const interrupt = sliceBetween(
  agentIpc,
  "// Handle HITL interrupt response",
  "// Handle cancellation",
  "agent:interrupt handler"
)
const cancel = sliceBetween(agentIpc, "// Handle cancellation", "\n}\n", "agent:cancel handler")

function testForegroundHandlerInventory(): void {
  assertIncludes(invoke, '"agent:invoke"', "invoke IPC remains registered")
  assertIncludes(resume, '"agent:resume"', "resume IPC remains registered")
  assertIncludes(interrupt, 'ipcMain.on("agent:interrupt"', "interrupt IPC remains registered")
  assertIncludes(cancel, '"agent:cancel"', "cancel IPC remains registered")
  assertOccurrences(invoke, "invokeRuntimeFactory.create(", 3, "invoke Runtime creation paths")
  assertOccurrences(resume, "resumeRuntimeFactory.create(", 2, "resume Runtime creation paths")
  assertOccurrences(
    interrupt,
    "interruptRuntimeFactory.create(",
    2,
    "interrupt Runtime creation paths"
  )
  assertNotIncludes(agentIpc, "createAgentRuntime(", "desktop IPC uses the controlled factory")
}

function testInvokeReplacementOwnershipOrder(): void {
  assertSourceOrder(
    invoke,
    [
      "withThreadRunMutationLock(threadId",
      "withActiveRunReplacementLock(threadId",
      "invalidateCurrentRunMessagePreparer(threadId)",
      "clearCurrentRunMessageQueue(threadId)",
      "existingController.abort()",
      "await waitForReplacedRunToSettle(threadId)",
      "const nextAbortController = new AbortController()",
      "activeRuns.set(threadId, nextAbortController)",
      "activeRunSettled.set(threadId, nextActiveRunSettledPromise)"
    ],
    "invoke replacement owner handoff"
  )
  assertIncludes(
    invoke,
    "if (initialController && isTrustedCoordinatorNotificationInvoke)",
    "internal coordinator notification does not replace a foreground run"
  )
}

function testFreshTurnGoalAndTranscriptSemantics(): void {
  const ordinaryGoalPreemption = sliceBetween(
    invoke,
    "        } else {\n          const currentGoal = goalManager.get(threadId)",
    "// Abort any existing stream for this thread before starting a new one",
    "ordinary input goal preemption"
  )
  assertSourceOrder(
    ordinaryGoalPreemption,
    [
      'goalManager.pause(threadId, "user message preempted active goal")',
      "LocalSandbox.cancelBackgroundTasks(threadId)"
    ],
    "ordinary desktop input pauses an active goal before replacing the run"
  )
  assertSourceOrder(
    invoke,
    [
      "const turnState = getOrCreateTurnState(",
      "resetTurnStateForNewInvoke(",
      "flushPendingStreamTranscriptMessages(threadId)",
      "const durableRuntimeTail = await getDurableRuntimeTail(threadId",
      "persistVisibleUserTranscriptMessage(",
      "const runToken = startTurnStateRun(turnState, nextInvokeRunToken)",
      "setCurrentRunMessageQueueOwner(threadId, runToken)"
    ],
    "new invoke turn setup"
  )
}

function testPromptSkillHookAndHarnessPreparation(): void {
  const preparation = sliceBetween(
    standardTurn,
    "export async function prepareStandardUserPrompt({",
    "export interface StandardTurnRoutingInput",
    "desktop prompt preparation"
  )
  assertSourceOrder(
    preparation,
    [
      "activateExplicitSkillFromMessage({",
      "isPreparationCurrent && !isPreparationCurrent()",
      '"UserPromptSubmit"',
      "promptSubmitResult?.blocked || promptSubmitResult?.continue === false",
      "updatedInput?.message",
      "onExplicitSkillActivated?.(explicitSkillActivation.skill)"
    ],
    "explicit Skill and UserPromptSubmit lifecycle"
  )
  assertIncludes(
    preparation,
    "applyPromptRewritePreservingGoalMarker",
    "hook rewrites preserve goal markers"
  )
  assertIncludes(
    preparation,
    "explicitSkillActivation.parsed.block",
    "hook rewrites retain the explicit Skill block"
  )
  const sharedFeatureBinding = sliceBetween(
    standardTurn,
    "export function resolveHarnessFeatureBindingContext(",
    "export function getHarnessAgentContext(",
    "shared Feature binding preparation"
  )
  assertSourceOrder(
    sharedFeatureBinding,
    ["readHarnessFeatureMetadata(metadata)", "resolveHarnessFeatureCurrentStage("],
    "shared Feature Harness preparation"
  )
  assertSourceOrder(
    invoke,
    [
      "resolveHarnessFeatureBindingContext(bindingMetadata)",
      "createStandardTurnTrace({",
      "const harnessAgentContext = getHarnessAgentContext(metadata",
      "await fireSessionStartOnce(",
      "const preparedPrompt = await prepareUserPromptForCurrentRun"
    ],
    "Feature Harness, trace and prompt preparation"
  )
  assertIncludes(
    invoke,
    "if (!isInternalNotificationTurn)",
    "only real user turns enter UserPromptSubmit preparation"
  )
}

function testRoutingRuntimeCheckpointAndAutoCommit(): void {
  assertSourceOrder(
    invoke,
    [
      "const autoCommit = await beginAutoCommitTracking(threadId, workspacePath)",
      "const preparedRouting = await resolveStandardTurnRouting({",
      "const userHumanMessage = isCoordinatorNotificationTurn",
      "id: userMessageId",
      "configurable: { thread_id: threadId }",
      "const orderedChain = preparedRouting.orderedModelIds",
      "const invokeRuntimeFactory = prepareStandardThreadRuntimeFactory({",
      "agent = await invokeRuntimeFactory.create(candidateId)",
      "stream = await agent.stream(input, streamConfig)"
    ],
    "desktop Runtime preparation and checkpoint identity"
  )
  for (const expected of [
    "currentRunMessageQueueOwnerToken: runToken",
    "abortSignal: abortController.signal",
    "enableRequestUserInput: true",
    "agentMode: effectiveAgentMode",
    "traceContext: runtimeTraceContext",
    "hookTurnId: turnState.turnId",
    "hookScope",
    "skillHookKeys",
    "skillUseTracker",
    "harnessContext: harnessAgentContext",
    "onFileMutation: autoCommit.onFileMutation"
  ]) {
    assertIncludes(invoke, expected, `desktop Runtime option ${expected}`)
  }
  assertIncludes(
    invoke,
    "activeStream = await agent.stream(null, streamConfig)",
    "mid-stream failover resumes from the existing checkpoint"
  )
  assertIncludes(
    runtime,
    "const checkpointer = await getCheckpointer(threadId)",
    "Runtime checkpointer is keyed by its threadId"
  )
}

function testResumeAndInterruptContinueTheSameLogicalTurn(): void {
  for (const [label, handler, runLabel] of [
    ["resume", resume, "nextResumeRunToken"],
    ["interrupt", interrupt, "nextInterruptRunToken"]
  ] as const) {
    assertSourceOrder(
      handler,
      [
        `const ${runLabel} = uuid()`,
        "invalidateCurrentRunMessagePreparer(threadId)",
        `setCurrentRunMessageQueueOwner(threadId, ${runLabel})`,
        "existingController.abort()",
        "await waitForReplacedRunToSettle(threadId)",
        "activeRuns.set(threadId, nextAbortController)",
        "const turnState = getOrCreateTurnState(threadId)",
        `const runToken = startTurnStateRun(turnState, ${runLabel})`,
        "pruneTurnStateAtInterrupt(turnState",
        `ensureTurnId(turnState, threadId, "${label}")`,
        "reuseSnapshot: turnState.autoCommitSnapshot !== undefined"
      ],
      `${label} ownership and TurnState continuity`
    )
    assertNotIncludes(handler, "resetTurnStateForNewInvoke(", `${label} does not start a new turn`)
    assertIncludes(handler, "enableRequestUserInput: true", `${label} retains structured input`)
    assertIncludes(
      handler,
      "harnessContext: harnessAgentContext",
      `${label} retains Harness context`
    )
  }
  assertIncludes(
    resume,
    "new Command({ resume: resumeValue })",
    "resume continues the HITL checkpoint with the renderer decision"
  )
  assertIncludes(
    interrupt,
    'if (decision.type === "approve")',
    "interrupt retains its legacy approve branch"
  )
  assertIncludes(
    interrupt,
    "intStream = await intAgent.stream(null, interruptStreamConfig)",
    "legacy interrupt approval resumes from the existing checkpoint"
  )
  assertIncludes(
    interrupt,
    '} else if (decision.type === "reject")',
    "interrupt retains its legacy reject branch"
  )
}

function testIdentityFencedCleanupAndCancellation(): void {
  for (const [label, handler, settledPromise, resolver] of [
    ["invoke", invoke, "activeRunSettledPromise", "resolveActiveRunSettled()"],
    ["resume", resume, "resumeRunSettledPromise", "resolveResumeRunSettled()"],
    ["interrupt", interrupt, "interruptRunSettledPromise", "resolveInterruptRunSettled()"]
  ] as const) {
    assertSourceOrder(
      handler,
      [
        "const currentController = activeRuns.get(threadId)",
        "if (currentController === abortController)",
        "activeRuns.delete(threadId)",
        `if (activeRunSettled.get(threadId) === ${settledPromise})`,
        "activeRunSettled.delete(threadId)",
        resolver
      ],
      `${label} identity-fenced cleanup`
    )
    assertIncludes(
      handler,
      "clearCurrentRunMessageQueue(threadId, runToken)",
      `${label} clears only its own queue owner token`
    )
  }
  assertSourceOrder(
    cancel,
    [
      "return withThreadRunMutationLock(threadId",
      "const controller = activeRuns.get(threadId)",
      "LocalSandbox.cancelBackgroundTasks(threadId)",
      "controller.abort()",
      "flushPendingStreamTranscriptMessages(threadId)"
    ],
    "desktop cancellation"
  )
  assertNotIncludes(cancel, "activeRuns.delete(threadId)", "cancel leaves cleanup to run finally")
}

function testApprovalAndStructuredInputRemainDesktopManaged(): void {
  assertIncludes(
    runtime,
    "const APPROVAL_TIMEOUT_MS: number | null = null",
    "desktop approval waits"
  )
  assertIncludes(runtime, "pendingApprovals.set(req.id", "Runtime registers approval ownership")
  assertIncludes(
    runtime,
    'options.abortSignal?.addEventListener("abort", onAbort',
    "stopping the run rejects its pending approval"
  )
  assertIncludes(
    sandboxIpc,
    'ipcMain.on("sandbox:approvalDecision"',
    "renderer approval decisions remain on sandbox IPC"
  )
  assertIncludes(
    sandboxIpc,
    "approvalDecisionBroker.decide({",
    "renderer approval decisions use the shared broker"
  )
  assertIncludes(
    sandboxIpc,
    'source: { kind: "desktop", webContentsId: event.sender.id }',
    "renderer approval retains its desktop source identity"
  )
  assertIncludes(
    approvalBroker,
    "decision.tool_call_id !== expectedToolCallId",
    "shared approval decisions remain bound to the requested tool call"
  )
  assertIncludes(
    approvalBroker,
    '"approve_permanent"',
    "the desktop broker retains permanent approval decisions"
  )
  assertOccurrences(
    invoke,
    "enableRequestUserInput: true",
    1,
    "the invoke Runtime factory retains request_user_input for every model variant"
  )
}

function testAdvancedDesktopModesStayInsideTheExistingHandler(): void {
  for (const expected of [
    "parseGoalSlashCommand(message)",
    "const metadataAgentMode = parsedThreadMetadata.agentMode",
    'effectiveAgentMode === "coordinator"',
    'metadataAgentMode === "workflow"',
    "coordinatorWorkerManager.restoreWorkersForThread({",
    "workflowRunManager.findPendingNotification(",
    "runCompletionHooksWithRevision({"
  ]) {
    assertIncludes(invoke, expected, `advanced desktop behavior ${expected}`)
  }
}

const tests = [
  testForegroundHandlerInventory,
  testInvokeReplacementOwnershipOrder,
  testFreshTurnGoalAndTranscriptSemantics,
  testPromptSkillHookAndHarnessPreparation,
  testRoutingRuntimeCheckpointAndAutoCommit,
  testResumeAndInterruptContinueTheSameLogicalTurn,
  testIdentityFencedCleanupAndCancellation,
  testApprovalAndStructuredInputRemainDesktopManaged,
  testAdvancedDesktopModesStayInsideTheExistingHandler
]

for (const test of tests) {
  test()
  console.log(`PASS ${test.name}`)
}

console.log(`desktop-agent-invoke-characterization.spec.ts: ${tests.length} passed`)
