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
  constructor(
    private readonly store: HostProjectStore,
    private readonly provider: HostProjectExecutionProvider
  ) {}

  async executePrepared(operationId: string): Promise<HostProjectOperation> {
    const operation = this.store.getOperation(operationId) ?? hostStateError("OPERATION_MISSING")
    const state = this.store.get(operation.projectId) ?? hostStateError("PROJECT_MISSING")
    if (operation.status !== "prepared") hostStateError("OPERATION_NOT_PREPARED")
    let fingerprint: string
    try {
      await this.provider.authorize(structuredClone(state), structuredClone(operation))
      fingerprint = await this.provider.fingerprint(
        structuredClone(state),
        structuredClone(operation)
      )
      if (fingerprint !== operation.inputFingerprint) hostStateError("INPUT_CHANGED")
    } catch (error) {
      this.store.failPrepared(operationId)
      throw error
    }
    // start performs another transactional status/version/approval check after async preparation.
    const ticket = this.store.start(operationId, fingerprint)
    const controller = new AbortController()
    this.controllers.set(operationId, controller)
    try {
      const outcome = await this.provider.execute(structuredClone(state), ticket, controller.signal)
      if (outcome !== "succeeded") return this.store.recordResult(ticket, { outcome, receipts: [] })
      if (controller.signal.aborted) {
        // The action returned a known outcome after cancellation; do not launch further validators.
        return this.store.recordResult(ticket, { outcome: "cancelled", receipts: [] })
      }
      const receipts = await this.provider.validate(
        structuredClone(state),
        ticket,
        controller.signal
      )
      return this.store.recordResult(ticket, { outcome: "succeeded", receipts })
    } catch {
      // A thrown error may follow an external write. Failure to observe a result is not proof of failure.
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
