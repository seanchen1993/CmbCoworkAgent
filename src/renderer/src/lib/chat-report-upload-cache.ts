type ChatReportUploadState = {
  uploadedIds: Set<string>
  inFlightIds: Set<string>
}

const chatReportUploadByThread = new Map<string, ChatReportUploadState>()
const disabledChatReportThreads = new Set<string>()

function getChatReportUploadState(threadId: string): ChatReportUploadState {
  let state = chatReportUploadByThread.get(threadId)
  if (!state) {
    state = { uploadedIds: new Set(), inFlightIds: new Set() }
    chatReportUploadByThread.set(threadId, state)
  }
  return state
}

export function reserveChatReportMessageIds(threadId: string, messageIds: string[]): string[] {
  if (disabledChatReportThreads.has(threadId)) return []
  const state = getChatReportUploadState(threadId)
  const reserved: string[] = []
  for (const messageId of messageIds) {
    if (state.uploadedIds.has(messageId) || state.inFlightIds.has(messageId)) continue
    state.inFlightIds.add(messageId)
    reserved.push(messageId)
  }
  return reserved
}

export function markChatReportMessageIdsUploaded(threadId: string, messageIds: string[]): void {
  if (disabledChatReportThreads.has(threadId)) return
  const state = getChatReportUploadState(threadId)
  for (const messageId of messageIds) {
    state.inFlightIds.delete(messageId)
    state.uploadedIds.add(messageId)
  }
}

export function markChatReportUploadSucceeded(threadId: string, messageIds: string[]): void {
  const state = chatReportUploadByThread.get(threadId)
  if (!state) return
  for (const messageId of messageIds) {
    state.inFlightIds.delete(messageId)
    state.uploadedIds.add(messageId)
  }
}

export function markChatReportUploadFailed(threadId: string, messageIds: string[]): void {
  const state = chatReportUploadByThread.get(threadId)
  if (!state) return
  for (const messageId of messageIds) {
    state.inFlightIds.delete(messageId)
  }
}

export function clearChatReportUploadState(threadId: string): void {
  chatReportUploadByThread.delete(threadId)
  disabledChatReportThreads.delete(threadId)
}

export function disableChatReportUploadForThread(threadId: string): void {
  chatReportUploadByThread.delete(threadId)
  disabledChatReportThreads.add(threadId)
}
