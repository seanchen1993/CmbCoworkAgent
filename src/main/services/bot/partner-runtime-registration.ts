import { getThread } from "../../db"
import { PARTNER_FAKE_MODEL_REF, PartnerFakeRequirementModel } from "./partner-fake-model"
import { registerPartnerInputOnlyImplementation } from "../../agent/agent-run-service"
import {
  createInputOnlyRequirementImplementation,
  InputOnlyRequirementFault
} from "./input-only-requirement-run"

/** Registers a restricted profile only. No listener, node or task auto-start. */
export function registerPartnerInputOnlyRuntime(): void {
  registerPartnerInputOnlyImplementation(
    createInputOnlyRequirementImplementation({
      resolveThread(threadId) {
        const thread = getThread(threadId)
        if (!thread || typeof thread.metadata !== "string")
          throw new InputOnlyRequirementFault("EXECUTION_FAILED")
        const metadata = JSON.parse(thread.metadata) as Record<string, unknown>
        return {
          metadata,
          workspacePath:
            typeof metadata.workspacePath === "string" ? metadata.workspacePath : undefined
        }
      },
      async resolveModel(modelRef) {
        if (modelRef === PARTNER_FAKE_MODEL_REF) return new PartnerFakeRequirementModel({})
        const { getModelConfigByRef } = await import("../../models/registry")
        const config = getModelConfigByRef(modelRef)
        if (!config) throw new InputOnlyRequirementFault("EXECUTION_FAILED")
        const { getModelInstance } = await import("../../agent/runtime")
        return getModelInstance(config, undefined, 1)
      }
    })
  )
}
