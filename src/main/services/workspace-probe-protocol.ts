import type { MessagePort } from "node:worker_threads"

export interface WorkspaceProbeRequest {
  id: number
  generation: number
  nonce: string
  workspace: string
  startedAt: bigint
  deadline: bigint
  port: MessagePort
}

export interface WorkspaceProbeResponse {
  id: number
  generation: number
  nonce: string
  workspace: string
  completedAt: bigint
  result: { canonical: string } | { error: "timeout" | "not-directory" | "unavailable" }
}

export class WorkspaceProbeError extends Error {
  constructor(readonly reason: "timeout" | "not-directory" | "unavailable" | "capacity") {
    super(`Workspace probe ${reason}`)
    this.name = "WorkspaceProbeError"
  }
}
