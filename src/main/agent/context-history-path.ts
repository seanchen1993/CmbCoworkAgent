import { realpathSync } from "fs"
import { realpath, rm } from "fs/promises"
import { join, resolve } from "path"
import { getCmbCoworkAgentDataRoot } from "../app-data-root"

// Match Claude Code's project-directory naming: preserve the readable absolute
// path for normal projects, and only add a stable suffix when a single path
// component would otherwise approach common filesystem limits.
const MAX_SANITIZED_PATH_LENGTH = 200

function djb2Hash(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0
  }
  return hash
}

export function sanitizeHistoryPathComponent(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9]/g, "-")
  if (sanitized.length <= MAX_SANITIZED_PATH_LENGTH) return sanitized
  const suffix = Math.abs(djb2Hash(value)).toString(36)
  return `${sanitized.slice(0, MAX_SANITIZED_PATH_LENGTH)}-${suffix}`
}

export async function canonicalizeWorkspacePath(workspacePath: string): Promise<string> {
  try {
    return (await realpath(workspacePath)).normalize("NFC")
  } catch {
    return resolve(workspacePath).normalize("NFC")
  }
}

/** Synchronous twin used by stores whose public API is intentionally synchronous. */
export function canonicalizeWorkspacePathSync(workspacePath: string): string {
  try {
    return realpathSync(workspacePath).normalize("NFC")
  } catch {
    return resolve(workspacePath).normalize("NFC")
  }
}

/**
 * Resolve one app-managed project/thread directory from an already-resolved
 * CmbCowork data root (normally `~/.cmbcoworkagent`). Keeping this small sync
 * helper beside the async history resolver prevents workflow persistence from
 * inventing a second project-key scheme.
 */
export function getProjectThreadDataDirectorySync(
  workspacePath: string,
  threadId: string,
  appDataRoot = getCmbCoworkAgentDataRoot()
): string {
  if (!threadId.trim()) {
    throw new Error("Thread ID is required to resolve app-managed thread data.")
  }
  const canonicalWorkspacePath = canonicalizeWorkspacePathSync(workspacePath)
  return join(
    appDataRoot,
    "projects",
    sanitizeHistoryPathComponent(canonicalWorkspacePath),
    sanitizeHistoryPathComponent(threadId)
  )
}

export async function getProjectThreadDataDirectory(
  workspacePath: string,
  threadId: string,
  userHome?: string
): Promise<string> {
  if (!threadId.trim()) {
    throw new Error("Thread ID is required to resolve app-managed thread data.")
  }
  const canonicalWorkspacePath = await canonicalizeWorkspacePath(workspacePath)
  const appDataRoot =
    userHome === undefined ? getCmbCoworkAgentDataRoot() : join(userHome, ".cmbcoworkagent")
  return join(
    appDataRoot,
    "projects",
    sanitizeHistoryPathComponent(canonicalWorkspacePath),
    sanitizeHistoryPathComponent(threadId)
  )
}

export async function deleteProjectThreadDataDirectory(
  workspacePath: string,
  threadId: string,
  userHome?: string
): Promise<void> {
  const threadDataDirectory = await getProjectThreadDataDirectory(workspacePath, threadId, userHome)
  await rm(threadDataDirectory, { recursive: true, force: true })
}

export async function getConversationHistoryDirectory(
  workspacePath: string,
  threadId: string,
  userHome?: string
): Promise<string> {
  return join(
    await getProjectThreadDataDirectory(workspacePath, threadId, userHome),
    "conversation_history"
  )
}
