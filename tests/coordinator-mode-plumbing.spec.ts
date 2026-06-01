/**
 * Lightweight integration contract tests for Coordinator Mode plumbing.
 *
 * These tests do not launch Electron or a model. They verify the mode signal
 * crosses renderer -> preload -> IPC -> runtime and that coordinator runtime
 * stays isolated from the normal-mode tool surface.
 *
 * Run:
 *   npx -y tsx tests/coordinator-mode-plumbing.spec.ts
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

function assertNotIncludes(value: string, expected: string, label: string): void {
  assert(!value.includes(expected), `${label}: expected not to include "${expected}"`)
}

function assertMatches(value: string, pattern: RegExp, label: string): void {
  assert(pattern.test(value), `${label}: expected to match ${pattern}`)
}

function assertOccurrenceCount(
  value: string,
  needle: string,
  expected: number,
  label: string
): void {
  const actual = value.split(needle).length - 1
  assert(actual === expected, `${label}: expected "${needle}" ${expected} time(s), got ${actual}`)
}

function assertSourceOrder(value: string, before: string, after: string, label: string): void {
  const beforeIndex = value.indexOf(before)
  const afterIndex = value.indexOf(after)
  assert(beforeIndex >= 0, `${label}: missing "${before}"`)
  assert(afterIndex >= 0, `${label}: missing "${after}"`)
  assert(beforeIndex < afterIndex, `${label}: expected "${before}" before "${after}"`)
}

async function readProjectFile(path: string): Promise<string> {
  return readFile(join(PROJECT_ROOT, path), "utf8")
}

async function testIpcTypesExposeAgentMode(): Promise<void> {
  const types = await readProjectFile("src/main/types.ts")
  assertMatches(
    types,
    /interface AgentInvokeParams[\s\S]*agentMode\?: "normal" \| "coordinator"/,
    "AgentInvokeParams"
  )
  assertIncludes(
    types,
    "coordinatorInternalNotification?: boolean",
    "AgentInvokeParams can carry trusted internal coordinator notification intent"
  )
  assertIncludes(
    types,
    "cancelWorkers?: boolean",
    "AgentCancelParams can distinguish foreground stop from explicit worker cancellation"
  )
  assertMatches(
    types,
    /interface AgentResumeParams[\s\S]*agentMode\?: "normal" \| "coordinator"/,
    "AgentResumeParams"
  )
  assertIncludes(
    types,
    '| { type: "custom"; data: Record<string, unknown> }',
    "StreamEvent includes main-process custom events"
  )
}

async function testRendererSendsAgentMode(): Promise<void> {
  const switcher = await readProjectFile("src/renderer/src/components/chat/AgentModeSwitcher.tsx")
  assertIncludes(switcher, 'value: "normal"', "AgentModeSwitcher exposes normal mode")
  assertIncludes(switcher, 'value: "coordinator"', "AgentModeSwitcher exposes coordinator mode")
  assertIncludes(
    switcher,
    "选择这次任务是快速直达，还是走多角色协同",
    "AgentModeSwitcher explains coordinator-only flow"
  )
  assertIncludes(switcher, "setOpen(false)", "AgentModeSwitcher closes after selection")
  assertIncludes(
    switcher,
    "适合日常问答、小范围修改和快速排查",
    "AgentModeSwitcher explains normal mode"
  )
  assertIncludes(
    switcher,
    "适合完整开发任务、文档产出和需要独立验证的改动",
    "AgentModeSwitcher explains coordinator mode"
  )

  const chat = await readProjectFile("src/renderer/src/components/chat/ChatContainer.tsx")
  assertIncludes(chat, "AgentModeSwitcher", "ChatContainer imports mode switcher")
  assertIncludes(
    chat,
    "const initialAgentMode = isCoordinatorModeMetadata(",
    "ChatContainer derives its initial mode from stored thread metadata"
  )
  assertIncludes(
    chat,
    "const metadataDerivedMode: ChatAgentMode = isCoordinatorModeMetadata(currentThread?.metadata)",
    "ChatContainer re-derives mode synchronously when switching threads"
  )
  assertIncludes(
    chat,
    "isCoordinatorModeMetadata(metadata)",
    "ChatContainer hydrates coordinator mode from legacy and new metadata fields"
  )
  assertIncludes(
    chat,
    ".isCoordinatorModeForced()",
    "ChatContainer checks environment-forced coordinator mode when hydrating the visible mode"
  )
  assertIncludes(
    chat,
    "delete nextMetadata.coordinatorMode",
    "ChatContainer clears legacy coordinatorMode when switching back to normal"
  )
  assertIncludes(
    chat,
    "const coordinatorPrefixed = /^\\s*(?:\\[coordinator\\]|#coordinator)",
    "ChatContainer recognizes coordinator prefixes before submitting"
  )
  assertIncludes(
    chat,
    "!agentModeHydratedRef.current",
    "ChatContainer re-resolves coordinator mode before first submit when hydration has not finished"
  )
  assertIncludes(chat, "agent_mode: submitAgentMode", "ChatContainer stream config")
  assertIncludes(
    chat,
    "const canChangeAgentMode = threadMessages.length === 0",
    "ChatContainer only allows mode switching before the thread has messages"
  )
  assertIncludes(
    chat,
    "当前线程已有消息，不能再切换执行模式。请新开线程选择其他模式。",
    "ChatContainer explains why mode switching is locked after conversation starts"
  )
  assertIncludes(
    chat,
    "disabled={isLoading || !canChangeAgentMode}",
    "ChatContainer disables mode switching while running or after the thread has messages"
  )

  const threadContextSource = await readProjectFile("src/renderer/src/lib/thread-context.tsx")
  assertIncludes(
    threadContextSource,
    "state.workspacePath === data.path\n                ? { workspacePath: data.path }\n                : { workspacePath: data.path, coordinatorWorkers: [] }",
    "ThreadContext clears stale coordinator workers when a backend workspace path change arrives"
  )
  assertIncludes(
    threadContextSource,
    "state.workspacePath === path\n              ? { workspacePath: path }\n              : { workspacePath: path, coordinatorWorkers: [] }",
    "ThreadContext clears stale coordinator workers when the current thread switches workspace locally"
  )
  assertIncludes(
    threadContextSource,
    "else if (data.worker)",
    "ThreadContext accepts single-worker coordinator deltas"
  )
  assertIncludes(
    threadContextSource,
    "mergeCoordinatorWorkers(prev.coordinatorWorkers, [data.worker!])",
    "ThreadContext merges incremental coordinator worker updates without waiting for a full refresh"
  )

  const tabbedPanel = await readProjectFile("src/renderer/src/components/tabs/TabbedPanel.tsx")
  assertIncludes(
    tabbedPanel,
    "<ChatContainer\n            key={threadId}",
    "TabbedPanel remounts ChatContainer when switching threads so old agent mode state cannot leak across threads"
  )
  assertIncludes(
    chat,
    "const hasRunningCoordinatorWorker = coordinatorWorkers.some(",
    "ChatContainer detects running async workers separately"
  )
  assertIncludes(
    chat,
    "const isLoading = streamData.isLoading || scheduledTaskLoading",
    "ChatContainer does not let background async workers lock normal input"
  )
  assertIncludes(
    chat,
    "hasRunningCoordinatorWorker && (",
    "ChatContainer keeps a background-worker stop button available while input remains usable"
  )
  assertIncludes(
    chat,
    'aria-label="停止后台子代理"',
    "ChatContainer labels the background worker stop button"
  )
  assertIncludes(
    chat,
    "handleCancelBackgroundWorkers",
    "ChatContainer separates foreground stop from explicit worker cancellation"
  )
  assertIncludes(
    chat,
    "the main stop button stops the",
    "ChatContainer keeps the foreground stop button scoped to the current response"
  )
  assertIncludes(
    chat,
    "window.api.agent.cancel(threadId, { cancelWorkers: true })",
    "ChatContainer exposes explicit durable coordinator worker cancellation separately"
  )
  assertIncludes(
    chat,
    "cancelWorkers: true",
    "ChatContainer only cancels durable coordinator workers from the background-worker stop button"
  )
  assertIncludes(
    chat,
    "hasCoordinatorWorkerNotifications(threadId)",
    "ChatContainer checks pending coordinator notifications before switching back to normal mode"
  )
  assertIncludes(
    chat,
    "结果待处理",
    "ChatContainer blocks normal mode while coordinator worker results are unresolved"
  )
  assertIncludes(
    chat,
    "当前环境变量强制开启协同模式，不能切回普通模式",
    "ChatContainer blocks switching back to normal when coordinator mode is forced by environment"
  )

  const transport = await readProjectFile("src/renderer/src/lib/electron-transport.ts")
  assertIncludes(
    transport,
    "payload.config?.configurable?.agent_mode",
    "Electron transport reads agent_mode"
  )
  assertMatches(
    transport,
    /window\.api\.agent\.streamAgent\([\s\S]*modelId,\s*agentMode,\s*coordinatorInternalNotification/,
    "Electron transport forwards agentMode and trusted internal notification flag"
  )
  for (const resetLine of [
    "this.subagentToolCallIds.clear()",
    "this.subagentToolLogEntryIds.clear()",
    "this.quietCoordinatorToolCallIds.clear()",
    "this.emittedMessageIds.clear()",
    "this.accumulatedToolCalls.clear()",
    "this.completedToolCallsByName.clear()"
  ]) {
    assertIncludes(transport, resetLine, `Electron transport resets per-stream state: ${resetLine}`)
  }

  const workspaceUtils = await readProjectFile("src/renderer/src/lib/workspace-utils.ts")
  assertIncludes(
    workspaceUtils,
    "const message = getWorkspaceSelectionErrorMessage(e)",
    "workspace selection utility surfaces blocked workspace-switch errors to the user"
  )
  assertIncludes(
    workspaceUtils,
    "toast.error(message)",
    "workspace selection utility shows the workspace-switch failure message to the user"
  )
  assertIncludes(
    workspaceUtils,
    'return { status: "cancelled" }',
    "workspace selection utility returns an explicit cancelled state instead of pretending success"
  )
  assertIncludes(
    workspaceUtils,
    'return { status: "success", path }',
    "workspace selection utility returns explicit success when the workspace actually changes"
  )

  const filesystemPanel = await readProjectFile(
    "src/renderer/src/components/panels/FilesystemPanel.tsx"
  )
  assertIncludes(
    filesystemPanel,
    "toast.error(getWorkspaceSelectionErrorMessage(e))",
    "FilesystemPanel surfaces blocked workspace-switch errors to the user"
  )

  const workspacePicker = await readProjectFile(
    "src/renderer/src/components/chat/WorkspacePicker.tsx"
  )
  assertIncludes(
    workspacePicker,
    'if (selection.status !== "success") return',
    "WorkspacePicker only resets worktree UI state after a successful workspace change"
  )

  const preload = await readProjectFile("src/preload/index.ts")
  assertIncludes(
    preload,
    "coordinatorInternalNotification",
    "preload can forward trusted internal coordinator notification turns"
  )
  assertIncludes(
    preload,
    "`agent:stream:${threadId}:coordinator-internal`",
    "preload isolates internal coordinator notification streams from foreground user streams"
  )
  assertMatches(
    preload,
    /ipcRenderer\.send\("agent:resume", \{ threadId, command, modelId, agentMode \}\)/,
    "preload resume forwards agentMode"
  )
  assertIncludes(
    preload,
    'ipcRenderer.invoke("agent:coordinator-workers", { threadId })',
    "preload exposes coordinator worker state refresh"
  )
  assertIncludes(
    preload,
    'ipcRenderer.invoke("agent:coordinator-worker-notifications-pending"',
    "preload exposes coordinator notification queue state"
  )
  assertIncludes(
    preload,
    'ipcRenderer.invoke("agent:coordinator-mode-forced")',
    "preload exposes environment-forced coordinator mode state for cold-start notification turns"
  )
  assertIncludes(preload, "...options", "preload forwards agent cancel options")

  const electronTransport = await readProjectFile("src/renderer/src/lib/electron-transport.ts")
  assertIncludes(
    electronTransport,
    "COORDINATOR_NOTIFICATION_PROMPT",
    "electron transport supplies the trusted internal coordinator notification prompt"
  )

  const threadContext = await readProjectFile("src/renderer/src/lib/thread-context.tsx")
  assertIncludes(
    threadContext,
    "hasCoordinatorWorkerNotifications(threadId)",
    "thread context checks pending notifications before auto-resume"
  )
  assertIncludes(
    threadContext,
    "isExplicitNormalModeMetadata",
    "thread context distinguishes explicit normal mode from default metadata before suppressing notification turns"
  )
  assertIncludes(
    threadContext,
    "isCoordinatorModeMetadata(thread?.metadata)",
    "thread context treats legacy coordinator metadata as coordinator mode"
  )
  assertIncludes(
    threadContext,
    "environmentCoordinatorThreadIdsRef.current.has(threadId)",
    "thread context allows environment-forced coordinator notification turns without persisting metadata"
  )
  assertIncludes(
    threadContext,
    "window.api.agent.isCoordinatorModeForced()",
    "thread context checks environment-forced coordinator mode before dropping cold-start notifications"
  )
  assertIncludes(
    threadContext,
    "isThreadMetadataExplicitNormalMode(threadId) && !isEnvironmentCoordinatorMode",
    "thread context suppresses auto notification turns only for explicitly normal threads"
  )
  assertIncludes(
    threadContext,
    'agent_mode: "coordinator"',
    "thread context auto-runs notification turns in coordinator mode"
  )
  assertIncludes(
    threadContext,
    "coordinator_internal_notification: true",
    "thread context marks auto notification turns as trusted internal coordinator work"
  )
  assertIncludes(
    threadContext,
    "additionalKwargs?.cmb_internal_coordinator_notification === true",
    "thread context hides persisted trusted internal notification prompts on history restore"
  )
  assertIncludes(
    threadContext,
    "msg.additional_kwargs ?? msg.kwargs?.additional_kwargs",
    "thread context recognizes internal notification metadata from live and serialized messages"
  )
  assertIncludes(
    threadContext,
    'const messageId =\n                msg.kwargs?.id ?? (typeof msg.id === "string" ? msg.id : `msg-${index}`)',
    "thread context uses LangChain message kwargs.id before serialized class-path ids"
  )
  assertIncludes(
    threadContext,
    "if (!streamData?.stream)",
    "thread context retries notification auto-run until the stream exists"
  )
  assertIncludes(
    threadContext,
    "wasLoading && loadingStates[threadId] === false",
    "thread context checks pending notifications when a busy stream becomes idle"
  )
  assertIncludes(
    threadContext,
    "const coordinatorNotificationRetryOnIdleRef = useRef<Record<string, boolean>>({})",
    "thread context tracks notification turns that were deferred because the stream was still busy or missing"
  )
  assertIncludes(
    threadContext,
    "coordinatorNotificationRetryOnIdleRef.current[threadId] = true",
    "thread context marks pending notifications for a retry-on-idle handoff when the stream is unavailable or still loading"
  )
  assertIncludes(
    threadContext,
    "!coordinatorNotificationRetryOnIdleRef.current[threadId]",
    "thread context only suppresses idle retry when there is neither an outstanding attempt nor a deferred busy-stream retry"
  )
  assertIncludes(
    threadContext,
    "const hasRunningWorker = state.coordinatorWorkers.some(",
    "thread context tracks unresolved coordinator threads by running workers or pending terminal notifications"
  )
  assertIncludes(
    threadContext,
    'worker.status === "running"',
    "thread context treats running coordinator workers as unresolved work"
  )
  assertIncludes(
    threadContext,
    "worker.notification_acknowledged === false &&\n            worker.suppress_notification_auto_run !== true",
    "thread context only treats unsuppressed terminal notifications as unresolved auto-run work"
  )
  assertIncludes(
    threadContext,
    "if (!initializedThreadsRef.current.has(threadId)) return false",
    "thread context does not keep polling cold threads whose coordinator notifications cannot auto-run yet"
  )
  assertIncludes(
    threadContext,
    "if (isThreadMetadataExplicitNormalMode(threadId) && !isEnvironmentCoordinatorMode) {\n          return false\n        }",
    "thread context lets unresolved terminal notifications drop out of the periodic refresh loop when explicit normal mode suppresses coordinator auto-runs"
  )
  assertIncludes(
    threadContext,
    "hasPendingTerminalNotification",
    "thread context keeps retrying internal notification turns for terminal workers whose notifications are still unresolved"
  )
  assertIncludes(
    threadContext,
    "hasNewTerminalWorker || hasPendingTerminalNotification",
    "thread context reschedules coordinator notification turns both for newly completed workers and for already-pending unresolved notifications"
  )
  assertIncludes(
    threadContext,
    "worker.suppress_notification_auto_run !== true",
    "thread context ignores user-suppressed terminal worker notifications in both unresolved polling and terminal refresh scheduling"
  )
  assertIncludes(
    threadContext,
    "delete coordinatorNotificationAttemptsRef.current[threadId]",
    "thread context clears coordinator notification retry counters after success, no-pending, and retry exhaustion"
  )
  assertIncludes(
    threadContext,
    'case "coordinator_notification_deferred"',
    "thread context reschedules internal notification turns explicitly deferred by the main process"
  )
  assertIncludes(
    threadContext,
    "hasPending) scheduleCoordinatorNotificationTurn(threadId)",
    "thread context schedules pending notifications after loading a thread"
  )
  assertIncludes(
    threadContext,
    'case "agent_mode"',
    "thread context handles backend-resolved coordinator mode changes"
  )
  assertIncludes(
    threadContext,
    "data.persisted === false",
    "thread context does not persist environment-forced coordinator mode events"
  )
  assertIncludes(
    threadContext,
    'data.source === "environment"',
    "thread context tracks environment-forced coordinator mode as runtime-only state"
  )
  assertNotIncludes(
    threadContext,
    "updateThreadMetadata(threadId",
    "thread context does not write stale renderer metadata back for backend-persisted agent_mode events"
  )
  assertIncludes(
    threadContext,
    "useAppStore.setState((state) => ({",
    "thread context syncs backend-resolved agent mode in memory only"
  )
  assertIncludes(
    threadContext,
    "persisted?: boolean",
    "thread context custom event type models non-persistent agent_mode events"
  )
  assertIncludes(
    threadContext,
    "approvalQueue: []",
    "thread context initializes a per-thread approval queue"
  )
  assertIncludes(
    threadContext,
    "function enqueuePendingApproval",
    "thread context queues concurrent approval requests instead of overwriting"
  )
  assertIncludes(
    threadContext,
    'approvalOperation(state.pendingApproval) === "prepare_save_code_exec_tool"',
    "thread context recognizes code-exec prepare approvals as a two-step flow"
  )
  assertIncludes(
    threadContext,
    'approvalOperation(request) === "save_code_exec_tool"',
    "thread context promotes the second code-exec save approval instead of hiding it in the queue"
  )
  assertIncludes(
    threadContext,
    "function advancePendingApproval",
    "thread context advances to the next queued approval after a decision"
  )
  assertIncludes(
    threadContext,
    "authoritative: true",
    "thread context treats main-process coordinator worker snapshots as authoritative"
  )
  assertNotIncludes(
    threadContext,
    "if (workers.length === 0) return\n              updateThreadState",
    "thread context allows authoritative empty coordinator worker snapshots to clear stale state"
  )
  assertIncludes(
    threadContext,
    "coordinatorWorkersEqual(prev.coordinatorWorkers, merged)",
    "thread context avoids no-op coordinator worker re-renders"
  )
  assertIncludes(
    threadContext,
    "function removePendingApprovalByRequestId",
    "thread context removes only the timed-out approval request"
  )
  assertIncludes(
    threadContext,
    "removePendingApprovalByRequestId(state, data.requestId)",
    "approval timeout handler does not clear unrelated current approvals"
  )
  assertIncludes(
    threadContext,
    "clearPendingApprovals",
    "thread context can clear queued approvals when a new user turn rejects them"
  )
  assertIncludes(
    chat,
    "for (const approval of [pendingApproval, ...approvalQueue].filter(Boolean))",
    "ChatContainer rejects current and queued approvals before sending a new user turn"
  )
  assertIncludes(
    chat,
    "用户输入的普通文本",
    "ChatContainer keeps user-typed coordinator internal markers visible as ordinary text"
  )
  assertIncludes(
    chat,
    "keepPrepareApprovalForSaveMetadata",
    "ChatContainer keeps the prepare approval visible until the save metadata approval replaces it"
  )
  assertIncludes(
    chat,
    "if (!keepPrepareApprovalForSaveMetadata)",
    "ChatContainer clears ordinary orchestrator approvals while preserving code-exec bridge state"
  )
}

async function testMainResolvesAndPersistsMode(): Promise<void> {
  const agentIpc = await readProjectFile("src/main/ipc/agent.ts")
  const replacementLock = await readProjectFile("src/main/ipc/async-keyed-lock.ts")
  assertIncludes(
    agentIpc,
    "resolveCoordinatorModeRequest",
    "agent IPC imports coordinator resolver"
  )
  assertIncludes(agentIpc, "coordinatorWorkerManager", "agent IPC imports worker manager")
  assertIncludes(
    agentIpc,
    "getAgentModeFromMetadata(metadata)",
    "agent IPC can load persisted mode"
  )
  assertIncludes(agentIpc, "requestedAgentMode", "agent IPC reads requested mode")
  assertIncludes(
    agentIpc,
    "coordinatorForcedByRequest",
    "agent IPC distinguishes explicit coordinator requests from persisted metadata"
  )
  assertIncludes(
    agentIpc,
    'requestedMode ?? (coordinatorFromMetadata ? "coordinator" : metadataAgentMode)',
    "agent IPC lets explicit UI mode override stale coordinator metadata"
  )
  assertIncludes(
    agentIpc,
    "const normalModeGuardState = await getNormalModeGuardState",
    "agent IPC loads unresolved coordinator worker state before allowing a normal-mode turn"
  )
  assertSourceOrder(
    agentIpc,
    'mode: "active"',
    "const normalModeGuardState = await getNormalModeGuardState",
    "agent IPC restores persisted worker state before applying the normal-mode guard"
  )
  assertIncludes(
    agentIpc,
    "COORDINATOR_NORMAL_MODE_BLOCKED",
    "agent IPC blocks normal-mode turns while coordinator work is still unresolved"
  )
  assertIncludes(
    agentIpc,
    "!isCoordinatorNotificationTurn &&",
    "agent IPC does not persist mode changes from internal coordinator notification turns"
  )
  assertIncludes(agentIpc, "metadata.agentMode = effectiveAgentMode", "agent IPC persists mode")
  assertIncludes(agentIpc, 'type: "agent_mode"', "agent IPC emits active mode event")
  assertIncludes(
    agentIpc,
    "persisted: shouldPersistAgentMode",
    "agent IPC tells renderer whether a resolved coordinator mode should be persisted"
  )
  assertIncludes(
    agentIpc,
    '!isCoordinatorNotificationTurn && effectiveAgentMode === "coordinator"',
    "agent IPC does not emit agent_mode sync events for internal coordinator notification turns"
  )
  assertIncludes(agentIpc, 'type: "coordinator_workers"', "agent IPC emits worker UI state")
  assertIncludes(
    agentIpc,
    "sendCoordinatorWorkerDelta(",
    "agent IPC emits lightweight single-worker coordinator updates for high-frequency progress"
  )
  assertIncludes(
    agentIpc,
    "bindWorkerUpdates(threadId, onUpdate, updateKey)",
    "agent IPC rebinds worker updates with a tracked callback key when coordinator worker polling refreshes an active thread"
  )
  assertIncludes(
    agentIpc,
    "payload: { threadId?: string; subscribeUpdates?: boolean }",
    "agent IPC lets passive coordinator worker refreshes avoid long-lived renderer update callbacks"
  )
  assertIncludes(
    agentIpc,
    "const subscribeUpdates = payload.subscribeUpdates !== false",
    "agent IPC defaults coordinator worker refreshes to the existing subscribed behavior"
  )
  assertIncludes(
    agentIpc,
    "unbindWorkerUpdates(boundThreadId, updateKey)",
    "agent IPC unbinds coordinator worker update callbacks when the renderer window closes"
  )
  assertIncludes(
    agentIpc,
    "sendCoordinatorWorkerEventToChannels(",
    "agent IPC reuses a shared coordinator worker update sender when polling refreshes rebind onUpdate"
  )
  assertIncludes(
    agentIpc,
    "suppressNotificationAutoRun",
    "agent IPC can mark coordinator worker notifications that should update UI without auto-resuming coordinator"
  )
  assertNotIncludes(
    agentIpc,
    "JSON.stringify(metadata).includes(workerThreadPrefix)",
    "agent IPC does not filter main-thread stream chunks through broad metadata string matching"
  )
  assertIncludes(
    agentIpc,
    'ipcMain.handle(\n    "agent:coordinator-workers"',
    "agent IPC exposes coordinator worker state refresh endpoint"
  )
  assertIncludes(
    agentIpc,
    'ipcMain.handle(\n    "agent:coordinator-worker-notifications-pending"',
    "agent IPC exposes notification queue check endpoint"
  )
  assertIncludes(
    agentIpc,
    'ipcMain.handle("agent:coordinator-mode-forced"',
    "agent IPC exposes runtime-only environment-forced coordinator mode state"
  )
  assertIncludes(
    agentIpc,
    "isCoordinatorModeForcedByEnvironment()",
    "agent IPC reports environment-forced coordinator mode without reading renderer metadata"
  )
  assertIncludes(
    agentIpc,
    "coordinatorWorkerManager.hasAutoRunnableNotifications(threadId)",
    "agent IPC checks only coordinator notifications that should still auto-resume"
  )
  assertIncludes(
    agentIpc,
    "restoreWorkersForThread({\n              parentThreadId: threadId",
    "agent IPC restores workers before checking persisted pending notifications"
  )
  assertIncludes(
    agentIpc,
    'mode: "recent"',
    "agent IPC uses a bounded recent restore when explicitly refreshing the coordinator worker list"
  )
  assertIncludes(
    agentIpc,
    'mode: "active"',
    "agent IPC lightweight worker refresh skips acknowledged terminal history during polling"
  )
  assertIncludes(
    agentIpc,
    "coordinatorWorkerManager.bindWorkerUpdates(threadId, onUpdate, updateKey)",
    "agent IPC rebinds in-memory worker updates without polling historical worker files"
  )
  assertIncludes(
    agentIpc,
    "[`agent:stream:${threadId}`, `agent:stream:${threadId}:coordinator-internal`]",
    "agent IPC preserves coordinator-internal worker updates when polling refresh rebinds onUpdate"
  )
  assertIncludes(
    agentIpc,
    "activeCoordinatorTurnPrompts",
    "agent IPC tracks the current coordinator turn prompt across replacements"
  )
  assertIncludes(
    agentIpc,
    "activeCoordinatorSelectedSkills",
    "agent IPC tracks selected skills across coordinator run replacements"
  )
  assertIncludes(
    agentIpc,
    "activeCoordinatorNotificationSelectedSkills",
    "agent IPC keeps per-notification selected skill context for coordinator follow-up turns"
  )
  assertIncludes(
    agentIpc,
    "const parsedCoordinatorSelectedSkill =\n            extractCoordinatorSelectedSkill(effectiveMessage) ?? undefined",
    "agent invoke extracts structured selected skill metadata before prompt adaptation"
  )
  assertIncludes(
    agentIpc,
    "await prepareQueuedCoordinatorNotificationsForPrompt(threadId",
    "agent invoke derives selected skill context from the current drained notifications"
  )
  assertIncludes(
    agentIpc,
    "queuedNotifications.map((notification) => notification.message)",
    "agent invoke restores drained worker notifications if selected-skill preparation fails"
  )
  assertIncludes(
    agentIpc,
    "coordinatorNotificationSelectedSkills = notificationSelectedSkills",
    "agent invoke stores the drained notification skill mapping from the shared preparation helper"
  )
  assertIncludes(
    agentIpc,
    "parseCoordinatorTurnPromptMetadata(metadata)",
    "agent IPC can rebuild the current coordinator turn context from persisted thread metadata"
  )
  assertIncludes(
    agentIpc,
    "parseCoordinatorSelectedSkillMetadata(metadata)",
    "agent IPC can rebuild the current coordinator selected skill from persisted thread metadata"
  )
  assertIncludes(
    agentIpc,
    "parseCoordinatorNotificationSelectedSkillsMetadata(",
    "agent IPC can rebuild notification-level selected skill context from persisted thread metadata"
  )
  assertIncludes(
    agentIpc,
    "serializeCoordinatorNotificationSelectedSkillsMetadata(",
    "agent IPC serializes notification-selected skill state without dropping skill-less notifications"
  )
  assertIncludes(
    agentIpc,
    "selectedSkill ?? null",
    "agent IPC persists skill-less notifications explicitly instead of losing them during JSON serialization"
  )
  assertIncludes(
    agentIpc,
    "coordinatorNotificationSelectedSkillsEqual(",
    "agent IPC compares notification-selected skill maps without lossy JSON stringification"
  )
  assertIncludes(
    agentIpc,
    "omitCoordinatorNotificationSelectedSkills(",
    "agent IPC prunes settled notification-selected skill entries instead of accumulating them forever"
  )
  assertIncludes(
    agentIpc,
    "deriveSharedCoordinatorSelectedSkill(coordinatorNotificationSelectedSkills)",
    "agent invoke only auto-inherits a selected skill when the current notification batch points at one shared non-empty skill"
  )
  assertIncludes(
    agentIpc,
    "activeCoordinatorNotificationSelectedSkills.set(",
    "agent invoke stores per-notification selected skill context for replacement runs"
  )
  assertIncludes(
    agentIpc,
    "notificationSkills.length === 0 ||",
    "agent invoke refuses to infer a shared selected skill when the current notification batch is empty"
  )
  assertIncludes(
    agentIpc,
    "notificationSkills.some((selectedSkill) => !selectedSkill)",
    "agent invoke refuses to infer a shared selected skill from mixed notification batches that include skill-less workers"
  )
  assertIncludes(
    agentIpc,
    "coordinatorNotificationSelectedSkills,\n              coordinatorWorkerTurnPlanning,\n              abortSignal: abortController.signal",
    "agent invoke passes notification-selected skill context into the first coordinator runtime"
  )
  assertIncludes(
    agentIpc,
    "const coordinatorWorkerTurnPlanning = createCoordinatorWorkerTurnPlanningState()",
    "agent invoke preserves coordinator worker planning counters across failover runtime rebuilds"
  )
  assertIncludes(
    agentIpc,
    "coordinatorTurnPrompt,\n              coordinatorSelectedSkill,",
    "agent invoke passes turn-scoped coordinator context into the first coordinator runtime"
  )
  assertIncludes(
    agentIpc,
    "coordinatorExplicitSelectedSkill",
    "agent IPC keeps explicit user-selected skills separate from notification-derived coordinator state"
  )
  assertIncludes(
    agentIpc,
    "let resumeCoordinatorTurnPrompt = getActiveOrPersistedCoordinatorTurnPrompt(",
    "agent resume inherits the current coordinator turn context from the active run or persisted thread metadata"
  )
  assertIncludes(
    agentIpc,
    "const resumeCoordinatorSelectedSkill = getActiveOrPersistedCoordinatorSelectedSkill(",
    "agent resume inherits selected skill from the active coordinator run or persisted thread metadata"
  )
  assertIncludes(
    agentIpc,
    "coordinatorTurnPrompt: resumeCoordinatorTurnPrompt",
    "agent resume passes the coordinator turn context into runtime recreation and failover"
  )
  assertIncludes(
    agentIpc,
    "let resumeCoordinatorNotificationSelectedSkills =\n        getActiveOrPersistedCoordinatorNotificationSelectedSkills(threadId, metadata)",
    "agent resume inherits current notification-selected skill context from the active coordinator run or persisted thread metadata"
  )
  assertIncludes(
    agentIpc,
    "coordinatorSelectedSkill: resumeCoordinatorSelectedSkill",
    "agent resume passes selected skill into runtime recreation and failover"
  )
  assertIncludes(
    agentIpc,
    "coordinatorExplicitSelectedSkill: resumeCoordinatorExplicitSelectedSkill",
    "agent resume passes explicit user-selected skill context into runtime recreation and failover"
  )
  assertIncludes(
    agentIpc,
    "coordinatorNotificationSelectedSkills: resumeCoordinatorNotificationSelectedSkills",
    "agent resume passes notification-selected skill context into runtime recreation and failover"
  )
  assertIncludes(
    agentIpc,
    "settleResumeDrainedCoordinatorNotifications",
    "agent resume settles notification consumption for notifications rehydrated into the resumed turn context"
  )
  assertIncludes(
    agentIpc,
    "peekedNotificationSelectedSkills",
    "agent resume and interrupt build selected-skill routing for peeked HITL notifications"
  )
  assertNotIncludes(
    agentIpc,
    "resumeCoordinatorSelectedSkill = deriveSharedCoordinatorSelectedSkill(\n            resumeCoordinatorNotificationSelectedSkills",
    "agent resume does not promote peeked notification skills into the ambient selected skill"
  )
  assertNotIncludes(
    agentIpc,
    "interruptCoordinatorSelectedSkill = deriveSharedCoordinatorSelectedSkill(\n          interruptCoordinatorNotificationSelectedSkills",
    "agent interrupt does not promote peeked notification skills into the ambient selected skill"
  )
  assertIncludes(
    agentIpc,
    "onCoordinatorNotificationAction",
    "agent resume and interrupt expose coordinator notification action callbacks"
  )
  assertIncludes(
    agentIpc,
    'if (resumeAgentMode === "coordinator")',
    "agent resume restores coordinator workers when re-entering a coordinator thread"
  )
  assertIncludes(
    agentIpc,
    "sendCoordinatorWorkers(window, channel, coordinatorWorkerManager.readWorkers(threadId))",
    "agent resume and interrupt push a fresh coordinator worker snapshot after rebinding updates"
  )
  assertIncludes(
    agentIpc,
    "let interruptCoordinatorTurnPrompt = getActiveOrPersistedCoordinatorTurnPrompt(",
    "agent interrupt inherits the current coordinator turn context from the active run or persisted thread metadata"
  )
  assertIncludes(
    agentIpc,
    "const interruptCoordinatorSelectedSkill = getActiveOrPersistedCoordinatorSelectedSkill(",
    "agent interrupt inherits selected skill from the active coordinator run or persisted thread metadata"
  )
  assertIncludes(
    agentIpc,
    "coordinatorTurnPrompt: interruptCoordinatorTurnPrompt",
    "agent interrupt passes the coordinator turn context into runtime recreation and failover"
  )
  assertIncludes(
    agentIpc,
    "let interruptCoordinatorNotificationSelectedSkills =\n      getActiveOrPersistedCoordinatorNotificationSelectedSkills(threadId, metadata)",
    "agent interrupt inherits current notification-selected skill context from the active coordinator run or persisted thread metadata"
  )
  assertIncludes(
    agentIpc,
    "coordinatorSelectedSkill: interruptCoordinatorSelectedSkill",
    "agent interrupt passes selected skill into runtime recreation and failover"
  )
  assertIncludes(
    agentIpc,
    "coordinatorExplicitSelectedSkill: interruptCoordinatorExplicitSelectedSkill",
    "agent interrupt passes explicit user-selected skill context into runtime recreation and failover"
  )
  assertIncludes(
    agentIpc,
    "coordinatorNotificationSelectedSkills: interruptCoordinatorNotificationSelectedSkills",
    "agent interrupt passes notification-selected skill context into runtime recreation and failover"
  )
  assertIncludes(
    agentIpc,
    "resumeForcedByEnvironment",
    "agent resume honors environment-forced coordinator mode"
  )
  assertIncludes(
    agentIpc,
    'interruptCoordinatorRequest.source === "environment"',
    "agent interrupt honors environment-forced coordinator mode"
  )
  assertIncludes(
    agentIpc,
    "BrowserWindow.fromWebContents(event.sender)",
    "agent IPC rebinds coordinator worker update callbacks to the current renderer"
  )
  assertIncludes(
    agentIpc,
    "if (controller && !cancelWorkers) {",
    "agent cancel only aborts the foreground controller for full-turn cancellation, not background worker cancellation"
  )
  assertIncludes(
    agentIpc,
    "suppressNotificationAutoRun: true,\n              dismissNotificationOnTerminalPersist: true",
    "agent cancel marks user-requested background worker cancellation notifications as non-resuming UI updates"
  )
  assertIncludes(
    agentIpc,
    "LocalSandbox.cancelBackgroundTasks(threadId)",
    "agent cancel still revokes foreground thread-scoped background tasks for full-turn cancellation"
  )
  assertIncludes(
    agentIpc,
    "sendCoordinatorWorkers(\n          window,\n          `agent:stream:${threadId}`,\n          coordinatorWorkerManager.readWorkers(threadId)\n        )",
    "agent cancel immediately publishes the full worker snapshot instead of a truncated cancelled-only list"
  )
  assertIncludes(
    agentIpc,
    'console.warn("[Agent] Failed to wait for coordinator worker cancellation:", error)\n            if (!window || window.isDestroyed()) return\n            sendCoordinatorWorkers(',
    "agent cancel publishes a full worker snapshot even when cleanup wait fails"
  )
  assertIncludes(
    agentIpc,
    "COORDINATOR_NOTIFICATION_PROMPT_PREFIX",
    "agent IPC recognizes internal coordinator notification turns"
  )
  assertIncludes(
    agentIpc,
    "coordinatorInternalNotification === true",
    "agent IPC requires a trusted IPC flag before treating a prompt as an internal coordinator notification"
  )
  assertIncludes(
    agentIpc,
    "isTrustedCoordinatorNotificationInvoke",
    "agent IPC identifies trusted internal notification requests before aborting active runs"
  )
  assertSourceOrder(
    agentIpc,
    "if (existingController) {",
    "if (isTrustedCoordinatorNotificationInvoke)",
    "agent IPC checks trusted internal notification requests inside the active-run guard"
  )
  assertSourceOrder(
    agentIpc,
    "if (isTrustedCoordinatorNotificationInvoke)",
    "existingController.abort()",
    "agent IPC no-ops internal notification turns instead of aborting active user runs"
  )
  assertIncludes(
    agentIpc,
    "isTrustedCoordinatorNotificationRequest && !isCoordinatorNotificationTurn",
    "agent IPC treats stale trusted coordinator notification turns as no-op instead of user text"
  )
  assertSourceOrder(
    agentIpc,
    "if (isTrustedCoordinatorNotificationRequest && !isCoordinatorNotificationTurn)",
    "const promptSubmitResult = await runHooksEnriched",
    "agent IPC drops stale internal notification turns before user prompt hooks"
  )
  assertIncludes(
    agentIpc,
    "COORDINATOR_NOTIFICATION_SUPPRESSED_NORMAL_MODE",
    "agent IPC suppresses trusted internal coordinator notification turns after the thread is switched to normal mode"
  )
  assertNotIncludes(
    agentIpc,
    "const suppressedNotifications = coordinatorWorkerManager.drainNotifications(threadId)",
    "agent IPC must not drain pending worker notifications when normal mode suppresses an internal turn"
  )
  assertSourceOrder(
    agentIpc,
    'const hasExplicitNormalAgentMode = metadata.agentMode === "normal"',
    "const shouldPersistAgentMode",
    "agent IPC checks persisted thread mode before processing an internal coordinator notification turn"
  )
  assertIncludes(
    agentIpc,
    "effectiveMessage = `User supplied literal text that resembles an internal coordinator marker",
    "agent IPC escapes user-supplied text that mimics internal coordinator markers"
  )
  assertIncludes(
    agentIpc,
    "containsCoordinatorInternalMarker(effectiveMessage)",
    "agent IPC treats all coordinator internal markers as user-supplied text unless the IPC flag is trusted"
  )
  assertIncludes(
    agentIpc,
    "cmb_internal_coordinator_notification",
    "agent IPC persists a trusted marker on internal coordinator notification HumanMessages"
  )
  assertIncludes(
    agentIpc,
    "isCoordinatorInternalNotificationMessage(msgChunk)",
    "agent Stop hook context ignores trusted internal coordinator notification messages"
  )
  assertIncludes(
    agentIpc,
    "lastUserIndex = i\n        break",
    "agent Stop hook values context treats internal coordinator notification messages as the current-turn boundary"
  )
  assertIncludes(
    agentIpc,
    "isTrustedCoordinatorNotificationInvoke ? undefined : message",
    "agent Stop hook context does not seed internal coordinator notification turns as user messages"
  )
  assertIncludes(
    agentIpc,
    "userMessage: isCoordinatorNotificationTurn ? undefined : message",
    "agent Stop hook context does not override internal coordinator notification turns with placeholder text"
  )
  assertIncludes(
    agentIpc,
    "processing internal worker notification turn",
    "agent IPC skips user-prompt hooks for internal worker notifications"
  )
  assertIncludes(
    agentIpc,
    "!isCoordinatorNotificationTurn && isOnlineSkillEvolutionEnabled()",
    "agent IPC excludes internal worker notifications from skill evolution"
  )
  assertIncludes(
    agentIpc,
    "coordinatorWorkerManager.readWorkers(threadId)",
    "agent IPC refresh endpoint reads current worker state"
  )
  assertIncludes(
    agentIpc,
    "window.webContents.isDestroyed()",
    "agent IPC avoids sending worker updates to destroyed windows"
  )
  assertIncludes(
    agentIpc,
    "function sanitizeStreamDataForRenderer",
    "agent IPC sanitizes stream payloads before renderer IPC"
  )
  assertIncludes(
    agentIpc,
    "sanitizeValuesMessagesForRenderer(messages)",
    "agent IPC keeps only current-turn values-mode messages before renderer IPC"
  )
  assertIncludes(
    agentIpc,
    'type === "human" || type === "user"',
    "agent IPC recognizes plain values-mode human messages while trimming history"
  )
  assertIncludes(
    agentIpc,
    ".slice(currentTurnStart)",
    "agent IPC avoids forwarding full values-mode message history"
  )
  assertIncludes(
    agentIpc,
    "cmb_worker_snapshot_index",
    "agent IPC preserves original checkpoint indexes for worker values fallback IDs"
  )
  assertIncludes(
    agentIpc,
    "[message, effectiveMessage].map(normalizeMessageText)",
    "agent IPC matches values-mode current turn against the effective checkpoint message"
  )
  assertOccurrenceCount(
    agentIpc,
    "data: sanitizeStreamDataForRenderer(mode, serialized)",
    2,
    "resume and interrupt streams sanitize renderer payloads"
  )
  assertSourceOrder(
    agentIpc,
    "const serialized = serializeStreamData(stream.data)",
    "data = sanitizeStreamDataForRenderer(stream.mode, serialized)",
    "focused worker stream serializes LangChain values before renderer sanitization"
  )
  assertNotIncludes(
    agentIpc,
    "sanitizeStreamDataForRenderer(stream.mode, stream.data)",
    "focused worker stream must not sanitize raw LangChain values before serialization"
  )
  assertIncludes(
    agentIpc,
    "data: sanitizeStreamDataForRenderer(mode, payload)",
    "normal invoke stream sanitizes renderer payloads"
  )
  assertIncludes(
    agentIpc,
    "restoreWorkersForThread",
    "agent IPC restores persisted async worker state before coordinator turns"
  )
  assertIncludes(
    agentIpc,
    "drainNotifications(threadId)",
    "agent IPC drains worker notifications into next coordinator turn"
  )
  assertIncludes(
    agentIpc,
    "acknowledgeDeliveredCoordinatorNotificationsIfNeeded",
    "agent IPC acknowledges task-notifications when they are delivered into the coordinator turn, matching Claude Code queue removal"
  )
  assertSourceOrder(
    agentIpc,
    "const humanMessages = [",
    "const acknowledgeDeliveredCoordinatorNotificationsIfNeeded",
    "agent IPC delivery-acknowledges task-notifications only after constructing the internal HumanMessage batch"
  )
  assertSourceOrder(
    agentIpc,
    "for await (const chunk of source)",
    "await acknowledgeDeliveredCoordinatorNotificationsIfNeeded()",
    "agent IPC removes delivered task-notifications from the queue only after the coordinator stream starts producing output"
  )
  assertIncludes(
    agentIpc,
    "const consumedCoordinatorNotificationIds = new Set<string>()",
    "agent IPC still tracks consumed worker notifications for traceability and skill routing"
  )
  assertNotIncludes(
    agentIpc,
    "acknowledgedNotifications = drainedCoordinatorNotifications.filter",
    "agent IPC should not rely on model-selected notification ids to acknowledge a successful turn"
  )
  assertIncludes(
    agentIpc,
    "const unconsumedNotifications = notifications.filter(",
    "agent IPC restores only unconsumed notifications when a turn does not complete successfully"
  )
  assertIncludes(
    agentIpc,
    "const consumedNotifications = notifications.filter(",
    "agent IPC acknowledges consumed notifications on failed turns to avoid duplicating durable worker actions"
  )
  assertIncludes(
    agentIpc,
    "onCoordinatorNotificationAction",
    "agent IPC wires coordinator worker actions into notification traceability"
  )
  assertIncludes(
    agentIpc,
    "consumedCoordinatorNotificationIds.add(",
    "agent IPC records notification ids referenced by worker actions"
  )
  assertNotIncludes(
    agentIpc,
    "drainedCoordinatorNotifications.length === 1",
    "agent IPC should not special-case single notification turns"
  )
  assertIncludes(
    agentIpc,
    'await settleDrainedCoordinatorNotifications("restore")',
    "agent IPC restores notifications only if a turn exits before delivery-acknowledgement, while HITL paths restore unconsumed peeked notifications"
  )
  assertIncludes(
    agentIpc,
    "let coordinatorNotificationsConsumed = false",
    "agent IPC tracks notification acknowledgement separately from stream start"
  )
  assertIncludes(
    agentIpc,
    "const settleDrainedCoordinatorNotifications = async",
    "agent IPC centralizes pre-delivery notification restoration for failure and cancellation"
  )
  assertIncludes(
    agentIpc,
    'data: { type: "coordinator_notification_deferred" }',
    "agent IPC explicitly tells the renderer to retry deferred internal coordinator notification turns"
  )
  assertIncludes(
    agentIpc,
    "buildNormalModeGuardMessage(",
    "agent IPC reports a backend normal-mode guard error when unresolved coordinator work remains"
  )
  assertIncludes(
    agentIpc,
    "await waitForReplacedRunToSettle(threadId)",
    "agent IPC waits for replaced runs to restore drained worker notifications before the next turn"
  )
  assertOccurrenceCount(
    agentIpc,
    "await waitForReplacedRunToSettle(threadId)",
    3,
    "agent IPC waits for replaced runs before invoke, resume, and interrupt continuations"
  )
  assertNotIncludes(
    agentIpc,
    "activeRuns.delete(threadId)\n        await waitForReplacedRunToSettle(threadId)",
    "agent IPC keeps the old active run visible while waiting for replacement cleanup"
  )
  assertIncludes(
    agentIpc,
    "ACTIVE_RUN_REPLACEMENT_MAX_WAIT_MS = 30_000",
    "agent IPC bounds replacement waiting with a hard timeout"
  )
  assertIncludes(
    agentIpc,
    "Promise.race([",
    "agent IPC races prior run settlement against a hard timeout before taking over"
  )
  assertIncludes(
    agentIpc,
    "allowing replacement run to take over with late cleanup risk",
    "agent IPC warns when it must take over before a hung prior run settles"
  )
  assertIncludes(
    agentIpc,
    "renderCoordinatorWorkerNotifications(notifications)",
    "agent IPC renders worker notifications for coordinator"
  )
  assertIncludes(
    agentIpc,
    "MAX_COORDINATOR_NOTIFICATIONS_IN_PROMPT = 12",
    "agent IPC bounds the number of notifications injected into a single coordinator prompt"
  )
  assertIncludes(
    agentIpc,
    "MAX_COORDINATOR_NOTIFICATION_PROMPT_CHARS = 128_000",
    "agent IPC also bounds notification prompt context by total character budget"
  )
  assertIncludes(
    agentIpc,
    "prepareQueuedCoordinatorNotificationsForPrompt(",
    "agent IPC caps notification prompt fan-in before routing and runtime creation"
  )
  assertIncludes(
    agentIpc,
    "deferredNotifications.map((notification) => notification.message)",
    "agent IPC re-queues overflow notifications instead of injecting the entire backlog into one coordinator turn"
  )
  assertIncludes(
    agentIpc,
    'data: { type: "coordinator_notification_deferred" }',
    "agent IPC explicitly schedules follow-up coordinator turns when notification overflow is deferred"
  )
  assertIncludes(
    agentIpc,
    "renderCoordinatorWorkerContext(workersForPromptContext)",
    "agent IPC injects current worker context into coordinator turns without duplicating pending terminal notifications"
  )
  assertIncludes(
    agentIpc,
    "buildCoordinatorNotificationHumanMessage(promptNotifications)",
    "agent IPC delivers worker notifications as a bounded internal HumanMessage for the current coordinator turn"
  )
  assertIncludes(
    agentIpc,
    "[COORDINATOR_VISIBLE_USER_MESSAGE_KEY]: message",
    "agent IPC persists hook-augmented prompts with the original visible user message"
  )
  assertIncludes(
    agentIpc,
    "getCoordinatorVisibleUserMessage(msg)",
    "agent IPC uses visible user message metadata when collecting Stop hook context"
  )
  assertIncludes(
    agentIpc,
    "userHumanMessage",
    "agent IPC includes both normal user input and worker notifications when they arrive in the same coordinator turn"
  )
  assertIncludes(
    agentIpc,
    "persistedCoordinatorTurnPromptForMetadata =\n            buildCoordinatorTurnContextPrompt(runningWorkerContext)",
    "agent IPC persists only worker context metadata, not full worker notification XML"
  )
  assertNotIncludes(
    agentIpc,
    "buildCoordinatorNotificationCommandUpdate",
    "agent resume and interrupt should not insert HumanMessages between pending tool calls and tool results"
  )
  assertIncludes(
    agentIpc,
    "providers require ToolMessage",
    "agent resume documents why restored notifications stay out of HumanMessage command updates"
  )
  assertIncludes(
    agentIpc,
    "Do not drain queued worker",
    "agent interrupt documents tool-call adjacency constraints"
  )
  assertIncludes(
    agentIpc,
    "coordinatorTurnPrompt = buildCoordinatorTurnContextPrompt(",
    "agent IPC keeps restored running worker state in turn-scoped system context"
  )
  assertNotIncludes(
    agentIpc,
    "## Additional Coordinator State Since Pause",
    "resume and interrupt rebuild coordinator turn context from current state instead of appending stale paused-turn context"
  )
  assertNotIncludes(
    agentIpc,
    "mergeCoordinatorTurnPrompts(",
    "agent IPC no longer accumulates coordinator turn prompts across repeated resume or interrupt cycles"
  )
  assertIncludes(
    agentIpc,
    "const routingDecisionMessage = (",
    "agent IPC derives model routing from the effective coordinator turn context"
  )
  assertIncludes(
    agentIpc,
    "message: routingDecisionMessage || effectiveMessage",
    "agent IPC routes coordinator turns using the augmented coordinator context"
  )
  assertIncludes(
    agentIpc,
    "settleResumeDrainedCoordinatorNotifications",
    "agent IPC can settle restored notifications after resume replacement flows"
  )
  assertIncludes(
    agentIpc,
    "settleInterruptDrainedCoordinatorNotifications",
    "agent IPC can settle restored notifications after interrupt replacement flows"
  )
  assertIncludes(
    agentIpc,
    'if (!workspacePath) {\n            safeSendToWindow(window, channel, {\n              type: "error",\n              error: "WORKSPACE_REQUIRED"',
    "agent resume blocks explicit normal-mode fallback when workspace metadata is missing"
  )
  assertSourceOrder(
    agentIpc,
    "coordinatorTurnPrompt = buildCoordinatorTurnContextPrompt(",
    "invokeRoutingResult = await resolveModel({",
    "agent IPC builds coordinator context before model routing runs"
  )
  assertIncludes(
    agentIpc,
    "coordinatorTurnPrompt,",
    "agent IPC forwards turn-scoped coordinator context to the runtime"
  )
  assertIncludes(
    agentIpc,
    "isCoordinatorWorkerStreamChunk(mode, data, threadId)",
    "agent IPC filters async worker stream chunks out of main coordinator stream"
  )
  assertSourceOrder(
    agentIpc,
    "isCoordinatorWorkerStreamChunk(mode, data, threadId)",
    "const serialized = serializeStreamData(data)",
    "agent IPC filters async worker chunks before serializing payloads for renderer forwarding"
  )
  assertIncludes(
    agentIpc,
    "messageStreamMetadata(mode, payload)",
    "agent IPC detects async worker chunks from stream metadata, not message content"
  )
  assertNotIncludes(
    agentIpc,
    "metadata).includes(workerThreadPrefix)",
    "agent IPC avoids broad metadata substring filtering for worker namespace detection"
  )
  assertIncludes(
    agentIpc,
    "compactCoordinatorWorkerText",
    "agent IPC compacts worker context before prompt injection"
  )
  assertIncludes(
    agentIpc,
    "MAX_RUNNING_COORDINATOR_WORKERS_IN_PROMPT = 10",
    "agent IPC caps running worker prompt context to keep coordinator inputs bounded"
  )
  assertIncludes(
    agentIpc,
    "MAX_RUNNING_READ_ONLY_WORKERS_IN_PROMPT = 6",
    "agent IPC gives read-only fan-out a stricter prompt-context cap"
  )
  assertIncludes(
    agentIpc,
    "additional running worker(s) omitted to keep coordinator prompt context bounded",
    "agent IPC tells the coordinator when some running workers were intentionally omitted from prompt context"
  )
  assertIncludes(
    agentIpc,
    "Treat terminal states as already known from their task notifications",
    "worker context discourages duplicate terminal fetches"
  )
  assertIncludes(
    agentIpc,
    "wait for task notifications",
    "worker context follows Claude Code notification-first behavior"
  )
  assertIncludes(agentIpc, "agentMode: effectiveAgentMode", "agent IPC passes mode to runtime")
  assertIncludes(
    agentIpc,
    "onCoordinatorWorkerEvent",
    "agent IPC forwards coordinator worker updates to runtime"
  )
  assertIncludes(agentIpc, "agentMode: interruptAgentMode", "interrupt IPC passes mode to runtime")
  assertIncludes(agentIpc, "agentMode: resumeAgentMode", "resume IPC passes mode to runtime")
  assertNotIncludes(
    agentIpc,
    "Parent coordinator run was replaced by a new invoke.",
    "agent IPC does not cancel durable workers when invoke replaces a foreground run"
  )
  assertNotIncludes(
    agentIpc,
    "Parent coordinator run was replaced by a resume.",
    "agent IPC does not cancel durable workers when resume replaces a foreground run"
  )
  assertNotIncludes(
    agentIpc,
    "Parent coordinator run was replaced by an interrupt.",
    "agent IPC does not cancel durable workers when interrupt replaces a foreground run"
  )
  assertNotIncludes(
    agentIpc,
    "Window closed while coordinator run was active.",
    "agent IPC does not cancel durable workers when a foreground window closes"
  )
  assertIncludes(
    agentIpc,
    'window.removeListener("closed", onWindowClosed)',
    "agent IPC removes window-close listeners after each run"
  )
  assertIncludes(
    agentIpc,
    "currentController === abortController",
    "agent IPC does not delete a newer active run during old-run cleanup"
  )
  assertIncludes(
    agentIpc,
    'await settleDrainedCoordinatorNotifications("ack")',
    "agent IPC still finalizes delivered task-notifications after a successful turn"
  )
  assertIncludes(
    agentIpc,
    "coordinatorNotificationsDelivered",
    "agent IPC separates task-notification delivery ack from final turn settlement"
  )
  assertIncludes(
    agentIpc,
    "withActiveRunReplacementLock(threadId",
    "agent IPC serializes replacement run startup for each thread"
  )
  assertIncludes(
    replacementLock,
    "const queued = previous",
    "replacement lock stores the queued promise so thread locks can be released"
  )
  assertIncludes(
    replacementLock,
    "this.pending.get(key) === queued",
    "replacement lock clears entries by comparing the queued promise identity"
  )
  assertNotIncludes(
    replacementLock,
    "this.pending.get(key) === current",
    "replacement lock does not compare entries against the raw unresolved promise"
  )
  assertIncludes(
    agentIpc,
    "replacedByNewRun",
    "agent IPC defers shared sandbox cleanup when a newer run owns the same thread"
  )
  assertIncludes(
    agentIpc,
    "nextResumeRunSettledPromise",
    "agent resume registers settled state so replacement runs wait for cleanup"
  )
  assertIncludes(
    agentIpc,
    "nextInterruptRunSettledPromise",
    "agent interrupt registers settled state so replacement runs wait for cleanup"
  )
  assertIncludes(
    agentIpc,
    "Keep activeRuns populated until the run's finally block resolves activeRunSettled",
    "agent cancel keeps the active run visible until cleanup settles"
  )
  assertIncludes(
    agentIpc,
    "User cancelled coordinator workers.",
    "agent IPC cancels workers only on explicit background-worker stop"
  )
  assertIncludes(
    agentIpc,
    "void coordinatorWorkerManager\n          .waitForWorkerCleanup",
    "agent IPC waits for explicit worker stop cleanup without blocking the cancel response"
  )
  assertIncludes(
    agentIpc,
    "coordinatorWorkerManager.acknowledgeNotifications(\n              threadId,\n              workers.map((worker) => worker.worker_id)",
    "agent IPC acknowledges explicitly cancelled worker notifications to avoid an extra auto coordinator turn"
  )
  assertIncludes(
    agentIpc,
    "dismissNotificationOnTerminalPersist: true",
    "agent IPC marks explicit background worker stops as dismissed terminal notifications"
  )
  assertIncludes(
    agentIpc,
    "Failed to wait for coordinator worker cancellation",
    "agent IPC logs background worker cancellation persistence failures"
  )

  const threadsIpc = await readProjectFile("src/main/ipc/threads.ts")
  assertIncludes(
    threadsIpc,
    "closeWorkerCheckpointersForThread(threadId)",
    "thread deletion closes worker checkpointers"
  )
  assertIncludes(
    threadsIpc,
    "deleteThreadWorkerCheckpoints(threadId)",
    "thread deletion removes worker checkpoint files"
  )
  assertIncludes(
    threadsIpc,
    "coordinatorWorkerManager.forgetThread(threadId)",
    "thread deletion clears in-memory worker state"
  )
  assertIncludes(
    threadsIpc,
    "forgetCoordinatorThreadState(threadId)",
    "thread deletion clears thread-scoped coordinator prompt and skill caches"
  )
  assertIncludes(
    threadsIpc,
    "assertCanPersistExplicitNormalMode(",
    "threads IPC rejects explicit normal-mode transitions while coordinator work is unresolved"
  )
  assertIncludes(
    threadsIpc,
    "if (!workspacePath) {\n    const workers = coordinatorWorkerManager.readWorkers(threadId)",
    "threads IPC allows empty coordinator threads without a workspace to switch back to normal after checking in-memory unresolved work"
  )
  assertIncludes(
    threadsIpc,
    "notification_acknowledged === false",
    "threads IPC normal-mode guard treats unresolved worker results as blocking"
  )
  assertIncludes(
    threadsIpc,
    "deleteCoordinatorWorkerArtifacts(threadId, workspacePath)",
    "thread deletion removes coordinator worker artifacts"
  )
  assertIncludes(
    threadsIpc,
    "Timed out waiting for coordinator worker cleanup",
    "thread deletion logs cleanup timeout warnings instead of aborting the rest of teardown"
  )
  assertSourceOrder(
    threadsIpc,
    "await waitForCleanupBestEffort()",
    "dbDeleteThread(threadId)",
    "thread deletion continues metadata cleanup after worker cleanup timeouts"
  )
}

async function testWorkspaceSwitchGuardsRunningCoordinatorWorkers(): Promise<void> {
  const modelsIpc = await readProjectFile("src/main/ipc/models.ts")
  assertIncludes(
    modelsIpc,
    'from "../agent/coordinator-worker-manager"',
    "workspace IPC can inspect coordinator worker state"
  )
  assertIncludes(
    modelsIpc,
    "assertWorkspaceSwitchAllowed",
    "workspace IPC has a backend guard for workspace switching"
  )
  assertIncludes(
    modelsIpc,
    "normalizeTrackedPath(currentPath)",
    "workspace IPC normalizes the current workspace path before deciding whether a switch is real"
  )
  assertIncludes(
    modelsIpc,
    "normalizeTrackedPath(nextPath)",
    "workspace IPC normalizes the next workspace path before deciding whether a switch is real"
  )
  assertIncludes(
    modelsIpc,
    "if (hasActiveAgentRun(threadId)) {",
    "workspace IPC blocks switching workspaces while a foreground run is still executing"
  )
  assertIncludes(
    modelsIpc,
    "当前线程仍有前台请求在执行，请等待该轮完成后再切换工作区。",
    "workspace IPC reports a clear error when a foreground turn blocks workspace switching"
  )
  assertIncludes(
    modelsIpc,
    'await coordinatorWorkerManager.restoreWorkersForThread({\n      parentThreadId: threadId,\n      workspacePath: currentPath,\n      mode: "active"',
    "workspace IPC only restores unresolved coordinator worker state before switching workspace"
  )
  assertIncludes(
    modelsIpc,
    "const workers = coordinatorWorkerManager.readWorkers(threadId)",
    "workspace IPC inspects restored coordinator workers before switching"
  )
  assertIncludes(
    modelsIpc,
    'worker.status === "running" || worker.notification_acknowledged === false',
    "workspace IPC blocks switching only while a worker is running or has an unhandled notification"
  )
  assertIncludes(
    modelsIpc,
    "coordinatorWorkerManager.forgetThread(threadId)",
    "workspace IPC clears terminal acknowledged coordinator worker state before switching workspace"
  )
  assertIncludes(
    modelsIpc,
    "forgetCoordinatorThreadState(threadId)",
    "workspace IPC clears thread-scoped coordinator prompt and skill caches before switching workspace"
  )
  assertSourceOrder(
    modelsIpc,
    "await coordinatorWorkerManager.waitForWorkerCleanup(threadId)",
    "coordinatorWorkerManager.forgetThread(threadId)",
    "workspace IPC waits for pending worker persistence before deleting old-workspace artifacts"
  )
  assertIncludes(
    modelsIpc,
    "deleteCoordinatorWorkerArtifacts(threadId, currentPath)",
    "workspace IPC removes terminal acknowledged coordinator artifacts from the old workspace before switching"
  )
  assertOccurrenceCount(
    modelsIpc,
    "assertWorkspaceSwitchAllowed(threadId, metadata.workspacePath",
    2,
    "workspace:set and workspace:select both enforce the running worker guard"
  )
}

async function testRuntimeKeepsNormalAndCoordinatorSeparate(): Promise<void> {
  const runtime = await readProjectFile("src/main/agent/runtime.ts")
  const coordinatorMode = await readProjectFile("src/main/agent/coordinator-mode.ts")
  const workerManager = await readProjectFile("src/main/agent/coordinator-worker-manager.ts")
  const workerAccess = await readProjectFile("src/main/agent/coordinator-worker-access.ts")
  assertIncludes(runtime, 'agentMode = "normal"', "runtime defaults to normal mode")
  assertIncludes(
    runtime,
    "disableSubagents?: boolean",
    "runtime exposes explicit leaf-runtime subagent disable option"
  )
  assertIncludes(
    runtime,
    "coordinatorTurnPrompt?: string",
    "runtime exposes a turn-scoped coordinator prompt channel separate from project instructions"
  )
  assertIncludes(
    runtime,
    "mainSubagentsEnabled = true",
    "createDeepAgent keeps synchronous task enabled by default"
  )
  assertIncludes(
    runtime,
    'const isCoordinatorMode = agentMode === "coordinator"',
    "runtime mode guard"
  )
  assertIncludes(
    runtime,
    "turnContext: coordinatorTurnPrompt",
    "runtime injects turn-scoped coordinator state only into the main coordinator system prompt"
  )
  assertIncludes(runtime, "getRuntimeTimeContext()", "runtime creates shared time context")
  assertIncludes(
    runtime,
    "Timestamp rule: Do not invent dates or timestamps",
    "runtime subagent prompt time rule"
  )
  assertIncludes(
    runtime,
    "workerTools: coordinatorWorkerTools",
    "runtime creates coordinator tools with async worker delegate"
  )
  assertIncludes(
    runtime,
    "coordinatorWorkerManager.startWorkerAndPersist",
    "runtime starts async workers only after initial state is durable"
  )
  assertIncludes(
    runtime,
    "coordinatorWorkerManager.continueWorkerAndPersist",
    "runtime continues async workers only after continuation state is durable"
  )
  assertIncludes(
    runtime,
    "threadId: workerInput.workerThreadId",
    "runtime uses worker thread id for async worker checkpoint"
  )
  assertIncludes(
    runtime,
    "approvalThreadId: workerInput.parentThreadId",
    "runtime routes worker approvals to the parent thread UI"
  )
  assertIncludes(
    runtime,
    "approvalThreadId = requestedApprovalThreadId ?? threadId",
    "runtime defaults approvals to the runtime thread for normal mode"
  )
  assertIncludes(
    runtime,
    "approvalStore = getOrCreateApprovalStore(approvalThreadId)",
    "runtime stores worker approval-session decisions on the parent approval thread"
  )
  assertIncludes(
    runtime,
    "approval:request:${approvalThreadId}",
    "runtime sends approval requests on the UI approval channel"
  )
  assertIncludes(
    runtime,
    "approval:timeout:${approvalThreadId}",
    "runtime sends approval timeouts on the UI approval channel"
  )
  assertIncludes(
    runtime,
    'options.abortSignal?.addEventListener("abort", onAbort',
    "runtime rejects pending approvals when the owning run is aborted"
  )
  assertIncludes(
    runtime,
    "configurable: { thread_id: workerInput.workerThreadId }",
    "runtime streams async worker on worker thread id"
  )
  assertIncludes(
    runtime,
    "extraSystemPrompt: `${workerRolePrompt}\\n\\n${workerMetadataPrompt}`",
    "runtime injects worker role prompt into async worker"
  )
  assertIncludes(
    runtime,
    "getCoordinatorScratchpadDir(workerInput.parentThreadId)",
    "runtime injects a durable scratchpad path into async worker metadata"
  )
  assertIncludes(
    runtime,
    "normal tool availability, approval, hook, and access limits still apply",
    "runtime keeps scratchpad guidance honest about existing write policies"
  )
  assertIncludes(
    runtime,
    "Access limits: read-only worker",
    "runtime tells read-only workers which tools are unavailable"
  )
  assertIncludes(
    runtime,
    "browser_playwright, deferred tools, and eager MCP tools are unavailable",
    "runtime tells read-only workers that browser/deferred/eager MCP tools are unavailable"
  )
  assertIncludes(
    runtime,
    "run validation commands, and use browser_playwright",
    "runtime tells verifier workers browser verification is available when the tool exists"
  )
  assertIncludes(
    runtime,
    "write it only under /tmp or $TMPDIR",
    "runtime tells verifier workers temporary harness writes must stay outside the workspace"
  )
  assertIncludes(
    runtime,
    "if (isConstrainedCoordinatorWorker)",
    "runtime branches constrained coordinator workers onto a lightweight capability-discovery path"
  )
  assertIncludes(
    runtime,
    "Access limits: verifier worker",
    "runtime tells verifier workers they can run checks but cannot write"
  )
  assertIncludes(
    runtime,
    "Access limits: scoped write worker",
    "runtime tells scoped write workers execute/task_output are unavailable"
  )
  assertIncludes(
    runtime,
    "Skipping MCP and deferred tool discovery for constrained coordinator worker",
    "runtime skips capability discovery work for constrained coordinator workers"
  )
  assertIncludes(
    runtime,
    "coordinatorWorkerManager.readWorkers",
    "runtime reads async worker state"
  )
  assertIncludes(
    runtime,
    "coordinatorWorkerManager.waitForWorkers",
    "runtime waits for async worker state without polling spam"
  )
  assertNotIncludes(
    runtime,
    "readWorkerState: async",
    "runtime should not expose worker state polling through coordinator tools"
  )
  assertNotIncludes(
    runtime,
    "readWorkerResult: async",
    "runtime should not expose worker result reads through coordinator tools"
  )
  assertIncludes(
    runtime,
    "const returnedWorkers = input.workerId",
    "runtime still returns the cancelled worker subset after coordinator cancellation"
  )
  assertIncludes(
    runtime,
    "suppressNotificationAutoRun: true,\n                    dismissNotificationOnTerminalPersist: true",
    "runtime marks cancel_worker notifications as dismissed terminal work instead of separately re-acking them"
  )
  assertIncludes(
    runtime,
    "workerInput.prompt",
    "runtime passes the current worker prompt to stream parsers"
  )
  assertNotIncludes(
    runtime,
    "extractWorkerTranscriptLine(mode, data)",
    "runtime no longer writes async worker transcript debug files"
  )
  assertIncludes(
    runtime,
    "const valuesContext = createWorkerValuesSnapshotContext(",
    "runtime precomputes a shared values-mode stream context once per chunk"
  )
  assertIncludes(
    runtime,
    "observeWorkerSkillUsage(mode, data, workerSkillUsageDetector, valuesContext)",
    "runtime reuses the shared values context for worker skill usage tracking"
  )
  assertIncludes(
    runtime,
    "extractWorkerUsage(mode, data, effectiveWorkerPrompt, valuesContext)",
    "runtime reuses the shared values context for async worker token usage"
  )
  assertIncludes(
    runtime,
    "extractWorkerFinalText(mode, data, effectiveWorkerPrompt, valuesContext)",
    "runtime reuses the shared values context for final worker text extraction"
  )
  assertNotIncludes(
    runtime,
    "extractWorkerUsage(mode, data, effectiveWorkerPrompt)",
    "runtime should not re-run values-mode usage extraction without the shared stream context"
  )
  assertIncludes(
    runtime,
    "const effectiveWorkerPrompt = await applyWorkerPromptSubmitHooks({",
    "runtime applies turn-level UserPromptSubmit hooks to async coordinator workers"
  )
  assertIncludes(
    runtime,
    "sessionId: workerInput.workerThreadId",
    "runtime uses workerThreadId consistently as the hook session for async coordinator workers"
  )
  assertIncludes(
    runtime,
    "const workerRoutingResult = await resolveModel({",
    "runtime routes coordinator workers through the shared model selection pipeline"
  )
  assertIncludes(
    runtime,
    "worker: event.worker,",
    "runtime emits single-worker progress deltas for coordinator workers"
  )
  assertNotIncludes(
    runtime,
    "workers: coordinatorWorkerManager.readWorkers(threadId)",
    "runtime no longer serializes the full worker list for every high-frequency coordinator progress event"
  )
  assertIncludes(
    runtime,
    "const workerOrderedChain = buildOrderedChain(",
    "runtime builds failover chains for coordinator workers"
  )
  assertIncludes(
    runtime,
    "messageModeAssistantTextTruncated",
    "runtime stops appending worker final-text deltas after the raw handoff cap is reached"
  )
  assertIncludes(
    runtime,
    "handoff_workload: read_only",
    "runtime makes missing-handoff retry prompts match the read-only fallback runtime"
  )
  assertIncludes(
    runtime,
    "Access limits: read-only handoff continuation.",
    "runtime makes missing-handoff retry prompts explicitly prohibit file and command side effects"
  )
  assertIncludes(
    runtime,
    "runWorkerStopHooksWithRevision({",
    "runtime applies Stop-hook revision gates to async coordinator workers"
  )
  assertIncludes(
    runtime,
    "const workerSkillUsageDetector = new SkillUsageDetector()",
    "runtime tracks worker skill usage for Stop hook context"
  )
  assertIncludes(
    runtime,
    "usedSkills: workerSkillUsageDetector.getUsedSkillNames()",
    "runtime forwards detected worker skill usage into Stop hook context"
  )
  assertIncludes(runtime, "workload: input.workload", "runtime forwards worker workload")
  assertIncludes(runtime, "ownedFiles: input.ownedFiles", "runtime forwards worker owned files")
  assertIncludes(
    runtime,
    "onCoordinatorWorkerEvent",
    "runtime exposes async worker UI event callback"
  )
  assertIncludes(
    runtime,
    "coordinatorWorkerManager.cancelWorkersForThread",
    "runtime cancels async workers"
  )
  assertIncludes(
    runtime,
    "LocalSandbox.cancelBackgroundTasks(workerInput.workerThreadId)",
    "runtime cancels worker-scoped background tasks after async worker run"
  )
  assertIncludes(
    runtime,
    'workerInput.abortSignal.addEventListener("abort", cancelWorkerBackgroundTasks, { once: true })',
    "runtime cancels worker-scoped background tasks immediately on abort"
  )
  assertIncludes(
    runtime,
    "Coordinator worker aborted before runtime creation",
    "runtime avoids creating a heavy worker runtime after cancellation"
  )
  assertIncludes(
    runtime,
    "applyCoordinatorWorkerFilesystemAccess",
    "runtime applies coordinator worker file-access limits"
  )
  assertIncludes(
    workerAccess,
    "function blockedToolNamesForAccess",
    "worker access policy centralizes constrained-worker blocked tool names"
  )
  assertIncludes(
    workerAccess,
    "...deferredExecutionToolNames",
    "worker access policy blocks deferred execution surfaces for constrained coordinator workers"
  )
  assertIncludes(
    workerAccess,
    '"search_tool"',
    "worker access policy blocks deferred search tooling for constrained coordinator workers"
  )
  assertIncludes(
    workerAccess,
    'directWriteToolNames = new Set(["write_file", "edit_file"])',
    "worker access policy can remove only direct write tools for verifier workers"
  )
  assertIncludes(
    workerAccess,
    'access.workload === "verify"',
    "worker access policy keeps execute available for verifier workers while removing direct writes"
  )
  assertIncludes(
    workerAccess,
    'new Set(["execute", "task_output", ...deferredToolNames, ...externalSideEffectToolNames])',
    "worker access policy removes shell/browser execution from owned_files-scoped write workers"
  )
  assertIncludes(
    runtime,
    "const finalTools = filterCoordinatorWorkerFinalTools(",
    "runtime applies worker file-access limits to final/deferred tools too"
  )
  assertIncludes(
    runtime,
    "isConstrainedCoordinatorWorker",
    "runtime detects constrained coordinator workers"
  )
  assertIncludes(
    runtime,
    "Skipping MCP and deferred tool discovery for constrained coordinator worker",
    "runtime skips MCP discovery entirely for constrained coordinator workers"
  )
  assertIncludes(
    workerAccess,
    "ownedFileGuardToolNames = new Set",
    "worker access policy guards direct write tools for owned_files workers"
  )
  assertIncludes(
    workerManager,
    "function normalizeOwnedFiles(files?: string[], workspacePath?: string): string[]",
    "worker manager normalizes owned_files with workspace-aware path semantics"
  )
  assertIncludes(
    workerManager,
    "const workspaceRoot = path.resolve(workspacePath ?? process.cwd())",
    "worker manager derives owned_files match keys from the actual workspace root"
  )
  assertIncludes(
    workerManager,
    "coordinatorFileMatchKey(resolveCoordinatorPath(path.resolve(workspaceRoot, file)))",
    "worker manager dedupes owned_files using workspace-aware canonical path keys"
  )
  assertIncludes(
    workerManager,
    "if (!isCoordinatorPathWithin(resolvedOwnedFile, workspaceRoot))",
    "worker manager rejects owned_files entries that escape the workspace through symlinks"
  )
  assertIncludes(
    workerManager,
    "normalizeOwnedFiles(options.ownedFiles, workspacePath)",
    "worker manager passes start_worker workspacePath into owned_files normalization"
  )
  assertIncludes(
    workerManager,
    "normalizeOwnedFiles(snapshot.owned_files, workspacePath)",
    "worker manager restores owned_files using the persisted worker workspace"
  )
  assertIncludes(
    workerAccess,
    "runtimeTool.invoke(input, config)",
    "owned_files write-tool wrapper preserves LangChain tool runtime/config"
  )
  const localSandbox = await readProjectFile("src/main/agent/local-sandbox.ts")
  assertIncludes(
    localSandbox,
    'if (this.isAborted) {\n      return { error: "文件写入已取消。" }',
    "local sandbox rechecks cancellation after write approval before writing"
  )
  assertIncludes(
    localSandbox,
    'if (preResult?.blocked) {\n      return { error: `[Hook blocked] ${preResult.stdout || "write_file was blocked by a hook"}` }\n    }\n    if (this.isAborted) {\n      return { error: "文件写入已取消。" }\n    }',
    "local sandbox checks cancellation after write PreToolUse hook before resolving/writing"
  )
  assertIncludes(
    localSandbox,
    'if (this.isAborted) {\n      return { error: "文件编辑已取消。" }',
    "local sandbox rechecks cancellation after edit approval before editing"
  )
  assertIncludes(
    localSandbox,
    'if (preResult?.blocked) {\n      return { error: `[Hook blocked] ${preResult.stdout || "edit_file was blocked by a hook"}` }\n    }\n    if (this.isAborted) {\n      return { error: "文件编辑已取消。" }\n    }',
    "local sandbox checks cancellation after edit PreToolUse hook before reading/writing"
  )
  assertSourceOrder(
    localSandbox,
    'if (this.isAborted) {\n          return { error: "文件编辑已取消。" }',
    "await this.writeFileEncoded(resolvedPath, expectedContent, encoding)",
    "local sandbox checks cancellation immediately before encoded edit write"
  )
  assertIncludes(
    runtime,
    "filesystemAccess: {\n              workload: workerInput.workload",
    "runtime passes worker workload into leaf runtime file-access limits"
  )
  assertIncludes(
    runtime,
    "do not loop the same call and instead report the blocking file/action back to the coordinator",
    "runtime warns write workers not to spin on denied file edits"
  )
  assertIncludes(
    coordinatorMode,
    "Notifications include a bounded <result> handoff from the worker.",
    "coordinator prompt tells the model to rely on pushed worker results"
  )
  assertIncludes(
    coordinatorMode,
    "toCoordinatorWorkerToolSnapshot",
    "coordinator worker tools strip internal fields before returning worker snapshots to the model"
  )
  assertIncludes(
    coordinatorMode,
    "Cancelled workers cannot be continued in CmbCowork",
    "coordinator prompt distinguishes CmbCowork final cancellation from Claude Code resumable stop"
  )
  assertNotIncludes(
    coordinatorMode,
    'name: "read_worker_result"',
    "coordinator should not expose result reads as a default tool"
  )
  assertNotIncludes(
    coordinatorMode,
    'name: "read_worker_state"',
    "coordinator should not expose state polling as a default tool"
  )
  assertIncludes(
    runtime,
    "filesystemAccess: options.filesystemAccess",
    "runtime forwards worker file-access limits into createDeepAgent filesystem middleware"
  )
  assertSourceOrder(
    runtime,
    "filesystemAccess: options.filesystemAccess",
    "taskSystemPrompt: isCoordinatorMode",
    "runtime forwards file-access limits before createDeepAgent builds task/filesystem middleware"
  )
  assertIncludes(
    runtime,
    "closeCheckpointer(workerInput.workerThreadId)",
    "runtime releases worker checkpointer resources when a worker turn finishes"
  )
  assertIncludes(
    runtime,
    "checkpointers.delete(threadId)\n    await checkpointer.close()",
    "runtime removes checkpointer from cache before awaiting close"
  )
  assertIncludes(
    runtime,
    'if (parentThreadId.includes("__worker__"))',
    "runtime refuses ambiguous worker-checkpoint cleanup requests for invalid parent thread ids"
  )
  assertIncludes(
    runtime,
    "await Promise.allSettled",
    "runtime waits for worker resource cleanup before a worker run resolves"
  )
  assertIncludes(
    runtime,
    "Promise.resolve().then(cancelWorkerBackgroundTasks)",
    "runtime keeps worker ACL/checkpointer cleanup running even if background-task cancellation throws"
  )
  assertIncludes(
    runtime,
    'workerInput.abortSignal.removeEventListener("abort", cancelWorkerBackgroundTasks)',
    "runtime removes async worker abort cleanup listeners"
  )
  assertIncludes(
    runtime,
    "LocalSandbox.revokeGrantedAclsForRun(workerInput.workerThreadId)",
    "runtime revokes worker-scoped sandbox ACLs after async worker run"
  )
  assertIncludes(
    runtime,
    "systemPrompt = buildCoordinatorSystemPrompt",
    "runtime replaces normal prompt in coordinator mode"
  )
  assertIncludes(runtime, "threadId,", "runtime passes threadId into coordinator prompt")
  assertIncludes(
    runtime,
    "timezone: timeContext.timezone",
    "runtime passes timezone into coordinator prompt"
  )
  assertIncludes(
    runtime,
    "currentTime: timeContext.currentTime",
    "runtime passes current time into coordinator prompt"
  )
  assertIncludes(
    runtime,
    "Current time: ${timeContext.currentTime}",
    "runtime keeps subagent time format aligned with normal mode"
  )
  assertIncludes(
    runtime,
    "mainTools = isCoordinatorMode ? coordinatorWorkerToolsForMain : finalTools",
    "runtime main tool split"
  )
  assertIncludes(runtime, "workerTools = finalTools", "runtime keeps full tools for workers")
  assertIncludes(runtime, "subagentDefaultTools: workerTools", "runtime worker tool split")
  assertOccurrenceCount(
    runtime,
    "createSubAgentMiddleware({",
    1,
    "runtime should have exactly one synchronous task middleware construction site"
  )
  assertSourceOrder(
    runtime,
    "...(mainSubagentsEnabled",
    "createSubAgentMiddleware({",
    "runtime guards the synchronous task middleware behind mainSubagentsEnabled"
  )
  assertIncludes(
    runtime,
    "mainTodosEnabled: !isCoordinatorMode",
    "runtime disables coordinator todos"
  )
  assertIncludes(
    runtime,
    "mainFilesystemEnabled: !isCoordinatorMode",
    "runtime disables coordinator filesystem"
  )
  assertIncludes(
    runtime,
    "includeGeneralPurposeSubagent: !isCoordinatorMode",
    "runtime hides general worker in coordinator"
  )
  assertIncludes(
    runtime,
    "mainSubagentsEnabled: !isCoordinatorMode",
    "runtime disables synchronous task subagents in coordinator"
  )
  assertIncludes(
    runtime,
    "disableSubagents = false",
    "runtime keeps synchronous task enabled by default for normal mode"
  )
  assertIncludes(
    runtime,
    "disableSubagents: true",
    "runtime disables synchronous task inside coordinator async workers"
  )
  assertIncludes(
    runtime,
    "mainSubagentsEnabled: !isCoordinatorMode && !disableSubagents",
    "runtime combines coordinator mode and leaf-worker subagent disabling"
  )
  assertIncludes(
    coordinatorMode,
    "notificationIds.some((notificationId) => !notificationSelectedSkills[notificationId])",
    "coordinator worker tools refuse to inherit a selected skill when any consumed notification in the batch has no skill"
  )
  assertSourceOrder(
    runtime,
    'agentMode: "normal",\n            disableSubagents: true',
    "workerStream = await workerAgent.stream",
    "async worker disables synchronous task before streaming starts"
  )
  assertIncludes(
    runtime,
    'enableAgentsPrompt: false,\n            agentMode: "normal",\n            disableSubagents: true,\n            filesystemAccess: {',
    "async worker disables prompt/subagent inheritance before applying worker access limits"
  )
  assertIncludes(
    runtime,
    "callbacks: [],\n        signal: workerInput.abortSignal",
    "async worker stream clears inherited callbacks before listening to background output"
  )
  assertSourceOrder(
    runtime,
    "coordinatorWorkerToolsForMain = isCoordinatorMode\n    ? createCoordinatorWorkerTools",
    "mainTools = isCoordinatorMode ? coordinatorWorkerToolsForMain : finalTools",
    "async worker tools are gated behind coordinator mode before main tool selection"
  )
  assertSourceOrder(
    runtime,
    "mainTools = isCoordinatorMode ? coordinatorWorkerToolsForMain : finalTools",
    "createDeepAgent({",
    "normal mode receives finalTools while coordinator receives only coordinator tools"
  )
  assertIncludes(
    runtime,
    "const coordinatorSubagents: ReturnType<typeof buildCoordinatorWorkerSubagents> = []",
    "runtime does not expose coordinator workers through synchronous task in coordinator"
  )
  assertIncludes(
    runtime,
    "timeContext",
    "runtime passes time context into async coordinator workers"
  )
  assertIncludes(
    runtime,
    "selectedSkill: options.coordinatorSelectedSkill",
    "runtime forwards the structured selected skill into coordinator worker tools"
  )
  assertIncludes(
    runtime,
    "buildCoordinatorTaskPrompt(threadId)",
    "runtime scopes task prompt to threadId"
  )
  assertIncludes(
    runtime,
    "skills: mainSkillSources",
    "runtime avoids injecting full skill middleware into coordinator main thread"
  )
  assertIncludes(
    runtime,
    "memory: mainMemorySources",
    "runtime avoids injecting memory middleware into coordinator main thread"
  )
  assertIncludes(
    workerManager,
    "activeRestoreHydratedWorkspaceByParent",
    "worker manager remembers when active restore has already hydrated a thread/workspace in this process"
  )
  assertIncludes(
    workerManager,
    'options.mode === "active" &&\n      this.activeRestoreHydratedWorkspaceByParent.get(parentThreadId) === workspacePath',
    "worker manager skips repeated active restore disk scans after the same thread/workspace has been hydrated"
  )
}

async function run(): Promise<void> {
  await testIpcTypesExposeAgentMode()
  console.log("PASS coordinator IPC types")
  await testRendererSendsAgentMode()
  console.log("PASS coordinator renderer/preload plumbing")
  await testMainResolvesAndPersistsMode()
  console.log("PASS coordinator main IPC mode handling")
  await testWorkspaceSwitchGuardsRunningCoordinatorWorkers()
  console.log("PASS coordinator workspace switch guard")
  await testRuntimeKeepsNormalAndCoordinatorSeparate()
  console.log("PASS coordinator runtime isolation")
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
