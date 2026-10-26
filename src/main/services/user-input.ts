import { createHash, randomUUID } from "crypto"
import { BrowserWindow } from "electron"
import type { UserInputQuestion, UserInputRequest, UserInputResponse } from "../types"
import { emitAppAttention } from "../app-attention-events"
import { HOST_INPUT_RESUME_CAPABILITIES } from "../../shared/project-runtime/host-types"
import type {
  HostUserInputBinding,
  HostContextResumeProof,
  HostUserInputRecord,
  HostUserInputStore
} from "./host-user-input-store"

interface AutoResolvedUserInputResponse {
  requestId: string
  autoResolved: true
  answers: UserInputResponse["answers"]
  message?: string
}

type UserInputResult = UserInputResponse | AutoResolvedUserInputResponse

interface PendingUserInput {
  acknowledged?: boolean
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
  /** Main tool runtime identity, never a question field supplied by a model. */
  toolCallId?: string
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
// Native question sites pin object identity. SQLite reads must not mint a new view
// on every lookup, but neither a cached view nor its identity can cache authority.
const PERSISTENT_QUESTION_VIEW_LIMIT = 64
const persistentQuestionViews = new Map<
  string,
  { store: HostUserInputStore; identity: string; request: UserInputRequest }
>()
const hostInputScopes = new Map<
  string,
  {
    binding: HostUserInputBinding
    assertCurrent: () => void
    unsafeToolSeen?: boolean
    activeTools?: number
    requiredContextText?: string
    contextResumeProof?: HostContextResumeProof
    continueIntent?: { remainingSteps: number; deadlineAt: number }
  }
>()
let hostPersistence:
  | {
      store: (create: boolean) => HostUserInputStore | undefined
      isCurrent: (record: HostUserInputRecord) => boolean
    }
  | undefined

/** Optional, lazy desktop wiring. Ordinary conversations retain their in-memory lifecycle. */
export function configureHostUserInputPersistence(value: typeof hostPersistence): void {
  persistentQuestionViews.clear()
  hostPersistence = value
}

/** Main-only registration around the original Host agent run; no renderer-provided binding. */
export function bindHostUserInputScope(
  threadId: string,
  binding: HostUserInputBinding,
  assertCurrent: () => void,
  requiredContextText?: string,
  continueIntent?: { remainingSteps: number; deadlineAt: number },
  contextResumeProof?: HostContextResumeProof
): () => void {
  if (hostInputScopes.has(threadId)) throw Error("HOST_USER_INPUT_SCOPE_ACTIVE")
  const scope = {
    binding: structuredClone(binding),
    assertCurrent,
    requiredContextText,
    contextResumeProof: contextResumeProof ? structuredClone(contextResumeProof) : undefined,
    continueIntent: continueIntent ? structuredClone(continueIntent) : undefined
  }
  hostInputScopes.set(threadId, scope)
  return () => {
    if (hostInputScopes.get(threadId) !== scope) return
    const waiting = hostPersistence?.store(false)?.pending(threadId)
    if (!waiting?.continuation || pendingUserInputThreads.has(threadId))
      cancelUserInputsForThread(threadId, "Host execution ended before consuming this request.")
    hostInputScopes.delete(threadId)
  }
}

function checkpointRequestId(operationId: string, toolCallId: string): string {
  return `host-input:${createHash("sha256")
    .update(JSON.stringify([operationId, toolCallId]))
    .digest("hex")}`
}

// Only synchronous native file tools have a bounded physical lifetime here. A returned shell,
// task, MCP or Job message is not proof that its external work ended, even after process restart.
/** An external lifecycle without a durable settled receipt cannot become a resumable wait. */
export function markHostInputExternalBoundary(threadId: string | undefined): void {
  const scope = threadId ? hostInputScopes.get(threadId) : undefined
  if (scope) {
    scope.unsafeToolSeen = true
    hostPersistence?.store(false)?.disqualifyContinuation(scope.binding.operationId)
  }
}

export function enterHostInputToolBoundary(threadId: string, name: string): () => void {
  const scope = hostInputScopes.get(threadId)
  if (!scope) return () => {}
  if (!HOST_INPUT_RESUME_CAPABILITIES.settledNativeTools.some((tool) => tool === name))
    markHostInputExternalBoundary(threadId)
  scope.activeTools = (scope.activeTools ?? 0) + 1
  return () => {
    scope.activeTools = Math.max(0, (scope.activeTools ?? 1) - 1)
  }
}

/** Called only before a single native input tool is dispatched by the original graph. */
export function prepareHostInputInterrupt(
  threadId: string,
  toolCallId: string,
  questions: UserInputQuestion[]
): HostUserInputRecord | undefined {
  const scope = hostInputScopes.get(threadId)
  if (!scope) return undefined
  if (scope.unsafeToolSeen || scope.activeTools) return undefined
  scope.assertCurrent()
  const store = hostPersistence?.store(true)
  if (!store) throw Error("HOST_USER_INPUT_PERSISTENCE_UNAVAILABLE")
  const requestId = checkpointRequestId(scope.binding.operationId, toolCallId)
  const existing = store.get(requestId)
  if (existing) {
    if (
      JSON.stringify(existing.binding) !== JSON.stringify(scope.binding) ||
      JSON.stringify(existing.request.questions) !== JSON.stringify(questions) ||
      existing.status === "cancelled"
    )
      throw Error("HOST_USER_INPUT_INTERRUPT_MISMATCH")
    return existing
  }
  const record = store.create(
    { requestId, threadId, questions, createdAt: new Date().toISOString() },
    scope.binding,
    {
      protocol: "host-user-input-interrupt/v1",
      toolCallId,
      claimed: false,
      priorToolsSettled: true,
      ...(scope.requiredContextText ? { requiredContextText: scope.requiredContextText } : {}),
      ...(scope.contextResumeProof ? { contextResumeProof: scope.contextResumeProof } : {}),
      ...(scope.continueIntent ? { continueIntent: scope.continueIntent } : {})
    }
  )
  emitAppAttention({ kind: "user-input", threadId, key: `user-input:${requestId}` })
  sendToThread(threadId, "request", record.request)
  return record
}

export function getHostInputContinuation(requestId: string): HostUserInputRecord | undefined {
  return hostPersistence?.store(false)?.get(requestId)
}

export function getHostInputWait(operationId: string): HostUserInputRecord | undefined {
  return hostPersistence?.store(false)?.unconsumedContinuation(operationId)
}

export function hasHostInputInterrupt(threadId: string): boolean {
  const scope = hostInputScopes.get(threadId)
  if (!scope) return false
  const record = getHostInputWait(scope.binding.operationId)
  return (
    !!record?.continuation && !record.continuation.claimed && record.request.threadId === threadId
  )
}

/** Only a main-process active Host execution may change the graph topology for durable input. */
export function hasHostUserInputScope(threadId: unknown): boolean {
  return typeof threadId === "string" && hostInputScopes.has(threadId)
}

export function claimHostInputContinuation(requestId: string): HostUserInputRecord {
  const store = hostPersistence?.store(false)
  if (!store) throw Error("HOST_USER_INPUT_PERSISTENCE_UNAVAILABLE")
  return store.claimContinuation(requestId)
}

function persistentRequest(threadId: string): UserInputRequest | null {
  const store = hostPersistence?.store(false)
  const record = store?.pending(threadId)
  if (!record) {
    persistentQuestionViews.delete(threadId)
    return null
  }
  let current: boolean | undefined
  try {
    current = hostPersistence?.isCurrent(record)
  } catch (error) {
    persistentQuestionViews.delete(threadId)
    throw error
  }
  if (!current) {
    persistentQuestionViews.delete(threadId)
    store!.cancel(
      record.request.requestId,
      "Host operation, installation or thread identity changed."
    )
    return null
  }
  const recoveryRequired = !record.continuation?.priorToolsSettled || record.continuation.claimed
  const identity = createHash("sha256")
    .update(JSON.stringify([record, recoveryRequired]))
    .digest("hex")
  const previous = persistentQuestionViews.get(threadId)
  if (previous && previous.store === store && previous.identity === identity) {
    persistentQuestionViews.delete(threadId)
    persistentQuestionViews.set(threadId, previous)
    return previous.request
  }
  const request = freezePersistentQuestion({
    ...record.request,
    recoveryRequired
  })
  persistentQuestionViews.delete(threadId)
  if (persistentQuestionViews.size >= PERSISTENT_QUESTION_VIEW_LIMIT) {
    const oldest = persistentQuestionViews.keys().next().value
    if (oldest !== undefined) persistentQuestionViews.delete(oldest)
  }
  persistentQuestionViews.set(threadId, { store: store!, identity, request })
  return request
}

function freezePersistentQuestion<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezePersistentQuestion(child)
    Object.freeze(value)
  }
  return value
}

export function hasPendingUserInputForThread(threadId: string): boolean {
  return getPendingUserInputForThread(threadId) !== null
}

export function getPendingUserInputForThread(threadId: string): UserInputRequest | null {
  const requestId = pendingUserInputThreads.get(threadId)
  if (!requestId) return persistentRequest(threadId)
  persistentQuestionViews.delete(threadId)
  const store = hostPersistence?.store(false)
  const record = store?.get(requestId)
  if (record) {
    try {
      const scope = hostInputScopes.get(threadId)
      if (scope) scope.assertCurrent()
      else if (!hostPersistence!.isCurrent(record)) throw Error("HOST_USER_INPUT_SCOPE_CHANGED")
    } catch {
      expireHostRequest(requestId)
      return null
    }
  }
  return pendingUserInputs.get(requestId)?.request ?? null
}

function expireHostRequest(requestId: string): void {
  const store = hostPersistence?.store(false)
  const record = store?.get(requestId)
  store?.cancel(requestId, "Host request identity or authority is no longer current.")
  const pending = cleanupPending(requestId)
  const threadId = pending?.request.threadId ?? record?.request.threadId
  if (threadId) {
    sendToThread(threadId, "cancel", {
      requestId,
      reason: "Host request expired. Reconcile the original operation before continuing."
    })
  }
  pending?.reject(new Error("HOST_USER_INPUT_SCOPE_CHANGED"))
}

/** Read-only host lifecycle fact; a queued/headless request is not an open desktop dialog. */
export function isUserInputRequestAcknowledged(requestId: string, threadId: string): boolean {
  const pending = pendingUserInputs.get(requestId)
  return pending?.request.threadId === threadId && pending.acknowledged === true
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

  const hostScope = hostInputScopes.get(threadId)
  if (hostScope) {
    hostScope.assertCurrent()
    if (params.toolCallId) {
      const store = hostPersistence?.store(false)
      const saved = store?.get(
        checkpointRequestId(hostScope.binding.operationId, params.toolCallId)
      )
      if (saved?.continuation) {
        if (
          !saved.continuation.claimed ||
          saved.status !== "answered" ||
          !saved.response ||
          JSON.stringify(saved.binding) !== JSON.stringify(hostScope.binding) ||
          JSON.stringify(saved.request.questions) !== JSON.stringify(questions)
        )
          return Promise.reject(new Error("HOST_USER_INPUT_CONTINUATION_MISMATCH"))
        store!.consume(saved.request.requestId)
        return Promise.resolve(saved.response)
      }
    }
    if (autoResolutionMs !== undefined)
      return Promise.reject(new Error("HOST_USER_INPUT_AUTO_RESOLUTION_UNSUPPORTED"))
  }
  const deferRenderer = allowDeferredRenderer || !!hostScope
  const windows = getLiveWindows()
  if (windows.length === 0 && !deferRenderer) {
    return Promise.reject(
      new UserInputRequestRejectedError(
        "no_renderer_window",
        "No renderer window is available for user input."
      )
    )
  }

  const existingRequestId = pendingUserInputThreads.get(threadId)
  if (existingRequestId || persistentRequest(threadId)) {
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
  if (hostScope) {
    const store = hostPersistence?.store(true)
    if (!store) return Promise.reject(new Error("HOST_USER_INPUT_PERSISTENCE_UNAVAILABLE"))
    store.create(request, hostScope.binding)
  }

  return new Promise<UserInputResult>((resolve, reject) => {
    const abortHandler = (): void => {
      hostPersistence?.store(false)?.cancel(request.requestId, "The agent run was cancelled.")
      const pending = cleanupPending(request.requestId)
      if (!pending) return
      sendToThread(threadId, "cancel", {
        requestId: request.requestId,
        reason: "The agent run was cancelled."
      })
      reject(new Error("User input request was cancelled."))
    }

    const ackTimeout = deferRenderer
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
                answers[question.id] = {
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
  if (!pending) return persistentRequest(threadId)?.requestId === requestId
  if (!pending || pending.request.threadId !== threadId) return false
  if (pending.ackTimeout) {
    clearTimeout(pending.ackTimeout)
    delete pending.ackTimeout
  }
  pending.acknowledged = true
  return true
}

export function submitUserInputResponse(
  response: UserInputResponse,
  options: { notifyRenderer?: boolean; reason?: string } = {}
): boolean {
  const current = pendingUserInputs.get(response.requestId)
  const store = hostPersistence?.store(false)
  const durable = store?.get(response.requestId)
  if (!current && !durable) return false
  if (durable) {
    if (durable.status === "cancelled") return false
    try {
      if (!durable.response) {
        if (current) {
          const scope = hostInputScopes.get(durable.request.threadId)
          if (!scope) throw Error("HOST_USER_INPUT_SCOPE_CHANGED")
          scope.assertCurrent()
        } else if (!hostPersistence!.isCurrent(durable))
          throw Error("HOST_USER_INPUT_SCOPE_CHANGED")
      }
    } catch {
      expireHostRequest(response.requestId)
      return false
    }
    // Closing a card is presentation only; it does not supply an answer or cancel the operation.
    if (response.ignored) return true
    const normalized = normalizeHostResponse(durable.request, response)
    if (!normalized) return false
    response = normalized
    try {
      store!.answer(response)
    } catch {
      return false
    }
    if (!current) {
      // Duplicate acknowledgements or a recovered answer never resume a model or expand authority.
      sendToThread(durable.request.threadId, "cancel", {
        requestId: response.requestId,
        reason: durable.continuation?.priorToolsSettled
          ? "Answer saved. The original operation will resume after safety checks."
          : "Answer saved. The interrupted Host operation still requires reconciliation."
      })
      return true
    }
  }
  if (!current) return false
  const answers = { ...response.answers }
  for (const [questionId, answer] of Object.entries(answers)) {
    if (answer?.type !== "options") continue
    const question = current.request.questions.find((item) => item.id === questionId)
    if (
      question?.multiSelect !== true ||
      answer.questionId !== questionId ||
      !Array.isArray(answer.optionIndices) ||
      !answer.optionIndices.length ||
      answer.optionIndices.length > question.options.length ||
      new Set(answer.optionIndices).size !== answer.optionIndices.length ||
      Array.from(answer.optionIndices).some(
        (index) => !Number.isSafeInteger(index) || index < 0 || index >= question.options.length
      )
    )
      return false
    const optionIndices = [...answer.optionIndices].sort((a, b) => a - b)
    answers[questionId] = {
      type: "options",
      questionId,
      optionIndices,
      labels: optionIndices.map((index) => question.options[index].label),
      descriptions: optionIndices.map((index) => question.options[index].description)
    }
  }
  // Invalid multiple selection leaves the original request and all waiting state intact.
  if (durable) store!.consume(response.requestId)
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
    answers,
    submittedAt: response.submittedAt ?? new Date().toISOString()
  })
  return true
}

export function cancelUserInputsForThread(threadId: string, reason: string): number {
  let count = 0
  for (const [requestId, pending] of pendingUserInputs) {
    if (pending.request.threadId !== threadId) continue
    hostPersistence?.store(false)?.cancel(requestId, reason)
    cleanupPending(requestId)
    sendToThread(threadId, "cancel", { requestId, reason })
    pending.reject(new Error(reason))
    count++
  }
  const store = hostPersistence?.store(false)
  const recovered = store?.pending(threadId)
  if (recovered) {
    store!.cancel(recovered.request.requestId, reason)
    sendToThread(threadId, "cancel", { requestId: recovered.request.requestId, reason })
    count++
  }
  return count
}

function normalizeHostResponse(
  request: UserInputRequest,
  response: UserInputResponse
): UserInputResponse | null {
  if (
    !response.answers ||
    typeof response.answers !== "object" ||
    Object.keys(response.answers).length !== request.questions.length
  )
    return null
  const answers: UserInputResponse["answers"] = {}
  for (const question of request.questions) {
    const answer = response.answers[question.id]
    if (!answer || answer.questionId !== question.id) return null
    if (answer.type === "other") {
      if (typeof answer.text !== "string" || !answer.text.trim() || answer.text.length > 20_000)
        return null
      answers[question.id] = { type: "other", questionId: question.id, text: answer.text }
    } else if (answer.type === "option") {
      if (!Number.isSafeInteger(answer.optionIndex)) return null
      const option = question.options[answer.optionIndex]
      if (
        !option ||
        (answer.additionalText !== undefined &&
          (typeof answer.additionalText !== "string" || answer.additionalText.length > 20_000))
      )
        return null
      answers[question.id] = {
        type: "option",
        questionId: question.id,
        optionIndex: answer.optionIndex,
        ...option,
        ...(answer.additionalText === undefined ? {} : { additionalText: answer.additionalText })
      }
    } else if (answer.type === "options") {
      if (
        !question.multiSelect ||
        !Array.isArray(answer.optionIndices) ||
        !answer.optionIndices.length ||
        new Set(answer.optionIndices).size !== answer.optionIndices.length ||
        answer.optionIndices.some(
          (index) => !Number.isSafeInteger(index) || !question.options[index]
        )
      )
        return null
      const indices = [...answer.optionIndices].sort((a, b) => a - b)
      answers[question.id] = {
        type: "options",
        questionId: question.id,
        optionIndices: indices,
        labels: indices.map((index) => question.options[index].label),
        descriptions: indices.map((index) => question.options[index].description)
      }
    } else return null
  }
  return {
    requestId: request.requestId,
    answers,
    submittedAt: response.submittedAt ?? new Date().toISOString()
  }
}
