import { IpcMain, BrowserWindow, dialog, type IpcMainInvokeEvent } from "electron"
import { constants as fsConstants, existsSync } from "fs"
import { copyFile, lstat, mkdir } from "fs/promises"
import path from "path"
import Store from "electron-store"
import AdmZip from "adm-zip"
import { v4 as uuid } from "uuid"
import {
  copyThreadSubagentManifestRowsPage,
  getThreadCore,
  getThreadHydrationCore,
  getThreadValuesJson,
  getThreadValuesJsonPage,
  getThreadMessages,
  getThreadMessageIdentityContext,
  getThreadMessagesAfterAnyId,
  getThreadMessagesByIds,
  getThreadMessagesPage,
  searchThreadMessages,
  getThreadSubagentManifestAt,
  getThreadSubagentBucketIdPage,
  getThreadSubagentManifestForwardPage,
  getThreadSubagentManifestJsonPage,
  getThreadSubagentManifestPage,
  getThreadSubagentManifestBlobReferenceHashes,
  getThreadSubagentTextJournalChunkPage,
  appendThreadSubagentManifestTextDeltas,
  patchThreadSubagentManifestPreservingTextJournal,
  threadSubagentManifestHasTextJournal,
  upsertThreadSubagentManifestMessages,
  getThreadGoalEvents,
  getThreadGoalEventsHydrationFallback,
  addThreadGoalEvent,
  flushStrict as flushDbStrict,
  createThread as dbCreateThread,
  updateThread as dbUpdateThread,
  mergeThreadValues as dbMergeThreadValues,
  replaceThreadMessageId,
  upsertThreadMessages,
  deleteThread as dbDeleteThread,
  type ThreadRow
} from "../db"
import {
  withCheckpointer,
  clearToolConcurrencyLocksForThread,
  retireThreadCheckpointers,
  pendingApprovals
} from "../agent/runtime"
import {
  cancelAndWaitForAgentThreadRun,
  disposeAgentThreadState,
  disposeDeletedAgentThreadRuntime,
  forgetCoordinatorThreadState,
  hasActiveAgentRun,
  isActiveAgentRunAborting,
  waitForActiveAgentRunToSettle
} from "./agent"
import {
  deleteThreadCheckpoint,
  deleteThreadWorkerCheckpoints,
  deleteThreadWorkflowCheckpoints,
  getThreadCheckpointPath,
  getDbPath,
  getOpenworkDir,
  purgeThreadCheckpointArtifacts
} from "../storage"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { workflowRunManager } from "../agent/workflow/run-manager"
import {
  commitWorkflowThreadDisposal,
  deleteWorkflowRunsForThread,
  isWorkflowThreadMarkedDisposed,
  countUnresolvedWorkflowWorktrees,
  markWorkflowThreadDisposed,
  rollbackWorkflowThreadDisposal
} from "../agent/workflow/run-store"
import {
  coordinatorWorkerManager,
  deleteCoordinatorWorkerArtifacts
} from "../agent/coordinator-worker-manager"
import { getAgentModeFromMetadata } from "../agent/coordinator-mode"
import { isAgentOutputStyle } from "../../shared/agent-output-style"
import { deleteTaskMmdThread } from "../agent/task-mmd/storage"
import {
  deleteProjectThreadDataDirectory,
  getProjectThreadDataDirectory
} from "../agent/context-history-path"
import { generateTitle } from "../services/title-generator"
import {
  finalizeWorkflowWorktreeRecord,
  identifyRepository,
  listWorkflowWorktreeRecordsForPrune
} from "../services/git-worktree"
import { fireSessionEnd } from "../hooks/session-lifecycle"
import { makeHookResultCallback } from "../hooks/result-callback"
import { getDefaultModel } from "./models"
import { stopWatching } from "../services/workspace-watcher"
import type {
  ForkableCheckpoint,
  Message,
  Thread,
  ThreadForkCheckpointForMessageParams,
  ThreadForkParams,
  ThreadForkResponse,
  SubagentTranscriptBlobField,
  ThreadMessageSearchOptions,
  ThreadHydrationOptions,
  ThreadSummaryPageOptions,
  ThreadMessagesPageOptions,
  ThreadUpdateParams,
  ThreadValuesMergeParams
} from "../types"
import { SqlGoalStore } from "../agent/goals/goal-store"
import type { ThreadGoal } from "../agent/goals/types"
import { GOAL_UI_EVENT_LIMIT } from "../../shared/goal-events"
import {
  buildFilteredThreadValues,
  describeCheckpointMessageForkTarget,
  deriveCheckpointTranscriptIndex,
  findMessagesAfterCheckpointVisibleIds,
  isWorkflowPlumbingTranscriptContent,
  mergeCheckpointAuthorityTranscriptMessages,
  truncateCheckpointMessagesAfter
} from "../../shared/checkpoint-transcript"
import {
  getMessageProviderOccurrenceIdentity,
  getMessageProviderTupleFromMetadata
} from "../../shared/message-role-collision"
import {
  buildVisibleForkableCheckpointList,
  describeCheckpointForkability,
  FORK_BOUNDARY_MARKER_VERSION,
  FORK_BOUNDARY_THREAD_METADATA_KEY,
  getCheckpointId,
  getForkBoundaryMarker,
  getCheckpointThreadId,
  isForkableCheckpointForMessage,
  toForkabilityError
} from "../../shared/checkpoint-forkability"
import type { LegacyForkFallbackMode } from "../../shared/checkpoint-forkability"
import { withThreadRunMutationLock } from "./thread-run-mutation-lock"
import { resolveRecentWorkspacePath } from "./recent-workspace"
import {
  copyCheckpoint,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple
} from "@langchain/langgraph-checkpoint"
import { persistedMessageToRuntimeMessage } from "./thread-runtime-tail"
import {
  isThreadMessageHydrationWorkerUnavailable,
  readThreadMessagesPageInWorker
} from "../thread-message-hydration/client"
import {
  isThreadMetadataHydrationWorkerUnavailable,
  readThreadGoalEventsInWorker,
  readThreadHydrationInWorker,
  readThreadSummaryPageInWorker
} from "../thread-metadata-hydration/client"
import type { ThreadGoalHydrationEvent } from "../thread-metadata-hydration/protocol"
import {
  bootstrapLegacyCheckpointTranscriptInWorker,
  cancelLegacyCheckpointTranscriptBootstrap,
  isCheckpointRuntimeProjectionCancelled,
  readLatestCheckpointTupleInWorker
} from "../checkpointer/runtime-projection-client"
import {
  cancelLegacySubagentTranscriptMigration,
  ensureLegacySubagentTranscriptRows as ensureSubagentTranscriptRows,
  forgetLegacySubagentTranscriptMigration
} from "../legacy-subagent-migration/coordinator"
import {
  cancelSubagentTranscriptStartupRead,
  isSubagentTranscriptStartupCancelled,
  readSubagentTranscriptStartupInWorker
} from "../subagent-transcript-startup/client"
import {
  buildHarnessFeatureAgentContext,
  DEFAULT_HARNESS_REQUEST_USER_INPUT_CONFIG
} from "../harness-board/service"
import {
  acquireSubagentTranscriptBlobReadPin,
  advanceSubagentTranscriptReferenceEpoch,
  compactSubagentTranscriptManifests,
  exportSubagentTranscriptBlobValue,
  exportSubagentTranscriptTextWithJournal,
  getSubagentTranscriptReferenceEpoch,
  hasActiveSubagentTranscriptExternalMutation,
  hydrateSubagentTranscriptManifestPage,
  quarantineSubagentTranscriptBlobGcCandidates,
  removeQuarantinedSubagentTranscriptBlobs,
  scanSubagentTranscriptBlobGcCandidates,
  sliceSubagentTranscriptManifestPage,
  withSubagentTranscriptContentMutationLock
} from "../services/subagent-transcript-content-store"
import {
  SUBAGENT_TRANSCRIPTS_THREAD_VALUE_KEY,
  getSubagentTranscriptBlobReferenceHashKey,
  isSubagentTranscriptBlobRef
} from "../../shared/subagent-transcript-storage"
import { collectReferencedTranscriptHashesFromPages } from "./thread-transcript-gc-scan"

type ExportMessageRole = "user" | "assistant" | "system" | "tool"
interface ExportAttachment {
  filename: string
}

interface ExportToolCall {
  id?: string
  name: string
  args: string
  truncated: boolean
}

interface ExportMessage {
  id: string
  role: ExportMessageRole
  content: string
  truncated?: boolean
  attachments: ExportAttachment[]
  toolCalls?: ExportToolCall[]
  toolCallNames?: string[]
  toolCallId?: string
  name?: string
  createdAt?: string
}

interface ExportPayload {
  version: 1
  exportedAt: string
  thread: {
    threadId: string
    title: string
    createdAt: string
    updatedAt: string
    workspacePath: string | null
  }
  messages: ExportMessage[]
}

interface CheckpointMessage {
  id?: string | string[]
  _getType?: () => string
  type?: string
  content?: string | Array<unknown>
  tool_calls?: Array<{ id?: string; name?: string; args?: unknown }>
  tool_call_id?: string
  name?: string
  additional_kwargs?: Record<string, unknown>
  kwargs?: {
    id?: string
    type?: string
    content?: string | Array<unknown>
    tool_calls?: Array<{ id?: string; name?: string; args?: unknown }>
    tool_call_id?: string
    name?: string
    additional_kwargs?: Record<string, unknown>
  }
}

interface ThreadCheckpoint {
  checkpoint?: {
    channel_values?: {
      messages?: CheckpointMessage[]
    }
  }
}

// 复用主进程 settings 存储，用于读取“最近一次选择的工作区”。
// 这里不存敏感信息，只读写路径类配置。
const settingsStore = new Store({
  name: "settings",
  cwd: getOpenworkDir()
})

const CHECKPOINT_THREAD_ID_PATTERN = /^[A-Za-z0-9_-]+$/

function assertValidCheckpointThreadId(threadId: string): string {
  const normalized = threadId.trim()
  if (!CHECKPOINT_THREAD_ID_PATTERN.test(normalized)) {
    throw new Error(`Invalid checkpoint threadId: ${threadId}`)
  }
  return normalized
}

async function assertCanPersistExplicitNormalMode(
  threadId: string,
  currentMetadata: Record<string, unknown>,
  nextMetadata: Record<string, unknown>
): Promise<void> {
  // Any workspace switch must keep the old workspace pinned while it owns an
  // active/pending run or an unresolved retained worktree. This also covers a
  // combined mode+workspace update without blocking a mode-only change.
  if (
    typeof currentMetadata.workspacePath === "string" &&
    typeof nextMetadata.workspacePath === "string" &&
    nextMetadata.workspacePath !== currentMetadata.workspacePath &&
    (await workflowRunManager.isWorkspacePinnedForThread(
      threadId,
      currentMetadata.workspacePath
    ))
  ) {
    throw new Error(
      "仍有动态工作流、待汇报结果或尚未处理的 worktree，请先完成 Merge/Discard/Cleanup 后再切换工作目录。"
    )
  }
  // Leaving workflow mode (to ANY non-workflow mode — normal OR coordinator) must
  // be blocked while a run is active or its result is still pending, or the
  // background run is orphaned (the renderer only schedules the completion turn in
  // workflow mode). Checked BEFORE the normal-only guard below so coordinator
  // targets are covered too. (Despite the function name, this also guards exits
  // from workflow mode.)
  if (currentMetadata.agentMode === "workflow" && nextMetadata.agentMode !== "workflow") {
    // Look the pending run up in the CURRENT (old) workspace — that's where its files live (it was
    // launched there). A combined update that ALSO switches workspacePath must NOT use the NEW path:
    // the run isn't there → findPendingNotification returns null → the leave would be allowed and
    // orphan the run. Mirrors the workspace-switch guard above, which also checks currentMetadata.
    const wsp =
      typeof currentMetadata.workspacePath === "string"
        ? currentMetadata.workspacePath
        : typeof nextMetadata.workspacePath === "string"
          ? nextMetadata.workspacePath
          : undefined
    const active = workflowRunManager.isActive(threadId)
    const pendingRun = wsp ? workflowRunManager.findPendingNotification(wsp, threadId) : null
    // Scan ALL pending runs, not just the first candidate: an exhausted newest
    // run must not unlock the exit while an older, still-deliverable run waits.
    const deliverablePending = wsp
      ? workflowRunManager.hasDeliverablePendingNotification(wsp, threadId)
      : false
    // Escape hatch: don't block on a pending run whose auto-re-report has been
    // exhausted this process (wedged report turn / API outage) — else the user is
    // locked in workflow mode with no exit but deleting the thread. HONEST CAVEAT
    // (#5): leaving does NOT keep the pending result on the auto-report path. The
    // renderer only hydrates / schedules the notification turn for workflow-mode
    // threads, so a restart re-reports ONLY while the thread is still in workflow
    // mode. After leaving — and especially after a later workspace switch, which
    // makes list/hydrate look under the NEW path — the result is stranded under the
    // ORIGINAL workspace: NOT lost (it's on disk, visible in that workspace's
    // history panel), just off the auto-report path until the user returns to
    // workflow mode there. (So this is "leave but you'll have to come back for it",
    // not "leave and it follows you".)
    const pending = deliverablePending
    if (active || pending) {
      throw new Error("仍有动态工作流在运行或结果待汇报，请先等待其完成或取消后再切换模式。")
    }
    if (pendingRun) {
      console.warn(
        `[Workflow] Leaving workflow mode with a renotify-exhausted pending run ${pendingRun.runId}: its result stays under the original workspace and won't auto-report until you return to workflow mode there. (#5)`
      )
    }
    return
  }

  if (nextMetadata.agentMode !== "normal" || currentMetadata.agentMode === "normal") {
    return
  }

  const workspacePath =
    typeof nextMetadata.workspacePath === "string"
      ? nextMetadata.workspacePath
      : typeof currentMetadata.workspacePath === "string"
        ? currentMetadata.workspacePath
        : undefined

  if (!workspacePath) {
    const workers = coordinatorWorkerManager.readWorkers(threadId)
    const hasPendingNotifications = coordinatorWorkerManager.hasNotifications(threadId)
    const unresolvedWorkers = workers.filter(
      (worker) => worker.status === "running" || worker.notification_acknowledged === false
    )
    if (unresolvedWorkers.length === 0 && !hasPendingNotifications) {
      return
    }
    throw new Error("该线程缺少工作区路径，无法安全切换到 Solo 或 Multi。请先重新选择工作区后再切换。")
  }

  await coordinatorWorkerManager.restoreWorkersForThread({
    parentThreadId: threadId,
    workspacePath,
    mode: "active"
  })

  const workers = coordinatorWorkerManager.readWorkers(threadId)
  const hasPendingNotifications = coordinatorWorkerManager.hasNotifications(threadId)
  const unresolvedWorkers = workers.filter(
    (worker) => worker.status === "running" || worker.notification_acknowledged === false
  )
  if (unresolvedWorkers.length === 0 && !hasPendingNotifications) return

  const workerList = unresolvedWorkers
    .map((worker) => `${worker.worker_id}: ${worker.description}`)
    .join("; ")
  throw new Error(
    "仍有 Agent Team worker 在运行或结果待处理，请先处理完成后再切换到 Solo 或 Multi。" +
      (workerList ? `相关 worker：${workerList}` : "请先切回 Agent Team 处理这些结果。")
  )
}

const TOOL_CALL_ARGS_LIMIT = 1200
const TOOL_RESULT_CONTENT_LIMIT = 4000
const MAX_FORK_DURABLE_TAIL_MESSAGES = 1_000
const MAX_FORK_DURABLE_TAIL_BYTES = 8 * 1024 * 1024
const FORK_MESSAGE_COPY_BATCH_SIZE = 128
const FORK_SUBAGENT_BUCKET_PAGE_SIZE = 32
const FORK_SUBAGENT_MESSAGE_PAGE_SIZE = 128

function yieldForkColdPath(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function parseThreadValues(raw: string | null | undefined): Record<string, unknown> {
  return parseJsonObject(raw) ?? {}
}

const foregroundLegacySubagentMigrationByWebContents = new Map<number, string>()

const MAIN_ONLY_THREAD_METADATA_KEYS = [
  "llmFileHistory",
  "llmModifiedFiles",
  "llmRecentlyRevertedFiles"
] as const

function threadMetadataWithoutMainOnlyHistory(
  raw: string | null | undefined
): Record<string, unknown> | undefined {
  const metadata = parseJsonObject(raw)
  if (!metadata) return undefined
  for (const key of MAIN_ONLY_THREAD_METADATA_KEYS) delete metadata[key]
  return metadata
}

function serializeThreadRow(row: ThreadRow): Thread {
  return {
    thread_id: row.thread_id,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    metadata: threadMetadataWithoutMainOnlyHistory(row.metadata),
    status: row.status as Thread["status"],
    // Subagent transcripts can contain thousands of manifest entries. They
    // travel only through the dedicated transcript IPC; returning them from
    // every unrelated update/merge/fork response repeatedly structured-clones
    // the entire history and defeats the sidecar storage boundary.
    thread_values: threadValuesWithoutSubagentTranscripts(row.thread_values),
    title: row.title ?? undefined
  }
}

function threadValuesWithoutSubagentTranscripts(
  raw: string | null | undefined
): Record<string, unknown> | undefined {
  if (!raw) return undefined
  const values = parseThreadValues(raw)
  delete values[SUBAGENT_TRANSCRIPTS_THREAD_VALUE_KEY]
  // Durable thread_messages rows already carry start_at/end_at. These legacy
  // lifetime maps can reach tens of thousands of entries and must not ride on
  // every task metadata hydration/IPC response.
  delete values.messageTimes
  delete values.messageTimeOrder
  delete values.internalGoalMessageTimes
  delete values.internalGoalMessageTimeOrder
  return values
}

function rowBackedSubagentTranscriptPage(
  threadId: string,
  subagentId: string,
  before?: number
): ReturnType<typeof sliceSubagentTranscriptManifestPage> {
  const rows = getThreadSubagentManifestPage(threadId, subagentId, before, 100)
  const selected = sliceSubagentTranscriptManifestPage(rows.messages)
  const globalStart = rows.ordinals[selected.start] ?? rows.start
  const selectedLastOrdinal = rows.ordinals[selected.end - 1]
  const globalEnd = selectedLastOrdinal === undefined ? globalStart : selectedLastOrdinal + 1
  const hasEarlierRows = selected.start > 0 || rows.hasMore
  return {
    ...selected,
    start: globalStart,
    end: globalEnd,
    total: rows.total,
    ...(hasEarlierRows ? { nextBefore: globalStart } : { nextBefore: undefined })
  }
}

function mergeThreadMessageTranscripts(
  baseMessages: Message[],
  incomingMessages: Message[]
): Message[] {
  return mergeCheckpointAuthorityTranscriptMessages(baseMessages, incomingMessages)
}

function normalizeIpcThreadMessage(message: Message): Message {
  const toDate = (value: unknown): Date | undefined => {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : undefined
    if (typeof value === "number" || typeof value === "string") {
      const date = new Date(value)
      return Number.isFinite(date.getTime()) ? date : undefined
    }
    return undefined
  }
  const createdAt = toDate(message.created_at) ?? new Date()
  const startAt = toDate(message.start_at)
  const endAt = toDate(message.end_at)
  return {
    ...message,
    created_at: createdAt,
    ...(startAt ? { start_at: startAt } : {}),
    ...(endAt ? { end_at: endAt } : {})
  }
}

function normalizeIpcMessageRole(role: unknown): Message["role"] | undefined {
  return role === "user" || role === "assistant" || role === "system" || role === "tool"
    ? role
    : undefined
}

async function copyForkedThreadMessages(input: {
  sourceThreadId: string
  targetThreadId: string
  visibleMessages: readonly {
    id: string
    role: string
    renderId?: string
    rawIndex?: number
    provider_source_id?: string
    provider_occurrence?: number
  }[]
  checkpointMessages?: CheckpointMessage[]
}): Promise<void> {
  if (input.visibleMessages.length === 0) return
  for (
    let offset = 0;
    offset < input.visibleMessages.length;
    offset += FORK_MESSAGE_COPY_BATCH_SIZE
  ) {
    const visibleBatch = input.visibleMessages.slice(
      offset,
      offset + FORK_MESSAGE_COPY_BATCH_SIZE
    )
    const allowedIdentities = new Set(
      visibleBatch.flatMap((message) => {
        const role = normalizeIpcMessageRole(message.role)
        return role
          ? [
              getMessageProviderOccurrenceIdentity({
                ...message,
                id: message.renderId || message.id,
                role
              })
            ]
          : []
      })
    )
    const selectors = visibleBatch.flatMap((message) => {
      const role = normalizeIpcMessageRole(message.role)
      if (!role) return []
      return [
        {
          messageId: message.renderId || message.id,
          providerSourceId: message.provider_source_id,
          providerOccurrence: message.provider_occurrence,
          role
        }
      ]
    })
    const visibleRawIndices = visibleBatch.flatMap((message) =>
      typeof message.rawIndex === "number" ? [message.rawIndex] : []
    )
    const checkpointMessages = checkpointMessagesToThreadMessages(input.checkpointMessages, {
      visibleRawIndices
    })
    const persistedMessages = getThreadMessageIdentityContext(
      input.sourceThreadId,
      selectors,
      1
    ).filter((message) =>
      allowedIdentities.has(getMessageProviderOccurrenceIdentity(message))
    )
    const messages = mergeThreadMessageTranscripts(checkpointMessages, persistedMessages)
    if (messages.length > 0) {
      // Batches are inserted in visible order, so no target-lifetime baseline
      // is needed to preserve ordering between batches.
      upsertThreadMessages(input.targetThreadId, messages, { preserveExistingOrder: true })
    }
    await yieldForkColdPath()
  }
}

async function findForkSubagentPrompt(
  threadId: string,
  subagentId: string
): Promise<Record<string, unknown> | undefined> {
  let cursor: Parameters<typeof getThreadSubagentManifestForwardPage>[2]
  while (true) {
    const page = getThreadSubagentManifestForwardPage(
      threadId,
      subagentId,
      cursor,
      FORK_SUBAGENT_MESSAGE_PAGE_SIZE
    )
    for (const message of page.messages) {
      if (
        isPlainRecord(message) &&
        typeof message.subagent_tool_call_id === "string" &&
        typeof message.subagent_invocation_scope === "string"
      ) {
        return message
      }
    }
    if (!page.hasMore) return undefined
    if (!page.nextCursor) throw new Error("Subagent transcript page did not advance.")
    cursor = page.nextCursor
    await yieldForkColdPath()
  }
}

function forkKeepsSubagentBucket(
  subagentId: string,
  prompt: Record<string, unknown> | undefined,
  transcriptIndex: ReturnType<typeof deriveCheckpointTranscriptIndex>
): boolean {
  const filtered = buildFilteredThreadValues(
    {
      [SUBAGENT_TRANSCRIPTS_THREAD_VALUE_KEY]: {
        [subagentId]: prompt ? [prompt] : []
      }
    },
    transcriptIndex
  )
  const buckets = filtered[SUBAGENT_TRANSCRIPTS_THREAD_VALUE_KEY]
  return isPlainRecord(buckets) && hasOwnProperty(buckets, subagentId)
}

async function copyForkedSubagentTranscriptsPaged(input: {
  sourceThreadId: string
  targetThreadId: string
  transcriptIndex: ReturnType<typeof deriveCheckpointTranscriptIndex>
}): Promise<void> {
  let afterSubagentId: string | undefined
  while (true) {
    const bucketPage = getThreadSubagentBucketIdPage(
      input.sourceThreadId,
      afterSubagentId,
      FORK_SUBAGENT_BUCKET_PAGE_SIZE
    )
    for (const subagentId of bucketPage.subagentIds) {
      const prompt = await findForkSubagentPrompt(input.sourceThreadId, subagentId)
      if (!forkKeepsSubagentBucket(subagentId, prompt, input.transcriptIndex)) continue

      let cursor: Parameters<typeof copyThreadSubagentManifestRowsPage>[0]["after"]
      while (true) {
        const copiedPage = await withSubagentTranscriptContentMutationLock(async () => {
          const result = copyThreadSubagentManifestRowsPage({
            sourceThreadId: input.sourceThreadId,
            targetThreadId: input.targetThreadId,
            subagentId,
            after: cursor,
            limit: FORK_SUBAGENT_MESSAGE_PAGE_SIZE
          })
          if (result.copied > 0) advanceSubagentTranscriptReferenceEpoch()
          return result
        })
        if (!copiedPage.hasMore) break
        if (!copiedPage.nextCursor) throw new Error("Subagent transcript copy did not advance.")
        cursor = copiedPage.nextCursor
        await yieldForkColdPath()
      }
      await yieldForkColdPath()
    }
    if (!bucketPage.hasMore) break
    if (!bucketPage.nextAfterSubagentId) {
      throw new Error("Subagent transcript bucket page did not advance.")
    }
    afterSubagentId = bucketPage.nextAfterSubagentId
    await yieldForkColdPath()
  }
}

function toCheckpointTimeMs(checkpoint: Checkpoint): number | null {
  if (typeof checkpoint.ts !== "string") return null
  const time = new Date(checkpoint.ts).getTime()
  return Number.isFinite(time) ? time : null
}

function copyForkedGoalStateForCheckpoint(input: {
  sourceThreadId: string
  targetThreadId: string
  forkCheckpoint: Checkpoint
  isLatestCheckpointFork: boolean
}): void {
  const { sourceThreadId, targetThreadId, forkCheckpoint, isLatestCheckpointFork } = input
  const goalStore = new SqlGoalStore()
  const sourceGoal = goalStore.get(sourceThreadId)
  const checkpointTimeMs = toCheckpointTimeMs(forkCheckpoint)

  if (sourceGoal) {
    const canCopyGoalState =
      isLatestCheckpointFork ||
      (checkpointTimeMs !== null &&
        sourceGoal.createdAt <= checkpointTimeMs &&
        sourceGoal.updatedAt <= checkpointTimeMs)
    if (canCopyGoalState) {
      goalStore.upsert({
        ...sourceGoal,
        threadId: targetThreadId
      })
    }
  }

  for (const event of getThreadGoalEvents(sourceThreadId)) {
    if (!isLatestCheckpointFork && checkpointTimeMs !== null && event.created_at > checkpointTimeMs) {
      continue
    }
    if (!isLatestCheckpointFork && checkpointTimeMs === null) continue
    addThreadGoalEvent(
      targetThreadId,
      event.message,
      event.goal_id,
      event.created_at,
      event.active_window_id
    )
  }
}

function stringifyThreadMessageContent(content: Message["content"]): string {
  if (typeof content === "string") return content
  return content
    .map((block) => {
      if (typeof block.text === "string") return block.text
      if (typeof block.content === "string") return block.content
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function isForkVisiblePersistedMessage(message: Message): boolean {
  return !isWorkflowPlumbingTranscriptContent(stringifyThreadMessageContent(message.content))
}

function findDurableForkTailMessages(
  sourceThreadId: string,
  visibleMessages: readonly {
    id: string
    role: string
    renderId?: string
    provider_source_id?: string
    provider_occurrence?: number
  }[]
): Message[] {
  const recentVisibleMessages = visibleMessages.slice(-32)
  const recentIds = Array.from(
    new Set(
      recentVisibleMessages.flatMap((message) =>
        [message.renderId, message.id].filter((id): id is string => Boolean(id))
      )
    )
  )
  let boundaries = getThreadMessagesByIds(sourceThreadId, recentIds)

  // Provider IDs survive renderer collision renames. Use them only as a
  // bounded compatibility fallback when none of the recent render/raw IDs is
  // durable, then filter away the helper's small context tail.
  if (boundaries.length === 0) {
    const recentIdentities = new Set(
      recentVisibleMessages.flatMap((message) => {
        const role = normalizeIpcMessageRole(message.role)
        return role
          ? [
              getMessageProviderOccurrenceIdentity({
                ...message,
                id: message.renderId || message.id,
                role
              })
            ]
          : []
      })
    )
    const selectors = recentVisibleMessages.flatMap((message) => {
      const role = normalizeIpcMessageRole(message.role)
      if (!role) return []
      return [
        {
          messageId: message.renderId || message.id,
          providerSourceId: message.provider_source_id,
          providerOccurrence: message.provider_occurrence,
          role
        }
      ]
    })
    boundaries = getThreadMessageIdentityContext(sourceThreadId, selectors, 1).filter((message) =>
      recentIdentities.has(getMessageProviderOccurrenceIdentity(message))
    )
  }

  const persistedMessages =
    boundaries.length > 0
      ? getThreadMessagesAfterAnyId(
          sourceThreadId,
          boundaries.map((message) => message.id),
          MAX_FORK_DURABLE_TAIL_MESSAGES + 1
        )
      : (() => {
          const page = getThreadMessagesPage(sourceThreadId, {
            limit: MAX_FORK_DURABLE_TAIL_MESSAGES
          })
          if (page.hasMore) {
            throw new Error("当前会话尾部消息过多，无法安全物化到 fork checkpoint。")
          }
          return page.messages
        })()
  if (persistedMessages.length > MAX_FORK_DURABLE_TAIL_MESSAGES) {
    throw new Error("当前会话尾部消息过多，无法安全物化到 fork checkpoint。")
  }
  return findMessagesAfterCheckpointVisibleIds(
    persistedMessages.filter(isForkVisiblePersistedMessage),
    visibleMessages
  )
}

function appendDurableTailToCheckpoint(
  checkpoint: Checkpoint,
  durableTail: readonly Message[]
): Checkpoint {
  if (durableTail.length === 0) return checkpoint
  if (durableTail.length > MAX_FORK_DURABLE_TAIL_MESSAGES) {
    throw new Error("当前会话尾部消息过多，无法安全物化到 fork checkpoint。")
  }
  const serializedTail = JSON.stringify(durableTail)
  if (Buffer.byteLength(serializedTail, "utf8") > MAX_FORK_DURABLE_TAIL_BYTES) {
    throw new Error("当前会话尾部数据过大，无法安全物化到 fork checkpoint。")
  }

  const runtimeTail = durableTail.map((message) => persistedMessageToRuntimeMessage(message))
  if (runtimeTail.some((message) => message === null)) {
    throw new Error("当前会话尾部包含无法安全恢复的工具消息，暂时不能 fork。")
  }

  const forkCheckpoint = copyCheckpoint(checkpoint)
  const checkpointMessages = getCheckpointChannelMessages(forkCheckpoint) ?? []
  forkCheckpoint.channel_values = {
    ...forkCheckpoint.channel_values,
    messages: [
      ...checkpointMessages,
      ...runtimeTail.filter((message): message is NonNullable<typeof message> => message !== null)
    ]
  }
  return forkCheckpoint
}

function updateForkBoundaryTailMetadata(
  tuple: CheckpointTuple,
  lastVisibleMessageId: string,
  durableTailMessageCount: number
): CheckpointMetadata | undefined {
  const marker = getForkBoundaryMarker(tuple)
  if (!marker) return tuple.metadata

  return {
    ...tuple.metadata,
    cmb_fork_boundary: {
      ...marker,
      lastVisibleMessageId,
      durableTailReplayed: true,
      durableTailMessageCount
    }
  } as CheckpointMetadata
}

function normalizeForkBoundaryMetadataForCheckpoint(
  metadata: CheckpointMetadata,
  checkpoint: Checkpoint
): CheckpointMetadata {
  if (!isPlainRecord(metadata)) return metadata
  const metadataRecord = metadata as Record<string, unknown>
  const boundary = metadataRecord.cmb_fork_boundary
  if (!isPlainRecord(boundary)) return metadata

  const lastVisibleMessageId = deriveCheckpointTranscriptIndex(checkpoint).visibleMessageIds.at(-1)
  if (!lastVisibleMessageId || boundary.lastVisibleMessageId === lastVisibleMessageId) {
    return metadata
  }

  return {
    ...metadata,
    cmb_fork_boundary: {
      ...boundary,
      lastVisibleMessageId
    }
  } as CheckpointMetadata
}

function materializeLatestForkTuple(
  sourceThreadId: string,
  tuples: readonly CheckpointTuple[],
  options: { omitUnsafeLatest?: boolean } = {}
): CheckpointTuple[] {
  if (tuples.length === 0) return []

  const latestTuple = tuples[0]
  const initialTranscript = deriveCheckpointTranscriptIndex(latestTuple.checkpoint)
  const durableTail = findDurableForkTailMessages(
    sourceThreadId,
    initialTranscript.visibleMessages
  )
  if (durableTail.length === 0) return [...tuples]

  let checkpoint: Checkpoint
  try {
    checkpoint = appendDurableTailToCheckpoint(latestTuple.checkpoint, durableTail)
  } catch (error) {
    if (options.omitUnsafeLatest) {
      console.warn("[Threads] Omitting unsafe latest fork checkpoint:", error)
      return [...tuples.slice(1)]
    }
    throw error
  }
  const transcript = deriveCheckpointTranscriptIndex(checkpoint)
  const lastVisibleMessageId = transcript.visibleMessageIds.at(-1)
  if (!lastVisibleMessageId) {
    throw new Error("当前会话尾部没有可用于 fork 的可见消息。")
  }

  return [
    {
      ...latestTuple,
      checkpoint,
      metadata: updateForkBoundaryTailMetadata(
        latestTuple,
        lastVisibleMessageId,
        durableTail.length
      )
    },
    ...tuples.slice(1)
  ]
}

function isAgentMode(value: unknown): value is "normal" | "coordinator" | "workflow" {
  return value === "normal" || value === "coordinator" || value === "workflow"
}

function hasOwnProperty(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function hasPendingApprovalForThread(threadId: string): boolean {
  for (const approval of pendingApprovals.values()) {
    if (approval.threadId === threadId || approval.runtimeThreadId === threadId) return true
  }
  return false
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function workspacePathsMatch(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false
  try {
    const normalize = (value: string): string => {
      const resolved = path.resolve(value)
      return process.platform === "win32" ? resolved.toLowerCase() : resolved
    }
    return normalize(left) === normalize(right)
  } catch {
    return left === right
  }
}

function cloneSanitizedGitContext(
  sourceMetadata: Record<string, unknown>,
  workspacePath: string
): Record<string, unknown> | null {
  if (!isPlainRecord(sourceMetadata.gitContext)) return null
  const contextWorkspacePath = sourceMetadata.gitContext.workspacePath
  if (
    typeof contextWorkspacePath === "string" &&
    !workspacePathsMatch(contextWorkspacePath, workspacePath)
  ) {
    return null
  }

  return { ...sourceMetadata.gitContext, workspacePath }
}

function copyForkGitMetadataIfWorkspaceMatches(input: {
  sourceMetadata: Record<string, unknown>
  targetMetadata: Record<string, unknown>
  workspacePath: unknown
  hasWorkspacePathOverride: boolean
}): void {
  const { sourceMetadata, targetMetadata, workspacePath, hasWorkspacePathOverride } = input
  const sourceWorkspacePath =
    typeof sourceMetadata.workspacePath === "string" ? sourceMetadata.workspacePath : null
  if (typeof workspacePath !== "string" || !sourceWorkspacePath) return
  if (hasWorkspacePathOverride && !workspacePathsMatch(workspacePath, sourceWorkspacePath)) return

  const primitiveKeys = [
    "gitRoot",
    "isWorktree",
    "worktreeBranch",
    "worktreeBaseBranch",
    "worktreeBaseCommit"
  ]

  for (const key of primitiveKeys) {
    const value = sourceMetadata[key]
    if (
      typeof value === "string" ||
      typeof value === "boolean" ||
      typeof value === "number" ||
      value === null
    ) {
      targetMetadata[key] = value
    }
  }

  const cachedWorkspacePath = sourceMetadata.cachedGitContextWorkspacePath
  if (typeof cachedWorkspacePath === "string" && workspacePathsMatch(cachedWorkspacePath, sourceWorkspacePath)) {
    for (const key of ["cachedIsGitRepo", "cachedIsWorktreePath", "cachedGitRoot", "cachedGitContextAt"]) {
      const value = sourceMetadata[key]
      if (
        typeof value === "string" ||
        typeof value === "boolean" ||
        typeof value === "number" ||
        value === null
      ) {
        targetMetadata[key] = value
      }
    }
    targetMetadata.cachedGitContextWorkspacePath = workspacePath
  }

  const gitContext = cloneSanitizedGitContext(sourceMetadata, workspacePath)
  if (gitContext) targetMetadata.gitContext = gitContext
}

function copyForkHarnessMetadata(input: {
  sourceMetadata: Record<string, unknown>
  targetMetadata: Record<string, unknown>
}): void {
  const { sourceMetadata, targetMetadata } = input
  const harnessFeature = sourceMetadata.harnessFeature
  const hasHarnessFeature =
    isPlainRecord(harnessFeature) &&
    typeof harnessFeature.projectId === "string" &&
    harnessFeature.projectId.trim().length > 0 &&
    typeof harnessFeature.slug === "string" &&
    harnessFeature.slug.trim().length > 0

  if (hasHarnessFeature) {
    targetMetadata.harnessFeature = { ...harnessFeature }
  }

  const harnessProjectSession = sourceMetadata.harnessProjectSession
  const hasHarnessProjectSession =
    isPlainRecord(harnessProjectSession) &&
    typeof harnessProjectSession.projectId === "string" &&
    harnessProjectSession.projectId.trim().length > 0 &&
    typeof harnessProjectSession.kind === "string" &&
    harnessProjectSession.kind.trim().length > 0

  if (hasHarnessProjectSession) {
    targetMetadata.harnessProjectSession = { ...harnessProjectSession }
  }

  if (
    (hasHarnessFeature || hasHarnessProjectSession) &&
    typeof sourceMetadata.disableAgentsPrompt === "boolean"
  ) {
    targetMetadata.disableAgentsPrompt = sourceMetadata.disableAgentsPrompt
  }
}

function isValidForkWorkspacePath(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

async function forkWorkspaceExists(workspacePath: string): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      lstat(path.resolve(workspacePath)).then(
        () => true,
        () => false
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 750)
        timer.unref?.()
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function assertValidForkOverrides(
  sourceMetadata: Record<string, unknown>,
  overrides: ThreadForkParams["overrides"]
): Promise<void> {
  if (overrides === undefined) return
  if (!isPlainRecord(overrides)) throw new Error("Fork overrides 格式无效。")

  const hasWorkspacePathOverride = hasOwnProperty(overrides, "workspacePath")
  const hasAgentModeOverride = hasOwnProperty(overrides, "agentMode")
  const workspacePath = hasWorkspacePathOverride
    ? overrides.workspacePath
    : sourceMetadata.workspacePath
  const agentMode = hasAgentModeOverride
    ? overrides.agentMode
    : getAgentModeFromMetadata(sourceMetadata)

  if (hasWorkspacePathOverride) {
    if (workspacePath !== null && !isValidForkWorkspacePath(workspacePath)) {
      throw new Error("Fork workspacePath override 必须是非空字符串或 null。")
    }
  }

  if (hasAgentModeOverride && !isAgentMode(agentMode)) {
    throw new Error("Fork agentMode override 无效。")
  }

  if (agentMode === "workflow" || agentMode === "coordinator") {
    if (!isValidForkWorkspacePath(workspacePath)) {
      throw new Error("Fork 到 workflow/coordinator 模式必须提供有效工作区。")
    }
    if (!(await forkWorkspaceExists(workspacePath))) {
      throw new Error("Fork 目标工作区不存在，无法进入 workflow/coordinator 模式。")
    }
  }
}

interface ThreadForkBusyInput {
  threadId: string
  workspacePath?: string | null
  agentMode?: "normal" | "coordinator" | "workflow"
}

async function isThreadForkBusy(input: ThreadForkBusyInput): Promise<boolean> {
  const { threadId, workspacePath, agentMode } = input
  if (hasActiveAgentRun(threadId)) {
    if (!isActiveAgentRunAborting(threadId)) return true
    const outcome = await waitForActiveAgentRunToSettle(threadId)
    if (outcome !== "settled" || hasActiveAgentRun(threadId)) return true
  }
  if (hasPendingApprovalForThread(threadId)) return true

  if (workflowRunManager.isActive(threadId)) return true
  if (workspacePath) {
    if (workflowRunManager.isBusyForThread(threadId, workspacePath)) return true
  } else if (agentMode === "workflow") {
    return true
  }

  if (workspacePath) {
    try {
      await coordinatorWorkerManager.restoreWorkersForThread({
        parentThreadId: threadId,
        workspacePath,
        mode: "active"
      })
    } catch (error) {
      if (agentMode === "coordinator") {
        console.warn("[Threads] Failed to hydrate coordinator workers before fork:", error)
        return true
      }
    }
  } else if (agentMode === "coordinator") {
    return true
  }

  const workers = coordinatorWorkerManager.readWorkers(threadId)
  if (coordinatorWorkerManager.hasNotifications(threadId)) return true
  return workers.some(
    (worker) => worker.status === "running" || worker.notification_acknowledged === false
  )
}

function assertForkableTuple(
  tuple: CheckpointTuple,
  options: { allowLegacyLatestFallback: boolean; allowLegacyHistoricalFallback?: boolean }
): void {
  const threadId = getCheckpointThreadId(tuple)
  const forkability = describeCheckpointForkability(tuple, {
    allowLegacyLatestFallback: options.allowLegacyLatestFallback,
    allowLegacyHistoricalFallback: options.allowLegacyHistoricalFallback,
    pendingApproval: hasPendingApprovalForThread(threadId)
  })
  if (!forkability.isStableTurnBoundary)
    throw new Error(toForkabilityError(forkability.unstableReason))
}

interface ForkBoundaryMarkerContext {
  hasAnyForkBoundaryMarker: boolean
  selectedHasNewerForkBoundaryMarker: boolean
}

function resolveLegacyForkFallbackMode(input: {
  hasThreadForkBoundaryMarkerEra: boolean
  hasAnyForkBoundaryMarker: boolean
}): LegacyForkFallbackMode {
  if (!input.hasThreadForkBoundaryMarkerEra && !input.hasAnyForkBoundaryMarker) return "all"
  if (input.hasAnyForkBoundaryMarker) return "older_than_marker"
  return "none"
}

function allowsLegacyHistoricalForkFallback(input: {
  mode: LegacyForkFallbackMode
  selectedHasNewerForkBoundaryMarker: boolean
}): boolean {
  return (
    input.mode === "all" ||
    (input.mode === "older_than_marker" && input.selectedHasNewerForkBoundaryMarker)
  )
}

async function getForkBoundaryMarkerContext(
  checkpointer: SqlJsSaver,
  threadId: string,
  selectedCheckpointId?: string
): Promise<ForkBoundaryMarkerContext> {
  const tuples: CheckpointTuple[] = []
  for await (const tuple of checkpointer.list({
    configurable: { thread_id: threadId, checkpoint_ns: "" }
  })) {
    tuples.push(tuple)
  }

  const markerIndexes = tuples.flatMap((tuple, index) => (getForkBoundaryMarker(tuple) ? [index] : []))
  const hasAnyForkBoundaryMarker = markerIndexes.length > 0
  const oldestForkBoundaryMarkerIndex =
    markerIndexes.length > 0 ? markerIndexes[markerIndexes.length - 1] : -1
  const selectedIndex = selectedCheckpointId
    ? tuples.findIndex((tuple) => getCheckpointId(tuple) === selectedCheckpointId)
    : -1
  const selectedHasNewerForkBoundaryMarker =
    selectedIndex >= 0 &&
    oldestForkBoundaryMarkerIndex >= 0 &&
    selectedIndex > oldestForkBoundaryMarkerIndex

  return { hasAnyForkBoundaryMarker, selectedHasNewerForkBoundaryMarker }
}

function buildForkMetadata(input: {
  sourceThreadId: string
  sourceTitle: string
  sourceMetadata: Record<string, unknown>
  checkpointId: string
  messageId?: string
  title?: string
  overrides?: ThreadForkParams["overrides"]
}): Record<string, unknown> {
  const { sourceThreadId, sourceTitle, sourceMetadata, checkpointId, messageId, title, overrides } =
    input
  const next: Record<string, unknown> = {}

  const hasWorkspacePathOverride = overrides ? hasOwnProperty(overrides, "workspacePath") : false
  const workspacePath = hasWorkspacePathOverride
    ? overrides?.workspacePath
    : sourceMetadata.workspacePath
  if (typeof workspacePath === "string" || workspacePath === null)
    next.workspacePath = workspacePath
  copyForkGitMetadataIfWorkspaceMatches({
    sourceMetadata,
    targetMetadata: next,
    workspacePath,
    hasWorkspacePathOverride
  })
  copyForkHarnessMetadata({ sourceMetadata, targetMetadata: next })

  const model = overrides?.model ?? sourceMetadata.model
  if (typeof model === "string" && model.trim()) next.model = model

  const agentMode = isAgentMode(overrides?.agentMode)
    ? overrides.agentMode
    : getAgentModeFromMetadata(sourceMetadata)
  if (isAgentMode(agentMode)) next.agentMode = agentMode
  if (agentMode === "normal") {
    next.subagentsEnabled = sourceMetadata.subagentsEnabled !== false
  }

  const memoryEnabled = overrides?.memoryEnabled ?? sourceMetadata.memoryEnabled
  if (typeof memoryEnabled === "boolean") next.memoryEnabled = memoryEnabled

  if (isAgentOutputStyle(sourceMetadata.outputStyle)) {
    next.outputStyle = sourceMetadata.outputStyle
  }
  if (sourceMetadata.conciseModeEnabled === true) next.conciseModeEnabled = true

  const nextTitle = overrides?.title?.trim() || title?.trim() || sourceTitle || sourceThreadId
  next.title = nextTitle
  next.forkedFromThreadId = sourceThreadId
  next.forkedFromCheckpointId = checkpointId
  next.forkedFromCheckpointNs = ""
  if (messageId) next.forkedFromMessageId = messageId
  next.forkedAt = new Date().toISOString()

  return next
}

interface ForkCheckpointHistoryEntry {
  checkpoint: CheckpointTuple["checkpoint"]
  metadata: CheckpointMetadata
  parentCheckpointId?: string
}

const FORK_PRIVATE_SUMMARIZATION_STATE_KEYS = [
  "_summarizationEvent",
  "_summarizationSessionId",
  "_cmbSummarizationOwner"
] as const

function copyCheckpointWithoutSourceSummarizationState(
  checkpoint: CheckpointTuple["checkpoint"]
): CheckpointTuple["checkpoint"] {
  const copied = copyCheckpoint(checkpoint)
  const channelValues = copied.channel_values
  if (!channelValues || typeof channelValues !== "object" || Array.isArray(channelValues)) {
    return copied
  }

  for (const key of FORK_PRIVATE_SUMMARIZATION_STATE_KEYS) {
    delete (channelValues as Record<string, unknown>)[key]
  }
  return copied
}

function fallbackForkCheckpointMetadata(): CheckpointMetadata {
  return {
    source: "fork",
    step: -1,
    writes: {},
    parents: {}
  } as CheckpointMetadata
}

function getTupleParentCheckpointId(tuple: CheckpointTuple): string | undefined {
  const parentCheckpointId = tuple.parentConfig?.configurable?.checkpoint_id
  return typeof parentCheckpointId === "string" && parentCheckpointId ? parentCheckpointId : undefined
}

function checkpointTranscriptDedupeKey(checkpoint: CheckpointTuple["checkpoint"]): string {
  const transcript = deriveCheckpointTranscriptIndex(checkpoint)
  return transcript.visibleMessages.length > 0
    ? JSON.stringify(
        transcript.visibleMessages.map((message) => [
          message.role,
          message.renderId ?? message.id
        ])
      )
    : `checkpoint:${checkpoint.id}`
}

function dedupeForkCheckpointHistoryEntries(
  entries: ForkCheckpointHistoryEntry[]
): ForkCheckpointHistoryEntry[] {
  const lastIndexByTranscript = new Map<string, number>()
  entries.forEach((entry, index) => {
    lastIndexByTranscript.set(checkpointTranscriptDedupeKey(entry.checkpoint), index)
  })

  const deduped = entries.filter((entry, index) => {
    return lastIndexByTranscript.get(checkpointTranscriptDedupeKey(entry.checkpoint)) === index
  })
  const parentByCheckpointId = new Map(
    entries.map((entry) => [entry.checkpoint.id, entry.parentCheckpointId] as const)
  )
  const copiedIds = new Set(deduped.map((entry) => entry.checkpoint.id))

  const nearestCopiedParent = (parentCheckpointId: string | undefined): string | undefined => {
    let current = parentCheckpointId
    const visited = new Set<string>()
    while (current && !visited.has(current)) {
      if (copiedIds.has(current)) return current
      visited.add(current)
      current = parentByCheckpointId.get(current)
    }
    return undefined
  }

  return deduped.map((entry) => {
    const parentCheckpointId = nearestCopiedParent(entry.parentCheckpointId)
    return {
      checkpoint: entry.checkpoint,
      metadata: entry.metadata,
      ...(parentCheckpointId ? { parentCheckpointId } : {})
    }
  })
}

function buildForkCheckpointHistory(input: {
  sourceHistoryTuples: CheckpointTuple[]
  selectedCheckpointId: string
  selectedCheckpoint: CheckpointTuple["checkpoint"]
  selectedMetadata: CheckpointMetadata
}): ForkCheckpointHistoryEntry[] {
  const entries = input.sourceHistoryTuples.map((tuple) => {
    const checkpointId = getCheckpointId(tuple)
    const parentCheckpointId = getTupleParentCheckpointId(tuple)
    const sourceCheckpoint =
      checkpointId === input.selectedCheckpointId ? input.selectedCheckpoint : tuple.checkpoint
    return {
      // A fork owns a new app-managed artifact directory. Keeping the source
      // event would leave its effective prompt pointing at the source thread's
      // absolute history path (and potentially expose history appended after
      // the fork boundary). The raw messages remain in the checkpoint, while
      // referenced evicted tool payloads are copied into the target directory
      // before commit, so the target can continue independently.
      checkpoint: copyCheckpointWithoutSourceSummarizationState(sourceCheckpoint),
      metadata:
        checkpointId === input.selectedCheckpointId
          ? input.selectedMetadata
          : (tuple.metadata ?? fallbackForkCheckpointMetadata()),
      ...(parentCheckpointId ? { parentCheckpointId } : {})
    }
  })
  return dedupeForkCheckpointHistoryEntries(entries)
}

function selectForkCheckpointHistoryTuples(input: {
  listedTuples: CheckpointTuple[]
  selectedCheckpointId: string
  legacyFallbackMode: LegacyForkFallbackMode
}): CheckpointTuple[] {
  const selectedIndex = input.listedTuples.findIndex(
    (tuple) => getCheckpointId(tuple) === input.selectedCheckpointId
  )
  // 从 selectedIndex 到数组末尾（即从选中 checkpoint 到最旧的方向，降序）
  const selectedToOldestDesc =
    selectedIndex >= 0 ? input.listedTuples.slice(selectedIndex) : input.listedTuples
  const forkableSummariesById = buildForkableCheckpointSummaryMap(input.listedTuples, {
    activeRun: false,
    pendingApproval: false,
    legacyFallbackMode: input.legacyFallbackMode
  })
  return selectedToOldestDesc
    .filter((tuple) => {
      const checkpointId = getCheckpointId(tuple)
      return checkpointId === input.selectedCheckpointId || forkableSummariesById.has(checkpointId)
    })
    .reverse()
}

async function putForkCheckpointHistory(input: {
  targetSaver: SqlJsSaver
  targetThreadId: string
  entries: ForkCheckpointHistoryEntry[]
}): Promise<void> {
  for (const entry of input.entries) {
    const existing = await input.targetSaver.getTuple({
      configurable: {
        thread_id: input.targetThreadId,
        checkpoint_ns: "",
        checkpoint_id: entry.checkpoint.id
      }
    })
    if (existing) continue
    await input.targetSaver.put(
      {
        configurable: {
          thread_id: input.targetThreadId,
          checkpoint_ns: "",
          ...(entry.parentCheckpointId ? { checkpoint_id: entry.parentCheckpointId } : {})
        }
      },
      entry.checkpoint,
      entry.metadata
    )
  }
}

const LARGE_TOOL_RESULT_PATH_PREFIX = "/large_tool_results/"
const LARGE_TOOL_RESULT_REFERENCE_PATTERN =
  /saved in the filesystem at this path: (\/large_tool_results\/[^\s]+)/g

function collectReferencedLargeToolResultNames(checkpoint: Checkpoint): string[] {
  const names = new Set<string>()
  for (const message of getCheckpointChannelMessages(checkpoint) ?? []) {
    if (getMessageRole(message) !== "tool") continue
    const content = stringifyContent(getCheckpointMessageContent(message))
    for (const match of content.matchAll(LARGE_TOOL_RESULT_REFERENCE_PATTERN)) {
      const logicalPath = match[1]
      const name = logicalPath.slice(LARGE_TOOL_RESULT_PATH_PREFIX.length)
      if (
        !name ||
        name === "." ||
        name === ".." ||
        name.includes("/") ||
        name.includes("\\") ||
        name.includes("\0")
      ) {
        throw new Error(
          `Fork checkpoint contains an invalid large tool result path: ${logicalPath}`
        )
      }
      names.add(name)
    }
  }
  return [...names]
}

async function resolveForkLargeToolResultSource(
  candidates: readonly string[]
): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      const stats = await lstat(candidate)
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error(`Fork large tool result is not a regular file: ${candidate}`)
      }
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
  }
  return null
}

async function copyForkLargeToolResults(input: {
  checkpoints: readonly Checkpoint[]
  sourceThreadId: string
  sourceWorkspacePath: string | null
  targetThreadId: string
  targetWorkspacePath: string | null
}): Promise<void> {
  const referencedNames = [
    ...new Set(input.checkpoints.flatMap(collectReferencedLargeToolResultNames))
  ]
  if (referencedNames.length === 0) return
  if (!input.sourceWorkspacePath || !input.targetWorkspacePath) {
    throw new Error(
      "Fork checkpoint references large tool results but the workspace path is missing."
    )
  }

  const [sourceThreadDataDirectory, targetThreadDataDirectory] = await Promise.all([
    getProjectThreadDataDirectory(input.sourceWorkspacePath, input.sourceThreadId),
    getProjectThreadDataDirectory(input.targetWorkspacePath, input.targetThreadId)
  ])
  const sourceManagedDirectory = path.join(sourceThreadDataDirectory, "large_tool_results")
  const sourceLegacyDirectory = path.join(
    input.sourceWorkspacePath,
    ".cmbdevclaw",
    "large_tool_results"
  )
  const targetDirectory = path.join(targetThreadDataDirectory, "large_tool_results")

  await mkdir(targetDirectory, { recursive: true, mode: 0o700 })
  for (const name of referencedNames) {
    const sourcePath = await resolveForkLargeToolResultSource([
      path.join(sourceManagedDirectory, name),
      path.join(sourceLegacyDirectory, name)
    ])
    if (!sourcePath) {
      console.warn(
        `[Threads] Fork source is missing referenced large tool result ${LARGE_TOOL_RESULT_PATH_PREFIX}${name}; preserving the preview-only checkpoint.`
      )
      continue
    }
    await copyFile(sourcePath, path.join(targetDirectory, name), fsConstants.COPYFILE_EXCL)
  }
}

async function cleanupFailedFork(
  targetThreadId: string,
  options: { rowCreated: boolean; workspacePath: string | null }
): Promise<void> {
  try {
    deleteThreadCheckpoint(targetThreadId)
  } catch (error) {
    console.warn("[Threads] Failed to cleanup fork checkpoint:", error)
  }
  if (options.rowCreated) {
    try {
      dbDeleteThread(targetThreadId)
    } catch (error) {
      console.warn("[Threads] Failed to cleanup fork thread row:", error)
    }
  }
  if (options.workspacePath) {
    try {
      await deleteProjectThreadDataDirectory(options.workspacePath, targetThreadId)
    } catch (error) {
      console.warn("[Threads] Failed to cleanup fork app-managed data:", error)
    }
  }
}

async function verifyForkCheckpointPersisted(
  targetThreadId: string,
  expectedCheckpointId: string
): Promise<void> {
  const verifier = new SqlJsSaver(getThreadCheckpointPath(targetThreadId))
  try {
    const tuple = await verifier.getTuple({
      configurable: { thread_id: targetThreadId, checkpoint_ns: "" }
    })
    if (!tuple || getCheckpointId(tuple) !== expectedCheckpointId) {
      throw new Error("Fork checkpoint was not persisted.")
    }
  } finally {
    await verifier.close()
  }
}

export async function forkThread(params: ThreadForkParams): Promise<ThreadForkResponse> {
  const sourceThreadId = assertValidCheckpointThreadId(params.sourceThreadId)
  const explicitCheckpointId = params.checkpointId?.trim()
  if (explicitCheckpointId) assertValidCheckpointThreadId(explicitCheckpointId)
  const explicitMessageId = params.messageId?.trim()

  return withThreadRunMutationLock(sourceThreadId, async () => {
    const sourceRow = getThreadCore(sourceThreadId)
    if (!sourceRow) throw new Error("源会话不存在。")

    const sourceMetadata = parseJsonObject(sourceRow.metadata) ?? {}
    const hasThreadForkBoundaryMarkerEra =
      sourceMetadata[FORK_BOUNDARY_THREAD_METADATA_KEY] === FORK_BOUNDARY_MARKER_VERSION
    const workspacePath =
      typeof sourceMetadata.workspacePath === "string" ? sourceMetadata.workspacePath : null
    const agentMode = getAgentModeFromMetadata(sourceMetadata)
    if (await isThreadForkBusy({ threadId: sourceThreadId, workspacePath, agentMode })) {
      throw new Error("当前会话仍在运行，请停止或等待完成后再 fork。")
    }
    await ensureSubagentTranscriptRows(sourceThreadId)

    const forkSource = await withCheckpointer(sourceThreadId, async (sourceSaver) => {
      const sourceTuple = await sourceSaver.getTuple({
        configurable: {
          thread_id: sourceThreadId,
          checkpoint_ns: "",
          ...(explicitCheckpointId ? { checkpoint_id: explicitCheckpointId } : {})
        }
      })
      const markerContext = sourceTuple
        ? await getForkBoundaryMarkerContext(
            sourceSaver,
            sourceThreadId,
            getCheckpointId(sourceTuple)
          )
        : { hasAnyForkBoundaryMarker: false, selectedHasNewerForkBoundaryMarker: false }
      const listedTuples: CheckpointTuple[] = []
      if (sourceTuple) {
        for await (const tuple of sourceSaver.list({
          configurable: { thread_id: sourceThreadId, checkpoint_ns: "" }
        })) {
          listedTuples.push(tuple)
        }
      }
      return { tuple: sourceTuple, markerContext, listedTuples }
    })
    const sourceTuple = forkSource.tuple
    if (!sourceTuple) throw new Error("当前会话还没有可 fork 的 checkpoint。")
    const selectedCheckpointId = getCheckpointId(sourceTuple)
    const rawListedTuples = forkSource.listedTuples.length > 0 ? forkSource.listedTuples : [sourceTuple]
    const selectedIsLatestCheckpoint =
      rawListedTuples.length > 0 && getCheckpointId(rawListedTuples[0]) === selectedCheckpointId
    const listedTuples = materializeLatestForkTuple(
      sourceThreadId,
      rawListedTuples,
      {
        omitUnsafeLatest: Boolean(explicitCheckpointId && !selectedIsLatestCheckpoint)
      }
    )
    const tuple =
      listedTuples.find((candidate) => getCheckpointId(candidate) === selectedCheckpointId) ??
      sourceTuple
    const legacyFallbackMode = resolveLegacyForkFallbackMode({
      hasThreadForkBoundaryMarkerEra,
      hasAnyForkBoundaryMarker: forkSource.markerContext.hasAnyForkBoundaryMarker
    })
    assertForkableTuple(tuple, {
      allowLegacyLatestFallback:
        !explicitCheckpointId &&
        !hasThreadForkBoundaryMarkerEra &&
        !forkSource.markerContext.hasAnyForkBoundaryMarker,
      allowLegacyHistoricalFallback:
        !!explicitCheckpointId &&
        !getForkBoundaryMarker(tuple) &&
        allowsLegacyHistoricalForkFallback({
          mode: legacyFallbackMode,
          selectedHasNewerForkBoundaryMarker:
            forkSource.markerContext.selectedHasNewerForkBoundaryMarker
        })
    })

    const checkpointId = getCheckpointId(tuple)
    const forkableSummariesById = buildForkableCheckpointSummaryMap(listedTuples, {
      activeRun: false,
      pendingApproval: false,
      legacyFallbackMode
    })
    if (explicitMessageId) {
      const messageTarget = describeCheckpointMessageForkTarget(tuple.checkpoint, explicitMessageId)
      if (
        !messageTarget.isForkableMessageBoundary ||
        !isForkableCheckpointForMessage(tuple, explicitMessageId)
      ) {
        throw new Error("该消息不是稳定完成边界上的 assistant 回复，无法从这里 fork。")
      }
    }
    if (!forkableSummariesById.has(checkpointId)) {
      throw new Error("该 checkpoint 不包含可安全 fork 的完整消息边界。")
    }
    const forkCheckpoint = explicitMessageId ? copyCheckpoint(tuple.checkpoint) : tuple.checkpoint
    if (explicitMessageId && !truncateCheckpointMessagesAfter(forkCheckpoint, explicitMessageId)) {
      throw new Error("该消息不在目标 checkpoint 中，无法从这里 fork。")
    }
    const sourceTitle =
      sourceRow.title || (typeof sourceMetadata.title === "string" ? sourceMetadata.title : "")
    const targetThreadId = uuid()
    await assertValidForkOverrides(sourceMetadata, params.overrides)
    const targetMetadata = buildForkMetadata({
      sourceThreadId,
      sourceTitle,
      sourceMetadata,
      checkpointId,
      messageId: explicitMessageId,
      title: params.title,
      overrides: params.overrides
    })
    const transcriptIndex = deriveCheckpointTranscriptIndex(forkCheckpoint)
    const sourceThreadValues = parseThreadValues(getThreadValuesJson(sourceThreadId))
    const filteredThreadValues = buildFilteredThreadValues(sourceThreadValues, transcriptIndex)
    // Message rows are the durable timing source. Rebuilding legacy lifetime
    // maps during a fork would reintroduce an O(history) thread_values payload.
    delete filteredThreadValues.messageTimes
    delete filteredThreadValues.messageTimeOrder
    delete filteredThreadValues.internalGoalMessageTimes
    delete filteredThreadValues.internalGoalMessageTimeOrder
    // Subagent manifests are copied from row storage in bounded pages below.
    // Never put an inline bucket back into the target thread_values payload.
    delete filteredThreadValues[SUBAGENT_TRANSCRIPTS_THREAD_VALUE_KEY]
    const targetWorkspacePath =
      typeof targetMetadata.workspacePath === "string" ? targetMetadata.workspacePath : null

    let targetSaver: SqlJsSaver | null = null
    let rowCreated = false
    try {
      const checkpointMetadata = normalizeForkBoundaryMetadataForCheckpoint(
        tuple.metadata ?? fallbackForkCheckpointMetadata(),
        forkCheckpoint
      )
      const sourceHistoryTuples = selectForkCheckpointHistoryTuples({
        listedTuples,
        selectedCheckpointId: checkpointId,
        legacyFallbackMode
      })
      const checkpointHistory = buildForkCheckpointHistory({
        sourceHistoryTuples: sourceHistoryTuples.length > 0 ? sourceHistoryTuples : [tuple],
        selectedCheckpointId: checkpointId,
        selectedCheckpoint: forkCheckpoint,
        selectedMetadata: checkpointMetadata
      })
      await copyForkLargeToolResults({
        checkpoints: checkpointHistory.map((entry) => entry.checkpoint),
        sourceThreadId,
        sourceWorkspacePath: workspacePath,
        targetThreadId,
        targetWorkspacePath
      })
      targetSaver = new SqlJsSaver(getThreadCheckpointPath(targetThreadId), undefined, {
        maxRootCheckpoints: Math.max(1, checkpointHistory.length),
        maxRootForkBoundaryCheckpoints: Math.max(0, checkpointHistory.length)
      })
      await putForkCheckpointHistory({
        targetSaver,
        targetThreadId,
        entries: checkpointHistory
      })
      await targetSaver.flushStrict()
      await targetSaver.close()
      targetSaver = null
      await verifyForkCheckpointPersisted(targetThreadId, forkCheckpoint.id)

      const row = await withSubagentTranscriptContentMutationLock(async () => {
        dbCreateThread(targetThreadId, targetMetadata)
        rowCreated = true
        const updated = dbUpdateThread(targetThreadId, {
          thread_values: JSON.stringify(filteredThreadValues)
        })
        if (!updated) throw new Error("Forked thread row was not created.")
        advanceSubagentTranscriptReferenceEpoch()
        return updated
      })
      await copyForkedSubagentTranscriptsPaged({
        sourceThreadId,
        targetThreadId,
        transcriptIndex
      })
      await copyForkedThreadMessages({
        sourceThreadId,
        targetThreadId,
        visibleMessages: transcriptIndex.visibleMessages,
        checkpointMessages: getCheckpointChannelMessages(forkCheckpoint)
      })
      copyForkedGoalStateForCheckpoint({
        sourceThreadId,
        targetThreadId,
        forkCheckpoint,
        isLatestCheckpointFork: selectedIsLatestCheckpoint
      })
      await flushDbStrict()
      return {
        thread: serializeThreadRow(row),
        sourceThreadId,
        sourceCheckpointId: checkpointId,
        sourceCheckpointNs: ""
      }
    } catch (error) {
      if (targetSaver) {
        try {
          await targetSaver.close()
        } catch (closeError) {
          console.warn("[Threads] Failed to close fork target saver:", closeError)
        }
      }
      await cleanupFailedFork(targetThreadId, { rowCreated, workspacePath: targetWorkspacePath })
      throw error
    }
  })
}

async function listForkableCheckpoints(threadId: string): Promise<ForkableCheckpoint[]> {
  const sourceThreadId = assertValidCheckpointThreadId(threadId)
  return withThreadRunMutationLock(sourceThreadId, async () => {
    const sourceRow = getThreadCore(sourceThreadId)
    if (!sourceRow) throw new Error("源会话不存在。")

    const sourceMetadata = parseJsonObject(sourceRow.metadata) ?? {}
    const workspacePath =
      typeof sourceMetadata.workspacePath === "string" ? sourceMetadata.workspacePath : null
    const agentMode = getAgentModeFromMetadata(sourceMetadata)
    const activeRun = await isThreadForkBusy({ threadId: sourceThreadId, workspacePath, agentMode })
    const pendingApproval = hasPendingApprovalForThread(sourceThreadId)
    return withCheckpointer(sourceThreadId, async (sourceSaver) => {
      const tuples: CheckpointTuple[] = []
      for await (const tuple of sourceSaver.list({
        configurable: { thread_id: sourceThreadId, checkpoint_ns: "" }
      })) {
        tuples.push(tuple)
      }
      const hasAnyForkBoundaryMarker = tuples.some((tuple) => Boolean(getForkBoundaryMarker(tuple)))
      const legacyFallbackMode = resolveLegacyForkFallbackMode({
        hasThreadForkBoundaryMarkerEra:
          sourceMetadata[FORK_BOUNDARY_THREAD_METADATA_KEY] === FORK_BOUNDARY_MARKER_VERSION,
        hasAnyForkBoundaryMarker
      })
      return buildVisibleForkableCheckpointList(
        materializeLatestForkTuple(sourceThreadId, tuples, { omitUnsafeLatest: true }),
        {
          activeRun,
          pendingApproval,
          legacyFallbackMode
        }
      )
    })
  })
}

function buildForkableCheckpointSummaryMap(
  tuples: CheckpointTuple[],
  options: {
    activeRun: boolean
    pendingApproval: boolean
    legacyFallbackMode: LegacyForkFallbackMode
  }
): Map<string, ForkableCheckpoint> {
  return new Map(
    buildVisibleForkableCheckpointList(tuples, options).map((summary) => [
      summary.checkpointId,
      summary
    ])
  )
}

type ForkMessageSnapshot = NonNullable<ThreadForkCheckpointForMessageParams["message"]>

interface ResolvedForkMessageTarget {
  messageId?: string
  mode: "message" | "checkpoint"
  transcript: ReturnType<typeof deriveCheckpointTranscriptIndex>
}

function normalizeComparableMessageText(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function stringifyForkMessageSnapshotContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  return content
    .map((block) => {
      if (typeof block === "string") return block
      if (!block || typeof block !== "object") return ""
      const record = block as Record<string, unknown>
      if (typeof record.text === "string") return record.text
      if (typeof record.content === "string") return record.content
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function readToolCallIdentities(toolCalls: unknown): Array<{ id?: string; name?: string }> {
  if (!Array.isArray(toolCalls)) return []
  return toolCalls.flatMap((toolCall): Array<{ id?: string; name?: string }> => {
    if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) return []
    const record = toolCall as Record<string, unknown>
    const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : undefined
    const name =
      typeof record.name === "string" && record.name.trim() ? record.name.trim() : undefined
    return id || name ? [{ id, name }] : []
  })
}

function hasMatchingToolCallIdentity(
  snapshotToolCalls: unknown,
  checkpointToolCalls: unknown
): boolean {
  const snapshotIdentities = readToolCallIdentities(snapshotToolCalls)
  const checkpointIdentities = readToolCallIdentities(checkpointToolCalls)
  if (snapshotIdentities.length === 0 || checkpointIdentities.length === 0) return false

  const snapshotIds = new Set(
    snapshotIdentities.flatMap((toolCall) => (toolCall.id ? [toolCall.id] : []))
  )
  if (snapshotIds.size > 0) {
    for (const toolCall of checkpointIdentities) {
      if (toolCall.id && snapshotIds.has(toolCall.id)) return true
    }
  }

  const snapshotNames = snapshotIdentities.map((toolCall) => toolCall.name ?? "")
  const checkpointNames = checkpointIdentities.map((toolCall) => toolCall.name ?? "")
  return (
    snapshotNames.length > 0 &&
    snapshotNames.length === checkpointNames.length &&
    snapshotNames.every((name, index) => name.length > 0 && name === checkpointNames[index])
  )
}

function comparableMessageTextsMatch(left: string, right: string): boolean {
  if (!left || !right) return false
  if (left === right) return true
  const shorterLength = Math.min(left.length, right.length)
  return shorterLength >= 24 && (left.startsWith(right) || right.startsWith(left))
}

function findCheckpointMessageById(
  checkpoint: unknown,
  messageId: string,
  role?: Message["role"],
  rawIndex?: number
): CheckpointMessage | null {
  const messages = getCheckpointChannelMessages(checkpoint) ?? []
  if (rawIndex !== undefined) {
    const indexedMessage = messages[rawIndex]
    if (
      indexedMessage &&
      getCheckpointMessageId(indexedMessage, rawIndex) === messageId &&
      (!role || getMessageRole(indexedMessage) === role)
    ) {
      return indexedMessage
    }
  }
  const index = messages.findIndex((message, messageIndex) => {
    return (
      getCheckpointMessageId(message, messageIndex) === messageId &&
      (!role || getMessageRole(message) === role)
    )
  })
  return index >= 0 ? messages[index] : null
}

function getCheckpointMessageToolCallIds(message: CheckpointMessage | null): Set<string> {
  const ids = new Set<string>()
  const toolCalls = message ? getCheckpointMessageToolCalls(message) : undefined
  if (!Array.isArray(toolCalls)) return ids
  for (const toolCall of toolCalls) {
    if (typeof toolCall?.id === "string" && toolCall.id.trim()) ids.add(toolCall.id.trim())
  }
  return ids
}

function isInterruptedForkBoundary(tuple: CheckpointTuple): boolean {
  const marker = getForkBoundaryMarker(tuple)
  // 双重检查：source 表示中断来源（用户主动中断 agent 运行），
  // outcome 表示中断结果（checkpoint 最终状态为 interrupted）。
  // 两者任一成立即视为中断边界，覆盖不同阶段的中断场景。
  return marker?.source === "agent_run_interrupted" || marker?.outcome === "interrupted"
}

function markerMatchesTranscriptTail(
  tuple: CheckpointTuple,
  transcript: ReturnType<typeof deriveCheckpointTranscriptIndex>
): boolean {
  const marker = getForkBoundaryMarker(tuple)
  const markerLastVisibleMessageId = marker?.lastVisibleMessageId
  return (
    typeof markerLastVisibleMessageId !== "string" ||
    markerLastVisibleMessageId === transcript.visibleMessageIds.at(-1)
  )
}

function snapshotMatchesCheckpointAssistantBoundary(
  tuple: CheckpointTuple,
  snapshot: ForkMessageSnapshot | undefined,
  targetMessageId: string,
  targetText: string,
  targetRawIndex?: number
): boolean {
  if (!snapshot) return false
  if (snapshot.role && snapshot.role !== "assistant") return false

  const snapshotText = normalizeComparableMessageText(
    stringifyForkMessageSnapshotContent(snapshot.content)
  )
  const checkpointText = normalizeComparableMessageText(targetText)

  const rawMessage = findCheckpointMessageById(
    tuple.checkpoint,
    targetMessageId,
    "assistant",
    targetRawIndex
  )
  if (!rawMessage) return false
  const snapshotId = typeof snapshot.id === "string" ? snapshot.id.trim() : ""
  if (snapshotId && snapshotId === targetMessageId) return true
  if (comparableMessageTextsMatch(snapshotText, checkpointText)) return true
  if (
    snapshotAllowsSparseAssistantFallback(snapshot) &&
    getCheckpointMessageToolCallIds(rawMessage).size > 0
  ) {
    return true
  }
  return hasMatchingToolCallIdentity(snapshot.tool_calls, getCheckpointMessageToolCalls(rawMessage))
}

function findSnapshotAssistantMessageInTranscript(
  tuple: CheckpointTuple,
  snapshot: ForkMessageSnapshot | undefined,
  transcript: ReturnType<typeof deriveCheckpointTranscriptIndex>
): { id: string; text: string; index: number; rawIndex?: number } | null {
  if (!snapshot) return null
  for (let index = transcript.visibleMessages.length - 1; index >= 0; index -= 1) {
    const message = transcript.visibleMessages[index]
    if (message.role !== "assistant") continue
    if (
      snapshotMatchesCheckpointAssistantBoundary(
        tuple,
        snapshot,
        message.id,
        message.text,
        message.rawIndex
      )
    ) {
      return { id: message.id, text: message.text, index, rawIndex: message.rawIndex }
    }
  }
  return null
}

function snapshotAllowsSparseAssistantFallback(
  snapshot: ForkMessageSnapshot | undefined
): boolean {
  if (!snapshot || (snapshot.role && snapshot.role !== "assistant")) return false
  const snapshotText = normalizeComparableMessageText(
    stringifyForkMessageSnapshotContent(snapshot.content)
  )
  return !snapshotText && readToolCallIdentities(snapshot.tool_calls).length === 0
}

function findLastAssistantBeforeToolTail(
  transcript: ReturnType<typeof deriveCheckpointTranscriptIndex>
): { id: string; text: string; index: number; rawIndex?: number } | null {
  let index = transcript.visibleMessages.length - 1
  while (index >= 0 && transcript.visibleMessages[index].role === "tool") {
    index -= 1
  }
  const message = index >= 0 ? transcript.visibleMessages[index] : undefined
  return message?.role === "assistant"
    ? { id: message.id, text: message.text, index, rawIndex: message.rawIndex }
    : null
}

function resolveInterruptedToolClusterForkTarget(
  tuple: CheckpointTuple,
  snapshot: ForkMessageSnapshot | undefined,
  transcript: ReturnType<typeof deriveCheckpointTranscriptIndex>,
  exactTarget: ReturnType<typeof describeCheckpointMessageForkTarget>
): ResolvedForkMessageTarget | null {
  if (!isInterruptedForkBoundary(tuple)) return null
  if (!markerMatchesTranscriptTail(tuple, transcript)) return null

  const exactMessage = exactTarget.message
  let candidateSource: "exact" | "snapshot" | "fallback" | null = null
  let candidate: { id: string; text: string; index: number; rawIndex?: number } | null = null
  if (exactMessage?.role === "assistant") {
    candidateSource = "exact"
    candidate = {
      id: exactMessage.id,
      text: exactMessage.text,
      index: transcript.visibleMessages.findIndex(
        (message) => (message.renderId ?? message.id) === (exactMessage.renderId ?? exactMessage.id)
      ),
      rawIndex: exactMessage.rawIndex
    }
  } else {
    candidate = findSnapshotAssistantMessageInTranscript(tuple, snapshot, transcript)
    if (candidate) {
      candidateSource = "snapshot"
    } else if (snapshotAllowsSparseAssistantFallback(snapshot)) {
      candidate = findLastAssistantBeforeToolTail(transcript)
      if (candidate) candidateSource = "fallback"
    }
  }
  if (!candidate || candidate.index < 0) return null

  if (
    candidateSource === "snapshot" &&
    !snapshotMatchesCheckpointAssistantBoundary(
      tuple,
      snapshot,
      candidate.id,
      candidate.text,
      candidate.rawIndex
    )
  ) {
    return null
  }

  const visibleTail = transcript.visibleMessages.slice(candidate.index + 1)
  if (visibleTail.length === 0 || visibleTail.some((message) => message.role !== "tool")) {
    return null
  }

  const assistantMessage = findCheckpointMessageById(
    tuple.checkpoint,
    candidate.id,
    "assistant",
    candidate.rawIndex
  )
  const assistantToolCallIds = getCheckpointMessageToolCallIds(assistantMessage)
  if (assistantToolCallIds.size === 0) return null

  const rawMessages = getCheckpointChannelMessages(tuple.checkpoint) ?? []
  const candidateRawIndex =
    candidate.rawIndex ??
    rawMessages.findIndex((message, index) => {
      return (
        getCheckpointMessageId(message, index) === candidate.id &&
        getMessageRole(message) === "assistant"
      )
    })
  if (candidateRawIndex < 0) return null

  for (let index = candidateRawIndex + 1; index < rawMessages.length; index += 1) {
    const message = rawMessages[index]
    const role = getMessageRole(message)
    if (role !== "tool") return null
    const toolCallId = getCheckpointMessageToolCallId(message)
    if (!toolCallId || !assistantToolCallIds.has(toolCallId)) return null
  }

  return { mode: "checkpoint", transcript }
}

function resolveForkableCheckpointMessageTarget(
  tuple: CheckpointTuple,
  requestedMessageId: string,
  snapshot?: ForkMessageSnapshot
): ResolvedForkMessageTarget | null {
  // 分支 1：请求的消息 ID 恰好是当前 checkpoint 的可 fork 消息边界
  // 直接返回该消息作为 fork 目标，这是最常见的路径。
  const exactTarget = describeCheckpointMessageForkTarget(tuple.checkpoint, requestedMessageId)
  if (
    exactTarget.isForkableMessageBoundary &&
    isForkableCheckpointForMessage(tuple, requestedMessageId)
  ) {
    return { mode: "message", messageId: requestedMessageId, transcript: exactTarget.transcript }
  }

  // 分支 2：请求的消息不是可 fork 边界，尝试回退到 transcript 中最后一条 assistant 消息
  // 场景：用户选择了一条 tool_call 消息（不可直接 fork），需要回退到同轮次的 assistant 消息。
  const lastVisibleMessage = exactTarget.transcript.visibleMessages.at(-1)
  if (lastVisibleMessage?.role === "assistant") {
    const lastVisibleMessageId = lastVisibleMessage.renderId ?? lastVisibleMessage.id
    if (!isForkableCheckpointForMessage(tuple, lastVisibleMessageId)) return null
    if (
      !snapshotMatchesCheckpointAssistantBoundary(
        tuple,
        snapshot,
        lastVisibleMessage.id,
        lastVisibleMessage.text,
        lastVisibleMessage.rawIndex
      )
    ) {
      return null
    }

    return {
      mode: "message",
      messageId: lastVisibleMessageId,
      transcript: exactTarget.transcript
    }
  }

  // 分支 3：最后一条消息不是 assistant（可能是 tool 或 interrupt），
  // 尝试解析中断工具集群的 fork 目标（递归处理嵌套工具调用链）。
  return resolveInterruptedToolClusterForkTarget(
    tuple,
    snapshot,
    exactTarget.transcript,
    exactTarget
  )
}

export async function resolveForkCheckpointForMessage(
  params: ThreadForkCheckpointForMessageParams
): Promise<ForkableCheckpoint | null> {
  const sourceThreadId = assertValidCheckpointThreadId(params.threadId)
  const messageId = params.messageId.trim()
  if (!messageId) return null

  return withThreadRunMutationLock(sourceThreadId, async () => {
    const sourceRow = getThreadCore(sourceThreadId)
    if (!sourceRow) throw new Error("源会话不存在。")

    const sourceMetadata = parseJsonObject(sourceRow.metadata) ?? {}
    const workspacePath =
      typeof sourceMetadata.workspacePath === "string" ? sourceMetadata.workspacePath : null
    const agentMode = getAgentModeFromMetadata(sourceMetadata)
    const activeRun = await isThreadForkBusy({ threadId: sourceThreadId, workspacePath, agentMode })
    const pendingApproval = hasPendingApprovalForThread(sourceThreadId)
    return withCheckpointer(sourceThreadId, async (sourceSaver) => {
      const tuples: CheckpointTuple[] = []
      for await (const tuple of sourceSaver.list({
        configurable: { thread_id: sourceThreadId, checkpoint_ns: "" }
      })) {
        tuples.push(tuple)
      }
      const hasAnyForkBoundaryMarker = tuples.some((tuple) => Boolean(getForkBoundaryMarker(tuple)))
      const legacyFallbackMode = resolveLegacyForkFallbackMode({
        hasThreadForkBoundaryMarkerEra:
          sourceMetadata[FORK_BOUNDARY_THREAD_METADATA_KEY] === FORK_BOUNDARY_MARKER_VERSION,
        hasAnyForkBoundaryMarker
      })
      const materializedTuples = materializeLatestForkTuple(sourceThreadId, tuples, {
        omitUnsafeLatest: true
      })
      const forkableSummariesById = buildForkableCheckpointSummaryMap(materializedTuples, {
        activeRun,
        pendingApproval,
        legacyFallbackMode
      })
      for (const tuple of materializedTuples) {
        const listedSummary = forkableSummariesById.get(getCheckpointId(tuple))
        if (!listedSummary) continue
        const messageTarget = resolveForkableCheckpointMessageTarget(
          tuple,
          messageId,
          params.message
        )
        if (messageTarget) {
          return {
            ...listedSummary,
            messageForkMode: messageTarget.mode,
            ...(messageTarget.messageId ? { resolvedMessageId: messageTarget.messageId } : {})
          }
        }
      }
      return null
    })
  })
}

function toIsoString(value: number | Date): string {
  return new Date(value).toISOString()
}

function getCheckpointMessageClassName(msg: CheckpointMessage): string {
  if (!Array.isArray(msg.id)) return ""
  const last = msg.id[msg.id.length - 1]
  return typeof last === "string" ? last : ""
}

function getMessageRole(msg: CheckpointMessage): ExportMessageRole | null {
  let type = msg.type ?? msg.kwargs?.type
  if (!type && typeof msg._getType === "function") {
    type = msg._getType()
  }

  if (type === "human") return "user"
  if (type === "ai") return "assistant"
  if (type === "system") return "system"
  if (type === "tool") return "tool"

  const className = getCheckpointMessageClassName(msg)
  if (className === "HumanMessage") return "user"
  if (className === "AIMessage" || className === "AIMessageChunk") return "assistant"
  if (className === "SystemMessage") return "system"
  if (className === "ToolMessage") return "tool"
  return null
}

function getCheckpointMessageId(msg: CheckpointMessage, index: number): string {
  return msg.kwargs?.id ?? (typeof msg.id === "string" ? msg.id : `msg-${index}`)
}

function getCheckpointMessageContent(msg: CheckpointMessage): CheckpointMessage["content"] {
  return msg.content ?? msg.kwargs?.content
}

function getCheckpointMessageAdditionalKwargs(
  msg: CheckpointMessage
): Record<string, unknown> | undefined {
  const additionalKwargs = msg.additional_kwargs ?? msg.kwargs?.additional_kwargs
  return additionalKwargs && typeof additionalKwargs === "object" && !Array.isArray(additionalKwargs)
    ? additionalKwargs
    : undefined
}

function getCheckpointMessageTranscriptContent(
  msg: CheckpointMessage,
  role: ExportMessageRole
): CheckpointMessage["content"] {
  const visibleUserMessage = getCheckpointMessageAdditionalKwargs(msg)?.cmb_visible_user_message
  if (role === "user" && typeof visibleUserMessage === "string" && visibleUserMessage.length > 0) {
    return visibleUserMessage
  }
  return getCheckpointMessageContent(msg)
}

function getCheckpointMessageToolCalls(msg: CheckpointMessage): CheckpointMessage["tool_calls"] {
  return msg.tool_calls ?? msg.kwargs?.tool_calls
}

function getCheckpointMessageToolCallId(msg: CheckpointMessage): string | undefined {
  return msg.tool_call_id ?? msg.kwargs?.tool_call_id
}

function getCheckpointMessageName(msg: CheckpointMessage): string | undefined {
  return msg.name ?? msg.kwargs?.name
}

function stringifyContent(content: CheckpointMessage["content"]): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  return content
    .map((block) => {
      if (typeof block === "string") return block
      if (!block || typeof block !== "object") return ""
      const record = block as Record<string, unknown>
      if (typeof record.text === "string") return record.text
      if (typeof record.content === "string") return record.content
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function sanitizeAttachmentContent(content: string): {
  content: string
  attachments: ExportAttachment[]
} {
  const attachments: ExportAttachment[] = []
  const cleaned = content
    .replace(
      /<attachment\s+filename="([^"]*)"[^>]*>[\s\S]*?<\/attachment>/g,
      (_match, encodedName: string) => {
        attachments.push({ filename: decodeXmlAttribute(encodedName) })
        return ""
      }
    )
    .trim()

  return { content: cleaned, attachments }
}

function safeFileName(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[<>:"/\\|?*]/g, "-")
    .split("")
    .map((char) => (char.charCodeAt(0) < 32 ? "-" : char))
    .join("")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .slice(0, 80)
    .trim()

  return cleaned || "chat-session"
}

async function collectReferencedTranscriptHashesBounded(): Promise<Set<string>> {
  return collectReferencedTranscriptHashesFromPages({
    readThreadValuesPage: getThreadValuesJsonPage,
    readManifestPage: getThreadSubagentManifestJsonPage,
    threadPageSize: 16,
    manifestPageSize: 128
  })
}

function escapeMarkdown(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`")
}

function stringifyToolArgs(args: unknown): string {
  if (args === undefined) return ""
  if (typeof args === "string") return args

  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(
      args,
      (_key, value) => {
        if (typeof value === "bigint") return value.toString()
        if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`
        if (typeof value === "symbol") return value.toString()
        if (value && typeof value === "object") {
          if (seen.has(value)) return "[Circular]"
          seen.add(value)
        }
        return value
      },
      2
    )
  } catch {
    return String(args)
  }
}

function truncateValue(value: string, limit: number): { value: string; truncated: boolean } {
  if (value.length <= limit) return { value, truncated: false }
  return { value: `${value.slice(0, limit)}\n...[truncated]`, truncated: true }
}

function buildExportToolCalls(toolCalls: CheckpointMessage["tool_calls"]): ExportToolCall[] {
  if (!Array.isArray(toolCalls)) return []

  return toolCalls.flatMap((toolCall): ExportToolCall[] => {
    const name = typeof toolCall?.name === "string" ? toolCall.name.trim() : ""
    if (!name) return []

    const serializedArgs = stringifyToolArgs(toolCall.args)
    const truncated = truncateValue(serializedArgs, TOOL_CALL_ARGS_LIMIT)

    return [
      {
        ...(typeof toolCall.id === "string" && toolCall.id ? { id: toolCall.id } : {}),
        name,
        args: truncated.value,
        truncated: truncated.truncated
      }
    ]
  })
}

function formatMarkdown(payload: ExportPayload): string {
  const lines: string[] = [
    `# ${escapeMarkdown(payload.thread.title)}`,
    "",
    `- Thread ID: \`${payload.thread.threadId}\``,
    `- Workspace: ${payload.thread.workspacePath ? escapeMarkdown(payload.thread.workspacePath) : "未关联工作区"}`,
    `- Created: ${payload.thread.createdAt}`,
    `- Updated: ${payload.thread.updatedAt}`,
    `- Exported: ${payload.exportedAt}`,
    ""
  ]

  const roleLabel: Record<ExportMessageRole, string> = {
    user: "User",
    assistant: "Assistant",
    system: "System",
    tool: "Tool Result"
  }

  for (const message of payload.messages) {
    if (
      !message.content.trim() &&
      message.attachments.length === 0 &&
      (!message.toolCalls || message.toolCalls.length === 0)
    ) {
      continue
    }

    lines.push(`## ${roleLabel[message.role]}`, "")
    if (message.role === "tool") {
      const toolMeta = [
        message.name ? `name: \`${escapeMarkdown(message.name)}\`` : null,
        message.toolCallId ? `tool_call_id: \`${escapeMarkdown(message.toolCallId)}\`` : null,
        message.truncated ? "content truncated" : null
      ].filter(Boolean)
      if (toolMeta.length > 0) {
        lines.push(`_${toolMeta.join(", ")}_`, "")
      }
    }
    if (message.attachments.length > 0) {
      lines.push(
        ...message.attachments.map(
          (attachment) => `- Attachment: ${escapeMarkdown(attachment.filename)}`
        ),
        ""
      )
    }
    if (message.content.trim()) {
      lines.push(message.content.trim(), "")
    }
    if (message.toolCalls && message.toolCalls.length > 0) {
      lines.push("### Tool Calls", "")
      for (const toolCall of message.toolCalls) {
        lines.push(
          `- ${escapeMarkdown(toolCall.name)}${toolCall.truncated ? " (args truncated)" : ""}`
        )
        if (toolCall.args.trim()) {
          lines.push("", "```json", toolCall.args, "```", "")
        }
      }
    }
  }

  return `${lines.join("\n").trimEnd()}\n`
}

async function getLatestCheckpoint(threadId: string): Promise<ThreadCheckpoint | null> {
  return withCheckpointer(threadId, async (checkpointer) => {
    const config = { configurable: { thread_id: threadId } }
    for await (const checkpoint of checkpointer.list(config, { limit: 1 })) {
      return checkpoint as ThreadCheckpoint
    }
    return null
  })
}

function buildExportMessages(messages: CheckpointMessage[] | undefined): ExportMessage[] {
  if (!Array.isArray(messages)) return []

  return messages.flatMap((msg, index): ExportMessage[] => {
    const role = getMessageRole(msg)
    if (!role) return []

    const rawContent = stringifyContent(getCheckpointMessageTranscriptContent(msg, role))
    // Drop the new workflow notification plumbing from the export. Coordinator
    // plumbing is intentionally left as-is (HEAD behavior) — see helper note.
    if (isWorkflowPlumbingTranscriptContent(rawContent)) return []
    const { content, attachments } = sanitizeAttachmentContent(rawContent)
    const exportedContent =
      role === "tool"
        ? truncateValue(content, TOOL_RESULT_CONTENT_LIMIT)
        : { value: content, truncated: false }
    const toolCalls = buildExportToolCalls(getCheckpointMessageToolCalls(msg))
    const toolCallNames = toolCalls.map((toolCall) => toolCall.name)

    if (!exportedContent.value.trim() && attachments.length === 0 && toolCalls.length === 0) {
      return []
    }

    return [
      {
        id: getCheckpointMessageId(msg, index),
        role,
        content: exportedContent.value,
        ...(exportedContent.truncated ? { truncated: true } : {}),
        attachments,
        ...(toolCalls.length > 0 ? { toolCalls, toolCallNames } : {}),
        ...(role === "tool" && getCheckpointMessageToolCallId(msg)
          ? { toolCallId: getCheckpointMessageToolCallId(msg) }
          : {}),
        ...(role === "tool" && getCheckpointMessageName(msg)
          ? { name: getCheckpointMessageName(msg) }
          : {})
      }
    ]
  })
}

function roleToCheckpointType(role: Message["role"]): CheckpointMessage["type"] {
  if (role === "user") return "human"
  if (role === "assistant") return "ai"
  return role
}

function checkpointMessagesToThreadMessages(
  messages: CheckpointMessage[] | undefined,
  options: { visibleRawIndices?: readonly number[] } = {}
): Message[] {
  if (!Array.isArray(messages)) return []
  const candidates: Array<[CheckpointMessage, number]> = options.visibleRawIndices
    ? Array.from(new Set(options.visibleRawIndices)).flatMap((index) =>
        Number.isSafeInteger(index) && index >= 0 && index < messages.length
          ? [[messages[index], index] as [CheckpointMessage, number]]
          : []
      )
    : messages.map((message, index) => [message, index])
  const now = new Date()
  return candidates.flatMap(([msg, index]): Message | [] => {
    const role = getMessageRole(msg)
    if (!role) return []
    const id = getCheckpointMessageId(msg, index)
    const content = getCheckpointMessageTranscriptContent(msg, role)
    const rawText = stringifyContent(content)
    if (isWorkflowPlumbingTranscriptContent(rawText)) return []
    const additionalKwargs = getCheckpointMessageAdditionalKwargs(msg)
    const providerTuple =
      role === "assistant"
        ? getMessageProviderTupleFromMetadata(additionalKwargs)
        : undefined
    return {
      id,
      ...providerTuple,
      role,
      content:
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? (content as Message["content"])
            : "",
      ...(getCheckpointMessageToolCalls(msg)
        ? { tool_calls: getCheckpointMessageToolCalls(msg) as Message["tool_calls"] }
        : {}),
      ...(role === "tool" && getCheckpointMessageToolCallId(msg)
        ? { tool_call_id: getCheckpointMessageToolCallId(msg) }
        : {}),
      ...(role === "tool" && getCheckpointMessageName(msg)
        ? { name: getCheckpointMessageName(msg) }
        : {}),
      created_at: now
    }
  })
}

function getCheckpointChannelMessages(checkpoint: unknown): CheckpointMessage[] | undefined {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return undefined
  const channelValues = (checkpoint as { channel_values?: unknown }).channel_values
  if (!channelValues || typeof channelValues !== "object" || Array.isArray(channelValues)) {
    return undefined
  }
  const messages = (channelValues as { messages?: unknown }).messages
  return Array.isArray(messages) ? (messages as CheckpointMessage[]) : undefined
}

function buildExportMessagesFromThreadMessages(messages: Message[]): ExportMessage[] {
  return buildExportMessages(
    messages.map((message) => ({
      id: message.id,
      type: roleToCheckpointType(message.role),
      content: message.content,
      tool_calls: message.tool_calls,
      tool_call_id: message.tool_call_id,
      name: message.name
    }))
  )
}

export function mergeCheckpointAndPersistedThreadMessagesForSession(
  checkpoint: unknown,
  persistedMessages: Message[]
): Message[] {
  const checkpointTranscriptIndex = checkpoint ? deriveCheckpointTranscriptIndex(checkpoint) : null
  const checkpointMessages = checkpointMessagesToThreadMessages(
    getCheckpointChannelMessages(checkpoint),
    checkpointTranscriptIndex
      ? {
          visibleRawIndices: checkpointTranscriptIndex.visibleMessages.flatMap((message) =>
            typeof message.rawIndex === "number" ? [message.rawIndex] : []
          )
        }
      : {}
  )
  return mergeThreadMessageTranscripts(checkpointMessages, persistedMessages)
}

function serializeGoal(goal: ThreadGoal | null): ThreadGoal | null {
  return goal
    ? {
        ...goal,
        ledger: {
          progress: [...goal.ledger.progress],
          evidence: [...goal.ledger.evidence],
          blockers: [...goal.ledger.blockers]
        },
        context: { ...goal.context }
      }
    : null
}

export function registerThreadHandlers(ipcMain: IpcMain): void {
  // Read a bounded page of task summaries. The renderer incrementally builds the
  // directory so Electron never structured-clones an unbounded task table.
  ipcMain.handle("threads:list-page", async (event, options?: ThreadSummaryPageOptions) => {
    try {
      return await readThreadSummaryPageInWorker(options, event.sender.id)
    } catch (error) {
      if (!isThreadMetadataHydrationWorkerUnavailable(error)) throw error
      console.warn(
        "[ThreadMetadataHydrationWorker] unavailable; retrying bounded task directory page",
        error
      )
      return readThreadSummaryPageInWorker(options, event.sender.id)
    }
  })

  // Get a single thread
  ipcMain.handle(
    "threads:get",
    async (event, threadId: string, options?: ThreadHydrationOptions) => {
      try {
        return await readThreadHydrationInWorker(
          threadId,
          options?.requestScope === "foreground-hydration" ? event.sender.id : undefined
        )
      } catch (error) {
        if (!isThreadMetadataHydrationWorkerUnavailable(error)) throw error
        console.warn(
          "[ThreadMetadataHydrationWorker] unavailable; using main-process thread fallback",
          error
        )
        const row = getThreadHydrationCore(threadId)
        if (!row) return null
        return {
          thread_id: row.thread_id,
          created_at: new Date(row.created_at),
          updated_at: new Date(row.updated_at),
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
          status: row.status as Thread["status"],
          thread_values: {},
          title: row.title
        }
      }
    }
  )

  ipcMain.handle("threads:messages", async (_event, threadId: string) => {
    return getThreadMessages(threadId)
  })

  ipcMain.handle(
    "threads:messages-page",
    async (
      event,
      {
        threadId,
        options
      }: { threadId: string; options?: ThreadMessagesPageOptions }
    ) => {
      try {
        return await readThreadMessagesPageInWorker(threadId, options, event.sender.id)
      } catch (error) {
        if (!isThreadMessageHydrationWorkerUnavailable(error)) throw error
        console.warn(
          "[ThreadHydrationWorker] unavailable; restarting the isolated reader",
          error
        )
        // Never deserialize a transcript row on Electron main as a fallback:
        // the first durable row may legitimately exceed the page budget. The
        // client drops a failed worker, so one retry starts a fresh isolated
        // reader; a second failure is surfaced for the renderer to retry.
        await new Promise<void>((resolve) => setImmediate(resolve))
        return readThreadMessagesPageInWorker(threadId, options, event.sender.id)
      }
    }
  )

  ipcMain.handle(
    "threads:search-messages",
    async (
      _event,
      {
        threadId,
        query,
        options
      }: { threadId: string; query: string; options?: ThreadMessageSearchOptions }
    ) => {
      return searchThreadMessages(threadId, query, options)
    }
  )

  ipcMain.handle(
    "threads:appendMessages",
    async (_event, { threadId, messages }: { threadId: string; messages: Message[] }) => {
      return withThreadRunMutationLock(threadId, async () => {
        if (!Array.isArray(messages)) return { count: 0 }
        const count = upsertThreadMessages(
          threadId,
          messages.map(normalizeIpcThreadMessage),
          { preserveExistingOrder: true }
        )
        return { count }
      })
    }
  )

  ipcMain.handle(
    "threads:replaceMessageId",
    async (
      _event,
      {
        threadId,
        fromId,
        toId,
        role
      }: { threadId: string; fromId: string; toId: string; role?: Message["role"] }
    ) => {
      return withThreadRunMutationLock(threadId, async () => {
        // withThreadRunMutationLock 是应用层互斥锁，防止同一 thread 的多个 IPC
        // handler 并发执行；replaceThreadMessageId 内部使用 SQLite 事务保证数据库
        // 原子性。两层锁定层级不同（应用层互斥 + 数据库事务），不会导致死锁，
        // 但在高并发场景下互斥锁可能成为性能瓶颈。
        return {
          replaced: replaceThreadMessageId(threadId, fromId, toId, normalizeIpcMessageRole(role))
        }
      })
    }
  )

  // Create a new thread
  ipcMain.handle("threads:create", async (_event, metadata?: Record<string, unknown>) => {
    const threadId = uuid()
    // 先拷贝一份，避免直接修改调用方传入的 metadata 对象。
    const nextMetadata: Record<string, unknown> = { ...(metadata ?? {}) }
    const harnessFeatureMetadata =
      nextMetadata.harnessFeature &&
      typeof nextMetadata.harnessFeature === "object" &&
      !Array.isArray(nextMetadata.harnessFeature)
        ? (nextMetadata.harnessFeature as Record<string, unknown>)
        : undefined
    if (harnessFeatureMetadata) {
      nextMetadata.harnessFeature = {
        ...harnessFeatureMetadata,
        requestUserInputConfig: { ...DEFAULT_HARNESS_REQUEST_USER_INPUT_CONFIG }
      }
    }

    // 仅当调用方没有显式传 workspacePath 时，才自动继承最近工作区。
    // 这样可以兼容两种场景：
    // 1) 用户手动点“新任务” -> 自动带上最近目录；
    // 2) 业务方显式指定 workspacePath -> 保持调用方优先。
    const hasWorkspacePath = Object.prototype.hasOwnProperty.call(nextMetadata, "workspacePath")
    if (!hasWorkspacePath) {
      // UNC/network paths can make existsSync block Electron main for seconds.
      // Probe asynchronously with a short bound, then verify the setting did not
      // change while I/O was in flight before inheriting it.
      const lastWorkspacePath = await resolveRecentWorkspacePath(() =>
        settingsStore.get("workspacePath", null)
      )
      if (lastWorkspacePath) {
        nextMetadata.workspacePath = lastWorkspacePath
      }
    }

    let harnessContext: Awaited<ReturnType<typeof buildHarnessFeatureAgentContext>> = null
    try {
      const workspacePath =
        typeof nextMetadata.workspacePath === "string" ? nextMetadata.workspacePath : undefined
      harnessContext = await buildHarnessFeatureAgentContext(nextMetadata, {
        workspacePath,
        requestUserInputConfigSource: "plugin"
      })
      if (harnessFeatureMetadata && harnessContext?.agentConfig?.toolConfig?.requestUserInput) {
        nextMetadata.harnessFeature = {
          ...harnessFeatureMetadata,
          requestUserInputConfig: harnessContext.agentConfig.toolConfig.requestUserInput
        }
      }
    } catch (error) {
      console.warn("[Threads] Failed to resolve Harness request_user_input policy:", error)
    }

    if (!Object.prototype.hasOwnProperty.call(nextMetadata, "agentMode")) {
      try {
        const initialAgentMode = harnessContext?.agentConfig?.agentMode
        if (initialAgentMode === "solo") {
          nextMetadata.agentMode = "normal"
          nextMetadata.subagentsEnabled = false
        }
        if (initialAgentMode === "multi") {
          nextMetadata.agentMode = "normal"
          nextMetadata.subagentsEnabled = true
        }
        if (initialAgentMode === "agent_team") nextMetadata.agentMode = "coordinator"
      } catch (error) {
        console.warn("[Threads] Failed to apply Harness initial agent mode:", error)
      }
    }
    if (
      getAgentModeFromMetadata(nextMetadata) === "normal" &&
      typeof nextMetadata.subagentsEnabled !== "boolean"
    ) {
      nextMetadata.subagentsEnabled = true
    }

    const hasModel = Object.prototype.hasOwnProperty.call(nextMetadata, "model")
    if (!hasModel) {
      const defaultModelId = getDefaultModel()
      if (defaultModelId) {
        nextMetadata.model = defaultModelId
      }
    }

    // title 仍保持原有规则：优先使用调用方传入，否则使用日期默认值。
    const title = (nextMetadata.title as string) || `Thread ${new Date().toLocaleDateString()}`
    nextMetadata.title = title

    const thread = dbCreateThread(threadId, nextMetadata)

    return {
      thread_id: thread.thread_id,
      created_at: new Date(thread.created_at),
      updated_at: new Date(thread.updated_at),
      metadata: thread.metadata ? JSON.parse(thread.metadata) : undefined,
      status: thread.status as Thread["status"],
      thread_values: thread.thread_values ? JSON.parse(thread.thread_values) : undefined,
      title
    } as Thread
  })

  ipcMain.handle("threads:fork", async (_event, params: ThreadForkParams) => {
    return forkThread(params)
  })

  ipcMain.handle("threads:list-forkable-checkpoints", async (_event, threadId: string) => {
    return listForkableCheckpoints(threadId)
  })

  ipcMain.handle(
    "threads:resolve-fork-checkpoint-for-message",
    async (_event, params: ThreadForkCheckpointForMessageParams) => {
      return resolveForkCheckpointForMessage(params)
    }
  )

  // Update a thread
  ipcMain.handle("threads:update", async (_event, { threadId, updates }: ThreadUpdateParams) => {
    return withThreadRunMutationLock(threadId, async () => {
      const updateData: Parameters<typeof dbUpdateThread>[1] = {}

      if (updates.metadata !== undefined) {
        const currentThread = getThreadCore(threadId)
        const currentMetadata = currentThread?.metadata
          ? (JSON.parse(currentThread.metadata) as Record<string, unknown>)
          : {}
        await assertCanPersistExplicitNormalMode(
          threadId,
          currentMetadata,
          updates.metadata as Record<string, unknown>
        )
        const requestedMetadata = updates.metadata as Record<string, unknown>
        for (const key of MAIN_ONLY_THREAD_METADATA_KEYS) {
          if (
            !Object.prototype.hasOwnProperty.call(requestedMetadata, key) &&
            Object.prototype.hasOwnProperty.call(currentMetadata, key)
          ) {
            requestedMetadata[key] = currentMetadata[key]
          }
        }
      }

      if (updates.title !== undefined) updateData.title = updates.title
      if (updates.status !== undefined) updateData.status = updates.status
      if (updates.metadata !== undefined) updateData.metadata = JSON.stringify(updates.metadata)
      if (updates.thread_values !== undefined) {
        await ensureSubagentTranscriptRows(threadId)
        const safeValues = { ...updates.thread_values }
        delete safeValues[SUBAGENT_TRANSCRIPTS_THREAD_VALUE_KEY]
        delete safeValues.messageTimes
        delete safeValues.messageTimeOrder
        delete safeValues.internalGoalMessageTimes
        delete safeValues.internalGoalMessageTimeOrder
        updateData.thread_values = JSON.stringify(safeValues)
      }

      const row = dbUpdateThread(threadId, updateData)
      if (!row) throw new Error("Thread not found")

      return serializeThreadRow(row)
    })
  })

  ipcMain.handle(
    "threads:mergeThreadValues",
    async (_event, { threadId, patch }: ThreadValuesMergeParams) => {
      return withThreadRunMutationLock(threadId, async () => {
        await ensureSubagentTranscriptRows(threadId)
        const safePatch = { ...patch }
        delete safePatch[SUBAGENT_TRANSCRIPTS_THREAD_VALUE_KEY]
        delete safePatch.messageTimes
        delete safePatch.messageTimeOrder
        delete safePatch.internalGoalMessageTimes
        delete safePatch.internalGoalMessageTimeOrder
        const row = dbMergeThreadValues(threadId, safePatch)
        if (!row) throw new Error("Thread not found")

        return serializeThreadRow(row)
      })
    }
  )

  ipcMain.handle("threads:getSubagentTranscripts", async (
    event,
    threadId: string,
    options?: { requestScope?: "foreground-hydration" }
  ) => {
    const webContentsId = event.sender.id
    const isForeground = options?.requestScope === "foreground-hydration"
    if (isForeground) {
      const previousThreadId = foregroundLegacySubagentMigrationByWebContents.get(webContentsId)
      if (previousThreadId && previousThreadId !== threadId) {
        cancelLegacySubagentTranscriptMigration(previousThreadId)
      }
      foregroundLegacySubagentMigrationByWebContents.set(webContentsId, threadId)
    }
    try {
      return await withThreadRunMutationLock(threadId, async () => {
        if (!getThreadCore(threadId)) return {}
        await ensureSubagentTranscriptRows(threadId)
        return readSubagentTranscriptStartupInWorker(threadId, {
          scope: isForeground
            ? `webContents:${webContentsId}:foreground`
            : `webContents:${webContentsId}:background:${threadId}`
        })
      })
    } catch (error) {
      if (isSubagentTranscriptStartupCancelled(error)) return {}
      throw error
    } finally {
      if (
        isForeground &&
        foregroundLegacySubagentMigrationByWebContents.get(webContentsId) === threadId
      ) {
        foregroundLegacySubagentMigrationByWebContents.delete(webContentsId)
      }
    }
  })

  ipcMain.handle(
    "threads:getSubagentTranscript",
    async (
      _event,
      {
        threadId,
        subagentId,
        before
      }: { threadId: string; subagentId: string; before?: number }
    ) => {
      const page = await withThreadRunMutationLock(threadId, async () => {
        if (!getThreadCore(threadId) || !subagentId) {
          return sliceSubagentTranscriptManifestPage([], before)
        }
        await ensureSubagentTranscriptRows(threadId)
        let selectedPage = rowBackedSubagentTranscriptPage(threadId, subagentId, before)
        if (
          !selectedPage.deferredHydration ||
          selectedPage.start >= selectedPage.end
        ) {
          return selectedPage
        }

        const deferredMessage = selectedPage.messages[0]
        const hasSidecar =
          deferredMessage &&
          typeof deferredMessage === "object" &&
          !Array.isArray(deferredMessage) &&
          (["content", "reasoning", "tool_calls"] as const).some((field) =>
            isSubagentTranscriptBlobRef(
              (deferredMessage as Record<string, unknown>)[`${field}_ref`],
              field
            )
          )
        if (hasSidecar) return selectedPage

        // A legacy inline value can itself exceed the hydration budget. Compact
        // just that selected row on demand so the bounded page gains a sidecar
        // that the user can stream-export; never migrate the whole history here.
        selectedPage = await withSubagentTranscriptContentMutationLock(async () => {
          const compacted = await compactSubagentTranscriptManifests({
            [subagentId]: [deferredMessage]
          })
          const compactedBucket = compacted.manifests[subagentId]
          if (!compacted.changed || !Array.isArray(compactedBucket) || !compactedBucket[0]) {
            return selectedPage
          }
          upsertThreadSubagentManifestMessages(threadId, subagentId, [compactedBucket[0]])
          advanceSubagentTranscriptReferenceEpoch()
          return rowBackedSubagentTranscriptPage(threadId, subagentId, before)
        })
        return selectedPage
      })
      // Blobs are immutable. Release both mutation locks before unbounded disk
      // reads so opening a large record cannot delay cancel/delete or another
      // focused request. Concurrent GC may make a blob unavailable; hydration
      // deliberately degrades to the compact projection in that case.
      const hydrated = await hydrateSubagentTranscriptManifestPage(page)
      const deferredMessage = page.deferredHydration ? page.messages[0] : undefined
      const deferredExport =
        deferredMessage &&
        typeof deferredMessage === "object" &&
        !Array.isArray(deferredMessage) &&
        typeof (deferredMessage as Record<string, unknown>).id === "string"
          ? {
              messageIndex: page.start,
              expectedMessageId: (deferredMessage as Record<string, unknown>).id as string,
              fields: (["content", "reasoning", "tool_calls"] as const).filter((field) =>
                isSubagentTranscriptBlobRef(
                  (deferredMessage as Record<string, unknown>)[`${field}_ref`],
                  field
                )
              )
            }
          : undefined
      return {
        messages: hydrated,
        deferredHydration: page.deferredHydration,
        ...(deferredExport?.fields.length && { deferredExport }),
        end: page.end,
        start: page.start,
        ...(page.nextBefore !== undefined && { nextBefore: page.nextBefore }),
        total: page.total
      }
    }
  )

  ipcMain.handle(
    "threads:exportSubagentTranscriptBlob",
    async (
      event,
      {
        threadId,
        subagentId,
        messageIndex,
        expectedMessageId,
        field
      }: {
        threadId: string
        subagentId: string
        messageIndex: number
        expectedMessageId: string
        field: SubagentTranscriptBlobField
      }
    ) => {
      let releasePin: (() => void) | undefined
      try {
        if (!(["content", "reasoning", "tool_calls"] as const).includes(field)) {
          return { success: false, error: "Invalid transcript field" }
        }
        const canExport = await withThreadRunMutationLock(threadId, async () => {
          if (
            !getThreadCore(threadId) ||
            !subagentId ||
            !expectedMessageId ||
            !Number.isSafeInteger(messageIndex) ||
            messageIndex < 0
          ) {
            return undefined
          }
          await ensureSubagentTranscriptRows(threadId)
          const message = getThreadSubagentManifestAt(threadId, subagentId, messageIndex)
          if (!message || typeof message !== "object" || Array.isArray(message)) return undefined
          if ((message as Record<string, unknown>).id !== expectedMessageId) return undefined
          const candidate = (message as Record<string, unknown>)[`${field}_ref`]
          return isSubagentTranscriptBlobRef(candidate, field)
        })
        if (!canExport) return { success: false, error: "完整内容引用不存在或已失效" }

        const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
        const result = await dialog.showSaveDialog(win ?? BrowserWindow.getAllWindows()[0], {
          title: "导出子代理完整记录字段",
          defaultPath: `${safeFileName(`${subagentId}-${expectedMessageId}-${field}`)}.json`,
          filters: [{ name: "JSON", extensions: ["json"] }]
        })
        if (result.canceled || !result.filePath) return { success: false, canceled: true }
        const exported = await withThreadRunMutationLock(threadId, async () => {
          if (!getThreadCore(threadId)) return false
          const message = getThreadSubagentManifestAt(threadId, subagentId, messageIndex)
          if (!message || typeof message !== "object" || Array.isArray(message)) return false
          const record = message as Record<string, unknown>
          if (record.id !== expectedMessageId) return false
          const ref = record[`${field}_ref`]
          if (!isSubagentTranscriptBlobRef(ref, field)) return false
          await withSubagentTranscriptContentMutationLock(async () => {
            releasePin = acquireSubagentTranscriptBlobReadPin(ref)
          })
          const journalLength = Number(record[`subagent_${field}_delta_journal_length`]) || 0
          if ((field === "content" || field === "reasoning") && journalLength > 0) {
            await exportSubagentTranscriptTextWithJournal(
              ref,
              result.filePath!,
              (afterFragmentId) =>
                getThreadSubagentTextJournalChunkPage(
                  threadId,
                  subagentId,
                  expectedMessageId,
                  field,
                  afterFragmentId,
                  128
                )
            )
          } else {
            await exportSubagentTranscriptBlobValue(ref, result.filePath!)
          }
          return true
        })
        if (!exported) return { success: false, error: "完整内容引用不存在或已失效" }
        return { success: true, filePath: result.filePath }
      } catch (error) {
        console.warn("[Threads] Failed to export subagent transcript blob:", error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      } finally {
        releasePin?.()
      }
    }
  )

  ipcMain.handle(
    "threads:persistSubagentTranscripts",
    async (
      _event,
      { threadId, transcripts }: { threadId: string; transcripts: Record<string, unknown> }
    ) => {
      return withThreadRunMutationLock(threadId, async () => {
        if (!getThreadCore(threadId)) throw new Error("Thread not found")
        await ensureSubagentTranscriptRows(threadId)
        return withSubagentTranscriptContentMutationLock(async () => {
          const persistedRows: Record<string, unknown[]> = {}
          let referenceMutationCommitted = false
          try {
            for (const [subagentId, incomingMessages] of Object.entries(transcripts)) {
              if (!Array.isArray(incomingMessages)) continue
              const persisted: unknown[] = []
              for (const incomingMessage of incomingMessages) {
                const incomingRecord =
                  !!incomingMessage &&
                  typeof incomingMessage === "object" &&
                  !Array.isArray(incomingMessage)
                    ? (incomingMessage as Record<string, unknown>)
                    : undefined
                const hasTextDelta =
                  !!incomingRecord &&
                  Object.prototype.hasOwnProperty.call(incomingRecord, "subagent_text_deltas")
                const messageId =
                  typeof incomingRecord?.id === "string" ? incomingRecord.id.trim() : ""
                const hasDurableTextJournal =
                  !!messageId &&
                  threadSubagentManifestHasTextJournal(threadId, subagentId, messageId)
                const carriesProjectedTextRef =
                  isSubagentTranscriptBlobRef(incomingRecord?.content_ref, "content") ||
                  isSubagentTranscriptBlobRef(incomingRecord?.reasoning_ref, "reasoning")
                const preserveTextJournal =
                  hasTextDelta || (hasDurableTextJournal && carriesProjectedTextRef)
                if (preserveTextJournal) {
                  const previousReferenceHashKey = getThreadSubagentManifestBlobReferenceHashes(
                    threadId,
                    subagentId,
                    messageId
                  ).join("\n")
                  const compacted = await compactSubagentTranscriptManifests({
                    [subagentId]: [
                      {
                        ...incomingRecord,
                        subagent_preserve_text_journal: true
                      }
                    ]
                  })
                  const compactedMessage = Array.isArray(compacted.manifests[subagentId])
                    ? compacted.manifests[subagentId][0]
                    : undefined
                  const updated = hasTextDelta
                    ? appendThreadSubagentManifestTextDeltas(
                        threadId,
                        subagentId,
                        compactedMessage
                      )
                    : patchThreadSubagentManifestPreservingTextJournal(
                        threadId,
                        subagentId,
                        compactedMessage
                      )
                  if (updated === undefined) {
                    throw new Error(
                      "Subagent transcript journal patch rejected; retry authoritative snapshot"
                    )
                  }
                  if (
                    getSubagentTranscriptBlobReferenceHashKey(updated) !== previousReferenceHashKey
                  ) {
                    referenceMutationCommitted = true
                  }
                  persisted.push(updated)
                  continue
                }
                const compacted = await compactSubagentTranscriptManifests({
                  [subagentId]: [incomingMessage]
                })
                const compactedMessages = compacted.manifests[subagentId]
                const upserted = upsertThreadSubagentManifestMessages(
                  threadId,
                  subagentId,
                  Array.isArray(compactedMessages) ? compactedMessages : []
                )
                if (upserted.length > 0) referenceMutationCommitted = true
                persisted.push(...upserted)
              }
              persistedRows[subagentId] = persisted
            }
            return persistedRows
          } finally {
            if (referenceMutationCommitted) advanceSubagentTranscriptReferenceEpoch()
          }
        })
      })
    }
  )

  // Delete a thread
  // Serialize same-thread deletions: two overlapping attempts would interleave
  // their tombstone mark/rollback — attempt A failing before dbDeleteThread
  // rolls back the mark attempt B still depends on; if B then succeeds without
  // a workspacePath, the no-sweep late-writer window the tombstone closes
  // would silently reopen. ThreadIds are uuids, so the map stays tiny.
  let transcriptBlobGcRun: Promise<void> | null = null
  let transcriptBlobGcRerunRequested = false
  let transcriptBlobGcRetryTimer: NodeJS.Timeout | undefined
  const runTranscriptBlobGcSweep = async (): Promise<boolean> => {
    const epoch = await withSubagentTranscriptContentMutationLock(async () =>
      hasActiveSubagentTranscriptExternalMutation()
        ? null
        : getSubagentTranscriptReferenceEpoch()
    )
    if (epoch === null) return false
    const referencedHashes = await collectReferencedTranscriptHashesBounded()
    const candidates = await scanSubagentTranscriptBlobGcCandidates(referencedHashes, 0)
    const batchSize = 8
    for (let offset = 0; offset < candidates.length; offset += batchSize) {
      let stale = false
      const quarantined = await withSubagentTranscriptContentMutationLock(async () => {
        if (
          hasActiveSubagentTranscriptExternalMutation() ||
          getSubagentTranscriptReferenceEpoch() !== epoch
        ) {
          stale = true
          return []
        }
        return quarantineSubagentTranscriptBlobGcCandidates(
          candidates.slice(offset, offset + batchSize),
          referencedHashes
        )
      })
      if (stale) return false
      await removeQuarantinedSubagentTranscriptBlobs(quarantined)
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    return true
  }
  const scheduleTranscriptBlobGc = (): void => {
    if (transcriptBlobGcRun) {
      transcriptBlobGcRerunRequested = true
      return
    }
    if (transcriptBlobGcRetryTimer) return
    transcriptBlobGcRun = (async () => {
      let completed = false
      for (let attempt = 0; attempt < 2 && !completed; attempt += 1) {
        completed = await runTranscriptBlobGcSweep()
      }
      if (!completed) {
        transcriptBlobGcRetryTimer = setTimeout(() => {
          transcriptBlobGcRetryTimer = undefined
          scheduleTranscriptBlobGc()
        }, 1_000)
      }
    })()
      .catch((error) => {
        console.warn("[Threads] Failed to prune transcript content blobs:", error)
      })
      .finally(() => {
        transcriptBlobGcRun = null
        if (transcriptBlobGcRerunRequested) {
          transcriptBlobGcRerunRequested = false
          scheduleTranscriptBlobGc()
        }
      })
  }

  const deletingThreads = new Map<string, Promise<void>>()

  const performThreadDeletion = async (
    event: IpcMainInvokeEvent,
    threadId: string
  ): Promise<void> => {
    console.log("[Threads] Deleting thread:", threadId)

    // ThreadId-keyed run-store tombstone FIRST, before any await: launches and
    // flush-failed write-backs landing during the (multi-await) teardown below
    // would otherwise recreate `.cmbdevclaw/workflows/<threadId>` — and when the
    // thread's metadata lost its workspacePath, there is no directory sweep to
    // clean that up afterwards. This only gates NEW work; live stores keep
    // flushing until commitWorkflowThreadDisposal after the DB delete (the
    // point of no return), so a failed attempt never eats a terminal flush.
    // Prior membership is captured so the failure rollback RESTORES it — an
    // earlier COMPLETED deletion's tombstone must survive our failed attempt.
    const priorDisposalMark = isWorkflowThreadMarkedDisposed(threadId)
    markWorkflowThreadDisposed(threadId)

    // Everything from here up to (and including) the DB delete can still fail
    // with the thread intact — the catch below rolls the workflow tombstone
    // back so the SURVIVING thread isn't left with poisoned stores/launches
    // until restart. The guard starts IMMEDIATELY after the mark: even the
    // metadata reads above the hook dispatch are DB reads that can throw.
    // After dbDeleteThread succeeds the thread is gone for good and the
    // tombstone must stay, whatever the later best-effort cleanups do.
    let workspacePath: string | undefined
    try {
      // Fallback workspace capture BEFORE cancelAndWait (which settles and
      // removes the active entry): if the thread's metadata lost its
      // workspacePath, the active run still knows where its artifacts live —
      // without this, the row gets deleted but `.cmbdevclaw/workflows/<id>`
      // survives in a workspace the sweep can no longer locate.
      const activeWorkspaceFallback = workflowRunManager.activeWorkspaceForThread(threadId)
      // A background dynamic workflow must not outlive its thread. Cancel and
      // wait (bounded) for it to settle — best-effort, so a slow subagent
      // can't hang this IPC. The orphan-directory race is closed regardless of
      // the timeout: the tombstone above and deleteWorkflowRunsForThread
      // (below) make any late flush from a still-settling run a no-op.
      try {
        await workflowRunManager.cancelAndWait(threadId)
      } catch (error) {
        console.warn("[Threads] Workflow cancel on delete failed:", error)
      }
      const window = BrowserWindow.fromWebContents(event.sender)
      try {
        const foregroundOutcome = await cancelAndWaitForAgentThreadRun(threadId, window)
        if (foregroundOutcome === "timed_out") {
          console.warn("[Threads] Timed out waiting for foreground run cleanup during delete")
        }
      } catch (error) {
        console.warn("[Threads] Foreground run cancel on delete failed:", error)
      }
      // Drop the thread's tool-concurrency locks so the module-level map
      // doesn't keep one idle lock per deleted thread for the process lifetime.
      clearToolConcurrencyLocksForThread(threadId)
      // Fire SessionEnd before teardown so hooks can observe a valid thread
      // record. No-op if SessionStart never fired for this thread.
      const existingThread = getThreadCore(threadId)
      if (existingThread?.metadata) {
        try {
          const metadata = JSON.parse(existingThread.metadata) as Record<string, unknown>
          workspacePath =
            typeof metadata.workspacePath === "string" ? metadata.workspacePath : undefined
        } catch {
          workspacePath = undefined
        }
      }
      workspacePath = workspacePath ?? activeWorkspaceFallback
      let unresolvedManifestWorktree = false
      if (workspacePath) {
        const repository = await identifyRepository(workspacePath)
        if (repository) {
          const manifestState = await listWorkflowWorktreeRecordsForPrune(repository.commonDir)
          if (!manifestState.reliable) {
            throw new Error(
              "检测到损坏的 workflow worktree 记录；为保护可能残留的工作，任务未删除。请修复该工作区的 worktree 记录后重试。"
            )
          }
          for (const record of manifestState.records) {
            if (record.threadId !== threadId) continue
            const terminal = record.status === "merged" || record.status === "discarded"
            const alreadyCleaned = terminal && record.cleanupPending !== true && !existsSync(record.directory)
            if (!alreadyCleaned) {
              unresolvedManifestWorktree = true
              break
            }
            // A process can crash after run.json has recorded terminal cleanup
            // but before its small ownership tombstone is finalized. This is no
            // longer user work; finish the idempotent CAS-protected finalizer
            // before allowing the thread (and its recovery entry point) to go.
            if (!(await finalizeWorkflowWorktreeRecord(record).catch(() => false))) {
              unresolvedManifestWorktree = true
              break
            }
          }
        }
      }
      const unresolvedWorktreeCount =
        (workspacePath ? countUnresolvedWorkflowWorktrees(workspacePath, threadId) : 0) +
        workflowRunManager
          .listFlushFailedRuns(threadId)
          .reduce(
            (count, run) =>
              count +
              (run.worktrees ?? []).filter(
                (record) =>
                  (record.status !== "merged" && record.status !== "discarded") ||
                  record.cleanupPending === true ||
                  existsSync(record.directory)
              ).length,
            0
          )
      if (unresolvedManifestWorktree || unresolvedWorktreeCount > 0) {
        throw new Error(
          "该任务仍有未处理或待清理的 workflow worktree；请先在运行历史中合并、丢弃或按错误提示完成手工清理，再删除任务。"
        )
      }
      const hookChannel = `agent:stream:${threadId}`
      await fireSessionEnd(
        threadId,
        workspacePath,
        window ? makeHookResultCallback(window, hookChannel) : undefined
      )
      disposeAgentThreadState(threadId)

      const cancelledWorkers = coordinatorWorkerManager.cancelWorkersForThread(
        threadId,
        "Thread was deleted."
      )
      const waitForCleanupBestEffort = async (workerIds?: string[]) => {
        try {
          await coordinatorWorkerManager.waitForWorkerCleanup(threadId, workerIds)
        } catch (error) {
          console.warn("[Threads] Timed out waiting for coordinator worker cleanup:", error)
        }
      }
      if (cancelledWorkers.length > 0) {
        await waitForCleanupBestEffort(cancelledWorkers.map((worker) => worker.worker_id))
      }
      await waitForCleanupBestEffort()

      // Delete from our metadata store — the point of no return.
      dbDeleteThread(threadId)
      forgetLegacySubagentTranscriptMigration(threadId)
      // Detach the deleted task from its shared physical workspace watcher so
      // subscriber lists and per-change IPC fan-out cannot grow forever.
      stopWatching(threadId)
      // Revoke foreground ownership and synchronously drop every buffered
      // transcript before the event loop can deliver a late chunk from a run
      // that exceeded the bounded cancellation wait.
      disposeDeletedAgentThreadRuntime(threadId)
      // Incarnation boundary crossed: permanently silence every store/snapshot
      // born before this deletion (revive-immune epoch bump).
      commitWorkflowThreadDisposal(threadId)
      console.log("[Threads] Deleted from metadata store")
    } catch (e) {
      // Rollback restores ONLY the workflow tombstone. The other pre-DB-delete
      // effects (workflow cancelAndWait, session-end hooks, turn-state dispose,
      // worker cancellation) are deliberately NOT rolled back — an abort cannot
      // be un-aborted, and the user's intent WAS deletion: a failed attempt
      // leaves a surviving thread whose background work has been stopped, which
      // is visible, recoverable state (re-run / re-delete both work). Only the
      // tombstone must roll back, because it alone would silently poison future
      // workflow use of the surviving thread until restart.
      rollbackWorkflowThreadDisposal(threadId, priorDisposalMark)
      throw e
    }
    // Drop the in-memory flush-failed snapshots only AFTER the point of no
    // return: dropped earlier, a deletion failing pre-DB-delete would have
    // already lost the surviving thread's only copy of a terminal state whose
    // disk persist had failed. (Their retries are already no-ops during the
    // attempt: persistRecoveredRun keeps the snapshot on a bare-set hit.)
    workflowRunManager.forgetThread(threadId)

    // Permanently retire every checkpointer of this thread (parent + all
    // __worker__/__wf_ sub-threads): tombstone + poison, BEFORE the disk sweeps
    // below — a writer that outlived its cancellation (hung subagent past
    // cancelAndWait's timeout, or an LRU-evicted instance still held by a run)
    // could otherwise flush a late snapshot and resurrect the just-deleted files.
    try {
      await retireThreadCheckpointers(threadId)
      console.log("[Threads] Retired thread checkpointers")
    } catch (e) {
      console.warn("[Threads] Failed to retire thread checkpointers:", e)
    }

    // Checkpoint disk sweeps IMMEDIATELY after retire, with NO await in
    // between: a revived fixed-id beat (heartbeat) resumes on the same
    // retiring-promise settlement this handler does — any await here would let
    // it initialize and flush a FRESH checkpoint that these sweeps (belonging
    // to the OLD deletion) would then eat. Single-threaded JS makes
    // retire-settle → sync sweeps an atomic segment; the awaited workspace
    // cleanups run after.
    //
    // Deep clean: durable sidecars AND quarantine archives — "delete thread"
    // means the transcript is gone. Each cleanup is independently best-effort:
    // one stubborn file (e.g. EPERM on a quarantine archive) must not block
    // the other sweeps from removing sub-thread transcripts.
    try {
      purgeThreadCheckpointArtifacts(threadId)
      console.log("[Threads] Purged thread checkpoint artifacts")
    } catch (e) {
      console.warn("[Threads] Failed to purge thread checkpoint artifacts:", e)
    }
    try {
      const deletedWorkerCheckpoints = deleteThreadWorkerCheckpoints(threadId)
      console.log("[Threads] Deleted worker checkpoints", { deletedWorkerCheckpoints })
    } catch (e) {
      console.warn("[Threads] Failed to delete worker checkpoints:", e)
    }
    // Workflow subagents self-clean their checkpoints in their finally; this
    // sweeps the rare crash / failed-cleanup leftovers, mirroring the worker
    // sweep (which only covers __worker__, not __wf_). (#3)
    try {
      const deletedWorkflowCheckpoints = deleteThreadWorkflowCheckpoints(threadId)
      console.log("[Threads] Deleted workflow checkpoints", { deletedWorkflowCheckpoints })
    } catch (e) {
      console.warn("[Threads] Failed to delete workflow checkpoints:", e)
    }

    coordinatorWorkerManager.forgetThread(threadId)
    forgetCoordinatorThreadState(threadId)
    if (workspacePath) {
      // Fence and sweep workflow runs BEFORE deleting the parent app-managed
      // thread directory. Managed workflow storage now lives under that parent;
      // reversing this order would leave a window where a late final flush could
      // recreate `<thread>/workflows` before its dir tombstone is registered.
      // The compatibility sweep also removes pre-upgrade project-local runs.
      deleteWorkflowRunsForThread(workspacePath, threadId)
      try {
        await deleteProjectThreadDataDirectory(workspacePath, threadId)
        console.log("[Threads] Deleted app-managed thread history and large results")
      } catch (e) {
        console.warn("[Threads] Failed to delete app-managed thread data:", e)
      }
      try {
        await deleteCoordinatorWorkerArtifacts(threadId, workspacePath)
        console.log("[Threads] Deleted coordinator worker artifacts")
      } catch (e) {
        console.warn("[Threads] Failed to delete coordinator worker artifacts:", e)
      }
    }

    try {
      deleteTaskMmdThread(threadId)
      console.log("[Threads] Deleted task-mmd files")
    } catch (e) {
      console.warn("[Threads] Failed to delete task-mmd files:", e)
    }

    // Shared, content-addressed blobs are swept in the background. Directory
    // walking/stat/removal stay outside the global write lock; only an
    // epoch-checked batch of canonical->quarantine renames holds it.
    scheduleTranscriptBlobGc()
  }

  ipcMain.handle("threads:delete", async (event, threadId: string) => {
    // Abort a parser before waiting for the same-thread mutation lock. Every
    // completed batch is independently committed and therefore safe to leave
    // behind until deletion or a later idempotent retry.
    cancelLegacySubagentTranscriptMigration(threadId)
    cancelSubagentTranscriptStartupRead(threadId)
    cancelLegacyCheckpointTranscriptBootstrap(threadId)
    return withThreadRunMutationLock(threadId, async () => {
      while (deletingThreads.has(threadId)) {
        await deletingThreads.get(threadId)?.catch(() => undefined)
      }
      const deletion = performThreadDeletion(event, threadId)
      deletingThreads.set(threadId, deletion)
      try {
        await deletion
      } finally {
        if (deletingThreads.get(threadId) === deletion) deletingThreads.delete(threadId)
      }
    })
  })

  // Get thread history (checkpoints)
  ipcMain.handle("threads:history", async (_event, threadId: string) => {
    try {
      return await withCheckpointer(threadId, async (checkpointer) => {
        const history: unknown[] = []
        const config = { configurable: { thread_id: threadId } }
        for await (const checkpoint of checkpointer.list(config, { limit: 50 })) {
          history.push(checkpoint)
        }
        return history
      })
    } catch (e) {
      console.warn("Failed to get thread history:", e)
      return []
    }
  })

  // Get only a bounded tail of the latest worker checkpoint. The full snapshot
  // is reconstructed inside the worker, but at most 500 / 1 MiB crosses into
  // Electron main and the renderer worker panel.
  ipcMain.handle("threads:latest-checkpoint", async (event, threadId: string) => {
    try {
      const normalizedThreadId = assertValidCheckpointThreadId(threadId)
      return await readLatestCheckpointTupleInWorker(
        getThreadCheckpointPath(normalizedThreadId),
        normalizedThreadId,
        "",
        {
          messageLimit: 500,
          messageByteBudget: 1024 * 1024,
          foregroundKey: `worker-panel:${event.sender.id}`
        }
      )
    } catch (e) {
      if (isCheckpointRuntimeProjectionCancelled(e)) return null
      console.warn("Failed to get latest thread checkpoint:", e)
      return null
    }
  })

  // Renderer hydration needs only small runtime channels (todos, interrupts,
  // etc.). Keep the full latest-checkpoint API above for worker/fork callers
  // that intentionally need channel_values.messages.
  ipcMain.handle("threads:latest-checkpoint-runtime-state", async (event, threadId: string) => {
    try {
      const normalizedThreadId = assertValidCheckpointThreadId(threadId)
      return await readLatestCheckpointTupleInWorker(
        getThreadCheckpointPath(normalizedThreadId),
        normalizedThreadId,
        "",
        {
          messageLimit: 0,
          messageByteBudget: 0,
          foregroundKey: `thread-hydration:${event.sender.id}`
        }
      )
    } catch (e) {
      if (isCheckpointRuntimeProjectionCancelled(e)) return null
      console.warn("Failed to get latest thread checkpoint runtime state:", e)
      return null
    }
  })

  // One-time bridge for old tasks whose transcript still lives only inside a
  // checkpoint. The worker imports that transcript into durable rows in
  // bounded transactions. Only the small runtime tuple and a bounded first
  // page cross worker -> main -> renderer; the full checkpoint array never
  // enters Electron main or the renderer hydration path.
  ipcMain.handle(
    "threads:bootstrap-legacy-checkpoint-transcript",
    async (event, threadId: string) => {
      try {
        const normalizedThreadId = assertValidCheckpointThreadId(threadId)
        const bootstrap = await bootstrapLegacyCheckpointTranscriptInWorker(
          getThreadCheckpointPath(normalizedThreadId),
          getDbPath(),
          normalizedThreadId,
          "",
          `thread-hydration:${event.sender.id}`
        )
        const pageOptions = { limit: 128, byteBudget: 1024 * 1024 }
        let page
        try {
          // Do not mark this as foreground/latest-wins. A stale bootstrap must
          // never cancel a newer task's latency-critical initial page.
          page = await readThreadMessagesPageInWorker(normalizedThreadId, pageOptions)
        } catch (error) {
          if (!isThreadMessageHydrationWorkerUnavailable(error)) throw error
          console.warn(
            "[ThreadHydrationWorker] unavailable after legacy bootstrap; restarting reader",
            error
          )
          await new Promise<void>((resolve) => setImmediate(resolve))
          page = await readThreadMessagesPageInWorker(normalizedThreadId, pageOptions)
        }
        return {
          checkpoint: bootstrap.runtimeTuple,
          page,
          migration: bootstrap.stats
        }
      } catch (error) {
        if (isCheckpointRuntimeProjectionCancelled(error)) return null
        console.warn("Failed to bootstrap legacy checkpoint transcript:", error)
        return null
      }
    }
  )

  ipcMain.handle("threads:exportSession", async (event, threadId: string) => {
    try {
      const row = getThreadCore(threadId)
      if (!row) return { success: false, error: "Thread not found" }

      const latestCheckpoint = await getLatestCheckpoint(threadId)
      const messages = buildExportMessagesFromThreadMessages(
        mergeCheckpointAndPersistedThreadMessagesForSession(
          latestCheckpoint?.checkpoint,
          getThreadMessages(threadId)
        )
      )

      if (messages.length === 0) {
        return { success: false, error: "暂无可导出的消息" }
      }

      const metadata = parseJsonObject(row.metadata)
      const workspacePath =
        typeof metadata?.workspacePath === "string" && metadata.workspacePath.trim()
          ? metadata.workspacePath
          : null
      const title =
        row.title || (typeof metadata?.title === "string" ? metadata.title : "") || row.thread_id
      const exportedAt = new Date().toISOString()
      const payload: ExportPayload = {
        version: 1,
        exportedAt,
        thread: {
          threadId,
          title,
          createdAt: toIsoString(row.created_at),
          updatedAt: toIsoString(row.updated_at),
          workspacePath
        },
        messages
      }

      const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
      const date = exportedAt.slice(0, 10)
      const result = await dialog.showSaveDialog(win ?? BrowserWindow.getAllWindows()[0], {
        title: "导出会话",
        defaultPath: `${safeFileName(title)}-session-${date}.zip`,
        filters: [{ name: "Zip Archive", extensions: ["zip"] }]
      })

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true }
      }

      const zip = new AdmZip()
      zip.addFile("session.md", Buffer.from(formatMarkdown(payload), "utf-8"))
      zip.addFile("session.json", Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf-8"))
      zip.writeZip(result.filePath)

      return { success: true, filePath: result.filePath }
    } catch (e) {
      console.error("[Threads] exportSession error:", e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle(
    "threads:goalEvents",
    async (event, threadId: string, options?: { restore?: boolean; limit?: number }) => {
      const recentLimit = Math.min(
        GOAL_UI_EVENT_LIMIT,
        Math.max(1, Math.floor(options?.limit ?? GOAL_UI_EVENT_LIMIT))
      )
      let events: ThreadGoalHydrationEvent[]
      try {
        const result = await readThreadGoalEventsInWorker(threadId, {
          restore: options?.restore === true,
          recentLimit,
          scanLimit: options?.restore ? 500 : recentLimit,
          byteBudget: 1024 * 1024,
          ...(options?.restore === true ? { webContentsId: event.sender.id } : {})
        })
        events = result.events
      } catch (error) {
        if (!isThreadMetadataHydrationWorkerUnavailable(error)) throw error
        console.warn(
          "[ThreadMetadataHydrationWorker] unavailable; using bounded goal-event fallback",
          error
        )
        events = getThreadGoalEventsHydrationFallback(threadId, {
          limit: recentLimit,
          restore: options?.restore === true,
          scanLimit: options?.restore ? 500 : recentLimit
        })
      }
      return events.map((event) => ({
        ...event,
        created_at: new Date(event.created_at)
      }))
    }
  )

  ipcMain.handle(
    "threads:goalState",
    async (_event, threadId: string, options?: { includeEvents?: boolean }) => {
      const goalStore = new SqlGoalStore()
      const includeEvents = options?.includeEvents !== false
      let events: ThreadGoalHydrationEvent[] = []
      if (includeEvents) {
        try {
          events = (
            await readThreadGoalEventsInWorker(threadId, {
              recentLimit: GOAL_UI_EVENT_LIMIT,
              scanLimit: GOAL_UI_EVENT_LIMIT,
              byteBudget: 1024 * 1024
            })
          ).events
        } catch (error) {
          if (!isThreadMetadataHydrationWorkerUnavailable(error)) throw error
          console.warn(
            "[ThreadMetadataHydrationWorker] unavailable; using bounded goal-state fallback",
            error
          )
          events = getThreadGoalEventsHydrationFallback(threadId, {
            limit: GOAL_UI_EVENT_LIMIT
          })
        }
      }
      return {
        goal: serializeGoal(goalStore.get(threadId)),
        events: includeEvents
          ? events.map((event) => ({
              ...event,
              created_at: new Date(event.created_at)
            }))
          : []
      }
    }
  )

  // Generate a title from a message
  ipcMain.handle("threads:generateTitle", async (_event, message: string) => {
    return generateTitle(message)
  })
}
