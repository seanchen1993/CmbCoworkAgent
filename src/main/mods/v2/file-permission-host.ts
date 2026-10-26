import { LocalSandbox } from "../../agent/local-sandbox"
import { getWindowsSandboxMode } from "../../storage"
import type { ModsManager } from "../manager"
import { ModError } from "../errors"
import type { FunctionFileScope } from "./file-access"
import { currentWorkflowWorktreeActionScope } from "../../agent/workflow/worktree-action-scope"
import { resolve, relative } from "node:path"

export function functionFileScope(
  manager: ModsManager,
  assertPlainThread: (threadId: string) => void,
  workspace: string,
  threadId: string
): FunctionFileScope {
  const scope = manager.functionRuntimeScope(workspace, threadId)
  const resource = currentWorkflowWorktreeActionScope(workspace, threadId)
  if (resource) {
    if (!scope.bound || !scope.queryTool) throw new ModError("MODS_FS_CONTEXT_REQUIRED")
    const windowsSandbox = process.platform === "win32" ? getWindowsSandboxMode() : "none"
    const query = LocalSandbox.createPermissionProbe({ rootDir: resource.boundary.workspaceRoot,
      runId: threadId, virtualMode: false, windowsSandbox, worktreeIsolation: resource.boundary })
    const assertLive = () => {
      scope.assertLive()
      if (currentWorkflowWorktreeActionScope(workspace, threadId) !== resource ||
        (process.platform === "win32" && getWindowsSandboxMode() !== windowsSandbox))
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
      resource.assertCurrent()
    }
    return { workspace: resource.boundary.workspaceRoot, assertLive,
      queryTool: async (tool, input) => {
        assertLive()
        const narrowed = await query(tool.replace(/^host:/, ""), input)
        if (narrowed.decision !== "allow") return narrowed
        // Preserve the original thread's tool/relative-path rules as well as the checkout boundary.
        const mapped = Object.fromEntries(Object.entries(input).map(([key, value]) =>
          [key, (key === "path" || key === "file_path") && typeof value === "string"
            ? resolve(scope.workspace, relative(resource.boundary.workspaceRoot, value)) : value]))
        const original = await scope.queryTool!(tool, mapped)
        assertLive()
        return original
      } }
  }
  if (scope.bound) {
    if (!scope.queryTool) throw new ModError("MODS_FS_CONTEXT_REQUIRED")
    return { ...scope, queryTool: scope.queryTool }
  }
  assertPlainThread(threadId)
  const windowsSandbox = process.platform === "win32" ? getWindowsSandboxMode() : "none"
  const query = LocalSandbox.createPermissionProbe({
    rootDir: scope.workspace,
    runId: threadId,
    virtualMode: false,
    windowsSandbox
  })
  const assertLive = () => {
    scope.assertLive()
    assertPlainThread(threadId)
    if (process.platform === "win32" && getWindowsSandboxMode() !== windowsSandbox)
      throw new ModError("MODS_CALL_SCOPE_CHANGED")
  }
  return {
    workspace: scope.workspace,
    assertLive,
    queryTool: async (tool, input) => {
      assertLive()
      const result = await query(tool.replace(/^host:/, ""), input)
      assertLive()
      return result
    }
  }
}
