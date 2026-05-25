import { randomUUID } from "crypto"
import { BrowserWindow } from "electron"
import type { UserInputQuestion, UserInputRequest, UserInputResponse } from "../types"

interface PendingUserInput {
  request: UserInputRequest
  resolve: (response: UserInputResponse) => void
  reject: (error: Error) => void
  abortSignal?: AbortSignal
  abortHandler?: () => void
  ackTimeout?: ReturnType<typeof setTimeout>
}

interface RequestUserInputParams {
  threadId: string
  questions: UserInputQuestion[]
  abortSignal?: AbortSignal
}

const pendingUserInputs = new Map<string, PendingUserInput>()
const pendingUserInputThreads = new Map<string, string>()
const USER_INPUT_ACK_TIMEOUT_MS = 5_000

export class UserInputRequestRejectedError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "UserInputRequestRejectedError"
    this.code = code
  }
}

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
  if (pendingUserInputThreads.get(pending.request.threadId) === requestId) {
    pendingUserInputThreads.delete(pending.request.threadId)
  }
  if (pending.abortSignal && pending.abortHandler) {
    pending.abortSignal.removeEventListener("abort", pending.abortHandler)
  }
  if (pending.ackTimeout) {
    clearTimeout(pending.ackTimeout)
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
    return Promise.reject(
      new UserInputRequestRejectedError(
        "no_renderer_window",
        "No renderer window is available for user input."
      )
    )
  }

  const existingRequestId = pendingUserInputThreads.get(threadId)
  if (existingRequestId) {
    return Promise.reject(
      new UserInputRequestRejectedError(
        "request_already_pending",
        "A user input request is already pending for this thread. Wait for the user's response before asking another question."
      )
    )
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

    const ackTimeout = setTimeout(() => {
      const pending = cleanupPending(request.requestId)
      if (!pending) return
      sendToThread(threadId, "cancel", {
        requestId: request.requestId,
        reason: "No renderer acknowledged this user input request."
      })
      pending.reject(
        new UserInputRequestRejectedError(
          "request_not_acknowledged",
          "No renderer acknowledged this user input request. The user may not have this thread open."
        )
      )
    }, USER_INPUT_ACK_TIMEOUT_MS)

    pendingUserInputs.set(request.requestId, {
      request,
      resolve,
      reject,
      abortSignal,
      abortHandler,
      ackTimeout
    })
    pendingUserInputThreads.set(threadId, request.requestId)

    abortSignal?.addEventListener("abort", abortHandler, { once: true })
    sendToThread(threadId, "request", request)
  })
}

export function acknowledgeUserInputRequest(requestId: string, threadId: string): boolean {
  const pending = pendingUserInputs.get(requestId)
  if (!pending || pending.request.threadId !== threadId) return false
  if (pending.ackTimeout) {
    clearTimeout(pending.ackTimeout)
    delete pending.ackTimeout
  }
  return true
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
