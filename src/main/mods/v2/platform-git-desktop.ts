import { dialog, type BrowserWindow } from "electron"
import { LocalSandbox } from "../../agent/local-sandbox"
import { getWindowsSandboxMode } from "../../storage"
import type { ModsManager } from "../manager"
import { createGitInspectionPlatformProvider } from "./platform-git-provider"

export function createDesktopGitInspectionProvider(
  manager: ModsManager,
  window: () => BrowserWindow | null | undefined
) {
  return createGitInspectionPlatformProvider({
    async confirmDirectory(context, root) {
      context.assertCurrent()
      const owner = window()
      if (!owner || owner.isDestroyed()) return false
      const result = await dialog.showMessageBox(owner, {
        signal: context.signal,
        type: "question",
        title: "查看代码变更",
        message: `允许 ${context.caller.name} 读取此仓库的代码变更？`,
        detail: `${root}\n仅对当前会话和插件生效；不会提交、合并或清理代码。`,
        buttons: ["允许读取", "取消"],
        defaultId: 1,
        cancelId: 1
      })
      context.assertCurrent()
      return result.response === 0
    },
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
