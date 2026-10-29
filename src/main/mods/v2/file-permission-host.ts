import { LocalSandbox } from "../../agent/local-sandbox"
import { getWindowsSandboxMode } from "../../storage"
import type { ModsManager } from "../manager"
import { ModError } from "../errors"
import type { FunctionFileScope } from "./file-access"

export function functionFileScope(
  manager: ModsManager,
  assertPlainThread: (threadId: string) => void,
  workspace: string,
  threadId: string
): FunctionFileScope {
  const scope = manager.functionRuntimeScope(workspace, threadId)
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
