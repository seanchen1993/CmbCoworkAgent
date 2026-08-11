/**
 * Integration-contract (source-shape) tests for the run-time message queue.
 *
 * These do not launch Electron or a model. They lock the cross-layer wiring that
 * keeps the four agent modes (solo / agent-team / ultra-workflow / goals) correct:
 *   - the injection middleware sits ONLY on the main-agent stack (so workflow
 *     subagents / coordinator workers, which run under their own thread ids, are
 *     never steered into);
 *   - the queue IPC only accepts steering when a FOREGROUND run is active;
 *   - each run-exit path clears the steer queue under the abort-replace guard;
 *   - handleSubmit enqueues only plain (non-/goal) messages while busy, and never
 *     rejects a pending approval when enqueuing;
 *   - the auto-drain is gated on !hasActiveGoalRunning so a draft never slips
 *     between two goal legs.
 *
 * Run:
 *   npx -y tsx tests/message-queue-plumbing.spec.ts
 */

import { readFileSync } from "fs"
import { join, resolve } from "path"

const PROJECT_ROOT = resolve(__dirname, "..")

function read(rel: string): string {
  return readFileSync(join(PROJECT_ROOT, rel), "utf8")
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assertIncludes(value: string, expected: string, label: string): void {
  assert(value.includes(expected), `${label}: expected to include ${JSON.stringify(expected)}`)
}

function assertNotIncludes(value: string, expected: string, label: string): void {
  assert(!value.includes(expected), `${label}: expected NOT to include ${JSON.stringify(expected)}`)
}

function assertMatches(value: string, pattern: RegExp, label: string): void {
  assert(pattern.test(value), `${label}: expected to match ${pattern}`)
}

function assertOccurrences(value: string, needle: string, expected: number, label: string): void {
  const actual = value.split(needle).length - 1
  assert(actual === expected, `${label}: expected ${expected}×"${needle}", got ${actual}`)
}

function assertSourceOrder(value: string, before: string, after: string, label: string): void {
  const b = value.indexOf(before)
  const a = value.indexOf(after)
  assert(b >= 0, `${label}: missing ${JSON.stringify(before)}`)
  assert(a >= 0, `${label}: missing ${JSON.stringify(after)}`)
  assert(b < a, `${label}: expected ${JSON.stringify(before)} before ${JSON.stringify(after)}`)
}

const runtime = read("src/main/agent/runtime.ts")
const queueModule = read("src/main/agent/current-run-message-queue.ts")
const physicalStreamRunSetup = read("src/main/agent/physical-stream-run-setup.ts")
const agentIpc = read("src/main/ipc/agent.ts")
const threadsIpc = read("src/main/ipc/threads.ts")
const preload = read("src/preload/index.ts")
const threadContext = read("src/renderer/src/lib/thread-context.tsx")
const chat = read("src/renderer/src/components/chat/ChatContainer.tsx")
const electronTransport = read("src/renderer/src/lib/electron-transport.ts")
const store = read("src/renderer/src/lib/store.ts")
const queuedMessageContent = read("src/renderer/src/lib/queued-message-content.ts")
const packageJson = read("package.json")

// ── Middleware placement (solo/team/workflow isolation) ─────────────────────────

function testMiddlewareOnlyOnMainStack(): void {
  // Called exactly once — on the main-agent stack. Never added to a subagent stack
  // (task subagents, workflow leaves, coordinator workers), so a foreground steer
  // can't leak into a background subagent's loop.
  assertOccurrences(
    runtime,
    "createCurrentRunMessageQueueMiddleware(currentRunMessageQueueOwnerToken)",
    1,
    "middleware invoked once (main stack only)"
  )
}

function testMiddlewareBeforeSummarizationAndHITL(): void {
  // Slice from the (single) main-stack invocation — summarization also appears in
  // the subagent stack earlier in the file, so a whole-file order check is wrong.
  const idx = runtime.indexOf(
    "createCurrentRunMessageQueueMiddleware(currentRunMessageQueueOwnerToken)"
  )
  assert(idx >= 0, "queue middleware present on the main stack")
  const after = runtime.slice(idx)
  // beforeModel must run before summarization (injected turns participate in
  // context management): the queue middleware immediately precedes it in the array.
  assertMatches(
    after,
    /createCurrentRunMessageQueueMiddleware\(currentRunMessageQueueOwnerToken\),\s*\n\s*createCmbSummarizationMiddleware\(mainSummarizationOptions\)/,
    "queue middleware immediately precedes summarization on the main stack"
  )
  // afterModel must sit before HITL in the array so an approval interrupt preempts
  // injection.
  assertSourceOrder(
    after,
    "createCurrentRunMessageQueueMiddleware(currentRunMessageQueueOwnerToken)",
    "humanInTheLoopMiddleware",
    "queue middleware before HITL on the main stack"
  )
}

function testQueueModuleIsElectronFree(): void {
  // The queue module must not import electron — that's what makes it unit-testable
  // and keeps the BrowserWindow dependency injected from runtime.ts.
  assertNotIncludes(queueModule, 'from "electron"', "queue module has no electron import")
  assertIncludes(runtime, "setCurrentRunInjectionNotifier(", "runtime wires the injection notifier")
}

function testAfterModelSkipsOnToolCalls(): void {
  // The afterModel hook must bail when the model requested tools, and must key off
  // the runtime thread id (not a subagent-inherited id).
  assertIncludes(
    queueModule,
    "lastMessage.tool_calls && lastMessage.tool_calls.length > 0",
    "afterModel skips when tool calls present"
  )
  assertIncludes(queueModule, 'canJumpTo: ["model"]', "afterModel declares canJumpTo model")
  assertOccurrences(
    queueModule,
    "runtime.configurable?.thread_id",
    2,
    "both hooks key off runtime thread id"
  )
}

// ── IPC: only steer a foreground run; clear on every exit ────────────────────────

function testQueueIpcRequiresActiveRun(): void {
  assertIncludes(agentIpc, '"agent:queueCurrentRunMessage"', "queue IPC handler registered")
  assertIncludes(agentIpc, '"agent:deleteCurrentRunQueuedMessage"', "delete IPC handler registered")
  // Background workflow/worker/scheduler runs don't populate activeRuns, so the
  // controller lookup is what prevents steering into them and also fences an
  // async hook preparation against run replacement.
  assertMatches(
    agentIpc,
    /const activeController = activeRuns\.get\(threadId\)[\s\S]{0,500}if \(!activeController \|\| activeController\.signal\.aborted\)[\s\S]{0,500}no_active_run/,
    "queue IPC rejects when no live foreground run"
  )
}

function testGuideRespectsActiveGoal(): void {
  const ipcStart = agentIpc.indexOf('"agent:queueCurrentRunMessage"')
  const ipcBody = agentIpc.slice(ipcStart, ipcStart + 6500)
  assertIncludes(
    ipcBody,
    'goalManager.get(threadId)?.status === "active"',
    "main process authoritatively rejects steering into an active goal"
  )
  assertIncludes(ipcBody, 'reason: "active_goal"', "active-goal rejection has a stable reason")
  assertOccurrences(
    ipcBody,
    'goalManager.get(threadId)?.status === "active"',
    2,
    "main rechecks active-goal state after asynchronous prompt preparation"
  )

  const guideStart = chat.indexOf("const handleGuideQueuedMessage = useCallback")
  const guideBody = chat.slice(guideStart, guideStart + 6000)
  assertSourceOrder(
    guideBody,
    "if (hasActiveGoalRunning)",
    "guidingQueuedMessageIdsRef.current.add(current.id)",
    "renderer rejects active-goal steering before claiming the draft"
  )
  assertIncludes(
    guideBody,
    'result.reason === "active_goal"',
    "renderer also handles authoritative active-goal rejection races"
  )
}

function testGuideUsesCurrentRunPromptPipeline(): void {
  assertIncludes(
    agentIpc,
    "const currentRunMessagePreparers = new Map<string, CurrentRunMessagePreparer>()",
    "active runs expose a thread-scoped prompt preparer"
  )
  assertIncludes(
    agentIpc,
    "async function prepareUserPromptForRun({",
    "normal and steered prompts share one preparation pipeline"
  )
  assertIncludes(
    agentIpc,
    "const prepareUserPromptForCurrentRun = async (",
    "the initial user prompt delegates to the shared pipeline"
  )
  assertIncludes(
    agentIpc,
    "const prepared = await prepareUserPromptForRun({",
    "the current-run preparer delegates steered messages to the shared pipeline"
  )
  assertOccurrences(
    agentIpc,
    "registerCurrentRunMessagePreparer({",
    4,
    "invoke, resume, and interrupt each register the shared preparer"
  )
  assertIncludes(
    agentIpc,
    '"UserPromptSubmit",\n    promptSubmitContext,',
    "shared preparation executes UserPromptSubmit hooks"
  )
  assertIncludes(
    agentIpc,
    "activateExplicitSkillFromMessage({",
    "shared preparation activates explicit skills"
  )
  assertIncludes(
    agentIpc,
    "currentRunMessagePreparers.get(threadId)?.runToken !== preparer.runToken",
    "async hook results cannot cross into a replacement run"
  )
  assertIncludes(
    agentIpc,
    "const promptTurnState: PromptPreparationTurnState = {",
    "async steer preparation snapshots run-scoped hook state"
  )
  assertIncludes(
    agentIpc,
    "isPreparationCurrent && !isPreparationCurrent()",
    "stale async hook results stop before committing skill and prompt side effects"
  )
  assertOccurrences(
    agentIpc,
    "invalidateCurrentRunMessagePreparer(threadId",
    9,
    "replacement, setup release, terminal cleanup, and thread deletion invalidate steer preparation"
  )
  assertIncludes(
    agentIpc,
    "const preparationLockKey = currentRunMessagePreparationKey(threadId, preparer.runToken)",
    "steer preparation serialization is scoped to the exact run token"
  )
  assertIncludes(
    agentIpc,
    "currentRunMessagePreparationLocks.withKey(preparationLockKey, async () => {",
    "a stale run's slow hook cannot hold the replacement run's preparation lock"
  )
  assertNotIncludes(
    agentIpc,
    "currentRunMessagePreparationLocks.withKey(threadId, async () => {",
    "steer preparation is never serialized across different runs on one thread"
  )
  assertIncludes(
    agentIpc,
    "!signal.aborted && currentRunMessagePreparers.get(threadId)?.runToken === runToken",
    "aborted runs invalidate async prompt preparation before side effects commit"
  )
  assertIncludes(
    agentIpc,
    "activeController.signal.aborted ||\n            currentRunMessagePreparers.get(threadId)?.runToken !== preparer.runToken",
    "queue commit rechecks abort state after asynchronous hooks"
  )
  assertIncludes(
    agentIpc,
    "neutralizeWorkflowPlumbingUserText(queuedMessage.content)",
    "steered workflow markers are neutralized as literal user text"
  )
  assertIncludes(
    agentIpc,
    "displayContent: neutralizeWorkflowPlumbingUserText(",
    "steered workflow marker aliases remain visible after persistence and restore"
  )
  assertIncludes(
    agentIpc,
    "[COORDINATOR_VISIBLE_USER_MESSAGE_KEY]: visibleTranscriptUserMessage",
    "normal rewritten prompts preserve the neutralized visible transcript text"
  )
  assertIncludes(
    agentIpc,
    "containsCoordinatorInternalMarker(prepared.content)",
    "steered coordinator markers are neutralized before model injection"
  )
}

function testClearOnEveryRunExit(): void {
  // A brand-new invoke clears old intent. Resume/interrupt are continuations:
  // ownership moves to the new physical run token before aborting the old one,
  // so even a settlement timeout cannot let stale middleware drain the queue.
  assertOccurrences(
    agentIpc,
    "clearCurrentRunMessageQueue(threadId)",
    2,
    "a brand-new invoke and irreversible thread deletion force-clear queue ownership"
  )
  assertOccurrences(
    agentIpc,
    "clearCurrentRunMessageQueue(threadId, runToken)",
    4,
    "terminal and abandoned-setup cleanup only clear the queue token they own"
  )
  const replacementStart = agentIpc.indexOf("const replacement = await withThreadRunMutationLock")
  assert(replacementStart >= 0, "new invoke replacement block exists")
  const replacementBody = agentIpc.slice(replacementStart, replacementStart + 5000)
  assertSourceOrder(
    replacementBody,
    "rejectAgentStartDuringShutdown(window, channel)",
    "flushPendingStreamTranscriptMessagesForThread(threadId, { throwOnError: true })",
    "invoke rechecks shutdown before mutating predecessor state"
  )
  assertSourceOrder(
    agentIpc,
    "const nextInvokeRunToken = uuid()",
    "const replacement = await withThreadRunMutationLock",
    "new invoke reserves its physical token before entering replacement"
  )
  assertSourceOrder(
    replacementBody,
    "flushPendingStreamTranscriptMessagesForThread(threadId, { throwOnError: true })",
    "invalidateCurrentRunMessagePreparer(threadId)",
    "a failed strict flush leaves the predecessor's steer preparer intact"
  )
  assertSourceOrder(
    replacementBody,
    "return { prePublicationFailure: true as const }",
    "invalidateCurrentRunMessagePreparer(threadId)",
    "invoke invalidates steer preparation only after the strict flush succeeds"
  )
  assertSourceOrder(
    replacementBody,
    "flushPendingStreamTranscriptMessagesForThread(threadId, { throwOnError: true })",
    "clearCurrentRunMessageQueue(threadId)",
    "a new invoke durably closes the old transcript before revoking its ownership"
  )
  assertSourceOrder(
    replacementBody,
    "clearCurrentRunMessageQueue(threadId)",
    "setCurrentRunMessageQueueOwner(threadId, nextInvokeRunToken)",
    "new invoke installs queue ownership inside the replacement critical section"
  )
  assertSourceOrder(
    replacementBody,
    "setCurrentRunMessageQueueOwner(threadId, nextInvokeRunToken)",
    "existingController.abort()",
    "new invoke transfers ownership before aborting the old controller"
  )
  assertSourceOrder(
    replacementBody,
    "startTurnStateRun(nextTurnState, nextInvokeRunToken)",
    "activeRuns.set(threadId, nextAbortController)",
    "invoke publishes cancel-visible turn token and controller atomically"
  )
  const invokeWaitStart = replacementBody.indexOf("await waitForReplacedRunToSettle(threadId)")
  assert(invokeWaitStart >= 0, "invoke replacement waits for its predecessor")
  const invokePostWait = replacementBody.slice(invokeWaitStart)
  assertSourceOrder(
    invokePostWait,
    "rejectAgentStartDuringShutdown(window, channel)",
    "activeRuns.set(threadId, nextAbortController)",
    "invoke rechecks shutdown after its last publication-preceding await"
  )
  const durableTailStart = agentIpc.indexOf(
    "const durableRuntimeTailSetup = await awaitPhysicalStreamRunSetup({"
  )
  const durableTailBody = agentIpc.slice(durableTailStart, durableTailStart + 2400)
  assertSourceOrder(
    durableTailBody,
    "const tail = await getDurableRuntimeTail(threadId",
    'if (durableRuntimeTailSetup.status === "abandoned") return',
    "new invoke handles durable-tail cancellation and exceptions before continuing"
  )
  assertSourceOrder(
    durableTailBody,
    'if (durableRuntimeTailSetup.status === "abandoned") return',
    "persistVisibleUserTranscriptMessage(",
    "a rejected starter cannot persist into the transcript"
  )
  for (const continuationMarker of ["const resumeReplacement", "const interruptReplacement"]) {
    const continuationStart = agentIpc.indexOf(continuationMarker)
    assert(continuationStart >= 0, `continuation block not found: ${continuationMarker}`)
    const continuationBody = agentIpc.slice(continuationStart, continuationStart + 5000)
    assertSourceOrder(
      continuationBody,
      "rejectAgentStartDuringShutdown(window, channel)",
      "flushPendingStreamTranscriptMessagesForThread(threadId, { throwOnError: true })",
      `${continuationMarker} rechecks shutdown before mutating predecessor state`
    )
    assertSourceOrder(
      continuationBody,
      "flushPendingStreamTranscriptMessagesForThread(threadId, { throwOnError: true })",
      "invalidateCurrentRunMessagePreparer(threadId)",
      `${continuationMarker} preserves predecessor steering when strict flush fails`
    )
    assertSourceOrder(
      continuationBody,
      "return { prePublicationFailure: true as const }",
      "invalidateCurrentRunMessagePreparer(threadId)",
      `${continuationMarker} invalidates steering only on successful handoff`
    )
    assertSourceOrder(
      continuationBody,
      "flushPendingStreamTranscriptMessagesForThread(threadId, { throwOnError: true })",
      "setCurrentRunMessageQueueOwner(threadId",
      `${continuationMarker} durably closes the old transcript before ownership transfer`
    )
    assertSourceOrder(
      continuationBody,
      "startTurnStateRun(nextTurnState",
      "setCurrentRunMessageQueueOwner(threadId",
      `${continuationMarker} reserves the logical-turn successor before ownership transfer`
    )
    assertSourceOrder(
      continuationBody,
      "setCurrentRunMessageQueueOwner(threadId",
      "existingController.abort()",
      `${continuationMarker} transfers ownership before aborting the old controller`
    )
    assertSourceOrder(
      continuationBody,
      "startTurnStateRun(nextTurnState",
      "activeRuns.set(threadId, nextAbortController)",
      `${continuationMarker} publishes cancel-visible turn token with its controller`
    )
    const continuationWaitStart = continuationBody.indexOf(
      "await waitForReplacedRunToSettle(threadId)"
    )
    assert(
      continuationWaitStart >= 0,
      `${continuationMarker} waits for its predecessor before publication`
    )
    const continuationPostWait = continuationBody.slice(continuationWaitStart)
    assertSourceOrder(
      continuationPostWait,
      "rejectAgentStartDuringShutdown(window, channel)",
      "activeRuns.set(threadId, nextAbortController)",
      `${continuationMarker} rechecks shutdown after its last publication-preceding await`
    )
    assertNotIncludes(
      continuationBody,
      "clearCurrentRunMessageQueue(threadId)",
      `${continuationMarker} does not discard same-turn handoffs`
    )
  }
  // Finally cleanup remains guarded so an old run cannot wipe a new run's queue.
  assertMatches(
    agentIpc,
    /revokeGrantedAclsForRun\(threadId\)[\s\S]{0,500}clearCurrentRunMessageQueue\(threadId, runToken\)/,
    "token-scoped clear sits under the same !replacedByNewRun guard as the ACL revoke"
  )
  assertOccurrences(
    agentIpc,
    "const replacedByNewRun = physicalRunHasSuccessor(",
    3,
    "invoke, resume, and interrupt cleanup recognize a reserved logical-turn successor"
  )
  const continuationReleaseCleanups =
    agentIpc.match(
      /if \(!wasOwner\) return\s+revokeSandboxAclsForRun\(threadId\)\s+discardAgentAutoCommitTracking\(threadId\)\s+releaseAbandonedContinuationTurnState\(/g
    )?.length ?? 0
  assert(
    continuationReleaseCleanups === 2,
    "resume and interrupt should roll back reservations and ACLs only while still owner"
  )
  assertOccurrences(
    agentIpc,
    "ownsLease: () => ownsPhysicalStreamRunLease(threadId, runToken, abortController)",
    3,
    "all physical setup guards distinguish cancellation from a true replacement"
  )
  assertOccurrences(
    agentIpc,
    "return { prePublicationFailure: true as const }",
    3,
    "invoke, resume, and interrupt close strict flush failures before setup publication"
  )
  assertOccurrences(
    agentIpc,
    "closePhysicalStreamRunBeforeSetupPublication(window, channel, error)",
    3,
    "every pre-publication strict flush failure reports a terminal renderer outcome"
  )
  assertOccurrences(
    agentIpc,
    "resolveAgentStreamRequestChannel(",
    3,
    "invoke, resume, and interrupt isolate terminal events on request-scoped channels"
  )
  assert(
    !agentIpc.includes("abort: () => {\n      LocalSandbox.cancelBackgroundTasks(threadId)"),
    "a pre-publication flush failure must not abort the predecessor before ownership transfer"
  )
  assertOccurrences(
    agentIpc,
    "streamChannelByRunController.set(nextAbortController, channel)",
    3,
    "every published physical run records its request-scoped terminal channel"
  )
  assertOccurrences(
    agentIpc,
    "clearStreamFailureDiagnostics(channel)",
    4,
    "the error consumer and all three request lifecycles release diagnostic maps"
  )
  const diagnosticCleanupStart = agentIpc.indexOf("function clearStreamFailureDiagnostics(")
  assert(diagnosticCleanupStart >= 0, "stream diagnostic cleanup helper exists")
  const diagnosticCleanupBody = agentIpc.slice(diagnosticCleanupStart, diagnosticCleanupStart + 240)
  assertIncludes(
    diagnosticCleanupBody,
    "lastFetchErrorByChannel.delete(channel)",
    "stream diagnostic cleanup releases fetch errors"
  )
  assertIncludes(
    diagnosticCleanupBody,
    "lastFailoverByChannel.delete(channel)",
    "stream diagnostic cleanup releases failover attempts"
  )
  assertOccurrences(
    agentIpc,
    "return { startRejectedDuringShutdown: true as const }",
    6,
    "all starters reject shutdown both on lock entry and after predecessor settlement"
  )
  assertOccurrences(
    agentIpc,
    'if ("startRejectedDuringShutdown" in',
    3,
    "invoke, resume, and interrupt exit without publishing a shutdown-raced run"
  )
  const foregroundDeleteStart = agentIpc.indexOf(
    "export async function cancelAndWaitForAgentThreadRun("
  )
  assert(foregroundDeleteStart >= 0, "foreground thread deletion helper exists")
  const foregroundDeleteBody = agentIpc.slice(foregroundDeleteStart, foregroundDeleteStart + 900)
  assertSourceOrder(
    foregroundDeleteBody,
    "controller.abort()",
    "return waitForReplacedRunToSettle(threadId)",
    "thread deletion aborts and bounded-waits for its foreground run"
  )
  const deletedRuntimeStart = agentIpc.indexOf(
    "export function disposeDeletedAgentThreadRuntime("
  )
  assert(deletedRuntimeStart >= 0, "deleted-thread runtime cleanup exists")
  const deletedRuntimeBody = agentIpc.slice(deletedRuntimeStart, deletedRuntimeStart + 500)
  assertSourceOrder(
    deletedRuntimeBody,
    "clearCurrentRunMessageQueue(threadId)",
    "discardPendingStreamTranscriptMessagesForThread(threadId)",
    "deleted threads revoke run ownership before dropping transcript buffers"
  )
  assertIncludes(
    deletedRuntimeBody,
    "discardStreamTranscriptToolCallAccumulatorsForThread(threadId)",
    "deleted threads drop tool-call transcript accumulators"
  )
  const discardThreadTranscriptStart = agentIpc.indexOf(
    "function discardPendingStreamTranscriptMessagesForThread("
  )
  assert(discardThreadTranscriptStart >= 0, "thread transcript discard helper exists")
  const discardThreadTranscriptBody = agentIpc.slice(
    discardThreadTranscriptStart,
    discardThreadTranscriptStart + 500
  )
  assertSourceOrder(
    discardThreadTranscriptBody,
    "if (pending.timer) clearTimeout(pending.timer)",
    "pendingStreamTranscriptMessages.delete(key)",
    "thread transcript cleanup cancels timers before deleting buffered messages"
  )
  assertSourceOrder(
    threadsIpc,
    "await cancelAndWaitForAgentThreadRun(threadId, window)",
    "dbDeleteThread(threadId)",
    "thread deletion settles foreground work before removing the database row"
  )
  assertSourceOrder(
    threadsIpc,
    "dbDeleteThread(threadId)",
    "disposeDeletedAgentThreadRuntime(threadId)",
    "thread deletion synchronously blocks late transcript chunks after the point of no return"
  )
  const goalControlStart = agentIpc.indexOf('"agent:goal-control"')
  assert(goalControlStart >= 0, "goal control handler exists")
  const goalControlBody = agentIpc.slice(goalControlStart, goalControlStart + 2200)
  assertSourceOrder(
    goalControlBody,
    "withThreadRunMutationLock(threadId",
    "streamChannelByRunController.get(activeController)",
    "goal termination resolves the active request channel under the replacement lock"
  )
  const leaseOwnerStart = agentIpc.indexOf("function ownsPhysicalStreamRunLease(")
  assert(leaseOwnerStart >= 0, "physical setup lease ownership helper should exist")
  const leaseOwnerBody = agentIpc.slice(leaseOwnerStart, leaseOwnerStart + 600)
  assertNotIncludes(
    leaseOwnerBody,
    "turnStates",
    "thread-state deletion must not prevent the physical owner from reclaiming ACLs"
  )
  assertIncludes(
    agentIpc,
    "revokeSandboxAclsForRun(threadId)\n        discardAgentAutoCommitTracking(threadId)",
    "a failed new-invoke setup reclaims inherited ACL and auto-commit tracking"
  )
  assertOccurrences(
    agentIpc,
    "releaseAbandonedContinuationTurnState(",
    5,
    "setup failures and shutdown races both roll back continuation reservations"
  )
  assertIncludes(
    runtime,
    "createCurrentRunMessageQueueMiddleware(currentRunMessageQueueOwnerToken)",
    "each middleware closure is bound to its physical run token"
  )
  assertOccurrences(
    agentIpc,
    "currentRunMessageQueueOwnerToken: runToken",
    7,
    "invoke, resume, interrupt, and failover runtimes all receive the owner token"
  )
}

function testStreamTranscriptBuffersArePhysicalRunScoped(): void {
  assertIncludes(
    agentIpc,
    "pendingStreamTranscriptKey(threadId, runToken)",
    "stream transcript buffers are keyed by the physical run owner"
  )
  const transcriptFlushStart = agentIpc.indexOf(
    "function flushPendingStreamTranscriptMessages("
  )
  assert(transcriptFlushStart >= 0, "stream transcript flush helper exists")
  const transcriptFlushBody = agentIpc.slice(transcriptFlushStart, transcriptFlushStart + 1800)
  assertSourceOrder(
    transcriptFlushBody,
    "try {",
    "const baselineMessages = getThreadMessages(threadId)",
    "baseline reads run inside the buffer-restoration boundary"
  )
  assertSourceOrder(
    transcriptFlushBody,
    "const messages = coalesceQueuedStreamMessages(baselineMessages, pending.messages)",
    "} catch (error) {",
    "message normalization runs inside the buffer-restoration boundary"
  )
  assertSourceOrder(
    transcriptFlushBody,
    "} catch (error) {",
    "pendingStreamTranscriptMessages.set(pendingKey",
    "any pre-persist flush failure restores the pending transcript buffer"
  )
  assertIncludes(
    agentIpc,
    "persistStreamTranscriptChunk(threadId, runToken, mode, payload",
    "invoke stream chunks carry their physical run token into persistence"
  )
  assertIncludes(
    agentIpc,
    "discardPendingStreamTranscriptMessages(threadId, runToken)",
    "a failed attempt discards only its own physical-run buffer"
  )
  const resetStart = agentIpc.indexOf("function resetFailedStreamAttempt(")
  const resetBody = agentIpc.slice(resetStart, resetStart + 1200)
  assertSourceOrder(
    resetBody,
    "if (options.preservePendingTranscript)",
    "discardPendingStreamTranscriptMessages(threadId, runToken)",
    "abort cleanup leaves a failed graceful flush available for the finally retry"
  )
  assertSourceOrder(
    resetBody,
    "discardPendingStreamTranscriptMessages(threadId, runToken)",
    "if (!isCurrentRunMessageQueueOwner(threadId, runToken)) return",
    "an obsolete run clears only its local tracking before owner validation"
  )
  assertSourceOrder(
    resetBody,
    "if (!isCurrentRunMessageQueueOwner(threadId, runToken)) return",
    "safeSendToWindow(window, channel",
    "an obsolete run cannot reset the replacement renderer stream"
  )
  assertIncludes(
    runtime,
    "flushTranscriptBeforeCurrentRunInjection(threadId, context.runToken)",
    "the strict steering flush targets the current physical run"
  )
  assertIncludes(
    agentIpc,
    "mergeIncrementalMessageContent(existing, incoming)",
    "main transcript coalescing uses block-aware delta merging"
  )
  assertIncludes(
    agentIpc,
    'if (incomingMode === "snapshot") return incoming',
    "known cumulative afterModel observations replace rather than append"
  )
  assertIncludes(
    agentIpc,
    "throwIfPhysicalStreamRunIsInactive(threadId, runToken, signal)",
    "persistence and renderer forwarding share a last-moment physical-run fence"
  )
  assertIncludes(
    agentIpc,
    "if (!isCurrentRunMessageQueueOwner(threadId, runToken)) return null",
    "obsolete runs cannot mutate completed routes or transcript buffers"
  )
  assertIncludes(
    agentIpc,
    "const toolCalls = accumulateStreamToolCallChunks(",
    "main transcript persistence retains split tool-call arguments across debounce flushes"
  )
  assertIncludes(
    agentIpc,
    "streamToolCallContentModeFromMessageMode(streamContentMode)",
    "main persistence does not misclassify provider tool args from the message class"
  )
  assertIncludes(
    agentIpc,
    "streamToolCallChunks.length === 0",
    "a continuation containing only tool-call chunks is retained"
  )
  assertIncludes(
    electronTransport,
    'import { mergeStreamToolCallArgs } from "../../../shared/stream-tool-call-chunks"',
    "live rendering and durable transcript persistence share one args merger"
  )
  assertIncludes(
    electronTransport,
    "return mergeStreamToolCallArgs(accumulated, chunk)",
    "renderer delegates tool-call args semantics to the shared policy"
  )
  const physicalSideEffectGuardCount =
    agentIpc.split(
      "if (!isPhysicalStreamRunActive(threadId, runToken, abortController.signal))"
    ).length - 1
  assert(
    physicalSideEffectGuardCount >= 9,
    `physical callbacks and catches stay run-scoped: got ${physicalSideEffectGuardCount}`
  )
  assertIncludes(
    agentIpc,
    "function guardPhysicalStreamRunCallback<TArgs extends unknown[]>",
    "run-scoped asynchronous callbacks share one side-effect guard"
  )
  assertIncludes(
    agentIpc,
    "if (!isActive()) return",
    "model retry callbacks cannot update a replacement renderer run"
  )
  assertIncludes(
    agentIpc,
    "function releaseAbandonedPhysicalStreamRunSetup(",
    "cancelled post-replacement setup has one idempotent lease release"
  )
  assertIncludes(
    agentIpc,
    "if (activeRunSettled.get(threadId) === settledPromise) activeRunSettled.delete(threadId)",
    "abandoned setup releases only its own settlement lease"
  )
  assertIncludes(
    agentIpc,
    "const awaitResumeSetup = <T>(operation: () => Promise<T>) =>",
    "resume setup success, cancellation, and exceptions share the lease wrapper"
  )
  assertIncludes(
    agentIpc,
    "const awaitInterruptSetup = <T>(operation: () => Promise<T>) =>",
    "interrupt setup success, cancellation, and exceptions share the lease wrapper"
  )
  assertIncludes(
    physicalStreamRunSetup,
    "if (error && wasActive) onActiveError(error.value)",
    "setup exceptions release their lease and report only for the current run"
  )
  assertOccurrences(
    agentIpc,
    "let pendingPhysicalStreamRunSetupGuard: PhysicalStreamRunSetupGuard | undefined",
    3,
    "invoke, resume, and interrupt guard their complete post-publication setup windows"
  )
  assertOccurrences(
    agentIpc,
    "pendingPhysicalStreamRunSetupGuard?.abandon()",
    3,
    "every pre-lifecycle return releases its physical setup lease"
  )
  assertOccurrences(
    agentIpc,
    "physicalStreamRunSetupGuard.handoff()",
    3,
    "each setup lease explicitly hands cleanup to its main lifecycle finally"
  )
  for (const lifecycleMarker of [
    "let resumeErrorModelId: string | undefined",
    "let interruptErrorModelId: string | undefined"
  ]) {
    const lifecycleStart = agentIpc.indexOf(lifecycleMarker)
    const lifecycleBody = agentIpc.slice(lifecycleStart, lifecycleStart + 500)
    assertSourceOrder(
      lifecycleBody,
      "physicalStreamRunSetupGuard.handoff()",
      "try {",
      `${lifecycleMarker} transfers cleanup only when the lifecycle finally is ready`
    )
  }
  assertIncludes(
    agentIpc,
    'if (autoCommitSetup.status === "abandoned") return',
    "resume and interrupt abort setup after failure or replacement"
  )

  for (const notifyMarker of [
    "const notifyFailover = (): void => {",
    "const notifyResumeFailover = (): void => {",
    "const notifyIntFailover = (): void => {"
  ]) {
    const notifyStart = agentIpc.indexOf(notifyMarker)
    const notifyBody = agentIpc.slice(notifyStart, notifyStart + 500)
    assertSourceOrder(
      notifyBody,
      "if (!isPhysicalStreamRunActive(threadId, runToken, abortController.signal)) return",
      "safeSendToWindow(window, channel",
      `${notifyMarker} cannot overwrite replacement routing state`
    )
  }

  const disconnectRetryStart = agentIpc.indexOf("export async function retryStreamAfterDisconnect")
  const disconnectRetryBody = agentIpc.slice(disconnectRetryStart, disconnectRetryStart + 1800)
  assertIncludes(
    disconnectRetryBody,
    "abortSignal.aborted || !isActive()",
    "disconnect retries stop when their physical run loses ownership"
  )
  const resumedDisconnectBody = disconnectRetryBody.slice(
    disconnectRetryBody.indexOf("const stream = await resume()")
  )
  assertSourceOrder(
    resumedDisconnectBody,
    "const stream = await resume()",
    "if (abortSignal.aborted || !isActive()) throw retryError",
    "a stale retry cannot clear the replacement retry indicator"
  )
  assertSourceOrder(
    resumedDisconnectBody,
    "if (abortSignal.aborted || !isActive()) throw retryError",
    "clearStreamDisconnectRetry(window, channel)",
    "retry UI clearing happens only after owner revalidation"
  )

  assertOccurrences(
    agentIpc,
    "const stillOwnsPhysicalRun =",
    3,
    "invoke, resume, and interrupt finally blocks recompute their lease after restore"
  )
  for (const clearFlag of [
    "clearCoordinatorNotificationSelectedSkillsOnExit",
    "clearResumeCoordinatorNotificationSelectedSkillsOnExit",
    "clearInterruptCoordinatorNotificationSelectedSkillsOnExit"
  ]) {
    assertIncludes(
      agentIpc,
      `if (stillOwnsPhysicalRun && ${clearFlag})`,
      `${clearFlag} cannot overwrite replacement metadata`
    )
  }

  for (const callbackMarker of [
    "const sendHookNotice = (notice: string): void => {",
    "const sendStreamError = (error: string): void => {"
  ]) {
    const callbackIndexes: number[] = []
    let callbackIndex = agentIpc.indexOf(callbackMarker)
    while (callbackIndex >= 0) {
      callbackIndexes.push(callbackIndex)
      callbackIndex = agentIpc.indexOf(callbackMarker, callbackIndex + callbackMarker.length)
    }
    assert(
      callbackIndexes.length === 3,
      `invoke, resume, and interrupt each guard ${callbackMarker}: got ${callbackIndexes.length}`
    )
    for (const index of callbackIndexes) {
      const body = agentIpc.slice(index, index + 500)
      assertSourceOrder(
        body,
        "if (!isPhysicalStreamRunActive(threadId, runToken, abortController.signal)) return",
        "safeSendToWindow(window, channel",
        `${callbackMarker} fences the side effect inside the callback`
      )
    }
  }

  const sessionStart = agentIpc.indexOf("await fireSessionStartOnce(")
  const sessionStartBody = agentIpc.slice(sessionStart, sessionStart + 800)
  assertSourceOrder(
    sessionStartBody,
    "await fireSessionStartOnce(",
    "throwIfInvokeAborted()",
    "invoke setup revalidates ownership after SessionStart hooks"
  )
  assertSourceOrder(
    sessionStartBody,
    "throwIfInvokeAborted()",
    "sendActiveHookNotice(window, channel, workspacePath)",
    "stale SessionStart completion cannot emit into a replacement run"
  )
  const promptPreparation = agentIpc.indexOf(
    "const preparedPrompt = await prepareUserPromptForCurrentRun(message, modelInputMessage)"
  )
  const promptPreparationBody = agentIpc.slice(promptPreparation, promptPreparation + 1000)
  assertSourceOrder(
    promptPreparationBody,
    "const preparedPrompt = await prepareUserPromptForCurrentRun(message, modelInputMessage)",
    "throwIfInvokeAborted()",
    "invoke setup revalidates ownership after UserPromptSubmit hooks"
  )
  assertSourceOrder(
    promptPreparationBody,
    "throwIfInvokeAborted()",
    "pauseActiveGoalForRuntimeStop(preparedPrompt.reason)",
    "a stale prompt rejection cannot pause the replacement goal"
  )
  assertIncludes(
    agentIpc,
    "const onHookResult = guardPhysicalStreamRunCallback(",
    "invoke, resume, and interrupt hook-result emitters are run-scoped"
  )
  assertIncludes(
    agentIpc,
    "onSystemMessage: (notice) => {\n              sendHookNotice(notice)",
    "prompt hook system messages use the run-scoped sender"
  )

  const completionHookMarker = "const completionOutcome = await runCompletionHooksWithRevision({"
  const completionHookIndexes: number[] = []
  let completionHookIndex = agentIpc.indexOf(completionHookMarker)
  while (completionHookIndex >= 0) {
    completionHookIndexes.push(completionHookIndex)
    completionHookIndex = agentIpc.indexOf(
      completionHookMarker,
      completionHookIndex + completionHookMarker.length
    )
  }
  assert(
    completionHookIndexes.length === 3,
    `invoke, resume, and interrupt each have one completion hook: got ${completionHookIndexes.length}`
  )
  for (const [index, label] of ["invoke", "resume", "interrupt"].entries()) {
    const body = agentIpc.slice(completionHookIndexes[index], completionHookIndexes[index] + 2600)
    const fence =
      label === "invoke"
        ? "throwIfInvokeAborted()"
        : "throwIfPhysicalStreamRunIsInactive(threadId, runToken, abortController.signal)"
    assertSourceOrder(
      body,
      "})",
      fence,
      `${label} revalidates physical ownership after the asynchronous completion hook`
    )
    assertSourceOrder(
      body,
      fence,
      'if (completionOutcome === "failed")',
      `${label} cannot apply a stale failed or halted outcome to a replacement run`
    )
  }

  const interruptRejectStart = agentIpc.indexOf('} else if (decision.type === "reject") {')
  const interruptRejectBody = agentIpc.slice(interruptRejectStart, interruptRejectStart + 900)
  assertSourceOrder(
    interruptRejectBody,
    "throwIfPhysicalStreamRunIsInactive(threadId, runToken, abortController.signal)",
    "pauseActiveGoalAfterBoundary(",
    "a delayed interrupt rejection cannot pause a replacement run"
  )
  assertSourceOrder(
    interruptRejectBody,
    "throwIfPhysicalStreamRunIsInactive(threadId, runToken, abortController.signal)",
    'safeSendToWindow(window, channel, { type: "done" })',
    "a delayed interrupt rejection cannot terminate a replacement renderer run"
  )

  const forkBoundaryHelperStart = agentIpc.indexOf("async function markLatestForkBoundary(")
  const forkBoundaryHelperBody = agentIpc.slice(forkBoundaryHelperStart, forkBoundaryHelperStart + 2800)
  assertIncludes(
    forkBoundaryHelperBody,
    "activeRuns.get(threadId) === controller",
    "fork boundaries bind to the originating physical controller"
  )
  assertIncludes(
    forkBoundaryHelperBody,
    "isCurrentRunMessageQueueOwner(threadId, runToken)",
    "fork boundaries bind to the originating queue token"
  )
  const postTupleBoundaryBody = forkBoundaryHelperBody.slice(
    forkBoundaryHelperBody.indexOf("const tuple = await checkpointer.getTuple")
  )
  assertSourceOrder(
    postTupleBoundaryBody,
    "const tuple = await checkpointer.getTuple",
    "if (!ownsPhysicalLease()) return",
    "a stale run cannot mark the replacement's latest checkpoint"
  )
  assertSourceOrder(
    postTupleBoundaryBody,
    "if (!ownsPhysicalLease()) return",
    "checkpointer.updateCheckpointMetadata(tuple.config",
    "fork metadata targets only the tuple read under the same lease"
  )
  const forkBoundaryCallMarker = "await markLatestForkBoundary({"
  const forkBoundaryCallIndexes: number[] = []
  let forkBoundaryCallIndex = agentIpc.indexOf(forkBoundaryCallMarker)
  while (forkBoundaryCallIndex >= 0) {
    forkBoundaryCallIndexes.push(forkBoundaryCallIndex)
    forkBoundaryCallIndex = agentIpc.indexOf(
      forkBoundaryCallMarker,
      forkBoundaryCallIndex + forkBoundaryCallMarker.length
    )
  }
  assert(
    forkBoundaryCallIndexes.length === 7,
    `all terminal boundary calls are physical-run scoped: got ${forkBoundaryCallIndexes.length}`
  )
  for (const index of forkBoundaryCallIndexes) {
    const callBody = agentIpc.slice(index, index + 380)
    assertIncludes(callBody, "runToken", "fork boundary call carries its run token")
    assertIncludes(
      callBody,
      "controller: abortController",
      "fork boundary call carries its controller"
    )
  }

  const completionBoundaryMarker = 'source: "agent_run_complete"'
  const completionBoundaryIndexes: number[] = []
  const registeredHandlersStart = agentIpc.indexOf("export function registerAgentHandlers(")
  let completionBoundaryIndex = agentIpc.indexOf(
    completionBoundaryMarker,
    registeredHandlersStart
  )
  while (completionBoundaryIndex >= 0) {
    completionBoundaryIndexes.push(completionBoundaryIndex)
    completionBoundaryIndex = agentIpc.indexOf(
      completionBoundaryMarker,
      completionBoundaryIndex + completionBoundaryMarker.length
    )
  }
  assert(
    completionBoundaryIndexes.length === 3,
    `invoke, resume, and interrupt each have one completed boundary: got ${completionBoundaryIndexes.length}`
  )
  for (const [index, label] of ["invoke", "resume", "interrupt"].entries()) {
    const body = agentIpc.slice(completionBoundaryIndexes[index], completionBoundaryIndexes[index] + 1000)
    const fence =
      label === "invoke"
        ? "throwIfInvokeAborted()"
        : "throwIfPhysicalStreamRunIsInactive(threadId, runToken, abortController.signal)"
    assertSourceOrder(
      body,
      completionBoundaryMarker,
      fence,
      `${label} revalidates physical ownership after terminal awaits`
    )
    assertSourceOrder(
      body,
      fence,
      'safeSendToWindow(window, channel, { type: "done" })',
      `${label} cannot terminate a replacement renderer run`
    )
  }

  const shutdownStart = agentIpc.indexOf("export async function shutdownAllAgentTasks(")
  const shutdownBody = agentIpc.slice(shutdownStart, shutdownStart + 1400)
  assertSourceOrder(
    shutdownBody,
    "flushPendingStreamTranscriptMessagesForThread(run.threadId)",
    "run.controller.abort()",
    "application shutdown persists already-rendered chunks before aborting"
  )

  const windowCloseHandlers = [
    "Window closed, aborting stream for thread:",
    "Window closed, aborting resume stream for thread:",
    "Window closed, aborting interrupt stream for thread:"
  ]
  for (const logMarker of windowCloseHandlers) {
    const handlerStart = agentIpc.indexOf(logMarker)
    assert(handlerStart >= 0, `window-close handler not found: ${logMarker}`)
    const handlerBody = agentIpc.slice(handlerStart, handlerStart + 320)
    assertSourceOrder(
      handlerBody,
      "flushPendingStreamTranscriptMessages(threadId, runToken)",
      "abortController.abort()",
      `${logMarker} persists already-rendered chunks before abort cleanup can discard them`
    )
  }

  const cancelStart = agentIpc.indexOf('"agent:cancel",')
  assert(cancelStart >= 0, "agent cancel handler exists")
  const cancelBody = agentIpc.slice(cancelStart, cancelStart + 4800)
  assertSourceOrder(
    cancelBody,
    "flushPendingStreamTranscriptMessages(threadId, activeRunToken)",
    "controller.abort()",
    "explicit cancel also persists already-rendered chunks before aborting"
  )
}

function testPreparingGuidesParticipateInReconciliation(): void {
  const queueStart = agentIpc.indexOf('"agent:queueCurrentRunMessage"')
  const queueBody = agentIpc.slice(queueStart, queueStart + 7500)
  assertSourceOrder(
    queueBody,
    "trackCurrentRunMessagePreparation(preparationLockKey, messageId, 1)",
    "await currentRunMessagePreparationLocks.withKey(preparationLockKey",
    "guide ids become reconcilable before waiting on their run-scoped preparation lock"
  )
  assertIncludes(
    queueBody,
    "trackCurrentRunMessagePreparation(preparationLockKey, messageId, -1)",
    "guide preparation tracking is released in finally"
  )
  const reconcileStart = agentIpc.indexOf('"agent:reconcileCurrentRunQueuedMessages"')
  const reconcileBody = agentIpc.slice(reconcileStart, reconcileStart + 2200)
  assertIncludes(
    reconcileBody,
    "getCurrentRunPreparingMessageIds(threadId, activePreparer.runToken)",
    "reload reconciliation treats current-run hook preparation as pending"
  )
  assertIncludes(
    reconcileBody,
    "...preparingIds",
    "preparing ids are merged into the pending response"
  )
  const rendererReconcileStart = chat.indexOf(
    "// Reconcile handed-off drafts against main-process state"
  )
  const rendererReconcileBody = chat.slice(rendererReconcileStart, rendererReconcileStart + 4200)
  assertIncludes(
    rendererReconcileBody,
    "if (!cancelled) setQueuePumpTick((tick) => tick + 1)",
    "reload reconciliation retries while main still owns a preparing or pending handoff"
  )
  const reconcileCatchStart = rendererReconcileBody.indexOf('.catch((error) => {')
  assert(reconcileCatchStart >= 0, "renderer reconcile catch branch not found")
  const reconcileCatchBody = rendererReconcileBody.slice(reconcileCatchStart)
  assertIncludes(
    reconcileCatchBody,
    "scheduleRetry()",
    "transient reconciliation failures schedule another authoritative check"
  )
  assertIncludes(
    rendererReconcileBody,
    "if (retryTimer) clearTimeout(retryTimer)",
    "handoff reconciliation cancels obsolete retries on state changes"
  )
}

// ── preload surface ──────────────────────────────────────────────────────────

function testPreloadExposesApi(): void {
  assertIncludes(preload, "queueCurrentRunMessage:", "preload exposes queueCurrentRunMessage")
  assertIncludes(
    preload,
    "deleteCurrentRunQueuedMessage:",
    "preload exposes deleteCurrentRunQueuedMessage"
  )
  assertIncludes(preload, "onQueuedMessagesInjected:", "preload exposes onQueuedMessagesInjected")
  assertIncludes(preload, "agent:queueInjected:", "preload subscribes to the injection channel")
}

// ── renderer state: listener registered + torn down ──────────────────────────────

function testThreadContextWiresInjectionListener(): void {
  assertIncludes(
    threadContext,
    "window.api.agent.onQueuedMessagesInjected",
    "thread-context registers the injection listener"
  )
  assertIncludes(
    threadContext,
    "queueListenerCleanups.current[threadId]?.()",
    "thread-context tears the injection listener down"
  )
  assertIncludes(
    threadContext,
    "getMessageProviderOccurrenceIdentity",
    "durable/live reconciliation compares canonical provider occurrences"
  )
  // Queue drafts persist per-thread so a reload/view-switch doesn't lose them.
  assertIncludes(threadContext, "loadQueuedMessages(threadId)", "queue hydrated on thread init")
}

function testInjectionPayloadHasNoRedundantIdsField(): void {
  // The wire payload used to carry both `messageIds` (a bare id list) AND
  // `messages` (id + content) — always built from the SAME source array by the
  // SAME .map() call in runtime.ts, so messageIds was 100% derivable from
  // messages and the consumer's "id present in messageIds but missing from
  // messages" fallback branch could never actually fire. Single source of truth
  // now: injectedIds is derived from messages directly, and the fallback branch
  // (and the messages?: optional marker that made it look reachable) is gone.
  assertNotIncludes(
    runtime,
    "messageIds: messages.map",
    "runtime's injection notifier payload no longer carries a redundant messageIds field"
  )
  assertNotIncludes(
    threadContext,
    "fallbackMessages",
    "the unreachable content-fallback branch was removed, not just left dead"
  )
  assertIncludes(
    threadContext,
    "const injectedIds = new Set(messages.map((message) => message.id))",
    "injectedIds is derived directly from messages, not a separate wire field"
  )
}

function testRestoreDropsAlreadyCommittedQueuedDrafts(): void {
  assertIncludes(
    threadContext,
    "restoredTranscriptMessages.map((message) => message.id)",
    "history restore collects committed message ids before reconciling drafts"
  )
  assertIncludes(
    threadContext,
    "removeQueuedMessagesById(\n          state.queuedMessages,\n          restoredMessageIds",
    "history restore removes queued drafts that already exist in the checkpoint"
  )
  assertIncludes(
    threadContext,
    "persistQueuedMessages(threadId, nextQueuedMessages)",
    "history restore persists the reconciliation so a later reload stays deduplicated"
  )
}

function testInjectedMessagesUseNormalUserTurnEffects(): void {
  const listenerStart = threadContext.indexOf("window.api.agent.onQueuedMessagesInjected")
  assert(listenerStart >= 0, "queue injection listener not found")
  const listenerBody = threadContext.slice(listenerStart, listenerStart + 2200)
  assertIncludes(
    listenerBody,
    "threadActions.appendMessage({",
    "injected user messages use appendMessage rather than mutating messages directly"
  )
  assertNotIncludes(
    listenerBody,
    "messages: [...state.messages, ...injectedUserMessages]",
    "injection listener does not bypass user-turn side effects with a direct append"
  )
}

// ── handleSubmit: enqueue plain messages, never /goal; don't reject approvals ────

function testEnqueueExcludesGoalInputs(): void {
  // willEnqueueWhileBusy must exclude every /goal input, so goals-mode routing is
  // completely untouched by the queue.
  assertMatches(
    chat,
    /willEnqueueWhileBusy\s*=\s*\n?\s*!isGoalSlashInput\s*&&\s*\(isLoading/,
    "enqueue-while-busy excludes /goal inputs"
  )
}

function testEnqueueBypassesSubmitLock(): void {
  // The submit-in-flight lock is held for the whole active run — exactly when a
  // draft is enqueued. Enqueuing must bypass it (it doesn't call stream.submit),
  // else a mid-run draft can never acquire the lock and is silently dropped.
  assertMatches(
    chat,
    /shouldUseSubmitInFlightLock\(\{ isSideChannelGoalControl \}\)\s*&&\s*\n?\s*!willEnqueueWhileBusy/,
    "enqueue bypasses the submit-in-flight lock"
  )
}

function testEnqueueDoesNotRejectApproval(): void {
  // The pending-approval auto-reject must be guarded by !willEnqueueWhileBusy, so
  // parking a draft mid-approval keeps the run alive instead of rejecting it.
  assertIncludes(
    chat,
    "!willEnqueueWhileBusy && (pendingApproval || approvalQueue.length > 0)",
    "auto-reject guarded by !willEnqueueWhileBusy"
  )
}

function testDrainGatedOnGoalNotActive(): void {
  // The auto-drain effect must bail while a goal is running, so a queued draft
  // never slips into the gap between two goal legs.
  assertIncludes(
    chat,
    "if (hasActiveGoalRunning) return",
    "auto-drain gated on !hasActiveGoalRunning"
  )
}

function testEnqueueBranchParksDraft(): void {
  assertMatches(
    chat,
    /if \(willEnqueueWhileBusy\) \{[\s\S]{0,160}addQueuedMessage\(composedDraft\)/,
    "busy branch parks the composed draft"
  )
}

// ── Regression coverage for the codex-review fixes ──────────────────────────────
// Each of these locks a fix for a bug found by an independent Codex review pass:
// Stop not stopping, premature drain on reload, mode-hydration drift between the
// live and queued send paths, duplicate ghost bubbles on retry, and a pump/live-send
// race window. See the fix commit for the full analysis of each.

function testCancelSuppressesAutoDrain(): void {
  // Stop must actually stop: a queued draft must not immediately fire a new run
  // right behind the run being cancelled. handleCancel's real agent-stop branch
  // (not the scheduled-task/heartbeat/chatx branches) sets the suppression flag;
  // the pump effect must check it before draining.
  //
  // This lives in thread-context (NOT a ChatContainer-local useRef): TabbedPanel
  // unmounts ChatContainer entirely when switching to a file tab
  // (`isAgentTab ? <ChatContainer> : <FileViewer>`), which would silently reset a
  // local ref back to false the moment the user glances at an open file and back,
  // undoing the suppression. A second independent Codex review pass caught this.
  assertIncludes(
    threadContext,
    "queueAutoDrainSuppressed: boolean",
    "queueAutoDrainSuppressed lives in ThreadState, not a ChatContainer-local ref"
  )
  assertIncludes(
    threadContext,
    "setQueueAutoDrainSuppressed: (suppressed: boolean) => void",
    "thread-context exposes a setter action for the suppression flag"
  )
  assertNotIncludes(
    chat,
    "queueAutoDrainSuppressedRef",
    "the suppression flag must not be a ChatContainer-local ref (resets on file-tab unmount)"
  )
  assertIncludes(
    chat,
    "setQueueAutoDrainSuppressed(true)",
    "cancel sets the auto-drain suppression flag"
  )
  assertIncludes(
    chat,
    "if (queueAutoDrainSuppressed) return",
    "pump effect checks the auto-drain suppression flag"
  )
  // Cleared at the two send paths that represent unambiguous renewed intent — an
  // actual enqueue and a validated live send — plus both guide-to-normal-queue
  // fallbacks. A guide click after Stop is also explicit intent to resume the
  // queued work; the pump's ordinary idle/goal/approval gates still apply.
  assertOccurrences(
    chat,
    "setQueueAutoDrainSuppressed(false)",
    4,
    "suppression clears for live enqueue/send and both guide fallback paths"
  )
}

function testGuideFallbackResumesStopPausedQueue(): void {
  const guideStart = chat.indexOf("const handleGuideQueuedMessage = useCallback(")
  assert(guideStart >= 0, "handleGuideQueuedMessage not found")
  const guideBody = chat.slice(guideStart, guideStart + 4000)
  assertOccurrences(
    guideBody,
    "setQueueAutoDrainSuppressed(false)",
    2,
    "guide fallback resumes a Stop-paused queue for both unavailable-run and IPC-failure cases"
  )
  assertSourceOrder(
    guideBody,
    "setQueueAutoDrainSuppressed(false)",
    "promoteQueuedMessage(current.id)",
    "guide fallback resumes draining before promoting the selected draft"
  )
}

function testPumpGatedOnHistoryLoadingReadOnlyContextReminder(): void {
  // queuedMessages hydrates from localStorage before the real DB history loads and
  // before a read-only thread is known to be read-only. Draining at that point
  // submits against a threadMessages that isn't authoritative yet (wrong
  // isFirstMessage → bogus title) or pushes a message into a thread that must
  // never accept one. Mirrors handleSubmit's own early-return guards.
  assertIncludes(
    chat,
    "if (historyLoading || readOnly || contextReminderPending) return",
    "auto-drain gated on historyLoading/readOnly/contextReminderPending"
  )
}

function testQueuedSendHydratesAgentMode(): void {
  // A draft can auto-drain before the live send path ever ran on a coordinator/
  // workflow thread (e.g. the first turn was composed while busy and queued). The
  // queued-send path must resolve agent_mode the same way handleSubmit does —
  // scoped to submitQueuedMessage, not just anywhere in the file, since
  // handleSubmit has its own copy of the same hydration block.
  const submitQueuedMessageStart = chat.indexOf("const submitQueuedMessage = useCallback(")
  assert(submitQueuedMessageStart >= 0, "submitQueuedMessage not found")
  const submitQueuedMessageBody = chat.slice(
    submitQueuedMessageStart,
    submitQueuedMessageStart + 7000
  )
  assertIncludes(
    submitQueuedMessageBody,
    "if (!coordinatorPrefixed && !agentModeHydratedRef.current) {",
    "submitQueuedMessage hydrates agentMode before submitting, like handleSubmit"
  )
  assertIncludes(
    submitQueuedMessageBody,
    "loadResolvedAgentMode()",
    "submitQueuedMessage awaits loadResolvedAgentMode when unhydrated"
  )
}

function testQueuedSendRevalidatesModelAndWorkspace(): void {
  const submitQueuedMessageStart = chat.indexOf("const submitQueuedMessage = useCallback(")
  assert(submitQueuedMessageStart >= 0, "submitQueuedMessage not found")
  const submitQueuedMessageBody = chat.slice(
    submitQueuedMessageStart,
    submitQueuedMessageStart + 8000
  )
  assertIncludes(
    submitQueuedMessageBody,
    "const selectedModel = queuedModel?.available",
    "queued send prefers its saved model only while it remains available"
  )
  assertIncludes(
    submitQueuedMessageBody,
    ": currentSelectedModel?.available",
    "queued send falls back to the thread's current available model"
  )
  assertIncludes(
    submitQueuedMessageBody,
    "updateQueuedMessage(queued.id, { modelId: queuedModelId })",
    "queued send durably rebinds a stale model instead of failing forever"
  )
  assertIncludes(
    submitQueuedMessageBody,
    "if (!workspacePath)",
    "queued send validates workspace availability"
  )
  assertSourceOrder(
    submitQueuedMessageBody,
    "if (!workspacePath)",
    "const isFirstMessage = threadMessages.length === 0",
    "queued validation runs before the draft is removed"
  )
}

function testRetryReusesStableMessageId(): void {
  // If stream.submit throws, the catch re-parks the same draft and the pump
  // retries it. Without a stable bubble id, each retry calls appendMessage with a
  // FRESH uuid and leaves a new orphaned "ghost" user bubble behind every attempt.
  // appendMessage upserts by id (verified in thread-context.spec-adjacent code),
  // so reusing queued.id makes a retry replace the same bubble instead of
  // duplicating it.
  assertIncludes(
    chat,
    "appendVisibleUserMessageWithTime(displayContent, {\n        persistTiming: true,\n        id: queued.id\n      })",
    "queued-send reuses queued.id for the optimistic bubble across retries"
  )
}

function testAtFileWarningsDoNotBlockQueuePump(): void {
  const warningStart = chat.indexOf("if (mentionCountLimitHit) {")
  assert(warningStart >= 0, "@file warning branch not found")
  const warningBody = chat.slice(warningStart, warningStart + 900)
  assertOccurrences(
    warningBody,
    "toast.warning(",
    3,
    "all non-fatal @file delivery warnings use non-blocking toasts"
  )
  assertNotIncludes(
    warningBody,
    "setError(",
    "non-fatal @file delivery warnings never populate the pump-blocking thread error"
  )
}

function testFailedQueuedSendRollsBackOptimisticBubble(): void {
  assertIncludes(
    threadContext,
    "removeLocalMessage: (messageId: string) => void",
    "thread actions expose a local-only optimistic-message rollback"
  )
  assertIncludes(
    threadContext,
    "removeLocalMessage: (messageId: string) => {",
    "thread actions implement optimistic-message rollback"
  )

  const pumpCatchStart = chat.indexOf("submitQueuedMessage(next)\n      .catch(async (err) => {")
  assert(pumpCatchStart >= 0, "queue pump catch branch not found")
  const pumpCatchBody = chat.slice(pumpCatchStart, pumpCatchStart + 2600)
  assertSourceOrder(
    pumpCatchBody,
    "reconcileCurrentRunQueuedMessages(",
    "if (durable === true) return",
    "failed queued sends reconcile durable acceptance before deciding to retry"
  )
  assertIncludes(
    pumpCatchBody,
    "removeLocalMessage(next.id)",
    "failed queued send removes its sent-looking optimistic bubble"
  )
  assertSourceOrder(
    pumpCatchBody,
    "removeLocalMessage(next.id)",
    "prependQueuedMessage({",
    "optimistic bubble is rolled back before the failed draft is re-queued"
  )
  assertIncludes(
    pumpCatchBody,
    "durable === undefined ? { handoffRequestedAt: new Date() } : {}",
    "ambiguous failures wait for authoritative reconciliation instead of retrying"
  )
  assertIncludes(
    pumpCatchBody,
    "savedModelStillAvailable",
    "a failed retry does not restore a stale queued model id"
  )
}

function testWillEnqueueDistinguishesLivePreparationFromPumpInFlight(): void {
  // The shared lock alone cannot identify whether a second Enter is a duplicate
  // gesture racing @file resolution or a genuinely new message racing the pump.
  // The module-level preparation set preserves both behaviors across remounts.
  assertMatches(
    chat,
    /shouldQueueBehindInFlightSubmit\(\{\s*hasInFlightSubmit: submitInFlightRef\.current\.has\(threadId\),\s*isLiveSubmitPreparing: liveSubmitPreparingThreads\.has\(threadId\)\s*\}\)/,
    "queueability distinguishes live preparation from other shared-lock owners"
  )
  assertSourceOrder(
    chat,
    "if (!tryAcquireSubmitInFlightLock(submitInFlightRef, shouldLockSubmit, threadId)) return",
    "if (shouldLockSubmit) liveSubmitPreparingThreads.add(threadId)",
    "a successful live lock acquisition is marked before asynchronous preparation"
  )
  const liveSubmitStart = chat.indexOf(
    "if (shouldLockSubmit) liveSubmitPreparingThreads.add(threadId)"
  )
  assert(liveSubmitStart >= 0, "live submit preparation marker not found")
  const liveSubmitBody = chat.slice(liveSubmitStart, liveSubmitStart + 16000)
  assertSourceOrder(
    liveSubmitBody,
    "if (shouldLockSubmit) liveSubmitPreparingThreads.delete(threadId)",
    "await stream.submit(",
    "the duplicate-submit guard ends when the prepared payload is committed, before the run starts"
  )
}

function testBusyDraftPreparationIsAtomic(): void {
  assertIncludes(
    chat,
    "const queuedDraftPreparingThreads = new Set<string>()",
    "busy draft preparation has a thread-scoped guard"
  )
  const claimStart = chat.indexOf(
    "if (shouldLockQueuedDraftPreparation) queuedDraftPreparingThreads.add(threadId)"
  )
  assert(claimStart >= 0, "busy draft preparation claim not found")
  const claimBody = chat.slice(claimStart, claimStart + 9000)
  assertSourceOrder(
    claimBody,
    "queuedDraftPreparingThreads.add(threadId)",
    "await resolveAtFileAttachments({",
    "busy draft ownership is claimed before asynchronous attachment resolution"
  )
  assertSourceOrder(
    claimBody,
    'setInput("")',
    "await resolveAtFileAttachments({",
    "the claimed composer input is cleared before asynchronous attachment resolution"
  )
  assertIncludes(
    chat,
    "queuedDraftPreparingThreads.delete(threadId)",
    "busy draft preparation guard is always released"
  )
}

function testSteerAcknowledgementIsDurableAndReconciled(): void {
  assertSourceOrder(
    runtime,
    "flushTranscriptBeforeCurrentRunInjection(threadId, context.runToken)",
    "const persistedCount = upsertThreadMessages(",
    "deferred assistant/tool transcript is flushed before the steered user turn"
  )
  assertIncludes(
    runtime,
    "win.isDestroyed() || win.webContents.isDestroyed()",
    "renderer acknowledgement skips destroyed webContents"
  )
  assertIncludes(
    runtime,
    'console.warn("[Runtime] Failed to notify renderer about injected messages:", error)',
    "renderer acknowledgement failure is non-fatal after durable persistence"
  )
  assertIncludes(
    runtime,
    'type: "current_run_user_injected"',
    "main marks the user boundary before a guided follow-up model call"
  )
  assertIncludes(
    runtime,
    "messages: payload.messages",
    "guided user boundaries carry the visible injected turns into the live stream"
  )
  assertIncludes(
    electronTransport,
    'if (data?.type === "current_run_user_injected")',
    "renderer recognizes guided user boundaries"
  )
  assertSourceOrder(
    electronTransport,
    'if (data?.type === "current_run_user_injected")',
    "this.resetCurrentAssistantMessage()",
    "guided user boundaries reset the current assistant accumulator"
  )
  assertIncludes(
    electronTransport,
    'type: "human"',
    "guided turns enter the renderer through the normal human stream message path"
  )
  assertIncludes(
    electronTransport,
    "routePendingIdlessCompletedAssistant(",
    "id-less delayed completion fragments are routed before fallback id allocation"
  )
  assertIncludes(
    threadContext,
    "getMessageProviderTupleFromMetadata(additionalKwargs)",
    "renderer checkpoint hydration restores the persisted provider tuple"
  )
  assertIncludes(
    threadContext,
    "...providerTuple",
    "renderer checkpoint messages retain provider identity for durable-tail comparison"
  )
  assertIncludes(
    agentIpc,
    "flushPendingStreamTranscriptMessages(threadId, runToken, { throwOnError: true })",
    "injection uses a strict transcript flush boundary"
  )
  assertIncludes(
    runtime,
    "assertCurrentRunMessagesDurablyPersisted(transcriptMessages.length, persistedCount)",
    "zero/partial DB writes fail the durable acknowledgement boundary"
  )
  assertSourceOrder(
    runtime,
    "assertCurrentRunMessagesDurablyPersisted(transcriptMessages.length, persistedCount)",
    "await flushStrict()",
    "injected user turns are flushed to disk after row-count validation"
  )
  assertIncludes(
    runtime,
    "content: message.displayContent || message.content",
    "durable transcript stores the user-visible steer instead of hook-prepared model content"
  )
  assertIncludes(
    queueModule,
    "[VISIBLE_USER_MESSAGE_KEY]: visibleContent",
    "checkpoint HumanMessage preserves the visible steer alias for restore and export"
  )
  assertSourceOrder(
    runtime,
    "await flushStrict()",
    "win.webContents.send(`agent:queueInjected:${threadId}`, payload)",
    "main reaches the renderer only after the injected turn is on disk"
  )
  assertSourceOrder(
    runtime,
    "await flushStrict()",
    "if (!isCurrentRunMessageQueueOwner(threadId, context.runToken))",
    "registerCurrentRunCompletedAssistantRoute(",
    "old physical runs are fenced after the async flush and before any renderer or route side effect"
  )
  assertIncludes(
    runtime,
    'ownershipError.name = "AbortError"',
    "an owner change aborts the old graph instead of acknowledging the injection"
  )
  assertIncludes(
    queueModule,
    "anchorMessage?: CurrentRunInjectionAnchor",
    "queue middleware carries the graph predecessor role/provider tuple into durable ordering"
  )
  assertIncludes(
    runtime,
    "resolveCurrentRunInjectionAnchorId(",
    "graph predecessor identity resolves to the normalized durable row before ordering"
  )
  assertIncludes(
    runtime,
    "moveThreadMessagesAfterAnchor(threadId, durableAnchorMessageId, transcriptMessageIds)",
    "durable steering order is anchored to the physical run instead of the latest global user"
  )
  const reconcileStart = agentIpc.indexOf('"agent:reconcileCurrentRunQueuedMessages"')
  const reconcileBody = agentIpc.slice(reconcileStart, reconcileStart + 2600)
  assertSourceOrder(
    reconcileBody,
    "await flushStrict()",
    "const durableIds = getThreadMessagesByIds(threadId, messageIds)",
    "durable reconciliation flushes sql.js before acknowledging message ids"
  )
  assertIncludes(
    preload,
    "reconcileCurrentRunQueuedMessages:",
    "preload exposes guided-draft reconciliation"
  )
  assertIncludes(
    agentIpc,
    '"agent:reconcileCurrentRunQueuedMessages"',
    "main exposes pending/injected/durable queue status"
  )
  assertIncludes(
    chat,
    ".reconcileCurrentRunQueuedMessages(",
    "idle renderer reconciles guided drafts instead of blindly auto-sending them"
  )
  const durableDraftReconcileStart = chat.indexOf("// Reconcile handed-off drafts")
  assert(durableDraftReconcileStart >= 0, "durable draft reconciliation effect not found")
  const durableDraftReconcileBody = chat.slice(durableDraftReconcileStart, durableDraftReconcileStart + 5000)
  assertSourceOrder(
    durableDraftReconcileBody,
    "await syncDurableTranscript(missingDurableIds)",
    "deleteQueuedMessage(queued.id)",
    "a missing durable bubble is merged by DB ordinal before its handed-off draft is removed"
  )
  assertIncludes(
    threadContext,
    "mergeDurableTranscriptSnapshot(persistedMessages, state.messages)",
    "durable transcript order is the baseline during lost-notification recovery"
  )
  assertNotIncludes(
    chat,
    "for (const queued of queuedMessages) {\n      if (queued.handoffRequestedAt) {",
    "idle renderer no longer clears every handoff marker without an acknowledgement"
  )
}

function testAfterModelSteerPersistsPrecedingAssistantReply(): void {
  assertIncludes(
    queueModule,
    "completedAssistantMessageForTranscript(lastMessage)",
    "afterModel forwards its completed assistant reply to the injection notifier"
  )
  assertIncludes(
    queueModule,
    "wrapModelCall: async (request, handler) =>",
    "the queue captures the raw model response before afterModel receives a trimmed state copy"
  )
  const notifierStart = runtime.indexOf("setCurrentRunInjectionNotifier(async")
  const notifierBody = runtime.slice(notifierStart, notifierStart + 8000)
  assertSourceOrder(
    notifierBody,
    "const completedAssistantMessage = context?.completedAssistantMessage",
    "...messages.map((message) => ({",
    "the final assistant reply is persisted before the steered user turn"
  )
  assertIncludes(
    notifierBody,
    "content_priority: 1",
    "the complete assistant reply wins over delayed stream chunks"
  )
  assertSourceOrder(
    notifierBody,
    "flushTranscriptBeforeCurrentRunInjection(threadId, context.runToken)",
    "resolveCurrentRunCompletedAssistantIdentity(",
    "provider occurrence resolution uses the durable baseline after pending chunks flush"
  )
  assertSourceOrder(
    notifierBody,
    "const durableMessagesBeforeCompletedAssistant = getThreadMessages(threadId)",
    "replaceThreadMessageId(",
    "the pre-afterModel durable partial is captured before its raw id is rekeyed"
  )
  assertIncludes(
    notifierBody,
    "{ observedContent: completedAssistantObservedContent }",
    "the delayed completion route resumes after the already-flushed durable prefix"
  )
  assertSourceOrder(
    notifierBody,
    "resolveCurrentRunCompletedAssistantIdentity(",
    "!replaceThreadMessageId(",
    "afterModel resolves the exact occurrence before rekeying"
  )
  assertSourceOrder(
    notifierBody,
    "!replaceThreadMessageId(",
    "const persistedCount = upsertThreadMessages(threadId, transcriptMessages)",
    "the exact provider occurrence is rekeyed before the stable final row is persisted"
  )
  assertIncludes(
    notifierBody,
    "completedAssistantIdentity.sourceId",
    "durable and renderer aliases use the occurrence-scoped source id"
  )
  assertIncludes(
    notifierBody,
    "provider_occurrence: completedAssistantIdentity.providerOccurrence",
    "the stable afterModel row persists its provider occurrence"
  )
  assertNotIncludes(
    notifierBody,
    "completedAssistantMessage.sourceId,\n      completedAssistantMessage.id",
    "afterModel must never rekey a reused bare provider id"
  )
  assertIncludes(
    queueModule,
    "{ splitAssistantAfterTool: true }",
    "completed reply identity resolution treats tool boundaries as occurrence boundaries"
  )
  assertSourceOrder(
    notifierBody,
    "await flushStrict()",
    "registerCurrentRunCompletedAssistantRoute(",
    "the one-shot delayed-event route is registered only after durable persistence"
  )
  assertIncludes(
    notifierBody,
    "context.runToken",
    "the delayed-event route is scoped to the physical run"
  )
  assertIncludes(
    notifierBody,
    "currentRunCompleted: true",
    "the renderer alias is explicitly scoped to the completed current-run slot"
  )
  assertIncludes(
    electronTransport,
    "rendererOnlyAlias: true",
    "an id-less renderer fallback is marked for synchronous local aliasing"
  )
  assertSourceOrder(
    threadContext,
    "if (rendererOnlyAlias) {",
    "aliases.set(resolvedFromId",
    "renderer-only aliases are retained for cumulative SDK replays"
  )
  assertSourceOrder(
    threadContext,
    "aliases.set(resolvedFromId",
    "commitLocalAlias()",
    "renderer-only aliases are applied before the following stable event"
  )
  assertIncludes(
    threadContext,
    "const resolvedFromId = rendererOnlyAlias ? fromId : resolveAliasSourceId(fromId)",
    "renderer fallback aliases bypass duplicate live/accumulator baseline normalization"
  )
  assertSourceOrder(
    threadContext,
    "const aliasedRawMessages = applyLiveStreamMessageIdAliases(",
    "const normalizedRawMessages = normalizeAppendedLiveStreamMessageIds(",
    "SDK cumulative snapshots apply renderer aliases before occurrence normalization"
  )
  assertIncludes(
    notifierBody,
    "completedAssistantId: completedAssistantMessage.id",
    "the user boundary reserves a completed slot even when the provider omitted its id"
  )
  assertIncludes(
    notifierBody,
    "completedAssistantContent: completedAssistantMessage.content",
    "the user boundary carries completed content for id-less fragment routing"
  )
  assertIncludes(
    notifierBody,
    "providerOccurrence: completedAssistantIdentity?.providerOccurrence",
    "the renderer alias carries the exact provider occurrence"
  )
  const streamPersistStart = agentIpc.indexOf("function persistStreamTranscriptChunk(")
  const streamPersistBody = agentIpc.slice(streamPersistStart, streamPersistStart + 1200)
  assertSourceOrder(
    streamPersistBody,
    "routeCurrentRunCompletedAssistantMessage(threadId, message, runToken)",
    "setSerializedMessageIdentity(payload, completedRoute)",
    "the delayed completed event is rewritten before renderer forwarding"
  )
  assertSourceOrder(
    streamPersistBody,
    "setSerializedMessageIdentity(payload, completedRoute)",
    "queueStreamTranscriptMessage(threadId, runToken, { ...message, streamContentMode }, options)",
    "the delayed completed event is rewritten before transcript persistence"
  )
  assertIncludes(
    agentIpc,
    "MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: identity.providerOccurrence",
    "the delayed stable stream payload persists provider occurrence metadata"
  )
  assertIncludes(
    queueModule,
    "MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: completedIdentity.providerOccurrence",
    "LangGraph state persists the completed provider occurrence across reload"
  )
  assertIncludes(
    queueModule,
    "completedAssistantRoutes.delete(threadId)",
    "the delayed-event route is one-shot and cannot swallow a later guided answer"
  )
  assertIncludes(
    queueModule,
    "current-run-assistant:${randomUUID()}",
    "afterModel replies receive an isolated transcript id even when providers reuse ids"
  )
}

function testTransportSupportsEveryAgentMode(): void {
  assertIncludes(
    electronTransport,
    'type TransportAgentMode = "normal" | "coordinator" | "workflow"',
    "transport agent mode includes ultra workflow"
  )
  assertNotIncludes(
    electronTransport,
    'agentMode?: "normal" | "coordinator"',
    "transport helpers do not narrow workflow out of their signatures"
  )
}

function testPreparedLiveSubmitAcceptsTheNextEnter(): void {
  const claimStart = chat.indexOf("// Claim the current composer payload before @file IO")
  assert(claimStart >= 0, "composer payload claim not found")
  const claimBody = chat.slice(claimStart, claimStart + 1800)
  assertSourceOrder(
    claimBody,
    'setInput("")',
    "liveSubmitPreparingThreads.delete(threadId)",
    "await resolveAtFileAttachments({",
    "new input becomes queueable as soon as the original composer payload is claimed"
  )
}

function testOrdinaryDeleteDoesNotCreateWithdrawalTombstone(): void {
  const deleteStart = chat.indexOf("const handleDeleteQueuedMessage = useCallback")
  const deleteBody = chat.slice(deleteStart, deleteStart + 1400)
  assertIncludes(
    deleteBody,
    "message.handoffRequestedAt || guidingQueuedMessageIdsRef.current.has(message.id)",
    "only guided or preparing drafts request a main-process withdrawal"
  )
  const deleteIpcStart = agentIpc.indexOf('"agent:deleteCurrentRunQueuedMessage"')
  const deleteIpcBody = agentIpc.slice(deleteIpcStart, deleteIpcStart + 900)
  assertSourceOrder(
    deleteIpcBody,
    "if (!activeRuns.has(payload.threadId)) return",
    "deleteCurrentRunQueuedMessage(payload.threadId, payload.messageId)",
    "idle deletes cannot allocate withdrawal tombstones"
  )
  const guideStart = chat.indexOf("const handleGuideQueuedMessage = useCallback")
  const guideBody = chat.slice(guideStart, guideStart + 2800)
  assertSourceOrder(
    guideBody,
    'if (result.reason === "withdrawn")',
    "deleteQueuedMessage(current.id)",
    "a stale window removes an authoritatively withdrawn guided draft"
  )
}

function testAlreadyInjectedNeverReturnsToOrdinaryQueue(): void {
  const guideStart = chat.indexOf("const handleGuideQueuedMessage = useCallback")
  const guideBody = chat.slice(guideStart, guideStart + 7000)
  const injectedStart = guideBody.indexOf('if (result.reason === "already_injected")')
  const genericFallbackStart = guideBody.indexOf(
    "if (getQueuedMessage(current.id)?.handoffRequestedAt)",
    injectedStart
  )
  assert(injectedStart >= 0, "already-injected guide branch not found")
  assert(genericFallbackStart > injectedStart, "generic guide fallback not found")
  const injectedBranch = guideBody.slice(injectedStart, genericFallbackStart)
  assertIncludes(
    injectedBranch,
    "reconcileCurrentRunQueuedMessages(",
    "already-injected drafts reconcile against authoritative main state"
  )
  assertIncludes(
    injectedBranch,
    'classifyGuidedMessage(current.id, reconciliation) === "durable"',
    "durable already-injected drafts are recognized"
  )
  assertIncludes(
    injectedBranch,
    "deleteQueuedMessage(current.id)",
    "durable already-injected drafts leave the local queue"
  )
  assertNotIncludes(
    injectedBranch,
    "handoffRequestedAt: undefined",
    "already-injected drafts never become ordinary drafts"
  )
  assertNotIncludes(
    injectedBranch,
    "promoteQueuedMessage(current.id)",
    "already-injected drafts can never be promoted for a duplicate submit"
  )
}

function testFailedPumpRestoresQueueHead(): void {
  assertIncludes(
    threadContext,
    "prependQueuedMessage: (message: QueuedMessage) => {",
    "thread actions can restore a failed queue head"
  )
  const pumpStart = chat.indexOf("// Auto-drain the queue head once the thread is idle")
  const pumpBody = chat.slice(pumpStart, pumpStart + 5000)
  assertSourceOrder(
    pumpBody,
    "if (durable === true) return",
    "prependQueuedMessage({",
    "durably accepted failed turns are never re-queued"
  )
  assertIncludes(
    pumpBody,
    "prependQueuedMessage({",
    "failed queue submission returns to the front instead of the tail"
  )
  assertNotIncludes(
    pumpBody,
    "addQueuedMessage({",
    "failed queue submission no longer appends behind later drafts"
  )
}

function testSubmitLockSpecRunsInMainSuite(): void {
  assertIncludes(
    packageJson,
    "npx tsx tests/submit-in-flight-lock.spec.ts",
    "main workflow test command includes submit lock regression coverage"
  )
}

function testGuideClaimsLocalOwnershipBeforeIpc(): void {
  const guideStart = chat.indexOf("const handleGuideQueuedMessage = useCallback")
  assert(guideStart >= 0, "handleGuideQueuedMessage not found")
  const guideBody = chat.slice(guideStart, guideStart + 4500)
  assertSourceOrder(
    guideBody,
    "guidingQueuedMessageIdsRef.current.add(current.id)",
    "await window.api.agent.queueCurrentRunMessage",
    "guide request is marked in-flight before crossing IPC"
  )
  assertSourceOrder(
    guideBody,
    "updateQueuedMessage(current.id, { handoffRequestedAt: new Date() })",
    "await window.api.agent.queueCurrentRunMessage",
    "handoff ownership blocks local edits and auto-drain before main responds"
  )
  const saveStart = chat.indexOf("const saveEditingQueuedMessage = useCallback")
  const saveBody = chat.slice(saveStart, saveStart + 1800)
  assertIncludes(
    saveBody,
    "guidingQueuedMessageIdsRef.current.has(message.id)",
    "saving cannot mutate a draft while its guide IPC is in flight"
  )
}

function testDisabledSliderModesRemainVisibleAndExplained(): void {
  const switcher = read("src/renderer/src/components/chat/AgentModeSwitcher.tsx")
  assertIncludes(
    switcher,
    "aria-disabled={disabledModes?.[item.value] || undefined}",
    "disabled mode labels expose their state to assistive technology"
  )
  assertIncludes(
    switcher,
    '"cursor-not-allowed text-muted-foreground/35"',
    "disabled mode labels have a visible disabled treatment"
  )
  assertIncludes(
    switcher,
    "toast.message(",
    "attempting to select an unavailable slider stop explains why it was rejected"
  )
  assertIncludes(
    switcher,
    "max={visibleModes.length - 1}",
    "disabled stops keep their physical positions"
  )
}

function testPumpHoldsSharedSubmitInFlightLock(): void {
  // The pump serializes on submitInFlightRef — the SAME lock handleSubmit's
  // live-send path uses — rather than a second, separate ref. A dedicated
  // queueSubmittingRef used to exist for the pump's own re-entrancy; it was
  // strictly redundant once the pump held submitInFlightRef for its own submit
  // duration, and a second lock that doesn't know about the first is exactly how
  // a live "/goal resume" (unconditionally excluded from willEnqueueWhileBusy,
  // since goal commands must never be silently parked in the queue) could have
  // raced the pump's own stream.submit. A second independent Codex review pass
  // caught both the original gap and this redundant-lock follow-up.
  assertNotIncludes(
    chat,
    "queueSubmittingRef",
    "the separate pump-only lock was removed; submitInFlightRef is the single source of truth"
  )
  const pumpEffectStart = chat.indexOf("if (queueAutoDrainSuppressed) return")
  assert(pumpEffectStart >= 0, "pump effect not found")
  const pumpEffectBody = chat.slice(pumpEffectStart, pumpEffectStart + 2800)
  assertIncludes(
    pumpEffectBody,
    "if (submitInFlightRef.current.has(threadId)) return",
    "pump effect checks the shared in-flight lock before draining"
  )
  assertIncludes(
    pumpEffectBody,
    "if (!tryAcquireSubmitInFlightLock(submitInFlightRef, true, threadId)) return",
    "pump acquires the shared lock before submitting a queued draft"
  )
  assertIncludes(
    pumpEffectBody,
    "releaseSubmitInFlightLock(submitInFlightRef, true, threadId)",
    "pump releases the shared lock once its submit settles"
  )
  assertSourceOrder(
    pumpEffectBody,
    "if (submitInFlightRef.current.has(threadId)) return",
    "if (!tryAcquireSubmitInFlightLock(submitInFlightRef, true, threadId)) return",
    "the pump checks the lock before later acquiring it for its own submit"
  )
  assertIncludes(
    chat,
    "submitInFlightRef,\n    threadError,\n    threadId",
    "pump effect tracks its thread and shared lock dependencies explicitly"
  )
}

function testSteerPathsGuardCoordinatorMarker(): void {
  // The live-send (handleSubmit) and drain (submitQueuedMessage) paths wrap their
  // displayContent in guardCoordinatorPlainText; both steer paths (guide +
  // save-while-guided) must do the same for consistency, even though the
  // renderer's role:"user" reconciliation currently makes the gap unreachable
  // in practice.
  assertOccurrences(
    chat,
    "guardCoordinatorPlainText(getQueuedDisplayContent(",
    6,
    "all remaining displayContent construction sites guard the coordinator marker; durable reconciliation uses DB content"
  )
}

function testEditLengthErrorDoesNotPolluteThreadError(): void {
  // A queued draft is typically edited WHILE the thread is busy (that's why it's
  // queued). The error card is gated on !isLoading, and the auto-drain pump's own
  // gate ALSO checks threadError — so using setError for this purely local
  // validation would be invisible when it fires AND silently stall the entire
  // queue (not just the over-limit item) once the run ends, until the user
  // notices and dismisses an error card that, by then, is disconnected in time
  // from the edit that produced it.
  const saveStart = chat.indexOf("const saveEditingQueuedMessage = useCallback")
  assert(saveStart >= 0, "saveEditingQueuedMessage not found")
  const saveBody = chat.slice(saveStart, saveStart + 2000)
  assertIncludes(
    saveBody,
    "if (nextText.length > MAX_INPUT_CHARS) {\n      toast.error(",
    "the edit-length limit reports via toast, not setError"
  )
  assertNotIncludes(
    saveBody,
    "setError(",
    "saveEditingQueuedMessage no longer touches the shared threadError state at all"
  )
}

function testGuidedEditReconcilesBeforeDowngrading(): void {
  const saveStart = chat.indexOf("const saveEditingQueuedMessage = useCallback")
  assert(saveStart >= 0, "saveEditingQueuedMessage not found")
  const saveBody = chat.slice(saveStart, saveStart + 9000)
  assertSourceOrder(
    saveBody,
    "const beforeEdit = await reconcile()",
    "await window.api.agent.queueCurrentRunMessage",
    "guided edits reconcile durable state before attempting to replace main's pending payload"
  )
  assertIncludes(
    saveBody,
    "const afterRejection = await reconcile()",
    "a run-end rejection is reconciled again before the draft is downgraded"
  )
  const catchStart = saveBody.indexOf("} catch (err) {")
  assert(catchStart >= 0, "guided edit catch not found")
  const catchBody = saveBody.slice(catchStart, catchStart + 900)
  assertNotIncludes(
    catchBody,
    "handoffRequestedAt: undefined",
    "ambiguous IPC failure preserves handoff ownership instead of risking a duplicate turn"
  )
  assertIncludes(catchBody, "toast.error(", "ambiguous failure remains visible to the user")
}

function testPumpClaimsCurrentVersionAndWaitsForHandoff(): void {
  const submitStart = chat.indexOf("const submitQueuedMessage = useCallback")
  const submitBody = chat.slice(submitStart, submitStart + 9000)
  assertSourceOrder(
    submitBody,
    "await loadResolvedAgentMode()",
    "canClaimQueuedMessage(queued, currentQueued)",
    "pump revalidates the authoritative draft after asynchronous mode hydration"
  )
  const claimStart = submitBody.indexOf("canClaimQueuedMessage(queued, currentQueued)")
  assert(claimStart >= 0, "authoritative queued-message claim not found")
  const claimBody = submitBody.slice(claimStart)
  assertSourceOrder(
    claimBody,
    "canClaimQueuedMessage(queued, currentQueued)",
    "deleteQueuedMessage(queued.id)",
    "pump claims the current version before deleting or submitting it"
  )
  const pumpStart = chat.indexOf("// Auto-drain the queue head once the thread is idle")
  const pumpBody = chat.slice(pumpStart, pumpStart + 3000)
  assertIncludes(
    pumpBody,
    "if (queuedMessages.some((queued) => queued.handoffRequestedAt)) return",
    "auto-drain waits until every handed-off draft is reconciled"
  )
}

function testGuidedItemsCannotBeReorderedLocally(): void {
  assertIncludes(
    chat,
    "draggable={!isEditing && !isGuided}",
    "guided items are not draggable while main owns their injection order"
  )
  const moveStart = chat.indexOf("const moveQueuedMessage = useCallback")
  const moveBody = chat.slice(moveStart, moveStart + 900)
  assertIncludes(
    moveBody,
    "source.handoffRequestedAt || target.handoffRequestedAt",
    "move handler rejects crossing a guided source or target"
  )
  assertIncludes(
    chat,
    "if (!isGuided) e.preventDefault()",
    "guided cards are not valid drop targets"
  )
}

function testSubmitInFlightLockSurvivesRemount(): void {
  // Same class of bug queueAutoDrainSuppressed had before it moved to
  // thread-context: TabbedPanel unmounts ChatContainer entirely when switching to
  // a file tab, which would silently reset a component-local useRef back to an
  // empty Set. Unlike queueAutoDrainSuppressed, this lock's synchronous
  // acquire-then-immediately-read semantics don't fit React state, so instead of
  // moving it into ThreadState it's hoisted to a plain module-level object that
  // every ChatContainer instance aliases — surviving remounts without ever
  // touching React's render/state cycle. A fifth independent review pass caught
  // this as the same-shaped gap D+E had already fixed for queueAutoDrainSuppressed.
  assertIncludes(
    chat,
    "const submitInFlightLockStore: SubmitInFlightLockRef = { current: new Set<string>() }",
    "the lock store is a module-level constant, not created inside the component"
  )
  assertNotIncludes(
    chat,
    "const submitInFlightRef = useRef",
    "submitInFlightRef is no longer a component-local useRef (unlike other, unrelated" +
      " Set<string> refs in this file, e.g. gitPushInFlightRef, which don't have this bug)"
  )
  assertIncludes(
    chat,
    "const submitInFlightRef = submitInFlightLockStore",
    "the in-component binding is an alias to the module-level store, not a fresh ref"
  )
}

function testDeleteThreadCleansLocalStorageQueue(): void {
  // The draft queue persists to localStorage independent of the DB thread record
  // (thread-context.tsx's persistQueuedMessages) so it survives reloads — but
  // nothing else ever cleared that key. store.ts's deleteThread is the actual
  // thread-deletion entry point (a zustand action, outside the React tree, so it
  // can't call a thread-context action) — it must clean the key up directly.
  // queueStorageKey lives in queued-message-content.ts (not thread-context.tsx,
  // which imports FROM store.ts) specifically so store.ts can import it back
  // without a circular import.
  assertIncludes(
    queuedMessageContent,
    "export function queueStorageKey(threadId: string): string {",
    "queueStorageKey is exported from the no-circular-import-risk module"
  )
  assertIncludes(
    store,
    "window.localStorage.removeItem(queueStorageKey(threadId))",
    "deleteThread cleans up the persisted draft queue for the deleted thread"
  )
  // The dead API this cleanup replaced (a thread-context action with zero call
  // sites, since deleteThread can't reach it from outside the React tree) must
  // stay gone, not come back as an unused, untested "someone will call this
  // eventually" surface.
  assertNotIncludes(
    threadContext,
    "clearQueuedMessages",
    "the unused clearQueuedMessages action was removed, not left as dead API"
  )
}

function main(): void {
  const tests = [
    testMiddlewareOnlyOnMainStack,
    testMiddlewareBeforeSummarizationAndHITL,
    testQueueModuleIsElectronFree,
    testAfterModelSkipsOnToolCalls,
    testQueueIpcRequiresActiveRun,
    testGuideRespectsActiveGoal,
    testGuideUsesCurrentRunPromptPipeline,
    testClearOnEveryRunExit,
    testStreamTranscriptBuffersArePhysicalRunScoped,
    testPreparingGuidesParticipateInReconciliation,
    testPreloadExposesApi,
    testThreadContextWiresInjectionListener,
    testInjectionPayloadHasNoRedundantIdsField,
    testRestoreDropsAlreadyCommittedQueuedDrafts,
    testInjectedMessagesUseNormalUserTurnEffects,
    testEnqueueExcludesGoalInputs,
    testEnqueueBypassesSubmitLock,
    testEnqueueDoesNotRejectApproval,
    testDrainGatedOnGoalNotActive,
    testEnqueueBranchParksDraft,
    testCancelSuppressesAutoDrain,
    testGuideFallbackResumesStopPausedQueue,
    testPumpGatedOnHistoryLoadingReadOnlyContextReminder,
    testQueuedSendHydratesAgentMode,
    testQueuedSendRevalidatesModelAndWorkspace,
    testRetryReusesStableMessageId,
    testAtFileWarningsDoNotBlockQueuePump,
    testFailedQueuedSendRollsBackOptimisticBubble,
    testWillEnqueueDistinguishesLivePreparationFromPumpInFlight,
    testBusyDraftPreparationIsAtomic,
    testSteerAcknowledgementIsDurableAndReconciled,
    testAfterModelSteerPersistsPrecedingAssistantReply,
    testTransportSupportsEveryAgentMode,
    testPreparedLiveSubmitAcceptsTheNextEnter,
    testOrdinaryDeleteDoesNotCreateWithdrawalTombstone,
    testAlreadyInjectedNeverReturnsToOrdinaryQueue,
    testFailedPumpRestoresQueueHead,
    testSubmitLockSpecRunsInMainSuite,
    testGuideClaimsLocalOwnershipBeforeIpc,
    testDisabledSliderModesRemainVisibleAndExplained,
    testPumpHoldsSharedSubmitInFlightLock,
    testSteerPathsGuardCoordinatorMarker,
    testEditLengthErrorDoesNotPolluteThreadError,
    testGuidedEditReconcilesBeforeDowngrading,
    testPumpClaimsCurrentVersionAndWaitsForHandoff,
    testGuidedItemsCannotBeReorderedLocally,
    testSubmitInFlightLockSurvivesRemount,
    testDeleteThreadCleansLocalStorageQueue
  ]
  for (const test of tests) {
    test()
    console.log(`✓ ${test.name}`)
  }
  console.log(`\n${tests.length} passed`)
}

main()
