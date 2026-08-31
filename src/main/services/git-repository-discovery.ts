import { execFile } from "child_process"
import * as fs from "fs/promises"
import * as path from "path"
import { promisify } from "util"
import { currentGitReadSignal, throwIfGitReadCancelled } from "./git-read-context"

const execFileAsync = promisify(execFile)

const GIT_CONTEXT_QUERY_TIMEOUT_MS = 10_000
const GIT_DISCOVERY_MAX_DEPTH = 4
const GIT_DISCOVERY_MAX_DIRECTORIES = 2_000

const GIT_BASE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",
  GIT_LFS_SKIP_SMUDGE: "1",
  GIT_TERMINAL_PROMPT: "0"
}

const GIT_SPAWN_OPTIONS = { windowsHide: true } as const

const SKIP_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".next",
  ".nuxt",
  ".output",
  ".parcel-cache",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "venv"
])

export interface DiscoveredGitRepository {
  repoPath: string
  gitRoot: string
  workspaceRelativePath: string
  displayPath: string
  isWorkspaceRoot: boolean
}

function normalizePathKey(input: string): string {
  return path.resolve(input).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

function normalizeDisplayPath(input: string): string {
  return input.replace(/\\/g, "/").replace(/\/+$/, "") || "."
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function hasGitMarker(directoryPath: string): Promise<boolean> {
  return pathExists(path.join(directoryPath, ".git"))
}

async function runGit(worktreePath: string, args: string[]): Promise<string> {
  const signal = currentGitReadSignal()
  throwIfGitReadCancelled(signal)
  const { stdout } = await execFileAsync("git", ["-C", worktreePath, ...args], {
    env: GIT_BASE_ENV,
    timeout: GIT_CONTEXT_QUERY_TIMEOUT_MS,
    signal,
    ...GIT_SPAWN_OPTIONS
  })
  throwIfGitReadCancelled(signal)
  return stdout
}

export async function getGitRootForPath(folderPath: string): Promise<string | null> {
  try {
    const root = (await runGit(folderPath, ["rev-parse", "--show-toplevel"])).trim()
    return root ? path.resolve(root) : null
  } catch {
    throwIfGitReadCancelled()
    return null
  }
}

function toRepository(
  workspacePath: string,
  repoPath: string,
  gitRoot: string,
  isWorkspaceRoot: boolean
): DiscoveredGitRepository {
  const workspaceRelativePath = normalizeDisplayPath(path.relative(workspacePath, repoPath))
  return {
    repoPath: path.resolve(repoPath),
    gitRoot: path.resolve(gitRoot),
    workspaceRelativePath,
    displayPath: isWorkspaceRoot ? "." : workspaceRelativePath,
    isWorkspaceRoot
  }
}

export async function discoverWorkspaceGitRepositories(
  workspacePath: string,
  options?: { maxDepth?: number; maxDirectories?: number }
): Promise<DiscoveredGitRepository[]> {
  throwIfGitReadCancelled()
  const workspaceRoot = path.resolve(workspacePath)
  const workspaceGitRoot = await getGitRootForPath(workspaceRoot)
  if (workspaceGitRoot) {
    return [toRepository(workspaceRoot, workspaceRoot, workspaceGitRoot, true)]
  }

  const maxDepth = options?.maxDepth ?? GIT_DISCOVERY_MAX_DEPTH
  const maxDirectories = options?.maxDirectories ?? GIT_DISCOVERY_MAX_DIRECTORIES
  const queue: Array<{ directoryPath: string; depth: number }> = [{ directoryPath: workspaceRoot, depth: 0 }]
  const visited = new Set<string>()
  const repositories = new Map<string, DiscoveredGitRepository>()
  let scannedDirectories = 0

  while (queue.length > 0 && scannedDirectories < maxDirectories) {
    throwIfGitReadCancelled()
    const current = queue.shift()
    if (!current) break
    const currentKey = normalizePathKey(current.directoryPath)
    if (visited.has(currentKey)) continue
    visited.add(currentKey)
    scannedDirectories += 1

    if (current.depth > 0 && (await hasGitMarker(current.directoryPath))) {
      const gitRoot = await getGitRootForPath(current.directoryPath)
      if (gitRoot) {
        const repo = toRepository(workspaceRoot, current.directoryPath, gitRoot, false)
        repositories.set(normalizePathKey(repo.repoPath), repo)
        continue
      }
    }

    if (current.depth >= maxDepth) continue

    try {
      const directory = await fs.opendir(current.directoryPath, { bufferSize: 64 })
      for await (const entry of directory) {
        throwIfGitReadCancelled()
        if (queue.length + scannedDirectories >= maxDirectories) break
        if (!entry.isDirectory()) continue
        if (SKIP_DIR_NAMES.has(entry.name)) continue
        queue.push({
          directoryPath: path.join(current.directoryPath, entry.name),
          depth: current.depth + 1
        })
      }
    } catch {
      throwIfGitReadCancelled()
      continue
    }
  }

  return Array.from(repositories.values()).sort((a, b) =>
    a.displayPath.localeCompare(b.displayPath, "zh-Hans-CN")
  )
}

export async function resolveGitOperationPath(
  workspacePath: string,
  requestedPath?: string | null
): Promise<{ worktreePath: string; gitRoot: string } | { error: string }> {
  throwIfGitReadCancelled()
  const workspaceRoot = path.resolve(workspacePath)
  const hasRequestedPath = typeof requestedPath === "string" && requestedPath.length > 0
  const candidatePath = path.resolve(hasRequestedPath ? requestedPath : workspaceRoot)
  const relativeToWorkspace = path.relative(workspaceRoot, candidatePath)
  if (
    relativeToWorkspace === ".." ||
    relativeToWorkspace.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToWorkspace)
  ) {
    return { error: "目标 Git 路径不在当前工作区内" }
  }

  let realWorkspaceRoot: string
  let realCandidatePath: string
  try {
    const resolvedPaths = await Promise.all([
      fs.realpath(workspaceRoot),
      fs.realpath(candidatePath)
    ])
    realWorkspaceRoot = resolvedPaths[0]
    realCandidatePath = resolvedPaths[1]
  } catch {
    throwIfGitReadCancelled()
    return { error: "目标 Git 路径不存在或无法访问" }
  }
  const relativeToRealWorkspace = path.relative(realWorkspaceRoot, realCandidatePath)
  if (
    relativeToRealWorkspace === ".." ||
    relativeToRealWorkspace.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRealWorkspace)
  ) {
    return { error: "目标 Git 路径解析后不在当前工作区内" }
  }

  const gitRoot = await getGitRootForPath(realCandidatePath)
  if (!gitRoot) {
    const repos = await discoverWorkspaceGitRepositories(workspaceRoot)
    if (!requestedPath && repos.length > 1) {
      return { error: "当前工作区包含多个 Git 仓库，请先指定要操作的子仓库" }
    }
    if (!requestedPath && repos.length === 1) {
      return { worktreePath: repos[0].repoPath, gitRoot: repos[0].gitRoot }
    }
    return { error: "目标路径不是 Git 仓库" }
  }

  return { worktreePath: realCandidatePath, gitRoot }
}
