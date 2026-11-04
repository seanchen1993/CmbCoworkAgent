import { LocalSandbox } from "../../agent/local-sandbox"
import { getWindowsSandboxMode } from "../../storage"
import type { ModsManager } from "../manager"
import { createGitInspectionPlatformProvider, type GitInspectionDependencies } from "./platform-git-provider"

export function createDesktopGitInspectionProvider(
  manager: ModsManager,
  confirmDirectory: GitInspectionDependencies["confirmDirectory"]
) {
  return createGitInspectionPlatformProvider({
    confirmDirectory,
    async authorizePath(context, root, path) {
      context.assertCurrent()
      const sandboxMode = process.platform === "win32" ? getWindowsSandboxMode() : "none"
      const runtime = manager.functionRuntimeScope(context.workspace, context.threadId)
      runtime.assertLive()
      const probe = LocalSandbox.createPermissionProbe({
        rootDir: root,
        runId: context.threadId,
        virtualMode: false,
        windowsSandbox: sandboxMode
      })
      const answer = await probe("read_file", { file_path: path })
      let denied = answer.decision !== "allow"
      // Respect the original runtime's restrictions in addition to the selected root.
      runtime.assertLive()
      if (!denied && runtime.bound) {
        if (!runtime.queryTool) throw Error("MODS_GIT_POLICY_UNAVAILABLE")
        const original = await runtime.queryTool("host:read_file", { file_path: path })
        denied = original.decision !== "allow"
      }
      // A partial list may omit denied paths, but never mask a global policy/runtime change.
      runtime.assertLive()
      context.assertCurrent()
      if (process.platform === "win32" && getWindowsSandboxMode() !== sandboxMode)
        throw Error("MODS_GIT_POLICY_CHANGED")
      if (denied) throw Error("MODS_GIT_PATH_DENIED")
    }
  })
}
