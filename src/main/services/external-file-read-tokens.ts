import { randomUUID } from "node:crypto"
import { realpath } from "node:fs/promises"
import path from "node:path"

/**
 * External previews are capabilities, not renderer-minted path tokens.
 *
 * A trusted main-process producer grants access to one directory. The renderer
 * only receives the opaque grant and may request descendants of that directory.
 * Grants are sender-bound, short-lived and bounded in number.
 */
export const EXTERNAL_FILE_READ_GRANT_TTL_MS = 5 * 60 * 1000
export const EXTERNAL_FILE_READ_MAX_GRANTS = 500

interface ExternalFileReadGrantEntry {
  rootPath: string
  allowedRelativePaths: Set<string>
  senderId: number
  scopeKey: string
  createdAt: number
}

const externalFileGrants = new Map<string, ExternalFileReadGrantEntry>()

const SENSITIVE_DENY_PATTERNS = [
  /[/\\]\.ssh(?:[/\\]|$)/i,
  /[/\\]\.aws(?:[/\\]|$)/i,
  /[/\\]\.config[/\\]/i,
  /[/\\]\.gnupg(?:[/\\]|$)/i,
  /[/\\]\.docker[/\\]config\.json$/i,
  /[/\\]\.npmrc$/i,
  /[/\\]\.env(?:\..+)?$/i,
  /[/\\]\.git-credentials$/i,
  /[/\\]\.netrc$/i,
  /[/\\]\.pgpass$/i,
  /[/\\]\.pypirc$/i,
  /[/\\]\.gitconfig$/i,
  /[/\\](?:id_rsa|id_ed25519|id_ecdsa|known_hosts|authorized_keys)$/i,
  /[/\\]\.kube[/\\]config$/i,
  /[/\\]\.vault-token$/i,
  /[/\\](?:\.bash_history|\.zsh_history|\.zhistory|\.mysql_history|\.psql_history)$/i,
  /^[/\\]etc[/\\](?:passwd|shadow|hosts|crontab)$/i,
  /^[/\\]etc[/\\]sudoers/i,
  /[/\\]Library[/\\]Keychains[/\\]/i,
  /[/\\]Library[/\\]Preferences[/\\]/i,
  /[/\\]Library[/\\]Application Support[/\\](?:Google[/\\]Chrome|Firefox[/\\]Profiles|Code)[/\\]/i
]

function pruneExpired(now = Date.now()): void {
  for (const [grant, entry] of externalFileGrants) {
    if (now - entry.createdAt > EXTERNAL_FILE_READ_GRANT_TTL_MS) {
      externalFileGrants.delete(grant)
    }
  }
}

const cleanupTimer = setInterval(pruneExpired, 2 * 60 * 1000)
cleanupTimer.unref()

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function isProtectedPath(filePath: string): boolean {
  return SENSITIVE_DENY_PATTERNS.some((pattern) => pattern.test(filePath))
}

function normalizeRelativePathKey(relativePath: string): string {
  const normalized = relativePath.split(path.sep).join("/")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function buildAllowedRelativePaths(
  rootPath: string,
  trustedRelativePaths: readonly string[]
): Set<string> | null {
  if (trustedRelativePaths.length === 0 || trustedRelativePaths.length > 2_000) return null
  const allowed = new Set<string>()
  for (const rawPath of trustedRelativePaths) {
    if (typeof rawPath !== "string" || !rawPath || rawPath.length > 32_768) return null
    const candidate = path.resolve(rootPath, rawPath.replace(/^[/\\]+/, ""))
    if (!isPathInside(rootPath, candidate) || isProtectedPath(candidate)) return null
    allowed.add(normalizeRelativePathKey(path.relative(rootPath, candidate)))
  }
  return allowed.size > 0 ? allowed : null
}

/** Main-process-only issuer. Never expose a path-to-grant IPC channel. */
export function issueExternalFileReadGrant(
  trustedRootPath: string,
  senderId: number,
  trustedRelativePaths: readonly string[],
  scopeKey: string
): { grant: string } | { error: string } {
  if (
    typeof trustedRootPath !== "string" ||
    !trustedRootPath ||
    trustedRootPath.length > 32_768 ||
    !Number.isSafeInteger(senderId) ||
    !path.isAbsolute(trustedRootPath) ||
    typeof scopeKey !== "string" ||
    !scopeKey ||
    scopeKey.length > 256
  ) {
    return { error: "Invalid external preview root" }
  }

  const rootPath = path.resolve(trustedRootPath)
  if (!path.isAbsolute(rootPath) || isProtectedPath(rootPath)) {
    return { error: "Access denied: path is protected" }
  }
  const allowedRelativePaths = buildAllowedRelativePaths(rootPath, trustedRelativePaths)
  if (!allowedRelativePaths) return { error: "Invalid external preview allowlist" }

  pruneExpired()
  // Reuse a live capability for repeated refreshes of the same trusted source.
  // This prevents an open panel from exhausting the bounded registry.
  for (const [grant, entry] of externalFileGrants) {
    if (
      entry.senderId === senderId &&
      entry.rootPath === rootPath &&
      entry.scopeKey === scopeKey
    ) {
      entry.allowedRelativePaths = allowedRelativePaths
      entry.createdAt = Date.now()
      return { grant }
    }
  }
  if (externalFileGrants.size >= EXTERNAL_FILE_READ_MAX_GRANTS) {
    return { error: "Too many pending external preview grants, please try again later" }
  }

  const grant = randomUUID()
  externalFileGrants.set(grant, {
    rootPath,
    allowedRelativePaths,
    senderId,
    scopeKey,
    createdAt: Date.now()
  })
  return { grant }
}

/**
 * Resolve a renderer-provided descendant through a trusted directory grant.
 * Both lexical and real paths are checked so `..` and symlink escapes fail.
 */
export async function resolveExternalFileReadGrant(
  grant: unknown,
  senderId: number,
  requestedPath: unknown
): Promise<{ filePath: string; rootPath: string } | { error: string }> {
  if (!grant || typeof grant !== "string") return { error: "Missing or invalid grant" }
  if (
    typeof requestedPath !== "string" ||
    !requestedPath ||
    requestedPath.length > 32_768
  ) {
    return { error: "Missing or invalid external preview path" }
  }

  const entry = externalFileGrants.get(grant)
  if (!entry) return { error: "Invalid or expired grant" }
  if (entry.senderId !== senderId) return { error: "Sender mismatch" }
  if (Date.now() - entry.createdAt > EXTERNAL_FILE_READ_GRANT_TTL_MS) {
    externalFileGrants.delete(grant)
    return { error: "Grant expired" }
  }

  const candidate = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(entry.rootPath, requestedPath)
  if (!isPathInside(entry.rootPath, candidate) || isProtectedPath(candidate)) {
    return { error: "Access denied: path outside trusted preview root" }
  }
  const relativePathKey = normalizeRelativePathKey(path.relative(entry.rootPath, candidate))
  if (!entry.allowedRelativePaths.has(relativePathKey)) {
    return { error: "Access denied: file was not issued by the trusted preview source" }
  }

  try {
    const [realRoot, realCandidate] = await Promise.all([
      realpath(entry.rootPath),
      realpath(candidate)
    ])
    if (!isPathInside(realRoot, realCandidate) || isProtectedPath(realCandidate)) {
      return { error: "Access denied: symlink target outside trusted preview root" }
    }
    return { filePath: realCandidate, rootPath: realRoot }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "External preview path is unavailable"
    }
  }
}

export function revokeExternalFileReadGrantsForOwner(senderId: number): number {
  let removed = 0
  for (const [grant, entry] of externalFileGrants) {
    if (entry.senderId !== senderId) continue
    externalFileGrants.delete(grant)
    removed += 1
  }
  return removed
}

export function externalFileReadGrantCountForTests(): number {
  return externalFileGrants.size
}
