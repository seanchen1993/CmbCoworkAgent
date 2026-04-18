import { lstat, open, realpath, stat } from "fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "path"

export const DEFAULT_AGENTS_FILENAME = "AGENTS.md"
export const LOCAL_AGENTS_OVERRIDE_FILENAME = "AGENTS.override.md"
export const DEFAULT_AGENTS_MAX_BYTES = 32 * 1024
const AGENTS_READ_PADDING_BYTES = 4

export interface AgentsPromptEntry {
  path: string
  content: string
  truncated: boolean
}

interface AgentsFileReference {
  path: string
  readPath: string
}

interface ReadAgentsFileResult {
  content: string
  truncated: boolean
}

export interface AgentsPromptResult {
  prompt: string | null
  projectRoot: string
  loadedPaths: string[]
  truncated: boolean
}

function isWithinRoot(rootDir: string, targetDir: string): boolean {
  const rel = relative(rootDir, targetDir)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function buildDirectoryChain(rootDir: string, cwd: string): string[] {
  if (!isWithinRoot(rootDir, cwd)) {
    return [cwd]
  }

  const dirs: string[] = []
  let current = cwd
  while (true) {
    dirs.push(current)
    if (current === rootDir) {
      break
    }
    const parent = dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }

  return dirs.reverse()
}

async function normalizeWorkspacePath(inputPath: string): Promise<string> {
  try {
    return await realpath(inputPath)
  } catch {
    return resolve(inputPath)
  }
}

export async function findProjectRootByGitMarker(startDir: string): Promise<string> {
  const normalizedStartDir = await normalizeWorkspacePath(startDir)
  let current = normalizedStartDir
  while (true) {
    const marker = join(current, ".git")
    if (await hasPath(marker)) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) {
      return normalizedStartDir
    }
    current = parent
  }
}

async function hasPath(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath)
    return true
  } catch {
    return false
  }
}

async function resolveSafeAgentsFile(
  projectRoot: string,
  candidatePath: string
): Promise<AgentsFileReference | null> {
  let stats: Awaited<ReturnType<typeof lstat>>
  try {
    stats = await lstat(candidatePath)
  } catch {
    return null
  }

  if (!stats.isFile() && !stats.isSymbolicLink()) {
    return null
  }

  let resolvedProjectRoot: string
  let resolvedCandidatePath: string
  try {
    resolvedProjectRoot = await realpath(projectRoot)
    resolvedCandidatePath = await realpath(candidatePath)
  } catch (error) {
    console.warn("[AGENTS] Failed to resolve AGENTS file path:", candidatePath, error)
    return null
  }

  try {
    const resolvedStats = await stat(resolvedCandidatePath)
    if (!resolvedStats.isFile()) {
      return null
    }
  } catch (error) {
    console.warn("[AGENTS] Failed to stat resolved AGENTS file:", resolvedCandidatePath, error)
    return null
  }

  if (!isWithinRoot(resolvedProjectRoot, resolvedCandidatePath)) {
    console.warn(
      "[AGENTS] Skipping AGENTS file outside project root:",
      candidatePath,
      "->",
      resolvedCandidatePath
    )
    return null
  }

  return {
    path: candidatePath,
    readPath: resolvedCandidatePath
  }
}

async function readAgentsFilePrefix(
  filePath: string,
  maxBytes: number
): Promise<ReadAgentsFileResult> {
  const readLimit = Math.max(1, maxBytes + AGENTS_READ_PADDING_BYTES)
  const handle = await open(filePath, "r")

  try {
    const fileStats = await handle.stat()
    const bytesToRead = Math.min(fileStats.size, readLimit)
    const buffer = Buffer.alloc(bytesToRead)
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0)
    return {
      content: buffer.toString("utf8", 0, bytesRead),
      truncated: fileStats.size > bytesToRead
    }
  } finally {
    await handle.close()
  }
}

export async function discoverAgentsFiles(
  projectRoot: string,
  cwd: string
): Promise<AgentsFileReference[]> {
  const dirs = buildDirectoryChain(projectRoot, cwd)
  const discovered: AgentsFileReference[] = []

  for (const dir of dirs) {
    const overridePath = join(dir, LOCAL_AGENTS_OVERRIDE_FILENAME)
    const overrideFile = await resolveSafeAgentsFile(projectRoot, overridePath)
    if (overrideFile) {
      discovered.push(overrideFile)
      continue
    }

    const agentsPath = join(dir, DEFAULT_AGENTS_FILENAME)
    const agentsFile = await resolveSafeAgentsFile(projectRoot, agentsPath)
    if (agentsFile) {
      discovered.push(agentsFile)
    }
  }

  return discovered
}

export async function readAgentsFiles(
  cwd: string,
  files: AgentsFileReference[],
  maxBytes = DEFAULT_AGENTS_MAX_BYTES
): Promise<{ entries: AgentsPromptEntry[]; truncated: boolean }> {
  const entries: AgentsPromptEntry[] = []
  let truncated = false

  for (const file of files) {
    let rawContent: ReadAgentsFileResult
    try {
      rawContent = await readAgentsFilePrefix(file.readPath, maxBytes)
    } catch (error) {
      console.warn("[AGENTS] Failed to read AGENTS file:", file.path, error)
      continue
    }

    const content = rawContent.content.trim()
    if (!content) {
      continue
    }

    let finalContent = content
    let entryTruncated = rawContent.truncated

    if (
      !doesRenderedPromptFit(
        cwd,
        [...entries, { path: file.path, content, truncated: rawContent.truncated }],
        maxBytes
      )
    ) {
      finalContent = fitRenderedContentToBudget(cwd, entries, file.path, content, maxBytes)
      entryTruncated = true
      truncated = true
    }

    if (rawContent.truncated) {
      truncated = true
    }

    if (!finalContent.trim()) {
      truncated = true
      break
    }

    entries.push({
      path: file.path,
      content: finalContent,
      truncated: entryTruncated
    })

    if (entryTruncated) {
      break
    }
  }

  return { entries, truncated }
}

export function renderAgentsPrompt(cwd: string, entries: AgentsPromptEntry[]): string | null {
  if (entries.length === 0) {
    return null
  }

  const lines: string[] = [`# AGENTS.md instructions for ${cwd}`, "", "<INSTRUCTIONS>"]
  for (const entry of entries) {
    lines.push(`[${entry.path}]`)
    lines.push(entry.content)
    if (entry.truncated) {
      lines.push("")
      lines.push("[truncated to fit prompt budget]")
    }
    lines.push("")
  }
  lines.push("</INSTRUCTIONS>")

  return lines.join("\n")
}

function doesRenderedPromptFit(
  cwd: string,
  entries: AgentsPromptEntry[],
  maxBytes: number
): boolean {
  const prompt = renderAgentsPrompt(cwd, entries)
  if (!prompt) {
    return true
  }
  return Buffer.byteLength(prompt, "utf8") <= maxBytes
}

function fitRenderedContentToBudget(
  cwd: string,
  existingEntries: AgentsPromptEntry[],
  filePath: string,
  content: string,
  maxBytes: number
): string {
  let best = ""
  let low = 1
  let high = content.length

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = content.slice(0, mid).trimEnd()
    if (!candidate) {
      low = mid + 1
      continue
    }

    const fits = doesRenderedPromptFit(
      cwd,
      [...existingEntries, { path: filePath, content: candidate, truncated: true }],
      maxBytes
    )
    if (fits) {
      best = candidate
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return best
}

export async function loadAgentsPromptForWorkspace(
  workspacePath: string,
  maxBytes = DEFAULT_AGENTS_MAX_BYTES
): Promise<AgentsPromptResult> {
  const cwd = await normalizeWorkspacePath(workspacePath)
  const projectRoot = await findProjectRootByGitMarker(cwd)
  const discoveredPaths = await discoverAgentsFiles(projectRoot, cwd)
  const { entries, truncated } = await readAgentsFiles(cwd, discoveredPaths, maxBytes)

  return {
    prompt: renderAgentsPrompt(cwd, entries),
    projectRoot,
    loadedPaths: entries.map((entry) => entry.path),
    truncated
  }
}
