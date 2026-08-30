type ChatReportUploadState = {
  uploadedIds: Set<string>
  inFlightIds: Set<string>
}

const chatReportUploadByThread = new Map<string, ChatReportUploadState>()
const disabledChatReportThreads = new Map<string, number>()

export const CHAT_REPORT_UPLOAD_CACHE_MAX_THREADS = 64
export const CHAT_REPORT_UPLOAD_CACHE_MAX_IDS_PER_THREAD = 256
export const CHAT_REPORT_UPLOAD_CACHE_MAX_IN_FLIGHT_IDS_PER_THREAD = 128
const CHAT_REPORT_DISABLED_THREAD_MAX_ENTRIES = 256
const CHAT_REPORT_DISABLED_THREAD_TTL_MS = 2 * 60_000

function touchThreadState(threadId: string, state: ChatReportUploadState): void {
  chatReportUploadByThread.delete(threadId)
  chatReportUploadByThread.set(threadId, state)
}

function pruneUploadedIds(state: ChatReportUploadState): void {
  while (state.uploadedIds.size > CHAT_REPORT_UPLOAD_CACHE_MAX_IDS_PER_THREAD) {
    const oldest = state.uploadedIds.values().next().value
    if (typeof oldest !== "string") break
    state.uploadedIds.delete(oldest)
  }
}

function pruneThreadStates(): void {
  if (chatReportUploadByThread.size <= CHAT_REPORT_UPLOAD_CACHE_MAX_THREADS) return
  for (const [threadId, state] of chatReportUploadByThread) {
    if (chatReportUploadByThread.size <= CHAT_REPORT_UPLOAD_CACHE_MAX_THREADS) break
    // Never evict a reservation while its upload is still in flight. A later
    // success/failure callback prunes the cache again once the state is idle.
    if (state.inFlightIds.size > 0) continue
    chatReportUploadByThread.delete(threadId)
  }
}

function makeRoomForThreadState(threadId: string): boolean {
  if (chatReportUploadByThread.has(threadId)) return true
  if (chatReportUploadByThread.size < CHAT_REPORT_UPLOAD_CACHE_MAX_THREADS) return true
  for (const [candidateThreadId, state] of chatReportUploadByThread) {
    if (state.inFlightIds.size > 0) continue
    chatReportUploadByThread.delete(candidateThreadId)
    if (chatReportUploadByThread.size < CHAT_REPORT_UPLOAD_CACHE_MAX_THREADS) return true
  }
  return false
}

function pruneDisabledThreads(now = Date.now()): void {
  for (const [threadId, expiresAt] of disabledChatReportThreads) {
    if (expiresAt <= now) disabledChatReportThreads.delete(threadId)
  }
  while (disabledChatReportThreads.size > CHAT_REPORT_DISABLED_THREAD_MAX_ENTRIES) {
    const oldest = disabledChatReportThreads.keys().next().value
    if (typeof oldest !== "string") break
    disabledChatReportThreads.delete(oldest)
  }
}

function isChatReportThreadDisabled(threadId: string): boolean {
  const expiresAt = disabledChatReportThreads.get(threadId)
  if (expiresAt === undefined) return false
  if (expiresAt <= Date.now()) {
    disabledChatReportThreads.delete(threadId)
    return false
  }
  return true
}

function getChatReportUploadState(threadId: string): ChatReportUploadState {
  let state = chatReportUploadByThread.get(threadId)
  if (!state) {
    state = { uploadedIds: new Set(), inFlightIds: new Set() }
    chatReportUploadByThread.set(threadId, state)
  } else {
    touchThreadState(threadId, state)
  }
  return state
}

export function reserveChatReportMessageIds(threadId: string, messageIds: string[]): string[] {
  if (isChatReportThreadDisabled(threadId)) return []
  if (!makeRoomForThreadState(threadId)) return []
  const state = getChatReportUploadState(threadId)
  const reserved: string[] = []
  for (const messageId of messageIds) {
    if (state.inFlightIds.size >= CHAT_REPORT_UPLOAD_CACHE_MAX_IN_FLIGHT_IDS_PER_THREAD) break
    if (state.uploadedIds.has(messageId) || state.inFlightIds.has(messageId)) continue
    state.inFlightIds.add(messageId)
    reserved.push(messageId)
  }
  pruneThreadStates()
  return reserved
}

export function markChatReportMessageIdsUploaded(threadId: string, messageIds: string[]): void {
  if (isChatReportThreadDisabled(threadId)) return
  const state = getChatReportUploadState(threadId)
  for (const messageId of messageIds) {
    state.inFlightIds.delete(messageId)
    state.uploadedIds.add(messageId)
  }
  pruneUploadedIds(state)
  pruneThreadStates()
}

export function markChatReportUploadSucceeded(threadId: string, messageIds: string[]): void {
  const state = chatReportUploadByThread.get(threadId)
  if (!state) return
  for (const messageId of messageIds) {
    state.inFlightIds.delete(messageId)
    state.uploadedIds.add(messageId)
  }
  pruneUploadedIds(state)
  touchThreadState(threadId, state)
  pruneThreadStates()
}

export function markChatReportUploadFailed(threadId: string, messageIds: string[]): void {
  const state = chatReportUploadByThread.get(threadId)
  if (!state) return
  for (const messageId of messageIds) {
    state.inFlightIds.delete(messageId)
  }
  touchThreadState(threadId, state)
  pruneThreadStates()
}

export function clearChatReportUploadState(threadId: string): void {
  chatReportUploadByThread.delete(threadId)
  disabledChatReportThreads.delete(threadId)
}

export function disableChatReportUploadForThread(threadId: string): void {
  chatReportUploadByThread.delete(threadId)
  disabledChatReportThreads.delete(threadId)
  disabledChatReportThreads.set(threadId, Date.now() + CHAT_REPORT_DISABLED_THREAD_TTL_MS)
  pruneDisabledThreads()
}
