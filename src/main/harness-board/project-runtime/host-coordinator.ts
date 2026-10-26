import type {
  HostActionResult,
  HostExecutionTicket,
  HostProjectOperation,
  HostProjectState,
  HostValidationReceipt
} from "../../../shared/project-runtime/host-types"
import { HostProjectStore } from "./host-store"
import { hostStateError } from "./host-state-protocol"

/** These callbacks are main-process providers, never deserialized plugin or renderer arguments. */
export interface HostProjectExecutionProvider {
  authorize: (state: HostProjectState, operation: HostProjectOperation) => Promise<void>
  fingerprint: (state: HostProjectState, operation: HostProjectOperation) => Promise<string>
  /** Last synchronous source/caller fence after every asynchronous admission step. */
  assertCurrent?: (state: HostProjectState, operation: HostProjectOperation) => void
  execute: (
    state: HostProjectState,
    ticket: HostExecutionTicket,
    signal: AbortSignal
  ) => Promise<HostActionResult["outcome"]>
  validate: (
    state: HostProjectState,
    ticket: HostExecutionTicket,
    signal: AbortSignal
  ) => Promise<HostValidationReceipt[]>
}

/** One host execution chain per admitted operation; no implicit retry or automatic stage advance. */
export class HostProjectCoordinator {
  private readonly controllers = new Map<string, AbortController>()
  private readonly executions = new Map<string, Promise<HostProjectOperation>>()
  constructor(
    private readonly store: HostProjectStore,
    private readonly provider: HostProjectExecutionProvider
  ) {}

  async executePrepared(operationId: string): Promise<HostProjectOperation> {
    return this.track(operationId, false)
  }

  async executeInterrupted(operationId: string): Promise<HostProjectOperation> {
    return this.track(operationId, true)
  }

  async waitForSettlement(operationId: string): Promise<void> {
    await this.executions.get(operationId)
  }

  private track(operationId: string, recovering: boolean): Promise<HostProjectOperation> {
    if (this.executions.has(operationId)) hostStateError("OPERATION_BUSY")
    const running = this.execute(operationId, recovering).finally(() => {
      if (this.executions.get(operationId) === running) this.executions.delete(operationId)
    })
    this.executions.set(operationId, running)
    return running
  }

  private async execute(operationId: string, recovering: boolean): Promise<HostProjectOperation> {
    const operation = this.store.getOperation(operationId) ?? hostStateError("OPERATION_MISSING")
    const state = this.store.get(operation.projectId) ?? hostStateError("PROJECT_MISSING")
    if (operation.status !== (recovering ? "unknown" : "prepared"))
      hostStateError("OPERATION_NOT_PREPARED")
    let fingerprint: string
    try {
      await this.provider.authorize(structuredClone(state), structuredClone(operation))
      fingerprint = await this.provider.fingerprint(
        structuredClone(state),
        structuredClone(operation)
      )
      if (fingerprint !== operation.inputFingerprint) hostStateError("INPUT_CHANGED")
    } catch (error) {
      if (!recovering) this.store.failPrepared(operationId)
      throw error
    }
    // start performs another transactional status/version/approval check after async preparation.
    this.provider.assertCurrent?.(state, operation)
    const ticket = recovering
      ? this.store.resumeInterrupted(operationId, fingerprint)
      : this.store.start(operationId, fingerprint)
    const controller = new AbortController()
    this.controllers.set(operationId, controller)
    let phase: "execute" | "validate" | "record-result" = "execute"
    try {
      const outcome = await this.provider.execute(structuredClone(state), ticket, controller.signal)
      if (outcome !== "succeeded") {
        phase = "record-result"
        return this.store.recordResult(ticket, { outcome, receipts: [] })
      }
      if (controller.signal.aborted) {
        // The action returned a known outcome after cancellation; do not launch further validators.
        phase = "record-result"
        return this.store.recordResult(ticket, { outcome: "cancelled", receipts: [] })
      }
      phase = "validate"
      const receipts = await this.provider.validate(
        structuredClone(state),
        ticket,
        controller.signal
      )
      phase = "record-result"
      return this.store.recordResult(ticket, { outcome: "succeeded", receipts })
    } catch (error) {
      // A thrown error may follow an external write. Failure to observe a result is not proof of failure.
      // Keep bounded diagnostic codes only; arbitrary exception details may contain task data.
      try {
        const message = error instanceof Error ? error.message : undefined
        const code = typeof message === "string" && /^[A-Z][A-Z0-9_]{0,95}$/.test(message) &&
          !message.endsWith("\n") ? message : "UNKNOWN"
        console.warn("[ProjectRuntime] Execution result unconfirmed", { phase, code })
      } catch { /* Diagnostics must not change the conservative result. */ }
      return this.store.recordResult(ticket, { outcome: "unknown", receipts: [] })
    } finally {
      this.controllers.delete(operationId)
    }
  }

  cancel(operationId: string): HostProjectOperation {
    const operation = this.store.cancel(operationId)
    this.controllers.get(operationId)?.abort()
    return operation
  }
}
