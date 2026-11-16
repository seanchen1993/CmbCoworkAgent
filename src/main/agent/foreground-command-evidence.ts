import { AsyncLocalStorage } from "node:async_hooks"
import type { ExecuteResponse } from "deepagents"

export type ForegroundCommandEvidence = Pick<ExecuteResponse, "output" | "truncated"> & {
  exitCode: number
  command: string
  directory: string
}

type Capture = {
  threadId: string
  begin: (callId: string) => ((evidence: ForegroundCommandEvidence) => void) | undefined
}
export const foregroundCommandEvidence = new AsyncLocalStorage<Capture | undefined>()
export const foregroundCommandCall = new AsyncLocalStorage<{
  threadId: string
  completed?: ForegroundCommandEvidence
}>()

// Only normal process collection can brand an outcome. Keep wrapper failures,
// approvals and timeouts out without changing the existing tool response.
export const observedProcessExits = new WeakSet<ExecuteResponse>()
