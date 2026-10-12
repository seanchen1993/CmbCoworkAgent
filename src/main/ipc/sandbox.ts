import { CODEX_HOME, SETUP_VERSION, USERPROFILE_READ_ROOT_EXCLUSIONS, normalizeDirKey, getElevatedSystemSensitivePathError, validateElevatedWorkspaceRoot, isElevatedSetupComplete, isElevatedRootPrepared, areElevatedRootsPrepared, areElevatedRootsPreparedAsync, markElevatedRootsPrepared, isWorkspaceElevatedSetupDone, markWorkspaceElevatedSetupDone } from "../agent/windows-sandbox-state"
export { normalizeDirKey, getElevatedSystemSensitivePathError, validateElevatedWorkspaceRoot, isElevatedSetupComplete, isElevatedRootPrepared, areElevatedRootsPrepared, areElevatedRootsPreparedAsync, markElevatedRootsPrepared, isWorkspaceElevatedSetupDone, markWorkspaceElevatedSetupDone }
export type { ElevatedWorkspaceRootValidation, ElevatedWorkspaceRootValidationReason } from "../agent/windows-sandbox-state"
import { app, BrowserWindow, IpcMain } from "electron"
import fs from "fs/promises"
import { execFile } from "child_process"
import { homedir, tmpdir } from "os"
import { join, resolve } from "path"
import { promisify } from "util"
import {
  getWindowsSandboxMode,
  setWindowsSandboxMode,
  getYoloMode,
  setYoloMode,
  getApprovalRules,
  removeApprovalRule,
  isSandboxNuxCompleted,
  setSandboxNuxCompleted
} from "../storage"
import { pendingApprovals } from "../agent/runtime"
import { approvalDecisionBroker } from "../agent/approval-decision-broker"
import { isFailureFuseUserNoticeEnabled } from "../agent/failure-fuse"
import type { ApprovalDecision, ApprovalRequest } from "../types"

const ENABLE_SANDBOX_NUX = false
const execFileP = promisify(execFile)

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

function createAbortError(): Error {
  const error = new Error("Operation aborted")
  error.name = "AbortError"
  return error
}

function execFileWithAbort(
  file: string,
  args: string[],
  options: Parameters<typeof execFile>[2] & { timeout?: number; windowsHide?: boolean },
  abortSignal?: AbortSignal
): Promise<void> {
  if (abortSignal?.aborted) {
    return Promise.reject(createAbortError())
  }

  return new Promise<void>((resolve, reject) => {
    const child = execFile(file, args, options, (err) => {
      abortSignal?.removeEventListener("abort", onAbort)
      if (err) reject(err)
      else resolve()
    })

    const onAbort = () => {
      abortSignal?.removeEventListener("abort", onAbort)
      try { child.kill() } catch { /* already exited */ }
      reject(createAbortError())
    }

    abortSignal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Enumerate user profile subdirectories, excluding sensitive ones.
 * Matches codex's profile_read_roots() behavior.
 */
async function profileReadRoots(userProfile: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(userProfile, { withFileTypes: true })
    return entries
      .filter((entry) => {
        const name = entry.name.toLowerCase()
        return !USERPROFILE_READ_ROOT_EXCLUSIONS.some((ex) => name === ex.toLowerCase())
      })
      .map((entry) => join(userProfile, entry.name))
  } catch {
    // If enumeration fails, fall back to the profile root (same as codex)
    return [userProfile]
  }
}

function notifyChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("sandbox:changed")
  }
}

/** Resolve the directory containing codex.exe and the sandbox helper binaries. */
async function resolveCodexBinDir(): Promise<string> {
  if (app.isPackaged) {
    return join(process.resourcesPath, "bin", "win32")
  }
  // Dev mode: electron-vite bundles into out/main/index.js. __dirname may be relative
  // on some machines, so try multiple strategies to find the resources directory.
  const candidates = [
    resolve(__dirname, "../../resources"),       // out/main → project root
    join(app.getAppPath(), "resources"),          // app.getAppPath() = project root in dev
    join(app.getAppPath(), "..", "resources"),    // fallback
  ]
  for (const c of candidates) {
    if (await pathExists(join(c, "bin", "win32"))) return join(c, "bin", "win32")
  }
  // Last resort: use __dirname-based path even if it doesn't exist
  return join(resolve(__dirname, "../../resources"), "bin", "win32")
}

let _cachedIsCurrentProcessElevated: boolean | null = null
let _currentProcessElevationPromise: Promise<boolean> | null = null
const SANDBOX_PREWARM_WORKSPACE_LIMIT = 5

async function getCurrentProcessElevationState(): Promise<boolean> {
  if (_cachedIsCurrentProcessElevated !== null) return _cachedIsCurrentProcessElevated
  if (_currentProcessElevationPromise) return _currentProcessElevationPromise

  if (process.platform !== "win32") {
    _cachedIsCurrentProcessElevated = false
    return false
  }

  // Use whoami /groups to check for High Mandatory Level SID (S-1-16-12288).
  // This is the only reliable way to confirm the process is truly elevated.
  // Do NOT use `net session`: in corporate domain environments it can succeed
  // for non-admin users due to group policy, producing a false positive that
  // causes the UAC prompt to be skipped entirely.
  const safeCwd = process.env.SYSTEMROOT || process.env.windir || "C:\\Windows"
  const lookup = execFileP("whoami", ["/groups"], {
    encoding: "utf-8",
    windowsHide: true,
    cwd: safeCwd,
    timeout: 5000
  }).then(({ stdout }) => {
    _cachedIsCurrentProcessElevated = String(stdout).includes("S-1-16-12288")
    return _cachedIsCurrentProcessElevated
  }).catch((e) => {
    // Transient probe failures must not pin the cache to false — leave it null
    // so the next caller (e.g. NUX setup, runElevatedSetupForPaths) retries the
    // whoami check. Returning false this time is just a safe-by-default fallback.
    console.warn("[Sandbox] whoami probe failed (cache untouched, will retry):", (e as Error)?.message?.slice(0, 120))
    return false
  }).finally(() => {
    if (_currentProcessElevationPromise === lookup) {
      _currentProcessElevationPromise = null
    }
  })
  _currentProcessElevationPromise = lookup
  return lookup
}

function prewarmCurrentProcessElevation(): void {
  void getCurrentProcessElevationState().catch((err) => {
    console.warn("[Sandbox] Failed to prewarm process elevation state:", err)
  })
}

async function scheduleKnownWorkspaceSandboxPrewarm(
  mode: "none" | "unelevated" | "readonly" | "elevated"
): Promise<void> {
  if (process.platform !== "win32" || mode === "none") return
  // Keep elevated mode close to Codex upstream: prepare only the active cwd
  // opportunistically, not a historical list of workspaces that can include
  // stale or protected paths.
  if (mode === "elevated") return

  try {
    const [{ getAllThreadSummaries }, { LocalSandbox }] = await Promise.all([
      import("../db"),
      import("../agent/local-sandbox")
    ])
    const workspaces = new Set<string>()

    for (const thread of getAllThreadSummaries().slice(0, SANDBOX_PREWARM_WORKSPACE_LIMIT)) {
      if (typeof thread.metadata !== "string" || !thread.metadata) continue
      try {
        const metadata = JSON.parse(thread.metadata) as { workspacePath?: unknown }
        if (typeof metadata.workspacePath === "string" && metadata.workspacePath.trim()) {
          workspaces.add(metadata.workspacePath)
        }
      } catch {
        // Ignore malformed metadata and continue.
      }
    }

    if (workspaces.size === 0) return
    LocalSandbox.prewarmForWorkspaces([...workspaces], mode)
  } catch (err) {
    console.warn("[Sandbox] Failed to schedule known workspace prewarm:", err)
  }
}

/**
 * Run elevated sandbox setup with UAC for the given workspace paths.
 * This is intended for explicit setup entry points such as first-run NUX
 * and the sandbox settings panel.
 */
export async function runElevatedSetupForPaths(
  workspacePaths?: string[],
  abortSignal?: AbortSignal
): Promise<{ success: boolean; error?: string }> {
  if (abortSignal?.aborted) {
    throw createAbortError()
  }

  if (process.platform !== "win32") {
    return { success: false, error: "Elevated sandbox is only available on Windows" }
  }

  const binDir = await resolveCodexBinDir()
  const setupExe = join(binDir, "codex-windows-sandbox-setup.exe")
  if (!(await pathExists(setupExe))) {
    return { success: false, error: `找不到沙箱配置程序: ${setupExe}` }
  }

  // Ensure .sandbox directory exists
  const sbxDir = join(CODEX_HOME, ".sandbox")
  await fs.mkdir(sbxDir, { recursive: true })

  const home = homedir()
  const tmpDir = process.env.TEMP || process.env.TMP || join(home, "AppData", "Local", "Temp")
  const userProfile = process.env.USERPROFILE || home

  // write_roots: TEMP + workspace paths (validated)
  const writeRoots = [tmpDir]
  const validatedWorkspacePaths: string[] = []
  const rejectedWorkspaceErrors: string[] = []
  if (workspacePaths) {
    const validations = await Promise.all(
      workspacePaths.map(async (p) => ({ path: p, validation: await validateElevatedWorkspaceRoot(p) }))
    )
    for (const { path: p, validation } of validations) {
      if (!validation.ok || !validation.resolved) {
        const error = validation.error || `Elevated 工作区路径无效：${p}`
        console.warn(`[Sandbox] Rejected write_root: ${error}`)
        rejectedWorkspaceErrors.push(error)
        continue
      }
      const resolved = validation.resolved
      if (!writeRoots.includes(resolved)) writeRoots.push(resolved)
      validatedWorkspacePaths.push(resolved)
    }
  }
  if (workspacePaths?.length && validatedWorkspacePaths.length === 0 && rejectedWorkspaceErrors.length > 0) {
    return { success: false, error: rejectedWorkspaceErrors[0] }
  }

  // read_roots: user profile subdirs (excluding sensitive dirs) + standard Windows dirs
  const readRoots = await profileReadRoots(userProfile)
  const standardReadDirs = [
    "C:\\Windows",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
    "C:\\ProgramData"
  ]
  const existingStandardReadDirs = await Promise.all(
    standardReadDirs.map(async (dir) => (await pathExists(dir) ? dir : null))
  )
  for (const d of existingStandardReadDirs) {
    if (d && !readRoots.includes(d)) readRoots.push(d)
  }

  // Determine if this is initial setup or refresh (workspace ACL update)
  const isRefresh = await isElevatedSetupComplete()

  const payload = {
    version: SETUP_VERSION,
    offline_username: "CodexSandboxOffline",
    online_username: "CodexSandboxOnline",
    codex_home: CODEX_HOME,
    command_cwd: validatedWorkspacePaths[0] || home,
    read_roots: readRoots,
    write_roots: writeRoots,
    real_user: process.env.USERNAME || "Administrators",
    refresh_only: isRefresh
  }
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64")

  try {
    if (await getCurrentProcessElevationState()) {
      await execFileWithAbort(setupExe, [b64], {
        timeout: 120_000,
        windowsHide: true
      }, abortSignal)
    } else {
      // Write PS script to a temp file to avoid command-line length limits and encoding
      // corruption that occur when passing long base64 payloads via -Command inline.
      const tmpScript = join(tmpdir(), `sandbox-setup-${process.pid}-${Date.now()}.ps1`)
      const psScript = [
        `$p = Start-Process -FilePath '${setupExe.replace(/'/g, "''")}' \``,
        `  -ArgumentList '${b64}' \``,
        `  -Verb RunAs \``,
        `  -Wait \``,
        `  -PassThru \``,
        `  -WindowStyle Hidden`,
        `if ($null -eq $p) { exit 1 }`,
        `exit $p.ExitCode`,
      ].join("\r\n")
      await fs.writeFile(tmpScript, psScript, "utf-8")

      try {
        await execFileWithAbort("powershell", [
          "-NoProfile", "-NonInteractive",
          "-ExecutionPolicy", "Bypass",
          "-File", tmpScript
        ], {
          timeout: 120_000,
          windowsHide: true
        }, abortSignal)
      } finally {
        await fs.unlink(tmpScript).catch(() => {})
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw err
    }
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("1223") || msg.includes("canceled") || msg.includes("cancelled")) {
      return { success: false, error: "用户取消了管理员授权" }
    }
    return { success: false, error: `沙箱配置失败: ${msg}` }
  }

  markElevatedRootsPrepared(validatedWorkspacePaths)

  if (await isElevatedSetupComplete()) {
    return { success: true }
  }
  return { success: false, error: "沙箱配置未完成，请重试" }
}

export function registerSandboxHandlers(
  ipcMain: IpcMain,
  publishExecutionSettings: () => Promise<void> = async () => {}
): void {
  prewarmCurrentProcessElevation()

  ipcMain.handle("sandbox:getMode", async (): Promise<"none" | "unelevated" | "readonly" | "elevated"> => {
    return getWindowsSandboxMode()
  })

  ipcMain.handle(
    "sandbox:setMode",
    async (_event, mode: "none" | "unelevated" | "readonly" | "elevated"): Promise<void> => {
      if (mode !== "none" && mode !== "unelevated" && mode !== "readonly" && mode !== "elevated") {
        throw new Error(`Invalid sandbox mode: ${mode}`)
      }
      setWindowsSandboxMode(mode)
      notifyChanged()
      void scheduleKnownWorkspaceSandboxPrewarm(mode)
    }
  )

  ipcMain.handle("sandbox:getYoloMode", async (): Promise<boolean> => {
    return getYoloMode()
  })

  ipcMain.handle("sandbox:setYoloMode", async (_event, yolo: boolean): Promise<void> => {
    if (typeof yolo !== "boolean") throw new Error(`Invalid yolo value: ${yolo}`)
    setYoloMode(yolo)
    notifyChanged()
  })

  ipcMain.handle("sandbox:getFailureFuseDebug", async (): Promise<boolean> => {
    return process.env.CMB_AGENT_FAIL_FAST === "1"
  })

  ipcMain.handle("sandbox:getFailureFuseWarning", async (): Promise<boolean> => {
    return isFailureFuseUserNoticeEnabled()
  })

  ipcMain.handle("sandbox:getFailureFuseModelFeedback", async (): Promise<boolean> => {
    return process.env.CMB_AGENT_FAILURE_FUSE_MODEL_FEEDBACK === "1"
  })

  ipcMain.handle("sandbox:setFailureFuseWarning", async (_event, enabled: boolean): Promise<void> => {
    if (typeof enabled !== "boolean") throw new Error(`Invalid failure fuse warning value: ${enabled}`)
    if (enabled) {
      process.env.CMB_AGENT_FAILURE_FUSE_WARN = "1"
    } else {
      process.env.CMB_AGENT_FAILURE_FUSE_WARN = "0"
    }
    await publishExecutionSettings()
    notifyChanged()
  })

  ipcMain.handle("sandbox:setFailureFuseModelFeedback", async (_event, enabled: boolean): Promise<void> => {
    if (typeof enabled !== "boolean") throw new Error(`Invalid failure fuse model feedback value: ${enabled}`)
    if (enabled) {
      process.env.CMB_AGENT_FAILURE_FUSE_MODEL_FEEDBACK = "1"
    } else {
      delete process.env.CMB_AGENT_FAILURE_FUSE_MODEL_FEEDBACK
    }
    await publishExecutionSettings()
    notifyChanged()
  })

  ipcMain.handle("sandbox:setFailureFuseDebug", async (_event, enabled: boolean): Promise<void> => {
    if (typeof enabled !== "boolean") throw new Error(`Invalid failure fuse debug value: ${enabled}`)
    if (enabled) {
      process.env.CMB_AGENT_FAIL_FAST = "1"
    } else {
      delete process.env.CMB_AGENT_FAIL_FAST
    }
    await publishExecutionSettings()
    notifyChanged()
  })

  ipcMain.handle("sandbox:getPendingApprovals", async (_event, threadId: string): Promise<ApprovalRequest[]> => {
    if (typeof threadId !== "string" || !threadId.trim()) return []
    return Array.from(pendingApprovals.values())
      .filter((pending) => pending.threadId === threadId)
      .map((pending) => pending.request)
  })

  ipcMain.handle("sandbox:checkElevatedSetup", async (): Promise<{ setupComplete: boolean }> => {
    return { setupComplete: await isElevatedSetupComplete() }
  })

  ipcMain.handle(
    "sandbox:runElevatedSetup",
    async (_event, workspacePaths?: string[]): Promise<{ success: boolean; error?: string }> => {
      return runElevatedSetupForPaths(workspacePaths)
    }
  )

  // ── NUX (first-run setup) ──

  ipcMain.handle("sandbox:isNuxNeeded", async (): Promise<boolean> => {
    // Sandbox now defaults to disabled. Keep elevated setup opt-in from Settings unless NUX is re-enabled.
    return ENABLE_SANDBOX_NUX && process.platform === "win32" && !isSandboxNuxCompleted()
  })

  ipcMain.handle(
    "sandbox:completeNux",
    async (_event, mode: "elevated" | "unelevated" | "none"): Promise<void> => {
      if (mode === "elevated") {
        if (!(await isElevatedSetupComplete())) {
          const result = await runElevatedSetupForPaths()
          if (!result.success) {
            // Elevated setup failed — fall back to unelevated mode instead of blocking the app
            console.warn(`[Sandbox NUX] elevated setup failed, falling back to unelevated: ${result.error}`)
            setWindowsSandboxMode("unelevated")
            setSandboxNuxCompleted()
            notifyChanged()
            return
          }
        }
        setWindowsSandboxMode(mode)
      } else if (mode === "unelevated") {
        setWindowsSandboxMode(mode)
      } else {
        setWindowsSandboxMode("none")
      }
      setSandboxNuxCompleted()
      notifyChanged()
      void scheduleKnownWorkspaceSandboxPrewarm(getWindowsSandboxMode())
    }
  )

  // ── Approval rules management ──

  ipcMain.handle("sandbox:getApprovalRules", async (): Promise<Array<{ pattern: string; decision: string }>> => {
    return getApprovalRules()
  })

  ipcMain.handle("sandbox:deleteApprovalRule", async (_event, pattern: string): Promise<void> => {
    removeApprovalRule(pattern)
  })

  // ── Approval decision from renderer ──
  // When the renderer makes a decision on an approval request, it sends it here.
  // We look up the pending promise and resolve it.

  ipcMain.on("sandbox:approvalDecision", (event, decision: ApprovalDecision & { requestId: string }) => {
    // P2 fix: validate sender is a known BrowserWindow
    const senderWindow = BrowserWindow.getAllWindows().find(w => w.webContents.id === event.sender.id)
    if (!senderWindow) {
      console.warn("[Sandbox] Rejected approval decision from unknown sender, webContentsId:", event.sender.id)
      return
    }

    if (!decision || !decision.requestId) {
      console.warn("[Sandbox] Rejected approval decision with invalid type:", decision?.type)
      return
    }

    const pending = pendingApprovals.get(decision.requestId)
    if (pending) {
      // P3 fix: accept decisions from any known BrowserWindow, not just the original targets.
      // After window reload / hot-reload the webContents.id changes, so the original
      // targetWebContentsIds list becomes stale. The senderWindow check above already
      // ensures the sender is a legitimate BrowserWindow.
      if (!pending.targetWebContentsIds.includes(event.sender.id)) {
        console.log(
          `[Sandbox] Accepting approval from reloaded window (sender=${event.sender.id}, originalTargets=[${pending.targetWebContentsIds.join(",")}])`
        )
      }

      const result = approvalDecisionBroker.decide({
        source: { kind: "desktop", webContentsId: event.sender.id },
        requestId: decision.requestId,
        decision
      })
      if (!result.accepted) {
        console.warn("[Sandbox] Rejected approval decision:", result.reasonCode)
      }
    } else {
      console.warn("[Sandbox] Received approval decision for unknown request:", decision.requestId)
    }
  })
}
