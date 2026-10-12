/** Shared native Windows sandbox state and path validation. No Electron dependency. */
import fs from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
export const CODEX_HOME = join(homedir(), ".codex")
const SETUP_MARKER_PATH = join(CODEX_HOME, ".sandbox", "setup_marker.json")
const SANDBOX_USERS_PATH = join(CODEX_HOME, ".sandbox-secrets", "sandbox_users.json")
const ELEVATED_WORKSPACES_PATH = join(CODEX_HOME, ".sandbox", "elevated_workspaces.json")
export const SETUP_VERSION = 5
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

/** Persistent + session cache of elevated sandbox roots already prepared for ACL use. */
const elevatedPreparedRoots = new Set<string>()

/** Normalize a directory path for consistent cache lookups (lowercase, no trailing slash, backslashes). */
export function normalizeDirKey(dir: string): string {
  return resolve(dir).replace(/\/+/g, "\\").replace(/\\+$/, "").toLowerCase()
}

const ELEVATED_SYSTEM_SENSITIVE_ROOTS = [
  "c:\\windows",
  "c:\\program files",
  "c:\\program files (x86)",
  "c:\\programdata",
  "c:\\users\\all users",
  "c:\\users\\default",
  "c:\\users\\public"
]

/** Sensitive directories under user profile that should NOT be readable by the sandbox user. */
export const USERPROFILE_READ_ROOT_EXCLUSIONS = [
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

export type ElevatedWorkspaceRootValidationReason =
  | "empty-path"
  | "unc-path"
  | "drive-root"
  | "system-sensitive-path"
  | "user-sensitive-path"
  | "not-directory"
  | "not-found"

export interface ElevatedWorkspaceRootValidation {
  ok: boolean
  resolved?: string
  reason?: ElevatedWorkspaceRootValidationReason
  error?: string
}

export function getElevatedSystemSensitivePathError(dir: string): string | null {
  if (!dir || typeof dir !== "string") return null
  let key: string
  try {
    key = normalizeDirKey(dir)
  } catch {
    return null
  }

  const blockedRoot = ELEVATED_SYSTEM_SENSITIVE_ROOTS.find((root) => key === root || key.startsWith(`${root}\\`))
  if (!blockedRoot) return null
  return `Elevated 模式可以读取系统目录，也可能执行不涉及写入的命令；但当前模式需要为工作区准备写入权限，不支持将系统敏感目录作为工作区：${dir}。请选择普通项目目录作为工作区；如只需读取或执行非写入命令，请切换到 readonly/unelevated/none 后重试。`
}

export async function validateElevatedWorkspaceRoot(workspacePath: string): Promise<ElevatedWorkspaceRootValidation> {
  if (!workspacePath || typeof workspacePath !== "string" || !workspacePath.trim()) {
    return { ok: false, reason: "empty-path", error: "Elevated 工作区路径不能为空。" }
  }

  let resolved: string
  try {
    resolved = resolve(workspacePath)
  } catch (err) {
    return {
      ok: false,
      reason: "not-found",
      error: `Elevated 工作区路径无效：${err instanceof Error ? err.message : String(err)}`
    }
  }

  const normalized = resolved.replace(/\\/g, "/").toLowerCase()
  if (/^[\\/]{2}/.test(workspacePath) || /^[\\/]{2}/.test(resolved)) {
    return {
      ok: false,
      resolved,
      reason: "unc-path",
      error: `Elevated 模式不支持将 UNC 网络路径作为工作区：${workspacePath}。请选择本地普通项目目录。`
    }
  }

  if (/^[a-z]:\/?\s*$/.test(normalized)) {
    return {
      ok: false,
      resolved,
      reason: "drive-root",
      error: `Elevated 模式不支持将盘符根目录作为工作区：${workspacePath}。请选择普通项目目录。`
    }
  }

  const sensitivePathError = getElevatedSystemSensitivePathError(resolved)
  if (sensitivePathError) {
    return { ok: false, resolved, reason: "system-sensitive-path", error: sensitivePathError }
  }

  const userProfile = process.env.USERPROFILE || homedir()
  const homeNorm = userProfile.replace(/\\/g, "/").toLowerCase()
  if (normalized.startsWith(homeNorm + "/")) {
    const relative = normalized.slice(homeNorm.length + 1).split("/")[0]
    if (USERPROFILE_READ_ROOT_EXCLUSIONS.some((entry) => entry.toLowerCase() === relative)) {
      return {
        ok: false,
        resolved,
        reason: "user-sensitive-path",
        error: `Elevated 模式不支持将用户敏感目录作为工作区：${workspacePath}。请选择普通项目目录。`
      }
    }
  }

  try {
    const stat = await fs.stat(resolved)
    if (!stat.isDirectory()) {
      return {
        ok: false,
        resolved,
        reason: "not-directory",
        error: `Elevated 工作区路径不是目录：${workspacePath}`
      }
    }
  } catch {
    return {
      ok: false,
      resolved,
      reason: "not-found",
      error: `Elevated 工作区路径不存在：${workspacePath}`
    }
  }

  return { ok: true, resolved }
}

function isPotentiallySafeElevatedPreparedRoot(dir: string): boolean {
  if (!dir || typeof dir !== "string") return false
  if (/^[\\/]{2}/.test(dir)) return false

  let key: string
  try {
    key = normalizeDirKey(dir)
  } catch {
    return false
  }

  if (/^[a-z]:$/i.test(key)) return false
  if (getElevatedSystemSensitivePathError(dir)) return false
  return true
}

async function isSafeElevatedPreparedRoot(dir: string): Promise<boolean> {
  if (!isPotentiallySafeElevatedPreparedRoot(dir)) return false
  try {
    return (await fs.stat(resolve(dir))).isDirectory()
  } catch {
    return false
  }
}

/** Load previously configured workspace paths from disk into the in-memory set. */
async function loadElevatedPreparedRoots(): Promise<void> {
  try {
    const data = JSON.parse(await fs.readFile(ELEVATED_WORKSPACES_PATH, "utf-8"))
    const version = typeof data.version === "number" ? data.version : SETUP_VERSION
    if (version !== SETUP_VERSION) return
    const rawRoots: unknown[] = Array.isArray(data.roots)
      ? data.roots
      : Array.isArray(data.paths)
        ? data.paths
        : []
    let changed = false
    const roots = rawRoots.filter((p): p is string => typeof p === "string")
    const validatedRoots = await mapLimit(roots, 8, async (root) => ({
      root,
      safe: await isSafeElevatedPreparedRoot(root)
    }))
    for (const { root, safe } of validatedRoots) {
      if (!safe) {
        changed = true
        continue
      }
      elevatedPreparedRoots.add(normalizeDirKey(root))
    }
    if (changed) saveElevatedPreparedRoots()
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.warn("[Sandbox] Failed to load elevated prepared roots:", err)
    }
  }
}

let elevatedPreparedRootsSavePromise = Promise.resolve()

/** Persist the current set of configured workspace paths to disk. */
function saveElevatedPreparedRoots(): void {
  elevatedPreparedRootsSavePromise = elevatedPreparedRootsSavePromise
    .catch(() => { /* previous failure already logged */ })
    .then(async () => {
      await elevatedPreparedRootsLoadPromise
      const snapshot = JSON.stringify({ version: SETUP_VERSION, roots: [...elevatedPreparedRoots] }, null, 2)
      const sbxDir = join(CODEX_HOME, ".sandbox")
      await fs.mkdir(sbxDir, { recursive: true })
      await fs.writeFile(ELEVATED_WORKSPACES_PATH, snapshot)
    })
  void elevatedPreparedRootsSavePromise.catch((err) => {
    console.warn("[Sandbox] Failed to persist elevated prepared roots:", err)
  })
}

// Load persisted roots immediately so they survive app restarts
const elevatedPreparedRootsLoadPromise = loadElevatedPreparedRoots()

/** Check whether the elevated sandbox setup has been completed (marker exists with correct version). */
export async function isElevatedSetupComplete(): Promise<boolean> {
  try {
    const [markerRaw, usersRaw] = await Promise.all([
      fs.readFile(SETUP_MARKER_PATH, "utf-8"),
      fs.readFile(SANDBOX_USERS_PATH, "utf-8")
    ])
    const marker = JSON.parse(markerRaw)
    const users = JSON.parse(usersRaw)
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

export function isElevatedRootPrepared(dir: string): boolean {
  return elevatedPreparedRoots.has(normalizeDirKey(dir))
}

export function areElevatedRootsPrepared(dirs: string[]): boolean {
  return dirs.every((dir) => isElevatedRootPrepared(dir))
}

export async function areElevatedRootsPreparedAsync(dirs: string[]): Promise<boolean> {
  await elevatedPreparedRootsLoadPromise
  return areElevatedRootsPrepared(dirs)
}

/** Mark elevated roots as prepared, and persist to disk. */
export function markElevatedRootsPrepared(dirs: string[]): void {
  let changed = false
  for (const dir of dirs) {
    if (!isPotentiallySafeElevatedPreparedRoot(dir)) continue
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
