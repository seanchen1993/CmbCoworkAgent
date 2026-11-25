import { randomUUID } from "node:crypto"
import type { WebContents } from "electron"
import { z } from "zod"
import { BTW_FILE_CANDIDATE_LIMIT, BTW_FILE_CANDIDATE_PATH_LIMIT, getBtwParentId, type BtwMessage } from "../../shared/btw-chat"
import { calculateContextCompactionBudget } from "../../shared/model-token-budget"
import { isImRemoteControlTranscriptMessageId } from "../../shared/im-remote-transcript"
import { coordinatorTranscriptContentToText } from "../../shared/internal-notification-turn"
import { isVisibleTranscriptMessage } from "../../shared/transcript-visibility"
import { getLocalThreadRunLease } from "../agent/thread-run-lease"
import { fitSideContextMessage } from "../agent/side-conversation-context"
import { findBotWorkThreadOwner } from "../bots/conversation-link-authority"
import { restoreSideConversationParentTranscript } from "../checkpointer/runtime-projection-client"
import { createThread, getDb, getLegacyCheckpointMigrationStatus, getThreadMessageOrdinalBoundary, getThreadRowLifetime, getThreadTranscriptBoundaryOrdinal, threadExists } from "../db"
import { onThreadDirectoryIdentityChanged } from "../db/thread-directory-lifecycle"
import { isThreadMessageHydrationWorkerUnavailable, readThreadMessagesPageInWorker } from "../thread-message-hydration/client"
import type { ThreadMessageHydrationPageOptions } from "../thread-message-hydration/protocol"
import { readSideParentInWorker } from "../thread-metadata-hydration/client"
import type { Message } from "../types"
import { getAvailableModelConfigOrDefault } from "../models/registry"
import { DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_MAX_TOKENS, getDbPath, getThreadCheckpointPath } from "../storage"
import { getWorkspaceFilePreviewClient } from "../workspace-file-preview/client"
import { classifyWorkspaceFilePreviewError } from "../workspace-file-preview/errors"
import {
  isForegroundCheckpointOpening,
  tryBackgroundThreadMutationLock,
  withThreadRunMutationLock
} from "./thread-run-mutation-lock"

export const btwRequest = z.object({
  parentId: z.string().uuid(),
  modelId: z.string().max(256),
  fileCandidates: z.array(z.string().min(1).max(BTW_FILE_CANDIDATE_PATH_LIMIT)
    .refine(path => !path.includes("\0"))).max(BTW_FILE_CANDIDATE_LIMIT).optional()
}).strict()

interface SideWindow {
  document: AbortController
  ids: Set<string>
}

interface SideThreadRegistration {
  ordinal: number
  owner: SideWindow
  lifetime: AbortController
  context: BtwMessage[]
}

interface SideThreadTeardown {
  attempt: Promise<void>
  completion: Promise<void>
}

const sideWindows = new WeakMap<WebContents, SideWindow>()
const sideThreads = new Map<string, SideThreadRegistration>()
const sideThreadTeardowns = new Map<string, SideThreadTeardown>()
const closedSideThreadSignal = AbortSignal.abort()

export function canRunSideThread(threadId: string): boolean {
  const parentId = getBtwParentId(threadId)
  if (!parentId) return true
  const registration = sideThreads.get(threadId)
  return registration !== undefined && !registration.lifetime.signal.aborted && threadExists(parentId)
}

export function getSideThreadContext(threadId: string): readonly BtwMessage[] | undefined {
  return sideThreads.get(threadId)?.context
}

/** Also fence work that first looks up a side thread after it is unregistered. */
export function getSideThreadLifetimeSignal(threadId: string): AbortSignal | undefined {
  if (!getBtwParentId(threadId)) return undefined
  return sideThreads.get(threadId)?.lifetime.signal ?? closedSideThreadSignal
}

export function hasRegisteredSideThread(threadId: string): boolean {
  return sideThreads.has(threadId)
}

export function getSideThreadTeardown(threadId: string): Promise<void> | undefined {
  return sideThreadTeardowns.get(threadId)?.completion
}

export function getSideThreadTeardownAttempt(threadId: string): Promise<void> | undefined {
  return sideThreadTeardowns.get(threadId)?.attempt
}

export function runSideThreadTeardown(
  threadId: string,
  teardown: () => Promise<void>,
  abandonedRecovery: () => { wait: () => Promise<void>; retry: () => Promise<void> } | undefined
): Promise<void> {
  const existing = getSideThreadTeardown(threadId)
  if (existing) return existing
  const attempt = teardown()
  const state: SideThreadTeardown = {
    attempt,
    completion: attempt.catch(async error => {
      const recovery = abandonedRecovery()
      if (!recovery) throw error
      await recovery.wait()
      state.attempt = recovery.retry()
      await state.attempt
    }).finally(() => sideThreadTeardowns.delete(threadId))
  }
  sideThreadTeardowns.set(threadId, state)
  return state.completion
}

export function bindSideWindow(sender: WebContents, close: (id: string) => Promise<void>): SideWindow {
  const existing = sideWindows.get(sender)
  if (existing) return existing
  const owner: SideWindow = { document: new AbortController(), ids: new Set() }
  sideWindows.set(sender, owner)
  const release = (): void => {
    const previousDocument = owner.document
    owner.document = new AbortController()
    previousDocument.abort()
    for (const id of owner.ids) {
      unregisterSideThread(id)
      void close(id).catch(error => console.warn("[BTW] Failed to close side conversation:", error))
    }
  }
  sender.on("did-start-navigation", event => {
    if (event.isMainFrame && !event.isSameDocument) release()
  })
  sender.on("render-process-gone", release)
  sender.once("destroyed", release)
  return owner
}

export function beginSideThreadClose(id: string): void {
  const registration = sideThreads.get(id)
  if (!registration) return
  registration.context = []
  registration.lifetime.abort()
}

export function unregisterSideThread(id: string): void {
  const registration = sideThreads.get(id)
  if (!registration) return
  registration.owner.ids.delete(id)
  sideThreads.delete(id)
  registration.lifetime.abort()
}

export async function closeOwnedSideThread(
  owner: SideWindow,
  id: unknown,
  close: (id: string) => Promise<void>
): Promise<void> {
  if (typeof id !== "string" || !owner.ids.has(id)) throw new Error("当前窗口没有此辅助对话。")
  beginSideThreadClose(id)
  await close(id)
  unregisterSideThread(id)
}

async function readSideContextPage(
  parentId: string,
  options: ThreadMessageHydrationPageOptions,
  assertCurrent?: () => void
) {
  assertCurrent?.()
  let page
  try {
    page = await readThreadMessagesPageInWorker(parentId, options)
  } catch (error) {
    assertCurrent?.()
    if (!isThreadMessageHydrationWorkerUnavailable(error)) throw error
    page = await readThreadMessagesPageInWorker(parentId, options)
  }
  assertCurrent?.()
  return page
}

function isVisibleUser(row: Message): boolean {
  return row.role === "user" && !isImRemoteControlTranscriptMessageId(row.id) &&
    isVisibleTranscriptMessage(row.role, coordinatorTranscriptContentToText(row.content))
}

const ORDINAL_BOUNDARY_MESSAGE_ID = "\u0001"

type ReadSideContext = (tokenBudget: number, assertCurrent?: () => void) => Promise<BtwMessage[]>

export function captureSideContext(parentId: string, running: boolean, activeUserId?: string): ReadSideContext {
  const boundary = getThreadMessageOrdinalBoundary(parentId)
  const activeOrdinal = running && activeUserId ? getThreadTranscriptBoundaryOrdinal(parentId, activeUserId) : undefined
  // A newly published controller may not have saved its user row. In that case
  // the captured history still includes the previous turn's completed output.
  const contextBoundary = activeOrdinal === undefined ? boundary : Math.min(boundary, activeOrdinal + 1)
  return (tokenBudget, assertCurrent) =>
    readSideContext(parentId, contextBoundary, running && !activeUserId, tokenBudget, assertCurrent)
}

async function findLatestVisibleSideContextUser(
  parentId: string, boundary: number, assertCurrent?: () => void
) {
  let beforeOrdinal = boundary
  let beforeMessageId = ORDINAL_BOUNDARY_MESSAGE_ID
  while (true) {
    const page = await readSideContextPage(parentId, {
      limit: 16, byteBudget: 64 * 1024, userOrdinalFloor: -1, beforeOrdinal, beforeMessageId
    }, assertCurrent)
    const user = page.messages.findLast(isVisibleUser)
    if (user?.ordinal !== undefined) return user.ordinal
    if (!page.hasMore || page.beforeOrdinal === null || page.beforeMessageId === null) return undefined
    beforeOrdinal = page.beforeOrdinal
    beforeMessageId = page.beforeMessageId
  }
}

async function readSideContext(
  parentId: string,
  contextBoundary: number,
  findCutoff: boolean,
  tokenBudget: number,
  assertCurrent?: () => void
): Promise<BtwMessage[]> {
  if (contextBoundary === 0 || tokenBudget <= 0) return []
  if (findCutoff) {
    const cutoff = await findLatestVisibleSideContextUser(parentId, contextBoundary, assertCurrent)
    if (cutoff === undefined) return []
    contextBoundary = Math.min(contextBoundary, cutoff + 1)
  }
  const pageOptions = { limit: 128, byteBudget: 512 * 1024 }
  let page = await readSideContextPage(parentId, {
    ...pageOptions, beforeOrdinal: contextBoundary, beforeMessageId: ORDINAL_BOUNDARY_MESSAGE_ID,
    sideContextTextByteBudget: tokenBudget * 4
  }, assertCurrent)
  const messages: BtwMessage[] = []
  let remaining = tokenBudget
  while (true) {
    for (let index = page.messages.length - 1; index >= 0; index--) {
      const row = page.messages[index]
      if (row.ordinal !== undefined && row.ordinal >= contextBoundary) continue
      if (isImRemoteControlTranscriptMessageId(row.id)) continue
      if (row.role !== "user" && row.role !== "assistant" && row.role !== "tool") continue
      const text = row.content
      if (typeof text !== "string" || !text) continue
      const content = row.role === "tool" ? `工具 ${row.name || "调用"} 的结果：\n${text}` : text
      const match = fitSideContextMessage({ role: row.role === "user" ? "user" : "assistant", content }, remaining)
      if (!match) return messages.reverse()
      messages.push(match.row)
      remaining -= match.tokens
      if (!remaining) return messages.reverse()
    }
    const { beforeOrdinal, beforeMessageId } = page
    if (!page.hasMore || beforeOrdinal === null || beforeMessageId === null) return messages.reverse()
    page = await readSideContextPage(parentId, {
      ...pageOptions, beforeOrdinal, beforeMessageId, sideContextTextByteBudget: remaining * 4
    }, assertCurrent)
  }
}

export function sideThreadIds(parentId: string): string[] {
  if (!z.string().uuid().safeParse(parentId).success) return []
  const stmt = getDb().prepare(
    `SELECT thread_id FROM threads
     WHERE thread_id GLOB ?
       AND CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.btwParentId') = ? END
     ORDER BY created_at, thread_id`
  )
  try {
    stmt.bind([`btw-${parentId}-*`, parentId])
    const ids: string[] = []
    while (stmt.step()) {
      const id = String(stmt.getAsObject().thread_id)
      if (getBtwParentId(id) === parentId) ids.push(id)
    }
    return ids
  } finally {
    stmt.free()
  }
}

async function checkSideQuestionFiles(
  parentId: string, workspacePath: string, candidates: string[], assertCurrent: () => void
): Promise<void> {
  if (!candidates.length) return
  const client = getWorkspaceFilePreviewClient()
  const request = `btw-file-candidates:${randomUUID()}`
  for (const filePath of new Set(candidates)) {
    assertCurrent()
    try {
      await client.inspect({ threadId: parentId, filePath, workspacePathKind: "relative" }, workspacePath, request)
    } catch (error) {
      const code = classifyWorkspaceFilePreviewError(error)
      if (code === "not-found" || code === "not-regular-file" || code === "source-outside-trusted-root" ||
        (error instanceof Error && ["EINVAL", "ENAMETOOLONG"].includes(error.name))) continue
      throw new Error("无法核对 @文件，当前草稿已保留，请重试。")
    }
    throw new Error("请在辅助对话中添加文件或选择能力，当前草稿已保留。")
  }
}

export async function createSideThread(
  raw: unknown,
  sender: WebContents,
  owner: SideWindow,
  captureContext: (parentId: string) => ReadSideContext
) {
  const { parentId, modelId, fileCandidates = [] } = btwRequest.parse(raw)
  const documentSignal = owner.document.signal
  const parentLifetime = getThreadRowLifetime(parentId)
  if (parentLifetime === null) throw new Error("Thread not found")
  const assertWindowCurrent = () => {
    if (sender.isDestroyed() || documentSignal.aborted) {
      throw new Error("创建辅助对话的页面已关闭。")
    }
  }
  const assertParentCurrent = () => {
    if (getThreadRowLifetime(parentId) !== parentLifetime) {
      throw new Error("原会话已关闭或变化，请重新创建辅助对话。")
    }
  }
  let parentRevision = 0
  let checkedPageRevision = 0
  const assertReadCurrent = () => {
    assertWindowCurrent()
    if (checkedPageRevision === parentRevision) return
    checkedPageRevision = parentRevision
    assertParentCurrent()
  }
  const stopWatchingParent = onThreadDirectoryIdentityChanged(id => {
    if (id === parentId) parentRevision++
  })
  let readRevision = -1
  let parent: Awaited<ReturnType<typeof readSideParentInWorker>>
  // Read outside the lock so active parent sends and stops need not wait for
  // large metadata. Only use the snapshot if it still matches at admission.
  async function withCurrentParent<T>(
    operation: (metadata: Record<string, unknown>, workspacePath: string) => T
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      assertReadCurrent()
      if (readRevision !== parentRevision) {
        readRevision = parentRevision
        parent = await readSideParentInWorker(parentId)
      }
      const result = await withThreadRunMutationLock(parentId, async () => {
        assertWindowCurrent()
        assertParentCurrent()
        if (readRevision !== parentRevision) return null
        const metadata = parent?.metadata
        const runOwner = getLocalThreadRunLease(parentId)?.owner
        if (!metadata || typeof metadata.workspacePath !== "string" ||
            findBotWorkThreadOwner(parentId) || (runOwner && runOwner !== "desktop")) {
          throw new Error("当前会话不能创建辅助对话。")
        }
        return { value: operation(metadata, metadata.workspacePath) }
      })
      if (result) return result.value
    }
    throw new Error("原会话已关闭或变化，请重新创建辅助对话。")
  }

  try {
    const { workspacePath, parentModel, capturedRead } = await withCurrentParent((metadata, workspacePath) => ({
      workspacePath,
      parentModel: typeof metadata.model === "string" ? metadata.model : undefined,
      capturedRead: getLegacyCheckpointMigrationStatus(parentId) === "complete" ? captureContext(parentId) : undefined
    }))
    let read = capturedRead
    if (!read) {
      // Ordinals can be assigned during legacy import. Keep its writes
      // serialized, and let a parent send or stop cancel it before acquiring the lock.
      const restoring = "原会话历史仍在恢复，请稍后重新创建辅助对话。"
      const controller = new AbortController()
      const signal = AbortSignal.any([documentSignal, controller.signal])
      const recovery = tryBackgroundThreadMutationLock(parentId, async () => {
        assertWindowCurrent()
        assertParentCurrent()
        if (getLegacyCheckpointMigrationStatus(parentId) !== "complete") {
          if (isForegroundCheckpointOpening(parentId) || getLocalThreadRunLease(parentId)) {
            throw new Error(restoring)
          }
          await restoreSideConversationParentTranscript(
            getThreadCheckpointPath(parentId), getDbPath(), parentId, signal
          )
          signal.throwIfAborted()
          if (getLegacyCheckpointMigrationStatus(parentId) === "migrating") {
            throw new Error(restoring)
          }
        }
        return captureContext(parentId)
      }, controller)
      if (!recovery) throw new Error(restoring)
      try {
        read = await recovery
      } catch (error) {
        assertWindowCurrent()
        if (controller.signal.aborted) throw new Error(restoring, { cause: error })
        throw error
      }
    }

    // Parent sends and stops can keep acquiring the mutation lock while the
    // worker reads pages within the captured boundary.
    await checkSideQuestionFiles(parentId, workspacePath, fileCandidates, assertReadCurrent)
    const requestedModelId = modelId || parentModel
    const model = getAvailableModelConfigOrDefault(requestedModelId)
    const capturedModelId = model?.ref ?? requestedModelId
    const { keepTokens } = calculateContextCompactionBudget(
      model?.maxTokens ?? DEFAULT_MAX_TOKENS,
      model?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
    )
    assertReadCurrent()
    const context = await read(keepTokens, assertReadCurrent)
    assertReadCurrent()
    return await withCurrentParent((metadata, latestWorkspacePath) => {
      if (latestWorkspacePath !== workspacePath) {
        throw new Error("原会话工作区已变化，请重新创建辅助对话。")
      }
      const id = `btw-${parentId}-${randomUUID()}`
      let ordinal = 1
      for (const [siblingId, sibling] of sideThreads) {
        if (getBtwParentId(siblingId) === parentId) ordinal = Math.max(ordinal, sibling.ordinal + 1)
      }
      const row = createThread(id, { title: `辅助对话 ${ordinal}`, btwOrdinal: ordinal, btwParentId: parentId,
        workspacePath,
        model: capturedModelId,
        agentMode: "normal",
        subagentsEnabled: metadata.subagentsEnabled !== false,
        memoryEnabled: metadata.memoryEnabled, outputStyle: metadata.outputStyle,
        conciseModeEnabled: metadata.conciseModeEnabled
      }, { newDurableTranscript: true })
      owner.ids.add(id)
      sideThreads.set(id, { owner, lifetime: new AbortController(), context, ordinal })
      const summary = JSON.parse(row.metadata!)
      return { id, ordinal, thread: { thread_id: id, title: row.title, status: row.status, created_at: new Date(row.created_at), updated_at: new Date(row.updated_at), metadata: summary } }
    })
  } finally {
    stopWatchingParent()
  }
}
