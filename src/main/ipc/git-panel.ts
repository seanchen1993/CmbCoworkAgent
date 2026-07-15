import type { IpcMain } from "electron"
import { randomUUID } from "crypto"
import { execFile } from "child_process"
import { mkdir, readFile, rename, writeFile, rm } from "fs/promises"
import * as path from "path"
import { promisify } from "util"
import { getThread } from "../db"
import { getOpenworkDir } from "../storage"
import type { GitCommitHistoryRecord } from "../../shared/git-commit-history"

const execFileAsync = promisify(execFile)
const GIT_COMMIT_HISTORY_LIMIT_PER_PROJECT = 80
const MAX_COMMIT_HISTORY_TEXT_CHARS = 4000
const GIT_PANEL_HISTORY_FILE_NAME = "git-panel-commit-history.json"

type GitCommitHistoryByProject = Record<string, GitCommitHistoryRecord[]>

interface GitCommitHistoryInput {
  workspacePath: string
  branch?: string | null
  commitSha?: string
  fullMessage: string
}

let historyMutationQueue: Promise<void> = Promise.resolve()

function enqueueHistoryMutation<T>(task: () => Promise<T>): Promise<T> {
  const next = historyMutationQueue.then(task, task)
  historyMutationQueue = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

function getHistoryFilePath(): string {
  return path.join(getOpenworkDir(), GIT_PANEL_HISTORY_FILE_NAME)
}

function trimCommitHistoryText(value: unknown, maxChars = MAX_COMMIT_HISTORY_TEXT_CHARS): string {
  if (typeof value !== "string") return ""
  const trimmed = value.trim()
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed
}

function normalizeCommitHistoryProjectKey(projectPath: string): string {
  const resolved = path.resolve(projectPath)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

async function getGitRoot(workspacePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", workspacePath, "rev-parse", "--show-toplevel"],
      {
        encoding: "utf-8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024
      }
    )
    return String(stdout || "").trim() || null
  } catch {
    return null
  }
}

async function getOptionalGitOutput(workspacePath: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", workspacePath, ...args], {
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    })
    return String(stdout || "").trim() || null
  } catch {
    return null
  }
}

async function getCommitHistoryProjectPath(workspacePath: string): Promise<string> {
  const gitRoot = await getGitRoot(workspacePath)
  return path.resolve(gitRoot || workspacePath)
}

function sanitizeCommitHistoryRecord(record: unknown): GitCommitHistoryRecord | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null
  const raw = record as Record<string, unknown>
  const commitMessage = trimCommitHistoryText(raw.commitMessage)
  const fullMessage = trimCommitHistoryText(raw.fullMessage)
  if (!commitMessage && !fullMessage) return null

  const projectPath = trimCommitHistoryText(raw.projectPath, 1000)
  const committedAt = trimCommitHistoryText(raw.committedAt, 100)
  const parsedTime = Date.parse(committedAt)

  return {
    id: trimCommitHistoryText(raw.id, 120) || randomUUID(),
    projectPath,
    branch: trimCommitHistoryText(raw.branch, 200) || null,
    commitSha: trimCommitHistoryText(raw.commitSha, 80) || undefined,
    committedAt: Number.isFinite(parsedTime) ? committedAt : new Date().toISOString(),
    cardNumber: trimCommitHistoryText(raw.cardNumber, 200),
    commitType: trimCommitHistoryText(raw.commitType, 80),
    commitMessage,
    fullMessage
  }
}

async function readGitCommitHistoryByProject(): Promise<GitCommitHistoryByProject> {
  try {
    const raw = await readFile(getHistoryFilePath(), "utf-8")
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}

    const result: GitCommitHistoryByProject = {}
    for (const [projectKey, records] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(records)) continue
      const sanitized = records
        .map(sanitizeCommitHistoryRecord)
        .filter((record): record is GitCommitHistoryRecord => Boolean(record))
        .sort((a, b) => Date.parse(b.committedAt) - Date.parse(a.committedAt))
        .slice(0, GIT_COMMIT_HISTORY_LIMIT_PER_PROJECT)
      if (sanitized.length > 0) {
        result[projectKey] = sanitized
      }
    }
    return result
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {}
    console.warn("[GitPanel] failed to read commit history:", error)
    return {}
  }
}

async function writeGitCommitHistoryByProject(history: GitCommitHistoryByProject): Promise<void> {
  const filePath = getHistoryFilePath()
  await mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tempPath, JSON.stringify(history, null, 2), "utf-8")
    await rename(tempPath, filePath)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

function parseGitPanelCommitMessage(fullMessage: string): {
  cardNumber: string
  commitType: string
  commitMessage: string
} | null {
  const match = fullMessage.match(/^(.+?)\s+#comment\s+([a-zA-Z][\w-]*):([\s\S]*?)\s+#CMBDevClaw\s*$/)
  if (!match) return null
  return {
    cardNumber: match[1].trim(),
    commitType: match[2].trim(),
    commitMessage: match[3].trim()
  }
}

async function getGitCommitHistoryForWorkspace(workspacePath: string): Promise<{
  projectPath: string
  records: GitCommitHistoryRecord[]
}> {
  await historyMutationQueue.catch(() => {})
  const projectPath = await getCommitHistoryProjectPath(workspacePath)
  const projectKey = normalizeCommitHistoryProjectKey(projectPath)
  const history = await readGitCommitHistoryByProject()
  return {
    projectPath,
    records: (history[projectKey] || [])
      .slice()
      .sort((a, b) => Date.parse(b.committedAt) - Date.parse(a.committedAt))
  }
}

function getThreadWorkspacePath(threadId: string): string | null {
  const thread = getThread(threadId)
  let metadata: Record<string, unknown> = {}
  try {
    metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
  } catch {
    metadata = {}
  }
  return typeof metadata.workspacePath === "string" ? metadata.workspacePath : null
}

function recordGitCommitHistoryAsync(
  params: GitCommitHistoryInput
): Promise<GitCommitHistoryRecord | null> {
  return enqueueHistoryMutation(async () => {
    const parsed = parseGitPanelCommitMessage(params.fullMessage)
    const cardNumber = trimCommitHistoryText(parsed?.cardNumber, 200)
    const commitType = trimCommitHistoryText(parsed?.commitType, 80)
    const commitMessage = trimCommitHistoryText(parsed?.commitMessage, MAX_COMMIT_HISTORY_TEXT_CHARS)
    const fullMessage = trimCommitHistoryText(params.fullMessage)

    if (!cardNumber || !commitType || !commitMessage || !fullMessage) {
      return null
    }

    const projectPath = await getCommitHistoryProjectPath(params.workspacePath)
    const projectKey = normalizeCommitHistoryProjectKey(projectPath)
    const history = await readGitCommitHistoryByProject()
    const record: GitCommitHistoryRecord = {
      id: randomUUID(),
      projectPath,
      branch: params.branch || null,
      commitSha: params.commitSha,
      committedAt: new Date().toISOString(),
      cardNumber,
      commitType,
      commitMessage,
      fullMessage
    }

    const existing = history[projectKey] || []
    history[projectKey] = [
      record,
      ...existing.filter((item) => {
        if (params.commitSha && item.commitSha === params.commitSha) return false
        return item.fullMessage !== record.fullMessage || item.cardNumber !== record.cardNumber
      })
    ].slice(0, GIT_COMMIT_HISTORY_LIMIT_PER_PROJECT)
    await writeGitCommitHistoryByProject(history)
    return record
  })
}

export function registerGitPanelHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    "git-panel:getCommitHistory",
    async (_event, { threadId }: { threadId: string }) => {
      try {
        const workspacePath = getThreadWorkspacePath(threadId)
        if (!workspacePath) {
          return {
            success: false,
            projectPath: null,
            records: [],
            error: "未关联工作区"
          }
        }
        const { projectPath, records } = await getGitCommitHistoryForWorkspace(workspacePath)
        return {
          success: true,
          projectPath,
          records
        }
      } catch (e) {
        return {
          success: false,
          projectPath: null,
          records: [],
          error: e instanceof Error ? e.message : "读取 commit 历史失败"
        }
      }
    }
  )

  ipcMain.handle(
    "git-panel:recordCommitHistory",
    async (_event, { threadId, fullMessage }: { threadId: string; fullMessage: string }) => {
      try {
        const workspacePath = getThreadWorkspacePath(threadId)
        if (!workspacePath) {
          return {
            success: false,
            record: null,
            error: "未关联工作区"
          }
        }

        const [branch, commitSha] = await Promise.all([
          getOptionalGitOutput(workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"]),
          getOptionalGitOutput(workspacePath, ["rev-parse", "HEAD"])
        ])
        const record = await recordGitCommitHistoryAsync({
          workspacePath,
          branch,
          commitSha: commitSha || undefined,
          fullMessage
        })

        return {
          success: true,
          record
        }
      } catch (e) {
        return {
          success: false,
          record: null,
          error: e instanceof Error ? e.message : "记录 commit 历史失败"
        }
      }
    }
  )
}
