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
const standardTurn = read("src/main/agent/standard-thread-turn.ts")
const agentIpc = read("src/main/ipc/agent.ts")
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
    /createCurrentRunMessageQueueMiddleware\(currentRunMessageQueueOwnerToken\),\s*\n\s*createSummarizationMiddleware\(mainSummarizationOptions\)/,
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
    standardTurn,
    "export async function prepareStandardUserPrompt({",
    "normal and steered prompts share one preparation pipeline"
  )
  assertIncludes(
    agentIpc,
    "const prepareUserPromptForCurrentRun = async (",
    "the initial user prompt delegates to the shared pipeline"
  )
  assertIncludes(
    agentIpc,
    "const prepared = await prepareStandardUserPrompt({",
    "the current-run preparer delegates steered messages to the shared pipeline"
  )
  assertOccurrences(
    agentIpc,
    "registerCurrentRunMessagePreparer({",
    4,
    "invoke, resume, and interrupt each register the shared preparer"
  )
  assertIncludes(
    standardTurn,
    '"UserPromptSubmit",\n    promptSubmitContext,',
    "shared preparation executes UserPromptSubmit hooks"
  )
  assertIncludes(
    standardTurn,
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
    standardTurn,
    "isPreparationCurrent && !isPreparationCurrent()",
    "stale async hook results stop before committing skill and prompt side effects"
  )
  assertOccurrences(
    agentIpc,
    "invalidateCurrentRunMessagePreparer(threadId",
    7,
    "one helper plus invoke, resume, interrupt, and their cleanup paths invalidate run-scoped steer preparation"
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
    1,
    "only a brand-new invoke force-clears queue ownership"
  )
  assertOccurrences(
    agentIpc,
    "clearCurrentRunMessageQueue(threadId, runToken)",
    3,
    "each physical run cleans up only the queue token it owns"
  )
  const replacementStart = agentIpc.indexOf("const replacement = await withThreadRunMutationLock")
  assert(replacementStart >= 0, "new invoke replacement block exists")
  const replacementBody = agentIpc.slice(replacementStart, replacementStart + 2200)
  assertSourceOrder(
    replacementBody,
    "clearCurrentRunMessageQueue(threadId)",
    "existingController.abort()",
    "new invoke clears old steer ownership before abort/replacement"
  )
  for (const continuationMarker of ["const resumeReplacement", "const interruptReplacement"]) {
    const continuationStart = agentIpc.indexOf(continuationMarker)
    assert(continuationStart >= 0, `continuation block not found: ${continuationMarker}`)
    const continuationBody = agentIpc.slice(continuationStart, continuationStart + 2400)
    assertSourceOrder(
      continuationBody,
      "setCurrentRunMessageQueueOwner(threadId",
      "existingController.abort()",
      `${continuationMarker} transfers ownership before aborting the old controller`
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
  assertIncludes(
    runtime,
    "createCurrentRunMessageQueueMiddleware(currentRunMessageQueueOwnerToken)",
    "each middleware closure is bound to its physical run token"
  )
  assertOccurrences(
    agentIpc,
    "currentRunMessageQueueOwnerToken: runToken",
    3,
    "invoke, resume, and interrupt factories pass the owner token to every failover runtime"
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
    "loadResolvedAgentMode().catch(",
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
  const liveSubmitBody = chat.slice(liveSubmitStart, liveSubmitStart + 14000)
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
    "flushTranscriptBeforeCurrentRunInjection(threadId)",
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
    agentIpc,
    "flushPendingStreamTranscriptMessages(threadId, { throwOnError: true })",
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
  const notifierBody = runtime.slice(notifierStart, notifierStart + 4500)
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
  assertIncludes(switcher, "max={MODES.length - 1}", "disabled stops keep their physical positions")
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
    7,
    "all displayContent construction sites, including durable reconciliation, guard the coordinator marker"
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
    "await loadResolvedAgentMode().catch(",
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
