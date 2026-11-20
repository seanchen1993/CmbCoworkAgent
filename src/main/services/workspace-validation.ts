import { realpath, stat } from "node:fs/promises"
import { isAbsolute } from "node:path"

export class WorkspaceValidationError extends Error {
  readonly code = "invalid_workspace_path"

  constructor(workspace: unknown, reason: string) {
    const location = typeof workspace === "string" ? `（${JSON.stringify(workspace)}）` : ""
    super(`工作区${location}${reason}。请选择运行应用的机器上实际存在且可访问的绝对目录后重试。`)
    this.name = "WorkspaceValidationError"
  }
}

/** Recheck on every run: persisted paths and previously valid directories can go stale. */
export async function validateWorkspaceDirectory(workspace: unknown): Promise<string> {
  if (typeof workspace !== "string" || !workspace.trim() || !isAbsolute(workspace)) {
    throw new WorkspaceValidationError(workspace, "路径无效")
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        const canonical = await realpath(workspace)
        if (!(await stat(canonical)).isDirectory()) {
          throw new WorkspaceValidationError(workspace, "不是目录")
        }
        return canonical
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new WorkspaceValidationError(workspace, "访问超时")), 3_000)
        timer.unref?.()
      })
    ])
  } catch (error) {
    if (error instanceof WorkspaceValidationError) throw error
    throw new WorkspaceValidationError(workspace, "不存在或不可访问")
  } finally {
    if (timer) clearTimeout(timer)
  }
}
