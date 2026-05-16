import { randomUUID } from "crypto"
import { BrowserWindow } from "electron"
import type { UserInputQuestion, UserInputRequest, UserInputResponse } from "../types"

interface PendingUserInput {
  request: UserInputRequest
  resolve: (response: UserInputResponse) => void
  reject: (error: Error) => void
  abortSignal?: AbortSignal
  abortHandler?: () => void
}

interface RequestUserInputParams {
  threadId: string
  questions: UserInputQuestion[]
  abortSignal?: AbortSignal
}

const pendingUserInputs = new Map<string, PendingUserInput>()

function getLiveWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed() && !win.webContents.isDestroyed()
  )
}

function sendToThread(threadId: string, event: "request" | "cancel", payload: unknown): void {
  const channel = `userInput:${event}:${threadId}`
  for (const win of getLiveWindows()) {
    win.webContents.send(channel, payload)
  }
}

function cleanupPending(requestId: string): PendingUserInput | undefined {
  const pending = pendingUserInputs.get(requestId)
  if (!pending) return undefined
  pendingUserInputs.delete(requestId)
  if (pending.abortSignal && pending.abortHandler) {
    pending.abortSignal.removeEventListener("abort", pending.abortHandler)
  }
  return pending
}

export function requestUserInput(params: RequestUserInputParams): Promise<UserInputResponse> {
  const { threadId, questions, abortSignal } = params
  if (abortSignal?.aborted) {
    return Promise.reject(new Error("User input request was cancelled before it was shown."))
  }

  const windows = getLiveWindows()
  if (windows.length === 0) {
    return Promise.reject(new Error("No renderer window is available for user input."))
  }

  const request: UserInputRequest = {
    requestId: randomUUID(),
    threadId,
    questions,
    createdAt: new Date().toISOString()
  }

  return new Promise<UserInputResponse>((resolve, reject) => {
    const abortHandler = (): void => {
      const pending = cleanupPending(request.requestId)
      if (!pending) return
      sendToThread(threadId, "cancel", {
        requestId: request.requestId,
        reason: "The agent run was cancelled."
      })
      reject(new Error("User input request was cancelled."))
    }

    pendingUserInputs.set(request.requestId, {
      request,
      resolve,
      reject,
      abortSignal,
      abortHandler
    })

    abortSignal?.addEventListener("abort", abortHandler, { once: true })
    sendToThread(threadId, "request", request)
  })
}

export function submitUserInputResponse(response: UserInputResponse): boolean {
  const pending = cleanupPending(response.requestId)
  if (!pending) return false
  pending.resolve({
    ...response,
    submittedAt: response.submittedAt ?? new Date().toISOString()
  })
  return true
}

export function cancelUserInputsForThread(threadId: string, reason: string): number {
  let count = 0
  for (const [requestId, pending] of pendingUserInputs) {
    if (pending.request.threadId !== threadId) continue
    cleanupPending(requestId)
    sendToThread(threadId, "cancel", { requestId, reason })
    pending.reject(new Error(reason))
    count++
  }
  return count
}
