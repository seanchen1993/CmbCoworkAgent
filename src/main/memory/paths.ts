import { createHash } from "crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync
} from "fs"
import { dirname, join, resolve, sep } from "path"
import { homedir } from "os"
import { realpath as realpathAsync } from "node:fs/promises"
import {
  clearAsyncGitRootCache,
  findCanonicalGitRootAsync as findCanonicalGitRootInBackground
} from "./git-root-resolver"

export type MemoryScope = "global" | "project"

export interface MemoryNamespace {
  scope: MemoryScope
  dir: string
  projectId?: string
  gitRoot?: string
}

export interface WorkspaceMemoryDirs {
  global: MemoryNamespace
  project: MemoryNamespace | null
}

interface ProjectMemoryMetadata {
  projectId: string
  gitRoot?: string
  updatedAt: number
}

export const MEMORY_ROOT_DIR = join(homedir(), ".cmbcoworkagent", "memory")
export const GLOBAL_MEMORY_DIR = join(MEMORY_ROOT_DIR, "global")
export const PROJECTS_MEMORY_DIR = join(MEMORY_ROOT_DIR, "projects")

let layoutEnsured = false
const GIT_ROOT_CACHE_TTL_MS = 60_000
const PROJECT_METADATA_FILE = ".project.json"
const gitRootCache = new Map<string, { value: string | null; expiresAt: number }>()

function normalizeIdentityPath(value: string): string {
  let resolved = resolve(value)
  try {
    resolved = realpathSync.native(resolved)
  } catch {
    // The path may not exist yet (for example, a candidate memory file path).
    // Fall back to lexical resolution so callers can still do prefix checks.
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function uniqueDestination(dir: string, name: string): string {
  const target = join(dir, name)
  if (!existsSync(target)) return target
  const dot = name.lastIndexOf(".")
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ""
  let i = 2
  while (existsSync(join(dir, `${stem}_${i}${ext}`))) i++
  return join(dir, `${stem}_${i}${ext}`)
}

function moveArchiveDirToGlobal(src: string): void {
  const dest = join(GLOBAL_MEMORY_DIR, "archive")
  mkdirSync(dest, { recursive: true })
  for (const child of readdirSync(src)) {
    renameSync(join(src, child), uniqueDestination(dest, child))
  }
  try {
    rmdirSync(src)
  } catch {
    // Leave a non-empty or locked legacy archive in place; it is ignored by the new layout.
  }
}

export function ensureMemoryLayout(): void {
  if (layoutEnsured) return
  mkdirSync(GLOBAL_MEMORY_DIR, { recursive: true })
  mkdirSync(PROJECTS_MEMORY_DIR, { recursive: true })

  try {
    for (const name of readdirSync(MEMORY_ROOT_DIR)) {
      if (name === "global" || name === "projects" || name === "index.sqlite") continue
      const src = join(MEMORY_ROOT_DIR, name)
      const stat = statSync(src)
      if (stat.isDirectory() && name === "archive") {
        moveArchiveDirToGlobal(src)
        continue
      }
      if (!stat.isFile()) continue
      if (!name.endsWith(".md") && name !== ".dream_state.json") continue
      renameSync(src, uniqueDestination(GLOBAL_MEMORY_DIR, name))
    }
  } catch (e) {
    console.warn(
      "[MemoryPaths] Legacy memory migration skipped:",
      e instanceof Error ? e.message : e
    )
  }

  layoutEnsured = true
}

export function findCanonicalGitRoot(workDir?: string | null): string | null {
  if (!workDir) return null
  const cwd = resolve(workDir)
  if (!existsSync(cwd)) return null

  const cacheKey = normalizeIdentityPath(cwd)
  const cached = gitRootCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  let current = cwd
  let gitRoot: string | null = null
  for (let depth = 0; depth < 256; depth += 1) {
    const marker = join(current, ".git")
    try {
      const markerStat = statSync(marker)
      if (markerStat.isDirectory()) {
        gitRoot = current
        break
      }
      if (markerStat.isFile() && markerStat.size <= 64 * 1024) {
        const match = readFileSync(marker, "utf-8").match(/^gitdir:\s*(.+)\s*$/im)
        if (match?.[1]) {
          const gitDir = resolve(current, match[1].trim()).replace(/\\/g, "/")
          const linkedWorktree = gitDir.match(/^(.*\/\.git)\/worktrees\/[^/]+(?:\/.*)?$/i)
          gitRoot = linkedWorktree?.[1] ? dirname(linkedWorktree[1]) : current
          break
        }
      }
    } catch {
      // Keep walking towards the filesystem root.
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  gitRootCache.set(cacheKey, {
    value: gitRoot,
    expiresAt: Date.now() + GIT_ROOT_CACHE_TTL_MS
  })
  return gitRoot
}

export function clearGitRootCache(): void {
  gitRootCache.clear()
  clearAsyncGitRootCache()
}

export function findCanonicalGitRootAsync(
  workDir?: string | null,
  signal?: AbortSignal
): Promise<string | null> {
  return findCanonicalGitRootInBackground(workDir, signal)
}

export function resolveProjectId(gitRoot: string): string {
  return createHash("sha256").update(normalizeIdentityPath(gitRoot)).digest("hex").slice(0, 12)
}

export async function resolveProjectIdAsync(gitRoot: string): Promise<string> {
  let normalized = resolve(gitRoot)
  try {
    normalized = await realpathAsync(normalized)
  } catch {
    // Git may return a path that disappeared between discovery and hashing.
  }
  if (process.platform === "win32") normalized = normalized.toLowerCase()
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12)
}

export function isMemoryStoragePath(filePath?: string | null): boolean {
  if (!filePath) return false
  const target = normalizeIdentityPath(filePath)
  const root = normalizeIdentityPath(MEMORY_ROOT_DIR).replace(/[\\/]+$/, "")
  const separator = process.platform === "win32" ? "\\" : sep
  return target === root || target.startsWith(`${root}${separator}`)
}

function isValidProjectId(projectId: string): boolean {
  return /^[a-f0-9]{12}$/.test(projectId)
}

function projectMemoryDirForId(projectId: string): string {
  return join(PROJECTS_MEMORY_DIR, projectId)
}

function readProjectMetadata(dir: string): ProjectMemoryMetadata | null {
  try {
    const raw = JSON.parse(
      readFileSync(join(dir, PROJECT_METADATA_FILE), "utf-8")
    ) as Partial<ProjectMemoryMetadata>
    if (!raw.projectId || !isValidProjectId(raw.projectId)) return null
    return {
      projectId: raw.projectId,
      gitRoot: typeof raw.gitRoot === "string" && raw.gitRoot ? raw.gitRoot : undefined,
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0
    }
  } catch {
    return null
  }
}

function writeProjectMetadata(namespace: MemoryNamespace): void {
  if (namespace.scope !== "project" || !namespace.projectId) return
  try {
    const metadata: ProjectMemoryMetadata = {
      projectId: namespace.projectId,
      gitRoot: namespace.gitRoot,
      updatedAt: Date.now()
    }
    writeFileSync(
      join(namespace.dir, PROJECT_METADATA_FILE),
      JSON.stringify(metadata, null, 2),
      "utf-8"
    )
  } catch (e) {
    console.warn(
      "[MemoryPaths] Failed to write project metadata:",
      e instanceof Error ? e.message : e
    )
  }
}

export function getGlobalMemoryDir(): string {
  ensureMemoryLayout()
  return GLOBAL_MEMORY_DIR
}

export function getProjectMemoryDir(workDir?: string | null): MemoryNamespace | null {
  ensureMemoryLayout()
  const gitRoot = findCanonicalGitRoot(workDir)
  if (!gitRoot) return null
  const projectId = resolveProjectId(gitRoot)
  const dir = projectMemoryDirForId(projectId)
  mkdirSync(dir, { recursive: true })
  const namespace = { scope: "project" as const, dir, projectId, gitRoot }
  writeProjectMetadata(namespace)
  return namespace
}

export function getProjectMemoryDirById(projectId?: string | null): MemoryNamespace | null {
  ensureMemoryLayout()
  if (!projectId || !isValidProjectId(projectId)) return null
  const dir = projectMemoryDirForId(projectId)
  if (!existsSync(dir)) return null
  const metadata = readProjectMetadata(dir)
  return {
    scope: "project",
    dir,
    projectId,
    gitRoot: metadata?.gitRoot
  }
}

export function listProjectMemoryDirs(workDir?: string | null): MemoryNamespace[] {
  ensureMemoryLayout()
  const current = getProjectMemoryDir(workDir)
  const byId = new Map<string, MemoryNamespace>()
  if (current?.projectId) byId.set(current.projectId, current)

  for (const name of readdirSync(PROJECTS_MEMORY_DIR)) {
    if (!isValidProjectId(name)) continue
    const dir = projectMemoryDirForId(name)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    if (byId.has(name)) continue
    const metadata = readProjectMetadata(dir)
    byId.set(name, {
      scope: "project",
      dir,
      projectId: name,
      gitRoot: metadata?.gitRoot
    })
  }

  return [...byId.values()]
}

export function resolveWorkspaceMemoryDirs(workDir?: string | null): WorkspaceMemoryDirs {
  ensureMemoryLayout()
  return {
    global: { scope: "global", dir: GLOBAL_MEMORY_DIR },
    project: getProjectMemoryDir(workDir)
  }
}

export function resolveScopedMemoryDir(options?: {
  scope?: MemoryScope
  workspacePath?: string | null
  projectId?: string | null
}): MemoryNamespace {
  ensureMemoryLayout()
  if (options?.scope !== "project") return { scope: "global", dir: GLOBAL_MEMORY_DIR }
  const selectedProject = getProjectMemoryDirById(options.projectId)
  if (selectedProject) return selectedProject
  return getProjectMemoryDir(options.workspacePath) ?? { scope: "global", dir: GLOBAL_MEMORY_DIR }
}
