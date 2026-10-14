import type { AgentRunExecutionContext, AgentRunRequest } from "./agent-run-service"

export interface AgentRunAdmission {
  context: AgentRunExecutionContext
  /** Called after the entire original run body settles, including cleanup. */
  settle(): void | Promise<void>
}
type AdmissionProvider = (
  request: AgentRunRequest,
  context: AgentRunExecutionContext
) => Promise<AgentRunAdmission | undefined>
let provider: AdmissionProvider | undefined

/** One application-owned adapter. Unregistered/default paths preserve the original behavior. */
export function registerAgentRunAdmission(next: AdmissionProvider): () => void {
  if (provider && provider !== next) throw Error("AGENT_RUN_ADMISSION_ALREADY_REGISTERED")
  provider = next
  return () => {
    if (provider === next) provider = undefined
  }
}
export function prepareAgentRunAdmission(
  request: AgentRunRequest,
  context: AgentRunExecutionContext
) {
  return provider?.(request, context)
}
