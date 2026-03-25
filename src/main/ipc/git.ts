import { ipcMain } from "electron"
import { execSync } from "child_process"
import { platform } from "os"
import { readdirSync, rmSync } from "fs"
import path from "path"

interface GitStatus {
  hasChanges: boolean
  changedFiles: string[]
  untrackedFiles: string[]
  stagedFiles: string[]
}

interface ExecCommandError extends Error {
  stderr?: unknown
  stdout?: unknown
  code?: string
  signal?: string
}

function isPushCommand(command: string): boolean {
  return /^git(\s+-C\s+"[^"]*")?\s+push(\s|$)/.test(command.trim())
}

function isPullLikeCommand(command: string): boolean {
  return /^git(\s+-C\s+"[^"]*")?\s+(pull|fetch)(\s|$)/.test(command.trim())
}

function getGitCommandTimeout(command: string): number {
  if (isPushCommand(command)) {
    return 3 * 60 * 1000
  }

  if (isPullLikeCommand(command)) {
    return 2 * 60 * 1000
  }

  return 30 * 1000
}

function getCommandWorkingDir(command: string, fallbackCwd: string): string {
  const match = command.match(/git\s+-C\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/i)
  const parsedDir = match?.[1] || match?.[2] || match?.[3]
  if (parsedDir) {
    return parsedDir
  }

  return fallbackCwd
}

function normalizeGitDirPath(rawGitDir: string, workingDir: string): string {
  const trimmed = rawGitDir.trim().replace(/^"(.*)"$/, "$1")

  if (platform() === "win32") {
    const posixDriveMatch = trimmed.match(/^\/([a-zA-Z])\/(.*)$/)
    if (posixDriveMatch) {
      const windowsPath = `${posixDriveMatch[1].toUpperCase()}:\\${posixDriveMatch[2].replace(/\//g, "\\")}`
      return path.resolve(windowsPath)
    }
  }

  return path.isAbsolute(trimmed) ? trimmed : path.resolve(workingDir, trimmed)
}

function resolveGitDir(command: string, fallbackCwd: string): string | null {
  const workingDir = getCommandWorkingDir(command, fallbackCwd)

  try {
    const gitDir = execSync(`git -C "${workingDir}" rev-parse --git-dir`, {
      encoding: "utf-8",
      cwd: workingDir,
      shell: platform() === "win32" ? "cmd.exe" : "/bin/bash"
    }).trim()

    return normalizeGitDirPath(gitDir, workingDir)
  } catch {
    return null
  }
}

function collectGitLockFiles(gitDir: string): string[] {
  const stack = [gitDir]
  const lockFiles: string[] = []

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) {
      continue
    }

    let entries: Array<{
      isDirectory: () => boolean
      isFile: () => boolean
      name: string
    }>
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
        continue
      }

      if (entry.isFile() && entry.name.toLowerCase().endsWith(".lock")) {
        lockFiles.push(fullPath)
      }
    }
  }

  return lockFiles
}

function cleanupGitLockFiles(command: string, fallbackCwd: string): string[] {
  const gitDir = resolveGitDir(command, fallbackCwd)
  if (!gitDir) {
    return []
  }

  const lockFiles = collectGitLockFiles(gitDir)
  const removed: string[] = []

  for (const lockFile of lockFiles) {
    try {
      rmSync(lockFile, { force: true })
      removed.push(lockFile)
    } catch {
      // Ignore single file cleanup errors and continue
    }
  }

  return removed
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()
  const withCode = error as Error & { code?: string; signal?: string }
  return (
    withCode.code === "ETIMEDOUT" ||
    withCode.signal === "SIGTERM" ||
    message.includes("timed out") ||
    message.includes("timeout")
  )
}

function isLockFileErrorText(text: string): boolean {
  const normalized = text.toLowerCase()
  return (
    normalized.includes(".lock") &&
    (normalized.includes("file exists") ||
      normalized.includes("unable to create") ||
      normalized.includes("another git process"))
  )
}

// Check Git version and capabilities
function checkGitVersion(): { version: string; supportsLFS: boolean } {
  try {
    const versionOutput = execSync("git --version", {
      encoding: "utf-8",
      shell: platform() === 'win32' ? 'cmd.exe' : '/bin/bash'
    }).trim()

    const versionMatch = versionOutput.match(/git version (\d+\.\d+\.\d+)/)
    const version = versionMatch ? versionMatch[1] : "unknown"

    // Check if version is >= 1.8.2 for LFS support
    const [major, minor, patch] = version.split('.').map(Number)
    const supportsLFS = major > 1 || (major === 1 && minor > 8) || (major === 1 && minor === 8 && patch >= 2)

    return { version, supportsLFS }
  } catch (error) {
    console.warn("Failed to check Git version:", error)
    return { version: "unknown", supportsLFS: false }
  }
}

// 获取当前工作目录
function getCurrentWorkingDirectory(): string {
  try {
    // 尝试获取Git仓库根目录
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      cwd: process.cwd(),
      shell: platform() === 'win32' ? 'cmd.exe' : '/bin/bash'
    }).trim()
    return gitRoot
  } catch {
    // 如果不是Git仓库，返回当前工作目录
    return process.cwd()
  }
}

// 执行Git命令
function executeGitCommand(command: string, cwd?: string): string {
  try {
    const workingDir = cwd || getCurrentWorkingDirectory()
    const timeout = getGitCommandTimeout(command)
    const result = execSync(command, {
      encoding: "utf-8",
      cwd: workingDir,
      timeout,
      shell: platform() === 'win32' ? 'cmd.exe' : '/bin/bash',
      env: {
        ...process.env,
        // Disable Git LFS for operations that don't need it
        GIT_LFS_SKIP_SMUDGE: "1"
      }
    })
    return result.trim()
  } catch (rawError: unknown) {
    const error = rawError as ExecCommandError
    // Enhanced error handling for common Windows Git issues
    let errorMessage = error.message
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : String(error.stderr || "").trim()
    const timeoutError = isTimeoutError(error)
    const lockError = isLockFileErrorText(`${stderr}\n${error.message || ""}`)
    const originalCommand = command
    const workingDir = cwd || getCurrentWorkingDirectory()

    if (stderr) {
      // Handle Git LFS version errors
      if (stderr.includes("git version >= 1.8.2 is required for Git LFS")) {
        const gitInfo = checkGitVersion()
        errorMessage = `Git LFS error: Current Git version ${gitInfo.version} may not support LFS. Consider updating Git or disabling LFS for this operation.`
      }
      // Handle push ref errors
      else if (stderr.includes("failed to push some refs")) {
        errorMessage = `Push failed: ${stderr}. Try pulling the latest changes first with 'git pull' before pushing.`
      }
      // Handle Windows path issues
      else if (stderr.includes("does not appear to be a git repository")) {
        errorMessage = `Repository error: ${stderr}. Ensure you're in a valid Git repository directory.`
      }
      else {
        errorMessage = stderr
      }
    } else if (error.stdout) {
      return String(error.stdout).trim()
    }

    if (timeoutError || lockError) {
      const removedLocks = cleanupGitLockFiles(originalCommand, workingDir)
      if (removedLocks.length > 0) {
        console.warn("[Git] cleaned stale lock files:", removedLocks)
      }

      if (lockError) {
        try {
          const timeout = getGitCommandTimeout(originalCommand)
          const retryResult = execSync(originalCommand, {
            encoding: "utf-8",
            cwd: workingDir,
            timeout,
            shell: platform() === "win32" ? "cmd.exe" : "/bin/bash",
            env: {
              ...process.env,
              GIT_LFS_SKIP_SMUDGE: "1"
            }
          })
          return retryResult.trim()
        } catch (retryRawError: unknown) {
          const retryError = retryRawError as ExecCommandError
          const retryStderr =
            typeof retryError.stderr === "string"
              ? retryError.stderr.trim()
              : String(retryError.stderr || "").trim()
          const retryMsg =
            retryStderr || retryError.message || "Git command retry failed after lock cleanup"
          throw new Error(retryMsg)
        }
      }

      if (timeoutError && removedLocks.length > 0) {
        errorMessage = `${errorMessage}\n命令超时后已自动清理 ${removedLocks.length} 个 Git 锁文件，请重试。`
      }
    }

    throw new Error(errorMessage)
  }
}

// 获取Git状态
function getGitStatus(): GitStatus {
  try {
    // 检查是否在Git仓库中
    try {
      executeGitCommand("git rev-parse --git-dir")
    } catch {
      return {
        hasChanges: false,
        changedFiles: [],
        untrackedFiles: [],
        stagedFiles: []
      }
    }

    const status: GitStatus = {
      hasChanges: false,
      changedFiles: [],
      untrackedFiles: [],
      stagedFiles: []
    }

    // 获取修改的文件
    try {
      const modifiedFiles = executeGitCommand("git diff --name-only")
      if (modifiedFiles) {
        status.changedFiles = modifiedFiles.split("\n").filter(f => f.trim())
      }
    } catch {
      // 忽略错误，可能没有修改的文件
    }

    // 获取未跟踪的文件
    try {
      const untrackedFiles = executeGitCommand("git ls-files --others --exclude-standard")
      if (untrackedFiles) {
        status.untrackedFiles = untrackedFiles.split("\n").filter(f => f.trim())
      }
    } catch {
      // 忽略错误
    }

    // 获取暂存的文件
    try {
      const stagedFiles = executeGitCommand("git diff --cached --name-only")
      if (stagedFiles) {
        status.stagedFiles = stagedFiles.split("\n").filter(f => f.trim())
      }
    } catch {
      // 忽略错误
    }

    // 检查是否有任何变更
    status.hasChanges =
      status.changedFiles.length > 0 ||
      status.untrackedFiles.length > 0 ||
      status.stagedFiles.length > 0

    return status
  } catch (error) {
    console.error("获取Git状态失败:", error)
    return {
      hasChanges: false,
      changedFiles: [],
      untrackedFiles: [],
      stagedFiles: []
    }
  }
}

// 注册Git相关的IPC处理器
export function registerGitHandlers(): void {
  // 获取Git状态
  ipcMain.handle("git-status", async (): Promise<GitStatus> => {
    try {
      return getGitStatus()
    } catch (error) {
      console.error("[IPC] git-status error:", error)
      throw error
    }
  })

  // 执行Git命令
  ipcMain.handle("execute-git-command", async (_, command: string): Promise<string> => {
    try {
      console.log("[IPC] 执行Git命令:", command)

      // 安全检查 - 只允许特定的Git命令
      const allowedCommands = [
        /^git(\s+-C\s+"[^"]*")?\s+add/,
        /^git(\s+-C\s+"[^"]*")?\s+commit/,
        /^git(\s+-C\s+"[^"]*")?\s+push/,
        /^git(\s+-C\s+"[^"]*")?\s+pull/,
        /^git(\s+-C\s+"[^"]*")?\s+status/,
        /^git(\s+-C\s+"[^"]*")?\s+diff/,
        /^git(\s+-C\s+"[^"]*")?\s+log/,
        /^git(\s+-C\s+"[^"]*")?\s+branch/,
        /^git(\s+-C\s+"[^"]*")?\s+checkout/,
        /^git(\s+-C\s+"[^"]*")?\s+merge/,
        /^git(\s+-C\s+"[^"]*")?\s+reset/,
        /^git(\s+-C\s+"[^"]*")?\s+stash/,
        /^git(\s+-C\s+"[^"]*")?\s+remote/,
        /^git(\s+-C\s+"[^"]*")?\s+rev-list/,
        /^git(\s+-C\s+"[^"]*")?\s+rev-parse/,
        /^git(\s+-C\s+"[^"]*")?\s+ls-files/
      ]

      const isAllowed = allowedCommands.some(pattern => pattern.test(command.trim()))
      if (!isAllowed) {
        throw new Error(`不允许执行的命令: ${command}`)
      }

      const result = executeGitCommand(command)
      console.log("[IPC] Git命令执行成功:", command, "结果:", result)

      return result
    } catch (error) {
      console.error("[IPC] execute-git-command error:", error)
      throw error
    }
  })

  // 执行任意命令（使用cmd）
  ipcMain.handle("execute-command", async (_, command: string): Promise<string> => {
    try {
      console.log("[IPC] 执行命令:", command)

      const result = execSync(command, {
        encoding: "utf-8",
        cwd: getCurrentWorkingDirectory(),
        timeout: 30000, // 30秒超时
        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'
      })

      console.log("[IPC] 命令执行成功:", command, "结果:", result.trim())
      return result.trim()
    } catch (rawError: unknown) {
      const error = rawError as ExecCommandError
      console.error("[IPC] execute-command error:", error)
      if (error.stderr) {
        throw new Error(String(error.stderr).trim())
      } else if (error.stdout) {
        return String(error.stdout).trim()
      } else {
        throw new Error(`命令执行失败: ${error.message}`)
      }
    }
  })

  console.log("[IPC] Git handlers registered")
}
