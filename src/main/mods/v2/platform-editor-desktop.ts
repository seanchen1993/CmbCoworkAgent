import { LocalSandbox } from "../../agent/local-sandbox"
import { getPreferredIde, getWindowsSandboxMode } from "../../storage"
import { openIde } from "../../utils/open-in-ide"
import type { ModsManager } from "../manager"
import {
  createEditorPlatformProvider,
  type EditorPlatformDependencies
} from "./platform-editor-provider"
import type { EditorNavigationBroker } from "./platform-editor-navigation"

/** Reuses current file policy and the user's saved IDE. Never chooses an executable or a model. */
export function createDesktopEditorPlatformProvider(
  manager: ModsManager,
  navigation: EditorNavigationBroker,
  rendererScope: EditorPlatformDependencies["rendererScope"]
) {
  return createEditorPlatformProvider({
    navigation,
    rendererScope,
    async authorizePath(context, absolutePath) {
      context.assertCurrent()
      const mode = process.platform === "win32" ? getWindowsSandboxMode() : "none"
      const runtime = manager.functionRuntimeScope(context.workspace, context.threadId)
      runtime.assertLive()
      const probe = LocalSandbox.createPermissionProbe({
        rootDir: context.workspace,
        runId: context.threadId,
        virtualMode: false,
        windowsSandbox: mode
      })
      const answer = await probe("read_file", { file_path: absolutePath })
      runtime.assertLive()
      if (answer.decision !== "allow") throw Error("EDITOR_NAVIGATION_PATH_DENIED")
      if (runtime.bound) {
        if (!runtime.queryTool) throw Error("EDITOR_NAVIGATION_POLICY_UNAVAILABLE")
        const original = await runtime.queryTool("host:read_file", { file_path: absolutePath })
        runtime.assertLive()
        if (original.decision !== "allow") throw Error("EDITOR_NAVIGATION_PATH_DENIED")
      }
      context.assertCurrent()
      if (process.platform === "win32" && getWindowsSandboxMode() !== mode)
        throw Error("EDITOR_NAVIGATION_POLICY_CHANGED")
    },
    async openExternal(context, absolutePath, line) {
      context.assertCurrent()
      const ide = getPreferredIde()
      if (!ide) return { unavailable: true, reason: "ide-not-configured" }
      // The existing Windows IDE service may use a .cmd launcher with shell:true.
      // Keep guest-selected paths out of that shell's expansion/operator language.
      if (process.platform === "win32" && /\s|[&|<>^%!"()]/u.test(context.workspace + absolutePath))
        return { unavailable: true, reason: "path-requires-built-in-preview" }
      const result = await openIde({
        ide,
        workspacePath: context.workspace,
        filePath: absolutePath,
        line
      })
      context.assertCurrent()
      if (getPreferredIde() !== ide) throw Error("EDITOR_NAVIGATION_IDE_CHANGED")
      return { mode: result.mode }
    }
  })
}
