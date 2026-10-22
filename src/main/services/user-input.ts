import { randomUUID } from "crypto"
import { BrowserWindow } from "electron"
import type { UserInputQuestion, UserInputRequest, UserInputResponse } from "../types"
import { emitAppAttention } from "../app-attention-events"

interface AutoResolvedUserInputResponse {
  requestId: string
  autoResolved: true
  answers: UserInputResponse["answers"]
  message?: string
}

type UserInputResult = UserInputResponse | AutoResolvedUserInputResponse

interface PendingUserInput {
  request: UserInputRequest
  resolve: (response: UserInputResult) => void
  reject: (error: Error) => void
  abortSignal?: AbortSignal
  abortHandler?: () => void
  ackTimeout?: ReturnType<typeof setTimeout>
  autoResolutionTimeout?: ReturnType<typeof setTimeout>
}

type PendingUserInputListener = (request: Readonly<UserInputRequest>) => void
type RemovedUserInputListener = (requestId: string, threadId: string) => void

interface RequestUserInputParams {
  threadId: string
  questions: UserInputQuestion[]
  autoResolutionMs?: number
  autoResolution?: {
    type: "select_first" | "user_message"
    message?: string
  }
  abortSignal?: AbortSignal
  /**
   * Remote IM turns may keep running while no renderer is mounted. In that
   * case the request stays in the main-process registry and is restored when a
   * desktop window opens the Thread. Foreground desktop turns retain the
   * existing fail-fast renderer acknowledgement behavior.
   */
  allowDeferredRenderer?: boolean
}

const pendingUserInputs = new Map<string, PendingUserInput>()
const pendingUserInputThreads = new Map<string, string>()
const pendingUserInputListeners = new Set<PendingUserInputListener>()
const removedUserInputListeners = new Set<RemovedUserInputListener>()
const USER_INPUT_ACK_TIMEOUT_MS = 5_000

export function hasPendingUserInputForThread(threadId: string): boolean {
  return pendingUserInputThreads.has(threadId)
}

export function getPendingUserInputForThread(threadId: string): UserInputRequest | null {
  const requestId = pendingUserInputThreads.get(threadId)
  if (!requestId) return null
  return pendingUserInputs.get(requestId)?.request ?? null
}

export function subscribePendingUserInput(listener: PendingUserInputListener): () => void {
  pendingUserInputListeners.add(listener)
  return () => pendingUserInputListeners.delete(listener)
}

export function subscribeRemovedUserInput(listener: RemovedUserInputListener): () => void {
  removedUserInputListeners.add(listener)
  return () => removedUserInputListeners.delete(listener)
}

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
  if (pending.autoResolutionTimeout) {
    clearTimeout(pending.autoResolutionTimeout)
  }
  emitAppAttention({
    action: "resolve",
    kind: "user-input",
    threadId: pending.request.threadId,
    key: `user-input:${requestId}`
  })
  for (const listener of removedUserInputListeners) {
    try {
      listener(requestId, pending.request.threadId)
    } catch (error) {
      console.warn("[UserInput] Removed listener failed:", error)
    }
  }
  return pending
}

export function requestUserInput(params: RequestUserInputParams): Promise<UserInputResult> {
  const {
    threadId,
    questions,
    autoResolutionMs,
    autoResolution,
    abortSignal,
    allowDeferredRenderer = false
  } = params
  if (abortSignal?.aborted) {
    return Promise.reject(new Error("User input request was cancelled before it was shown."))
  }

  const windows = getLiveWindows()
  if (windows.length === 0 && !allowDeferredRenderer) {
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
    autoResolutionMs,
    createdAt: new Date().toISOString()
  }

  return new Promise<UserInputResult>((resolve, reject) => {
    const abortHandler = (): void => {
      const pending = cleanupPending(request.requestId)
      if (!pending) return
      sendToThread(threadId, "cancel", {
        requestId: request.requestId,
        reason: "The agent run was cancelled."
      })
      reject(new Error("User input request was cancelled."))
    }

    const ackTimeout = allowDeferredRenderer
      ? undefined
      : setTimeout(() => {
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

    const autoResolutionTimeout =
      autoResolutionMs === undefined
        ? undefined
        : setTimeout(() => {
            const pending = cleanupPending(request.requestId)
            if (!pending) return
            const selectedFirstOption = autoResolution?.type === "select_first"
            sendToThread(threadId, "cancel", {
              requestId: request.requestId,
              reason: "The user input request was automatically resolved."
            })
            const answers: UserInputResponse["answers"] = {}
            if (selectedFirstOption) {
              for (const question of questions) {
                const firstOption = question.options[0]
                if (!firstOption) continue
                answers[question.id] = question.allowMultiple
                  ? {
                      type: "options",
                      questionId: question.id,
                      options: [{ optionIndex: 0, ...firstOption }]
                    }
                  : {
                      type: "option",
                      questionId: question.id,
                      optionIndex: 0,
                      label: firstOption.label,
                      description: firstOption.description
                    }
              }
            }
            const response: AutoResolvedUserInputResponse = {
              requestId: request.requestId,
              autoResolved: true,
              answers
            }
            if (autoResolution?.type === "user_message" && autoResolution.message) {
              response.message = autoResolution.message
            }
            pending.resolve(response)
          }, autoResolutionMs)

    pendingUserInputs.set(request.requestId, {
      request,
      resolve,
      reject,
      abortSignal,
      abortHandler,
      ackTimeout,
      autoResolutionTimeout
    })
    pendingUserInputThreads.set(threadId, request.requestId)

    abortSignal?.addEventListener("abort", abortHandler, { once: true })
    emitAppAttention({
      kind: "user-input",
      threadId,
      key: `user-input:${request.requestId}`
    })
    sendToThread(threadId, "request", request)
    for (const listener of pendingUserInputListeners) {
      try {
        listener(request)
      } catch (error) {
        console.warn("[UserInput] Pending listener failed:", error)
      }
    }
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

export function submitUserInputResponse(
  response: UserInputResponse,
  options: { notifyRenderer?: boolean; reason?: string } = {}
): boolean {
  const request = pendingUserInputs.get(response.requestId)?.request
  if (request && !validMultipleChoiceResponse(request, response)) return false
  const pending = cleanupPending(response.requestId)
  if (!pending) return false
  if (options.notifyRenderer) {
    sendToThread(pending.request.threadId, "cancel", {
      requestId: response.requestId,
      reason: options.reason ?? "User input was answered outside the desktop renderer."
    })
  }
  pending.resolve({
    ...response,
    submittedAt: response.submittedAt ?? new Date().toISOString()
  })
  return true
}

/** Only the additive Bot protocol is checked here; legacy single-choice callers retain their contract. */
function validMultipleChoiceResponse(
  request: UserInputRequest,
  response: UserInputResponse
): boolean {
  const answers = response.answers as Record<string, unknown>
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
  if (!record(answers)) return false
  if (
    !request.questions.some((q) => q.allowMultiple) &&
    !Object.values(answers).some((answer) => record(answer) && answer.type === "options")
  )
    return true
  if (response.ignored) return Object.keys(answers).length === 0
  if (Object.keys(answers).length !== request.questions.length) return false
  return request.questions.every((question) => {
    const answer = answers[question.id]
    if (!record(answer) || answer.questionId !== question.id) return false
    if (answer.type === "other") return typeof answer.text === "string" && !!answer.text.trim()
    const matches = (option: unknown): boolean => {
      if (!record(option) || !Number.isInteger(option.optionIndex)) return false
      const expected = question.options[Number(option.optionIndex)]
      return (
        !!expected && expected.label === option.label && expected.description === option.description
      )
    }
    if (question.allowMultiple) {
      if (
        answer.type !== "options" ||
        !Array.isArray(answer.options) ||
        !answer.options.length ||
        answer.options.length > question.options.length ||
        !answer.options.every(matches)
      )
        return false
      return (
        new Set(answer.options.map((option) => option.optionIndex)).size === answer.options.length
      )
    }
    return answer.type === "option" && matches(answer)
  })
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
