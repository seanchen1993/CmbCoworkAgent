import { realpathSync, statSync } from "node:fs"
import { workerData } from "node:worker_threads"
import type { WorkspaceProbeRequest, WorkspaceProbeResponse } from "./workspace-probe-protocol"

const request = workerData as WorkspaceProbeRequest
let result: WorkspaceProbeResponse["result"]
try {
  if (process.hrtime.bigint() > request.deadline) result = { error: "timeout" }
  else {
    const canonical = realpathSync(request.workspace)
    result = statSync(canonical).isDirectory() ? { canonical } : { error: "not-directory" }
  }
} catch {
  result = { error: "unavailable" }
}
const completedAt = process.hrtime.bigint()
request.port.postMessage({
  id: request.id,
  generation: request.generation,
  nonce: request.nonce,
  workspace: request.workspace,
  completedAt,
  result: completedAt > request.deadline ? { error: "timeout" } : result
} satisfies WorkspaceProbeResponse)
request.port.close()
