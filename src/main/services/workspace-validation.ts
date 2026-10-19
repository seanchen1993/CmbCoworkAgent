import { isAbsolute } from "node:path"
import { probeWorkspaceDirectory } from "./workspace-probe-client"
import { WorkspaceProbeError } from "./workspace-probe-protocol"

export class WorkspaceValidationError extends Error {
  readonly code = "invalid_workspace_path"

  constructor(workspace: unknown, reason: string) {
    const location = typeof workspace === "string" ? `（${JSON.stringify(workspace)}）` : ""
    super(`工作区${location}${reason}。请选择运行应用的机器上实际存在且可访问的绝对目录后重试。`)
    this.name = "WorkspaceValidationError"
  }
}

/** Recheck on every run: persisted paths and previously valid directories can go stale. */
export async function validateWorkspaceDirectory(
  workspace: unknown,
  signal?: AbortSignal
): Promise<string> {
  if (typeof workspace !== "string" || !workspace.trim() || !isAbsolute(workspace)) {
    throw new WorkspaceValidationError(workspace, "路径无效")
  }
  try {
    return await probeWorkspaceDirectory(workspace, signal)
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error
    if (error instanceof WorkspaceProbeError && error.reason === "timeout")
      throw new WorkspaceValidationError(workspace, "访问超时")
    if (error instanceof WorkspaceProbeError && error.reason === "not-directory")
      throw new WorkspaceValidationError(workspace, "不是目录")
    throw new WorkspaceValidationError(workspace, "不存在或不可访问")
  }
}
