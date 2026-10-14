import { registerAgentRunAdmission } from "../../agent/agent-run-admission"
import { registerFlowRuntimeAdmission } from "../../mods/flows/runtime-admission"
import { registerLegacyProjectEntryGate } from "./legacy-entry-gate"

/** A damaged opt-in ledger must neither stop ordinary chat nor silently lose its source fence. */
export function registerUnavailableLegacyRuntime(isProjectThread: (threadId: string) => boolean) {
  const reject = () => { throw Error("PROJECT_LEGACY_RUNTIME_UNAVAILABLE") }
  const stopAgent = registerAgentRunAdmission(async request => {
    if (isProjectThread(request.threadId)) reject()
    return undefined
  })
  let stopFlow: (() => void) | undefined
  let stopGate: (() => void) | undefined
  try {
    stopFlow = registerFlowRuntimeAdmission(async request => {
      if (isProjectThread(request.threadId)) reject()
      return undefined
    })
    stopGate = registerLegacyProjectEntryGate(reject)
  } catch (error) {
    stopFlow?.()
    stopAgent()
    throw error
  }
  return () => { stopGate?.(); stopFlow?.(); stopAgent() }
}
