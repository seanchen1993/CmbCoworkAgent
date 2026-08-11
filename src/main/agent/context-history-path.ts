import { realpath, rm } from "fs/promises"
import { homedir } from "os"
import { join, resolve } from "path"

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

export async function getProjectThreadDataDirectory(
  workspacePath: string,
  threadId: string,
  userHome = homedir()
): Promise<string> {
  if (!threadId.trim()) {
    throw new Error("Thread ID is required to resolve app-managed thread data.")
  }
  const canonicalWorkspacePath = await canonicalizeWorkspacePath(workspacePath)
  return join(
    userHome,
    ".cmbcoworkagent",
    "projects",
    sanitizeHistoryPathComponent(canonicalWorkspacePath),
    sanitizeHistoryPathComponent(threadId)
  )
}

export async function deleteProjectThreadDataDirectory(
  workspacePath: string,
  threadId: string,
  userHome = homedir()
): Promise<void> {
  const threadDataDirectory = await getProjectThreadDataDirectory(workspacePath, threadId, userHome)
  await rm(threadDataDirectory, { recursive: true, force: true })
}

export async function getConversationHistoryDirectory(
  workspacePath: string,
  threadId: string,
  userHome = homedir()
): Promise<string> {
  return join(
    await getProjectThreadDataDirectory(workspacePath, threadId, userHome),
    "conversation_history"
  )
}
