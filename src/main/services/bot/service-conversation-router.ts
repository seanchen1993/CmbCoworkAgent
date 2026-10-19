import type { PartnerWorkerExecutor } from "./partner-local-worker"
import type { PartnerRequirementRun, PartnerRequirementResult } from "./requirement-execution-types"
import { validatePartnerRun } from "./requirement-execution-types"
import { PartnerLocalFault } from "./partner-local-boundary"
import {
  ServiceConversationStore,
  serviceScopeKey,
  type ServiceScope
} from "./service-conversation-store"
import type { ServiceModelBinding } from "./service-model-binding"

/** A router inside the existing single node worker, not a second poller. */
export class ServiceConversationRouter implements PartnerWorkerExecutor {
  private active = new Map<string, PartnerWorkerExecutor>()
  constructor(
    private readonly deps: {
      scope: ServiceScope
      store: ServiceConversationStore
      legacy: PartnerWorkerExecutor
      /** Only the controller's persisted pre-M02 lastRun can use old fake recovery. */
      legacyRunId: string | null
      model(ref: string): Promise<ServiceModelBinding>
      createExecutor(
        model: ServiceModelBinding,
        refusalCode?: "MODEL_CHANGED" | "MODEL_UNAVAILABLE"
      ): PartnerWorkerExecutor
      attemptState?(run: PartnerRequirementRun): string | null
      refused?(scope: ServiceScope, run: PartnerRequirementRun, code: string): void
      unknown?(scope: ServiceScope, run: PartnerRequirementRun): void
      claimed(scope: ServiceScope, run: PartnerRequirementRun): void
      finished(): void
    }
  ) {}
  async execute(raw: PartnerRequirementRun): Promise<PartnerRequirementResult> {
    const run = validatePartnerRun(raw),
      key = serviceScopeKey(this.deps.scope)
    let executor: PartnerWorkerExecutor
    const existing = this.deps.store.binding(key, run.commandId ?? "")
    if (existing) {
      const binding = this.deps.store.claim(key, run)
      if (binding.kind === "service") {
        const state = this.deps.attemptState?.(run)
        let refusal: "MODEL_CHANGED" | "MODEL_UNAVAILABLE" | undefined
        if (!state) {
          try {
            const model = await this.deps.model(binding.model.ref)
            if (model.hash !== binding.model.hash) refusal = "MODEL_CHANGED"
          } catch {
            refusal = "MODEL_UNAVAILABLE"
          }
        }
        // Saved results use their original attempt even after model deletion.
        // New admissions are refused durably, without calling a model.
        this.deps.claimed(this.deps.scope, run)
        if (refusal) this.deps.refused?.(this.deps.scope, run, refusal)
        executor = this.deps.createExecutor(binding.model, refusal)
      } else executor = this.deps.legacy
    } else {
      const s = this.deps.scope
      if (
        this.deps.store.ownsTask(key, run.taskId) ||
        run.id !== this.deps.legacyRunId ||
        run.requesterPrincipalId !== s.businessPrincipalId ||
        !["spaceId", "nodeId", "ownerPrincipalId", "workspaceRef", "groupId", "botId"].every(
          (k) =>
            (run as unknown as Record<string, unknown>)[k] ===
            (s as unknown as Record<string, unknown>)[k]
        )
      )
        throw new PartnerLocalFault("EXECUTION_BINDING_MISMATCH")
      executor = this.deps.legacy
    }
    this.active.set(run.id, executor)
    this.owned.set(run.id, run)
    try {
      return await executor.execute(run)
    } catch (error) {
      if (
        error instanceof Error &&
        ["PARTNER_EXECUTION_OUTCOME_UNKNOWN", "PARTNER_EXECUTION_LEASE_LOST"].includes(
          error.message
        )
      )
        this.deps.unknown?.(this.deps.scope, run)
      throw error
    } finally {
      this.active.delete(run.id)
      this.owned.delete(run.id)
      this.deps.finished()
    }
  }
  cancel(run: PartnerRequirementRun): boolean {
    return this.active.get(run.id)?.cancel(run) ?? false
  }
  cancelOwned(runId: string): boolean {
    // The router stores the exact authenticated attempt, never a renderer RunSpec.
    const value = this.owned.get(runId)
    return value ? (this.active.get(runId)?.cancel(value) ?? false) : false
  }
  private owned = new Map<string, PartnerRequirementRun>()
}
