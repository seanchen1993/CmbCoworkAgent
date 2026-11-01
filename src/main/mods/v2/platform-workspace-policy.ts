import { isAbsolute, relative, resolve, sep } from "node:path"
import { LocalSandbox } from "../../agent/local-sandbox"
import { getWindowsSandboxMode } from "../../storage"
import type { ModsManager } from "../manager"
import { normalizeWorkspacePathKey } from "../../../shared/workspace-path"
import type { NativePlatformCallContext } from "./platform-capabilities-types"

/** Reuse the native workspace policy; capability grants never turn an ask into allow. */
export function createWorkspaceReadPolicy(manager: Pick<ModsManager, "functionRuntimeScope">) {
  const capture = (context: NativePlatformCallContext) => {
    const root = resolve(context.workspace)
    const runtime = manager.functionRuntimeScope(context.workspace, context.threadId)
    const mode = process.platform === "win32" ? getWindowsSandboxMode() : "none"
    const check = () => {
      context.signal.throwIfAborted()
      context.assertCurrent()
      runtime.assertLive()
      if (normalizeWorkspacePathKey(runtime.workspace) !== normalizeWorkspacePathKey(root))
        throw Error("MODS_WORKSPACE_SCOPE_CHANGED")
      if (process.platform === "win32" && getWindowsSandboxMode() !== mode)
        throw Error("MODS_WORKSPACE_POLICY_CHANGED")
    }
    check()
    return { root, runtime, mode, check }
  }
  const authorize = async (context: NativePlatformCallContext, path: string): Promise<void> => {
    const { root, runtime, mode, check } = capture(context)
    const absolute = resolve(path)
    const tail = relative(root, absolute)
    if (!isAbsolute(path) || tail === ".." || tail.startsWith(`..${sep}`) || isAbsolute(tail))
      throw Error("MODS_WORKSPACE_PATH_DENIED")
    const probe = LocalSandbox.createPermissionProbe({
      rootDir: root,
      runId: context.threadId,
      virtualMode: false,
      windowsSandbox: mode
    })
    const result = await probe("read_file", { file_path: absolute })
    check()
    if (result.decision !== "allow") throw Error("MODS_WORKSPACE_PATH_DENIED")
    if (runtime.bound) {
      if (!runtime.queryTool) throw Error("MODS_WORKSPACE_POLICY_UNAVAILABLE")
      const original = await runtime.queryTool("host:read_file", { file_path: absolute })
      check()
      if (original.decision !== "allow") throw Error("MODS_WORKSPACE_PATH_DENIED")
    }
    check()
  }
  return Object.assign(authorize, {
    /** Pin the same runtime and sandbox mode across a complete asynchronous observation. */
    capture: (context: NativePlatformCallContext) => capture(context).check
  })
}
