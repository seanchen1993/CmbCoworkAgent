import { constants as fsConstants, type Stats } from "fs"
import { lstat, open, realpath, stat } from "fs/promises"
import { homedir } from "os"
import { dirname, isAbsolute, join, relative, resolve } from "path"

export const DEFAULT_AGENTS_FILENAME = "AGENTS.md"
export const LOCAL_AGENTS_OVERRIDE_FILENAME = "AGENTS.override.md"
export const DEFAULT_AGENTS_MAX_BYTES = 32 * 1024
export const DEFAULT_GLOBAL_AGENTS_MAX_BYTES = DEFAULT_AGENTS_MAX_BYTES
const AGENTS_PROJECT_SEPARATOR = "\n\n---\n\n"
const AGENTS_CONTENT_FENCE_MIN_TICKS = 9
const UTF8_READ_PADDING_BYTES = 4
const GLOBAL_AGENTS_SECTION_TITLE = "# Global AGENTS.md instructions"

export interface AgentsPromptEntry {
  path: string
  content: string
  truncated: boolean
}

interface AgentsFileReference {
  path: string
  readPath: string
  rootPath: string | null
  rejectHardLinks: boolean
  fallbackFiles?: AgentsFileReference[]
}

interface ReadAgentsFileResult {
  content: string
  truncated: boolean
  bytesRead: number
}

export interface AgentsPromptResult {
  prompt: string | null
  projectRoot: string
  loadedPaths: string[]
  truncated: boolean
}

export interface AgentsPromptBudgetOptions {
  globalMaxBytes?: number
  projectMaxBytes?: number
  totalMaxBytes?: number
}

export interface AgentsPromptPlaceholderContext {
  pluginRoot?: string
  pluginWorkspace?: string
  featureId?: string
  projectCode?: string
}

type AgentsPromptBudget = number | AgentsPromptBudgetOptions

interface NormalizedAgentsPromptBudget {
  globalMaxBytes: number
  projectMaxBytes: number
  totalMaxBytes?: number
}

interface ResolveAgentsFileOptions {
  rejectHardLinks?: boolean
  rejectSymlinks?: boolean
}

function normalizeAgentsPlaceholderPath(value: string): string {
  return resolve(value).replace(/\\/g, "/")
}

function replaceAgentsPlaceholders(
  content: string,
  context: AgentsPromptPlaceholderContext
): string {
  const replacements: Record<string, string | undefined> = {
    PLUGIN_ROOT:
      context.pluginRoot !== undefined && context.pluginRoot !== ""
        ? normalizeAgentsPlaceholderPath(context.pluginRoot)
        : undefined,
    PLUGIN_WORKSPACE:
      context.pluginWorkspace !== undefined && context.pluginWorkspace !== ""
        ? normalizeAgentsPlaceholderPath(context.pluginWorkspace)
        : undefined,
    PROJECT_CODE:
      context.projectCode !== undefined && context.projectCode !== "" ? context.projectCode : undefined,
    FEATURE_ID:
      context.featureId !== undefined && context.featureId !== "" ? context.featureId : undefined
  }

  return content.replace(
    /\{(PLUGIN_ROOT|PLUGIN_WORKSPACE|PROJECT_CODE|FEATURE_ID)\}/g,
    (match, key: string) => replacements[key] ?? match
  )
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
  projectRoot: string | null,
  candidatePath: string,
  options: ResolveAgentsFileOptions = {}
): Promise<AgentsFileReference | null> {
  let stats: Awaited<ReturnType<typeof lstat>>
  try {
    stats = await lstat(candidatePath)
  } catch {
    return null
  }

  if (stats.isSymbolicLink()) {
    if (options.rejectSymlinks) {
      console.warn("[AGENTS] Skipping AGENTS symlink:", candidatePath)
      return null
    }
  } else if (!stats.isFile()) {
    return null
  }

  let resolvedCandidatePath: string
  try {
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
    if (options.rejectHardLinks && resolvedStats.nlink > 1) {
      console.warn(
        "[AGENTS] Skipping AGENTS file with multiple hard links:",
        candidatePath,
        "links:",
        resolvedStats.nlink
      )
      return null
    }
  } catch (error) {
    console.warn("[AGENTS] Failed to stat resolved AGENTS file:", resolvedCandidatePath, error)
    return null
  }

  let resolvedProjectRoot: string | null = null
  if (projectRoot) {
    try {
      resolvedProjectRoot = await realpath(projectRoot)
    } catch (error) {
      console.warn("[AGENTS] Failed to resolve project root:", projectRoot, error)
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
  }

  return {
    path: candidatePath,
    readPath: resolvedCandidatePath,
    rootPath: resolvedProjectRoot,
    rejectHardLinks: options.rejectHardLinks === true
  }
}

function areSameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function findUtf8SafePrefixLength(buffer: Buffer, maxBytes: number): number {
  const end = Math.min(buffer.length, Math.max(0, maxBytes))
  if (end === 0 || end === buffer.length) {
    return end
  }

  let sequenceStart = end - 1
  while (sequenceStart >= 0 && (buffer[sequenceStart] & 0xc0) === 0x80) {
    sequenceStart -= 1
  }

  if (sequenceStart < 0) {
    return 0
  }

  const firstByte = buffer[sequenceStart]
  let expectedLength = 1
  if ((firstByte & 0x80) === 0) {
    expectedLength = 1
  } else if ((firstByte & 0xe0) === 0xc0) {
    expectedLength = 2
  } else if ((firstByte & 0xf0) === 0xe0) {
    expectedLength = 3
  } else if ((firstByte & 0xf8) === 0xf0) {
    expectedLength = 4
  } else {
    return sequenceStart
  }

  return end - sequenceStart >= expectedLength ? end : sequenceStart
}

async function readAgentsFilePrefix(
  file: AgentsFileReference,
  maxBytes: number
): Promise<ReadAgentsFileResult> {
  const contentLimit = Math.max(1, maxBytes)
  const readLimit = contentLimit + UTF8_READ_PADDING_BYTES
  const forbidSymlink = file.rejectHardLinks && file.path === file.readPath
  const flags = forbidSymlink ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW : fsConstants.O_RDONLY
  const handle = await open(forbidSymlink ? file.path : file.readPath, flags)

  try {
    const fileStats = await handle.stat()
    if (!fileStats.isFile()) {
      throw new Error(`AGENTS path is not a regular file: ${file.path}`)
    }
    if (file.rejectHardLinks && fileStats.nlink > 1) {
      throw new Error(`AGENTS path has multiple hard links: ${file.path}`)
    }

    if (file.rootPath) {
      const resolvedPath = await realpath(file.path)
      if (!isWithinRoot(file.rootPath, resolvedPath)) {
        throw new Error(`AGENTS path escaped root while opening: ${file.path}`)
      }
      const currentStats = await stat(resolvedPath)
      if (!areSameFile(fileStats, currentStats)) {
        throw new Error(`AGENTS path changed while opening: ${file.path}`)
      }
    }

    const bytesToRead = Math.min(fileStats.size, readLimit)
    const buffer = Buffer.alloc(bytesToRead)
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0)
    const contentBytes = findUtf8SafePrefixLength(buffer.subarray(0, bytesRead), contentLimit)
    return {
      content: buffer.toString("utf8", 0, contentBytes),
      truncated: fileStats.size > contentBytes,
      bytesRead: contentBytes
    }
  } finally {
    await handle.close()
  }
}

async function readFirstAvailableAgentsFile(
  file: AgentsFileReference,
  maxBytes: number
): Promise<{ file: AgentsFileReference; content: ReadAgentsFileResult } | null> {
  const candidates = [file, ...(file.fallbackFiles ?? [])]

  for (const candidate of candidates) {
    try {
      return {
        file: candidate,
        content: await readAgentsFilePrefix(candidate, maxBytes)
      }
    } catch (error) {
      console.warn("[AGENTS] Failed to read AGENTS file:", candidate.path, error)
    }
  }

  return null
}

function normalizeAgentsPromptBudget(budget: AgentsPromptBudget): NormalizedAgentsPromptBudget {
  if (typeof budget === "number") {
    return {
      globalMaxBytes: budget,
      projectMaxBytes: budget,
      totalMaxBytes: budget
    }
  }

  return {
    globalMaxBytes: budget.globalMaxBytes ?? DEFAULT_GLOBAL_AGENTS_MAX_BYTES,
    projectMaxBytes: budget.projectMaxBytes ?? DEFAULT_AGENTS_MAX_BYTES,
    totalMaxBytes: budget.totalMaxBytes
  }
}

export function getCmbCoworkAgentsHome(): string {
  const configuredHome = process.env.CMB_COWORK_AGENT_HOME?.trim()
  if (configuredHome) {
    return resolve(configuredHome)
  }
  return join(homedir(), ".cmbcoworkagent")
}

export async function discoverGlobalAgentsFiles(
  agentsHome = getCmbCoworkAgentsHome()
): Promise<AgentsFileReference[]> {
  const globalFileOptions: ResolveAgentsFileOptions = {
    rejectHardLinks: true,
    rejectSymlinks: true
  }
  const overridePath = join(agentsHome, LOCAL_AGENTS_OVERRIDE_FILENAME)
  const agentsPath = join(agentsHome, DEFAULT_AGENTS_FILENAME)
  const [overrideFile, agentsFile] = await Promise.all([
    resolveSafeAgentsFile(agentsHome, overridePath, globalFileOptions),
    resolveSafeAgentsFile(agentsHome, agentsPath, globalFileOptions)
  ])

  if (overrideFile) {
    return [
      {
        ...overrideFile,
        fallbackFiles: agentsFile ? [agentsFile] : undefined
      }
    ]
  }

  return agentsFile ? [agentsFile] : []
}

export async function discoverAgentsFiles(
  projectRoot: string,
  cwd: string
): Promise<AgentsFileReference[]> {
  const dirs = buildDirectoryChain(projectRoot, cwd)
  const discovered: AgentsFileReference[] = []

  for (const dir of dirs) {
    const overridePath = join(dir, LOCAL_AGENTS_OVERRIDE_FILENAME)
    const overrideFile = await resolveSafeAgentsFile(projectRoot, overridePath, {
      rejectHardLinks: true,
      rejectSymlinks: true
    })
    if (overrideFile) {
      discovered.push(overrideFile)
      continue
    }

    const agentsPath = join(dir, DEFAULT_AGENTS_FILENAME)
    const agentsFile = await resolveSafeAgentsFile(projectRoot, agentsPath, {
      rejectHardLinks: true,
      rejectSymlinks: true
    })
    if (agentsFile) {
      discovered.push(agentsFile)
    }
  }

  return discovered
}

export function readAgentsFiles(
  cwd: string,
  files: AgentsFileReference[],
  maxBytes?: number
): Promise<{ entries: AgentsPromptEntry[]; truncated: boolean }>
export function readAgentsFiles(
  files: AgentsFileReference[],
  maxBytes?: number,
  sectionTitle?: string
): Promise<{ entries: AgentsPromptEntry[]; truncated: boolean }>
export async function readAgentsFiles(
  firstArg: string | AgentsFileReference[],
  secondArg?: AgentsFileReference[] | number,
  thirdArg?: number | string
): Promise<{ entries: AgentsPromptEntry[]; truncated: boolean }> {
  const files = typeof firstArg === "string" ? (secondArg as AgentsFileReference[]) : firstArg
  const maxBytes =
    typeof firstArg === "string"
      ? typeof thirdArg === "number"
        ? thirdArg
        : DEFAULT_AGENTS_MAX_BYTES
      : typeof secondArg === "number"
        ? secondArg
        : DEFAULT_AGENTS_MAX_BYTES
  const sectionTitle =
    typeof firstArg === "string"
      ? getProjectAgentsSectionTitle(firstArg)
      : typeof thirdArg === "string"
        ? thirdArg
        : undefined
  return readAgentsFilesInternal(files, maxBytes, sectionTitle)
}

async function readAgentsFilesInternal(
  files: AgentsFileReference[],
  maxBytes: number,
  sectionTitle?: string,
  placeholderContext?: AgentsPromptPlaceholderContext
): Promise<{ entries: AgentsPromptEntry[]; truncated: boolean }> {
  const entries: AgentsPromptEntry[] = []
  let truncated = false

  if (maxBytes <= 0) {
    return { entries, truncated: files.length > 0 }
  }

  for (const file of files) {
    const readResult = await readFirstAvailableAgentsFile(file, maxBytes)
    if (!readResult) {
      continue
    }
    const loadedFile = readResult.file
    const rawContent = readResult.content

    if (rawContent.truncated) {
      truncated = true
    }

    let content = rawContent.content.trim()
    if (!content) {
      continue
    }

    if (placeholderContext) {
      content = replaceAgentsPlaceholders(content, placeholderContext)
    }

    entries.push({
      path: loadedFile.path,
      content,
      truncated: rawContent.truncated
    })
  }

  if (!sectionTitle) {
    return { entries, truncated }
  }

  const fitted = fitEntriesToSectionBudget(sectionTitle, entries, maxBytes)
  return {
    entries: fitted.entries,
    truncated: truncated || fitted.truncated || fitted.entries.length < entries.length
  }
}

function getProjectAgentsSectionTitle(cwd: string): string {
  return `# AGENTS.md instructions for ${cwd}`
}

function renderAgentsPromptSection(title: string, entries: AgentsPromptEntry[]): string | null {
  if (entries.length === 0) {
    return null
  }

  const lines: string[] = [title, ""]
  for (const entry of entries) {
    const fence = getMarkdownFenceForContent(entry.content)
    lines.push(`<!-- From: ${escapeHtmlCommentText(entry.path)} -->`)
    lines.push(fence)
    lines.push(entry.content)
    lines.push(fence)
    if (entry.truncated) {
      lines.push("")
      lines.push("[truncated to fit prompt budget]")
    }
    lines.push("")
  }

  return lines.join("\n")
}

function escapeHtmlCommentText(value: string): string {
  return value.replace(/--/g, "- -")
}

function getMarkdownFenceForContent(content: string): string {
  let longestRun = 0
  let currentRun = 0

  for (const char of content) {
    if (char === "`") {
      currentRun += 1
      longestRun = Math.max(longestRun, currentRun)
    } else {
      currentRun = 0
    }
  }

  return "`".repeat(Math.max(AGENTS_CONTENT_FENCE_MIN_TICKS, longestRun + 1))
}

function doesRenderedSectionFit(
  title: string,
  entries: AgentsPromptEntry[],
  maxBytes: number
): boolean {
  const prompt = renderAgentsPromptSection(title, entries)
  if (!prompt) {
    return true
  }
  return Buffer.byteLength(prompt, "utf8") <= maxBytes
}

function materializeSelectedEntries(
  selectedEntries: Array<AgentsPromptEntry | null>
): AgentsPromptEntry[] {
  return selectedEntries.filter((entry): entry is AgentsPromptEntry => entry != null)
}

function fitRenderedContentAtIndexToSectionBudget(
  title: string,
  selectedEntries: Array<AgentsPromptEntry | null>,
  entryIndex: number,
  entry: AgentsPromptEntry,
  maxBytes: number
): string {
  let best = ""
  let low = 1
  const codePoints = Array.from(entry.content)
  let high = codePoints.length

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = codePoints.slice(0, mid).join("").trimEnd()
    if (!candidate) {
      low = mid + 1
      continue
    }

    const candidateEntries = [...selectedEntries]
    candidateEntries[entryIndex] = {
      ...entry,
      content: candidate,
      truncated: true
    }
    const fits = doesRenderedSectionFit(
      title,
      materializeSelectedEntries(candidateEntries),
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

function fitEntriesToSectionBudget(
  title: string,
  entries: AgentsPromptEntry[],
  maxBytes: number
): { entries: AgentsPromptEntry[]; truncated: boolean } {
  const fittedEntries: Array<AgentsPromptEntry | null> = Array(entries.length).fill(null)
  let truncated = false

  if (maxBytes <= 0) {
    return { entries: [], truncated: entries.length > 0 }
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    fittedEntries[index] = entry

    if (doesRenderedSectionFit(title, materializeSelectedEntries(fittedEntries), maxBytes)) {
      continue
    }

    fittedEntries[index] = null
    const fittedContent = fitRenderedContentAtIndexToSectionBudget(
      title,
      fittedEntries,
      index,
      entry,
      maxBytes
    )

    if (fittedContent.trim()) {
      fittedEntries[index] = {
        ...entry,
        content: fittedContent,
        truncated: true
      }
    }

    truncated = true
  }

  return {
    entries: materializeSelectedEntries(fittedEntries),
    truncated
  }
}

function fitEntriesToTotalBudget(
  cwd: string,
  projectEntries: AgentsPromptEntry[],
  globalEntries: AgentsPromptEntry[],
  maxBytes: number
): {
  projectEntries: AgentsPromptEntry[]
  globalEntries: AgentsPromptEntry[]
  truncated: boolean
} {
  if (maxBytes <= 0) {
    return {
      projectEntries: [],
      globalEntries: [],
      truncated: projectEntries.length > 0 || globalEntries.length > 0
    }
  }

  const currentPrompt = renderAgentsPrompt(cwd, projectEntries, globalEntries)
  if (!currentPrompt || Buffer.byteLength(currentPrompt, "utf8") <= maxBytes) {
    return { projectEntries, globalEntries, truncated: false }
  }

  const projectTitle = getProjectAgentsSectionTitle(cwd)
  const projectPrompt = renderAgentsPromptSection(projectTitle, projectEntries)

  if (!projectPrompt) {
    const fittedGlobal = fitEntriesToSectionBudget(
      GLOBAL_AGENTS_SECTION_TITLE,
      globalEntries,
      maxBytes
    )
    return {
      projectEntries: [],
      globalEntries: fittedGlobal.entries,
      truncated: fittedGlobal.truncated
    }
  }

  const projectBytes = Buffer.byteLength(projectPrompt, "utf8")
  if (projectBytes >= maxBytes) {
    const fittedProject = fitEntriesToSectionBudget(projectTitle, projectEntries, maxBytes)
    return {
      projectEntries: fittedProject.entries,
      globalEntries: [],
      truncated: true
    }
  }

  const separatorBytes = Buffer.byteLength(AGENTS_PROJECT_SEPARATOR, "utf8")
  const globalMaxBytes = maxBytes - projectBytes - separatorBytes
  const fittedGlobal = fitEntriesToSectionBudget(
    GLOBAL_AGENTS_SECTION_TITLE,
    globalEntries,
    globalMaxBytes
  )

  return {
    projectEntries,
    globalEntries: fittedGlobal.entries,
    truncated: fittedGlobal.truncated || fittedGlobal.entries.length < globalEntries.length
  }
}

export function renderAgentsPrompt(
  cwd: string,
  projectEntries: AgentsPromptEntry[],
  globalEntries: AgentsPromptEntry[] = []
): string | null {
  const globalPrompt = renderAgentsPromptSection(GLOBAL_AGENTS_SECTION_TITLE, globalEntries)
  const projectPrompt = renderAgentsPromptSection(getProjectAgentsSectionTitle(cwd), projectEntries)

  if (globalPrompt && projectPrompt) {
    return `${globalPrompt}${AGENTS_PROJECT_SEPARATOR}${projectPrompt}`
  }
  return globalPrompt ?? projectPrompt
}

export async function loadAgentsPromptForWorkspace(
  workspacePath: string,
  budget: AgentsPromptBudget = {
    globalMaxBytes: DEFAULT_GLOBAL_AGENTS_MAX_BYTES,
    projectMaxBytes: DEFAULT_AGENTS_MAX_BYTES
  },
  placeholderContext: AgentsPromptPlaceholderContext = {}
): Promise<AgentsPromptResult> {
  const cwd = await normalizeWorkspacePath(workspacePath)
  const projectRoot = await findProjectRootByGitMarker(cwd)
  const globalPaths = await discoverGlobalAgentsFiles()
  const projectPaths = await discoverAgentsFiles(projectRoot, cwd)
  const { globalMaxBytes, projectMaxBytes, totalMaxBytes } = normalizeAgentsPromptBudget(budget)
  const globalResult = await readAgentsFiles(
    globalPaths,
    globalMaxBytes,
    GLOBAL_AGENTS_SECTION_TITLE
  )
  const projectResult = await readAgentsFilesInternal(
    projectPaths,
    projectMaxBytes,
    getProjectAgentsSectionTitle(cwd),
    placeholderContext
  )
  const totalBudgetResult =
    totalMaxBytes == null
      ? {
          globalEntries: globalResult.entries,
          projectEntries: projectResult.entries,
          truncated: false
        }
      : fitEntriesToTotalBudget(cwd, projectResult.entries, globalResult.entries, totalMaxBytes)

  return {
    prompt: renderAgentsPrompt(
      cwd,
      totalBudgetResult.projectEntries,
      totalBudgetResult.globalEntries
    ),
    projectRoot,
    loadedPaths: [...totalBudgetResult.globalEntries, ...totalBudgetResult.projectEntries].map(
      (entry) => entry.path
    ),
    truncated: globalResult.truncated || projectResult.truncated || totalBudgetResult.truncated
  }
}
