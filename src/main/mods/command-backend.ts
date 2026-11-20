import { app } from "electron"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { LocalSandbox } from "../agent/local-sandbox"
import { getEnabledHooks, getWindowsSandboxMode } from "../storage"
import { ModError } from "./errors"

/** Plain project sessions can run explicit native-tool commands without invoking a model. */
export function bindStandaloneModCommand(
  workspace: string,
  threadId: string,
  turnId: string,
  signal: AbortSignal
): () => Promise<void> {
  const windowsSandbox = process.platform === "win32" ? getWindowsSandboxMode() : "none"
  const codexExePath = join(
    app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources"),
    "bin",
    process.platform,
    "codex.exe"
  )
  if (windowsSandbox !== "none" && !existsSync(codexExePath))
    throw new ModError("MODS_SANDBOX_NOT_READY")
  // Construction only installs host-owned adapters. It cannot start a tool by itself.
  const aclOwnerId = `mod-command:${randomUUID()}`
  new LocalSandbox({
    rootDir: workspace,
    runId: threadId,
    hookTurnId: turnId,
    aclOwnerId,
    modCommandOnly: true,
    virtualMode: false,
    windowsSandbox,
    codexExePath,
    hooks: () => getEnabledHooks(workspace),
    abortSignal: signal,
    timeout: 60_000,
    maxOutputBytes: 48_000
  })
  return () => LocalSandbox.revokeGrantedAclsForRun(aclOwnerId)
}
