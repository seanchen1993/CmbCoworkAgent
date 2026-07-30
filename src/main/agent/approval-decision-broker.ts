import type { ApprovalDecision, ApprovalDecisionType, ApprovalRequest } from "../types"

export type ApprovalDecisionSource =
  | { kind: "desktop"; webContentsId: number }
  | {
      kind: "im"
      principalId: string
      conversationKey: string
      deviceEpoch: number
    }

export interface ApprovalBrokerRegistration {
  request: ApprovalRequest
  threadId: string
  runtimeThreadId: string
  resolve: (decision: ApprovalDecision) => void
}

export type ApprovalBrokerDecisionResult =
  | { accepted: true; request: ApprovalRequest; threadId: string }
  | {
      accepted: false
      reasonCode:
        | "APPROVAL_NOT_FOUND"
        | "APPROVAL_DECISION_INVALID"
        | "APPROVAL_TOOL_CALL_MISMATCH"
        | "REMOTE_APPROVAL_DECISION_UNSUPPORTED"
        | "REMOTE_APPROVAL_TYPE_NOT_ALLOWED"
    }

const DESKTOP_DECISION_TYPES = new Set<ApprovalDecisionType>([
  "approve",
  "approve_session",
  "approve_permanent",
  "reject",
  "error"
])

type PendingListener = (registration: Readonly<ApprovalBrokerRegistration>) => void
type RemovedListener = (requestId: string) => void

export class ApprovalDecisionBroker {
  private readonly pending = new Map<string, ApprovalBrokerRegistration>()
  private readonly pendingListeners = new Set<PendingListener>()
  private readonly removedListeners = new Set<RemovedListener>()

  register(registration: ApprovalBrokerRegistration): void {
    const requestId = registration.request.id?.trim()
    if (!requestId) throw new Error("approval request id is required")
    if (this.pending.has(requestId)) {
      throw new Error(`approval request is already registered: ${requestId}`)
    }
    this.pending.set(requestId, registration)
    for (const listener of this.pendingListeners) {
      try {
        listener(registration)
      } catch (error) {
        console.warn("[ApprovalBroker] Pending listener failed:", error)
      }
    }
  }

  unregister(requestId: string): void {
    if (!this.pending.delete(requestId)) return
    for (const listener of this.removedListeners) {
      try {
        listener(requestId)
      } catch (error) {
        console.warn("[ApprovalBroker] Removed listener failed:", error)
      }
    }
  }

  get(requestId: string): Readonly<ApprovalBrokerRegistration> | null {
    return this.pending.get(requestId) ?? null
  }

  list(threadId?: string): Readonly<ApprovalBrokerRegistration>[] {
    const registrations = [...this.pending.values()]
    return threadId ? registrations.filter((entry) => entry.threadId === threadId) : registrations
  }

  subscribePending(listener: PendingListener): () => void {
    this.pendingListeners.add(listener)
    return () => this.pendingListeners.delete(listener)
  }

  subscribeRemoved(listener: RemovedListener): () => void {
    this.removedListeners.add(listener)
    return () => this.removedListeners.delete(listener)
  }

  decide(input: {
    source: ApprovalDecisionSource
    requestId: string
    decision: ApprovalDecision
  }): ApprovalBrokerDecisionResult {
    const registration = this.pending.get(input.requestId)
    if (!registration) return { accepted: false, reasonCode: "APPROVAL_NOT_FOUND" }
    const decision = input.decision
    if (!decision || !DESKTOP_DECISION_TYPES.has(decision.type)) {
      return { accepted: false, reasonCode: "APPROVAL_DECISION_INVALID" }
    }
    const expectedToolCallId = registration.request.tool_call?.id
    if (
      expectedToolCallId &&
      (!decision.tool_call_id || decision.tool_call_id !== expectedToolCallId)
    ) {
      return { accepted: false, reasonCode: "APPROVAL_TOOL_CALL_MISMATCH" }
    }
    if (input.source.kind === "im") {
      if (decision.type !== "approve" && decision.type !== "reject") {
        return { accepted: false, reasonCode: "REMOTE_APPROVAL_DECISION_UNSUPPORTED" }
      }
      if (!registration.request.allowed_approval_types.includes(decision.type)) {
        return { accepted: false, reasonCode: "REMOTE_APPROVAL_TYPE_NOT_ALLOWED" }
      }
    }

    // Consume ownership before invoking the resolver. Runtime resolvers normally
    // unregister themselves as part of resolveOnce, but the broker must remain
    // single-shot even when another transport registers a simpler resolver.
    this.unregister(input.requestId)
    registration.resolve(decision)
    return {
      accepted: true,
      request: registration.request,
      threadId: registration.threadId
    }
  }
}

export const approvalDecisionBroker = new ApprovalDecisionBroker()
