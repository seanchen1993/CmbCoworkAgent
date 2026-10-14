import type { FlowRun } from "../../../shared/mods/flows/types"

export interface FlowRuntimeAdmission {
  run<T>(work: () => T): T
  /** Original Flow has disposed and persisted. Missing receipt is never a successful result. */
  settle(run: FlowRun | undefined, notStarted: boolean): void | Promise<void>
}
export interface FlowRuntimeAdmissionRequest {
  threadId: string
  workspace: string
  requestId: string
  input: string
}
type Provider = (
  request: FlowRuntimeAdmissionRequest
) => Promise<FlowRuntimeAdmission | undefined> | undefined
let provider: Provider | undefined
export function registerFlowRuntimeAdmission(next: Provider): () => void {
  if (provider) throw Error("FLOW_RUNTIME_ADMISSION_ALREADY_REGISTERED")
  provider = next
  return () => {
    if (provider === next) provider = undefined
  }
}
export function prepareFlowRuntimeAdmission(request: FlowRuntimeAdmissionRequest) {
  return provider?.(request)
}
