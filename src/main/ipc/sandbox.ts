import { app, BrowserWindow, IpcMain } from "electron"
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs"
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
import type { ApprovalDecision } from "../types"

const CODEX_HOME = join(homedir(), ".codex")
const SETUP_MARKER_PATH = join(CODEX_HOME, ".sandbox", "setup_marker.json")
const SANDBOX_USERS_PATH = join(CODEX_HOME, ".sandbox-secrets", "sandbox_users.json")
const ELEVATED_WORKSPACES_PATH = join(CODEX_HOME, ".sandbox", "elevated_workspaces.json")
const SETUP_VERSION = 5
const execFileP = promisify(execFile)

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

/** Persistent + session cache of elevated sandbox roots already prepared for ACL use. */
const elevatedPreparedRoots = new Set<string>()

/** Normalize a directory path for consistent cache lookups (lowercase, no trailing slash, backslashes). */
export function normalizeDirKey(dir: string): string {
  return resolve(dir).replace(/\/+/g, "\\").replace(/\\+$/, "").toLowerCase()
}

function isSafeElevatedPreparedRoot(dir: string): boolean {
  if (!dir || typeof dir !== "string") return false
  if (/^[\\/]{2}/.test(dir)) return false

  let key: string
  try {
    key = normalizeDirKey(dir)
  } catch {
    return false
  }

  if (/^[a-z]:$/i.test(key)) return false

  const blockedRoots = [
    "c:\\windows",
    "c:\\program files",
    "c:\\program files (x86)",
    "c:\\programdata",
    "c:\\users\\all users",
    "c:\\users\\default",
    "c:\\users\\public"
  ]
  if (blockedRoots.some((root) => key === root || key.startsWith(`${root}\\`))) {
    return false
  }

  try {
    return statSync(resolve(dir)).isDirectory()
  } catch {
    return false
  }
}

/** Load previously configured workspace paths from disk into the in-memory set. */
function loadElevatedPreparedRoots(): void {
  try {
    if (!existsSync(ELEVATED_WORKSPACES_PATH)) return
    const data = JSON.parse(readFileSync(ELEVATED_WORKSPACES_PATH, "utf-8"))
    const version = typeof data.version === "number" ? data.version : SETUP_VERSION
    if (version !== SETUP_VERSION) return
    const rawRoots = Array.isArray(data.roots)
      ? data.roots
      : Array.isArray(data.paths)
        ? data.paths
        : []
    let changed = false
    for (const p of rawRoots) {
      if (typeof p !== "string") continue
      if (!isSafeElevatedPreparedRoot(p)) {
        changed = true
        continue
      }
      elevatedPreparedRoots.add(normalizeDirKey(p))
    }
    if (changed) saveElevatedPreparedRoots()
  } catch {
    // Corrupt or missing file — start fresh, will be overwritten on next save
  }
}

/** Persist the current set of configured workspace paths to disk. */
function saveElevatedPreparedRoots(): void {
  try {
    const sbxDir = join(CODEX_HOME, ".sandbox")
    mkdirSync(sbxDir, { recursive: true })
    writeFileSync(
      ELEVATED_WORKSPACES_PATH,
      JSON.stringify({ version: SETUP_VERSION, roots: [...elevatedPreparedRoots] }, null, 2)
    )
  } catch (err) {
    console.warn("[Sandbox] Failed to persist elevated prepared roots:", err)
  }
}

// Load persisted roots immediately so they survive app restarts
loadElevatedPreparedRoots()

/** Sensitive directories under user profile that should NOT be readable by the sandbox user. */
const USERPROFILE_READ_ROOT_EXCLUSIONS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".config",
  ".npm",
  ".pki",
  ".terraform.d"
]

/**
 * Enumerate user profile subdirectories, excluding sensitive ones.
 * Matches codex's profile_read_roots() behavior.
 */
function profileReadRoots(userProfile: string): string[] {
  try {
    const entries = readdirSync(userProfile, { withFileTypes: true })
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
function resolveCodexBinDir(): string {
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
    if (existsSync(join(c, "bin", "win32"))) return join(c, "bin", "win32")
  }
  // Last resort: use __dirname-based path even if it doesn't exist
  return join(resolve(__dirname, "../../resources"), "bin", "win32")
}

/** Check whether the elevated sandbox setup has been completed (marker exists with correct version). */
export function isElevatedSetupComplete(): boolean {
  if (!existsSync(SETUP_MARKER_PATH) || !existsSync(SANDBOX_USERS_PATH)) return false
  try {
    const marker = JSON.parse(readFileSync(SETUP_MARKER_PATH, "utf-8"))
    const users = JSON.parse(readFileSync(SANDBOX_USERS_PATH, "utf-8"))
    return marker.version === SETUP_VERSION
      && users.version === SETUP_VERSION
      && typeof marker.offline_username === "string"
      && typeof marker.online_username === "string"
      && typeof users.offline?.username === "string"
      && typeof users.online?.username === "string"
  } catch {
    return false
  }
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
    const [{ getAllThreads }, { LocalSandbox }] = await Promise.all([
      import("../db"),
      import("../agent/local-sandbox")
    ])
    const workspaces = new Set<string>()

    for (const thread of getAllThreads().slice(0, SANDBOX_PREWARM_WORKSPACE_LIMIT)) {
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

  const binDir = resolveCodexBinDir()
  const setupExe = join(binDir, "codex-windows-sandbox-setup.exe")
  if (!existsSync(setupExe)) {
    return { success: false, error: `找不到沙箱配置程序: ${setupExe}` }
  }

  // Ensure .sandbox directory exists
  const sbxDir = join(CODEX_HOME, ".sandbox")
  mkdirSync(sbxDir, { recursive: true })

  const home = homedir()
  const tmpDir = process.env.TEMP || process.env.TMP || join(home, "AppData", "Local", "Temp")
  const userProfile = process.env.USERPROFILE || home

  // write_roots: TEMP + workspace paths (validated)
  const writeRoots = [tmpDir]
  const validatedWorkspacePaths: string[] = []
  if (workspacePaths) {
    for (const p of workspacePaths) {
      if (!p || typeof p !== "string") continue
      // Resolve to absolute path (handles relative paths like ../../)
      const resolved = resolve(p)
      const normalized = resolved.replace(/\\/g, "/").toLowerCase()

      // Block UNC paths (\\server\share or //server/share)
      if (/^[\\/]{2}/.test(p) || /^[\\/]{2}/.test(resolved)) {
        console.warn(`[Sandbox] Rejected write_root: UNC path "${p}"`)
        continue
      }

      // Block drive roots (e.g. "C:\", "D:\")
      if (/^[a-z]:\/?\s*$/.test(normalized)) {
        console.warn(`[Sandbox] Rejected write_root: drive root "${p}"`)
        continue
      }
      // Block system directories
      const blockedPrefixes = [
        "c:/windows", "c:/program files", "c:/program files (x86)",
        "c:/programdata", "c:/users/all users", "c:/users/default",
        "c:/users/public"
      ]
      if (blockedPrefixes.some(bp => normalized === bp || normalized.startsWith(bp + "/"))) {
        console.warn(`[Sandbox] Rejected write_root: system directory "${p}"`)
        continue
      }
      // Block sensitive user directories
      const homeNorm = home.replace(/\\/g, "/").toLowerCase()
      if (normalized.startsWith(homeNorm + "/")) {
        const relative = normalized.slice(homeNorm.length + 1).split("/")[0]
        if (USERPROFILE_READ_ROOT_EXCLUSIONS.some(e => e.toLowerCase() === relative)) {
          console.warn(`[Sandbox] Rejected write_root: sensitive directory "${p}"`)
          continue
        }
      }
      // Verify path exists and is a directory
      try {
        const st = statSync(resolved)
        if (!st.isDirectory()) {
          console.warn(`[Sandbox] Rejected write_root: not a directory "${p}"`)
          continue
        }
      } catch {
        console.warn(`[Sandbox] Rejected write_root: path does not exist "${p}"`)
        continue
      }
      if (!writeRoots.includes(resolved)) writeRoots.push(resolved)
      validatedWorkspacePaths.push(resolved)
    }
  }

  // read_roots: user profile subdirs (excluding sensitive dirs) + standard Windows dirs
  const readRoots = profileReadRoots(userProfile)
  const standardReadDirs = [
    "C:\\Windows",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
    "C:\\ProgramData"
  ]
  for (const d of standardReadDirs) {
    if (existsSync(d) && !readRoots.includes(d)) readRoots.push(d)
  }

  // Determine if this is initial setup or refresh (workspace ACL update)
  const isRefresh = isElevatedSetupComplete()

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
      writeFileSync(tmpScript, psScript, "utf-8")

      try {
        await execFileWithAbort("powershell", [
          "-NoProfile", "-NonInteractive",
          "-ExecutionPolicy", "Bypass",
          "-File", tmpScript
        ], {
          timeout: 120_000,
          windowsHide: false
        }, abortSignal)
      } finally {
        try { unlinkSync(tmpScript) } catch {}
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

  if (isElevatedSetupComplete()) {
    return { success: true }
  }
  return { success: false, error: "沙箱配置未完成，请重试" }
}

export function isElevatedRootPrepared(dir: string): boolean {
  return elevatedPreparedRoots.has(normalizeDirKey(dir))
}

export function areElevatedRootsPrepared(dirs: string[]): boolean {
  return dirs.every((dir) => isElevatedRootPrepared(dir))
}

/** Mark elevated roots as prepared, and persist to disk. */
export function markElevatedRootsPrepared(dirs: string[]): void {
  let changed = false
  for (const dir of dirs) {
    if (!isSafeElevatedPreparedRoot(dir)) continue
    const key = normalizeDirKey(dir)
    if (!elevatedPreparedRoots.has(key)) {
      elevatedPreparedRoots.add(key)
      changed = true
    }
  }
  if (changed) saveElevatedPreparedRoots()
}

export function isWorkspaceElevatedSetupDone(dir: string): boolean {
  return isElevatedRootPrepared(dir)
}

/** Backwards-compatible alias for workspace-only callers. */
export function markWorkspaceElevatedSetupDone(dir: string): void {
  markElevatedRootsPrepared([dir])
}

export function registerSandboxHandlers(ipcMain: IpcMain): void {
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

  ipcMain.handle("sandbox:checkElevatedSetup", async (): Promise<{ setupComplete: boolean }> => {
    return { setupComplete: isElevatedSetupComplete() }
  })

  ipcMain.handle(
    "sandbox:runElevatedSetup",
    async (_event, workspacePaths?: string[]): Promise<{ success: boolean; error?: string }> => {
      return runElevatedSetupForPaths(workspacePaths)
    }
  )

  // ── NUX (first-run setup) ──

  ipcMain.handle("sandbox:isNuxNeeded", async (): Promise<boolean> => {
    // Only show NUX on Windows, and only if not yet completed (persisted across app restarts)
    return process.platform === "win32" && !isSandboxNuxCompleted()
  })

  ipcMain.handle(
    "sandbox:completeNux",
    async (_event, mode: "elevated" | "unelevated" | "none"): Promise<void> => {
      if (mode === "elevated") {
        if (!isElevatedSetupComplete()) {
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

  const VALID_DECISION_TYPES = new Set(["approve", "approve_session", "approve_permanent", "reject"])

  ipcMain.on("sandbox:approvalDecision", (event, decision: ApprovalDecision & { requestId: string }) => {
    // P2 fix: validate sender is a known BrowserWindow
    const senderWindow = BrowserWindow.getAllWindows().find(w => w.webContents.id === event.sender.id)
    if (!senderWindow) {
      console.warn("[Sandbox] Rejected approval decision from unknown sender, webContentsId:", event.sender.id)
      return
    }

    // Validate decision type
    if (!decision || !decision.requestId || !VALID_DECISION_TYPES.has(decision.type)) {
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

      // P2 fix: validate tool_call_id matches the original request
      // When expected ID exists, decision MUST provide a matching non-empty value
      // (prevents bypass via empty string or omitted field)
      const expectedToolCallId = pending.request.tool_call?.id
      if (expectedToolCallId) {
        if (!decision.tool_call_id || decision.tool_call_id !== expectedToolCallId) {
          console.warn(
            `[Sandbox] Rejected approval decision: tool_call_id mismatch (expected=${expectedToolCallId}, got=${decision.tool_call_id ?? "(missing)"})`
          )
          return
        }
      }
      pendingApprovals.delete(decision.requestId)
      pending.resolve(decision)
    } else {
      console.warn("[Sandbox] Received approval decision for unknown request:", decision.requestId)
    }
  })
}
