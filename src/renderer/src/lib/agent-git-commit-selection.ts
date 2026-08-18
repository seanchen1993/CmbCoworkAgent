export interface CommitSelectionFile {
  path: string
  previousPath?: string
  status?: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked"
}

export interface CommitSelectionOptions {
  suggestedBasePath?: string
  repositoryRootPath?: string
  suggestedPathKind?: "pathspec" | "staged"
  workspacePath?: string | null
  targetWorktreePath?: string
}

export const AGENT_COMMIT_NO_ELIGIBLE_FILES_MESSAGE =
  "Agent 指定的文件均被 Git ignore，未发起提交。"

export function shouldAutoDismissEmptyAgentCommitSelection(options: {
  selectionSource?: "pathspec" | "staged"
  suggestedPathCount: number
  selectedPathCount: number
  loading: boolean
  failed: boolean
}): boolean {
  return (
    options.selectionSource === "pathspec" &&
    options.suggestedPathCount > 0 &&
    options.selectedPathCount === 0 &&
    !options.loading &&
    !options.failed
  )
}

export function normalizeCommitPath(filePath: string): string {
  if (filePath === ".") return filePath
  return filePath.replace(/^\.\//, "").replace(/\/+$/, "")
}

interface ParsedFsPath {
  root: string
  segments: string[]
  caseInsensitive: boolean
}

function parseFsPath(filePath: string): ParsedFsPath {
  const hasWindowsRoot =
    /^[A-Za-z]:[\\/]/.test(filePath) ||
    /^\\\\/.test(filePath) ||
    /^\/\/(?:\?\/|[^/]+\/[^/]+(?:\/|$))/.test(filePath)
  const normalized = hasWindowsRoot ? filePath.replace(/\\/g, "/") : filePath
  const extendedUncMatch = normalized.match(/^\/\/\?\/UNC\/([^/]+)\/([^/]+)(?:\/|$)/i)
  const extendedDriveMatch = normalized.match(/^\/\/\?\/([A-Za-z]:)(?:\/|$)/)
  const uncMatch = normalized.match(/^\/\/([^/]+)\/([^/]+)(?:\/|$)/)
  const driveMatch = normalized.match(/^([A-Za-z]:)(?:\/|$)/)
  let root = ""
  let rest = normalized
  let caseInsensitive = false
  if (extendedUncMatch) {
    root = `//?/UNC/${extendedUncMatch[1]}/${extendedUncMatch[2]}/`
    rest = normalized.slice(extendedUncMatch[0].length)
    caseInsensitive = true
  } else if (extendedDriveMatch) {
    root = `//?/${extendedDriveMatch[1]}/`
    rest = normalized.slice(extendedDriveMatch[0].length)
    caseInsensitive = true
  } else if (uncMatch) {
    root = `//${uncMatch[1]}/${uncMatch[2]}/`
    rest = normalized.slice(uncMatch[0].length)
    caseInsensitive = true
  } else if (driveMatch) {
    root = `${driveMatch[1]}/`
    rest = normalized.slice(driveMatch[0].length)
    caseInsensitive = true
  } else if (normalized.startsWith("/")) {
    root = "/"
    rest = normalized.replace(/^\/+/, "")
  }
  const segments: string[] = []
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue
    if (part === ".." && segments.length > 0 && segments[segments.length - 1] !== "..") {
      segments.pop()
      continue
    }
    if (part !== ".." || !root) segments.push(part)
  }
  return { root, segments, caseInsensitive }
}

function collapseFsPath(filePath: string): string {
  const parsed = parseFsPath(filePath)
  return `${parsed.root}${parsed.segments.join("/")}` || parsed.root
}

function isAbsoluteFsPath(filePath: string, referencePath?: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(filePath)) {
    return referencePath ? fsPathParts(referencePath).caseInsensitive : true
  }
  return filePath.startsWith("/") || filePath.startsWith("\\\\")
}

function resolveFsPath(basePath: string, filePath: string): string {
  if (isAbsoluteFsPath(filePath, basePath)) return collapseFsPath(filePath)
  const normalizedBase = fsPathParts(basePath).caseInsensitive
    ? basePath.replace(/\\/g, "/")
    : basePath
  return collapseFsPath(`${normalizedBase.replace(/\/+$/, "")}/${filePath}`)
}

function fsPathParts(filePath: string): ParsedFsPath {
  const parsed = parseFsPath(filePath)
  const extendedUncRoot = parsed.root.match(/^\/\/\?\/UNC\/([^/]+)\/([^/]+)\/$/i)
  const extendedDriveRoot = parsed.root.match(/^\/\/\?\/([A-Za-z]:)\/$/)
  const comparableRoot = extendedUncRoot
    ? `//${extendedUncRoot[1]}/${extendedUncRoot[2]}/`
    : extendedDriveRoot
      ? `${extendedDriveRoot[1]}/`
      : parsed.root
  return {
    ...parsed,
    root: parsed.caseInsensitive ? comparableRoot.toLowerCase() : comparableRoot
  }
}

function relativePathWithin(basePath: string, targetPath: string): string | null {
  const base = fsPathParts(basePath)
  const target = fsPathParts(targetPath)
  if (base.root !== target.root) return null
  const caseInsensitive = base.caseInsensitive && target.caseInsensitive
  let common = 0
  while (
    common < base.segments.length &&
    common < target.segments.length &&
    (caseInsensitive
      ? base.segments[common].toLowerCase() === target.segments[common].toLowerCase()
      : base.segments[common] === target.segments[common])
  ) {
    common += 1
  }
  if (common < base.segments.length) return null
  return target.segments.slice(common).join("/") || "."
}

/**
 * Prefer the repository root so pathspecs from a nested Git cwd cannot alias a
 * same-named file inside that subdirectory. When the configured workspace is itself
 * only a subdirectory of a parent repository, clamp the target to the workspace so
 * the commit dialog never expands its review/commit scope beyond the user's workspace.
 */
export function resolveCommitWorktreePath(
  workspacePath?: string | null,
  repositoryRootPath?: string
): string | undefined {
  const workspace = workspacePath?.trim() ? collapseFsPath(workspacePath) : ""
  const repositoryRoot = repositoryRootPath?.trim() ? collapseFsPath(repositoryRootPath) : ""
  if (!repositoryRoot) return workspace || undefined
  if (!workspace) return repositoryRoot
  const repositoryWithinWorkspace = relativePathWithin(workspace, repositoryRoot)
  if (repositoryWithinWorkspace !== null) {
    return repositoryWithinWorkspace === "."
      ? workspace
      : resolveFsPath(workspace, repositoryWithinWorkspace)
  }
  return workspace
}

function normalizeSuggestedCommitPath(
  filePath: string,
  basePath?: string,
  repositoryRootPath?: string,
  suggestedPathKind?: "pathspec" | "staged",
  workspacePath?: string | null,
  targetWorktreePath?: string
): string {
  const normalized = normalizeCommitPath(filePath)
  if (!normalized) return ""
  const repositoryRelative = suggestedPathKind !== "staged" && normalized.startsWith(":/")
  const pathWithoutMagic = repositoryRelative
    ? normalizeCommitPath(normalized.slice(2)) || "."
    : normalized
  if (!workspacePath && !targetWorktreePath && !(repositoryRelative && repositoryRootPath)) {
    return pathWithoutMagic
  }
  if (repositoryRelative && !repositoryRootPath) return ""
  const absolutePath = repositoryRelative
    ? resolveFsPath(repositoryRootPath as string, pathWithoutMagic)
    : isAbsoluteFsPath(
          pathWithoutMagic,
          basePath ?? targetWorktreePath ?? workspacePath ?? repositoryRootPath
        )
      ? collapseFsPath(pathWithoutMagic)
      : basePath
        ? resolveFsPath(basePath, pathWithoutMagic)
        : null
  if (!absolutePath) return pathWithoutMagic
  if (targetWorktreePath) {
    const targetRelative = relativePathWithin(targetWorktreePath, absolutePath)
    if (targetRelative) return normalizeCommitPath(targetRelative)
    return ""
  }
  return normalizeCommitPath(
    workspacePath ? (relativePathWithin(workspacePath, absolutePath) ?? normalized) : normalized
  )
}

function hasUnsupportedGitPathspecSyntax(filePath: string): boolean {
  const normalized = filePath
  const withoutTopMagic = normalized.startsWith(":/") ? normalized.slice(2) : normalized
  if (!normalized.startsWith(":/") && normalized.startsWith(":")) return true
  if (normalized.startsWith(":/") && /^[/!^:]/.test(withoutTopMagic)) return true
  if (withoutTopMagic.startsWith("//?/")) return false
  return ["*", "?", "["].some((marker) => withoutTopMagic.includes(marker))
}

function pathMatchesNormalizedSelection(filePath: string, normalizedSelection: string): boolean {
  const candidate = normalizeCommitPath(filePath)
  return (
    normalizedSelection === "." ||
    candidate === normalizedSelection ||
    candidate.startsWith(`${normalizedSelection}/`)
  )
}

export function pathMatchesSelection(file: CommitSelectionFile, selectedPath: string): boolean {
  const normalizedSelected = normalizeCommitPath(selectedPath)
  if (!normalizedSelected) return false
  const paths = file.status === "renamed" ? [file.path, file.previousPath] : [file.path]
  return paths
    .filter((item): item is string => Boolean(item))
    .some((candidate) => pathMatchesNormalizedSelection(candidate, normalizedSelected))
}

export function pathsForCommitSelectionFile(file: CommitSelectionFile): string[] {
  const paths = file.status === "renamed" ? [file.previousPath, file.path] : [file.path]
  return paths
    .filter((item): item is string => Boolean(item))
    .map(normalizeCommitPath)
    .filter(Boolean)
}

/**
 * Build the Agent commit dialog's initial selection from Git's changed-file list.
 *
 * Once `allChangedFiles` is available it is authoritative: suggested pathspecs that Git
 * omitted (for example ignored untracked, clean, or nonexistent paths) are discarded instead of
 * being sent back to the commit IPC. Suggestions may still name a directory, so expand
 * them to the matching changed files rather than requiring an exact file-name match.
 */
export function buildInitialSelectedPaths(
  files: CommitSelectionFile[],
  suggestedFilePaths?: string[],
  allChangedFiles?: string[],
  options?: CommitSelectionOptions
): Set<string> {
  const hasExplicitSuggestions =
    (suggestedFilePaths?.length ?? 0) > 0 || options?.suggestedPathKind === "staged"
  if (
    options?.suggestedPathKind !== "staged" &&
    (suggestedFilePaths ?? []).some(hasUnsupportedGitPathspecSyntax)
  ) {
    return new Set()
  }
  const suggested = Array.from(
    new Set(
      (suggestedFilePaths ?? [])
        .map((filePath) =>
          normalizeSuggestedCommitPath(
            filePath,
            options?.suggestedBasePath,
            options?.repositoryRootPath,
            options?.suggestedPathKind,
            options?.workspacePath,
            options?.targetWorktreePath
          )
        )
        .filter(Boolean)
    )
  )
  if (suggested.length === 0) {
    if (hasExplicitSuggestions) return new Set()
    const fallbackFiles = Array.isArray(allChangedFiles)
      ? allChangedFiles
      : files.map((file) => file.path)
    return new Set(fallbackFiles.map(normalizeCommitPath).filter(Boolean))
  }

  const normalizedChangedFiles = Array.from(
    new Set((allChangedFiles ?? []).map(normalizeCommitPath).filter(Boolean))
  )
  const changedFileSet = new Set(normalizedChangedFiles)
  const changedFilesByDirectory = new Map<string, string[]>()
  for (const changedPath of normalizedChangedFiles) {
    const parts = changedPath.split("/")
    let directory = ""
    for (let index = 0; index < parts.length - 1; index += 1) {
      directory = directory ? `${directory}/${parts[index]}` : parts[index]
      const descendants = changedFilesByDirectory.get(directory)
      if (descendants) descendants.push(changedPath)
      else changedFilesByDirectory.set(directory, [changedPath])
    }
  }
  const selected = new Set<string>()
  for (const suggestedPath of suggested) {
    if (changedFileSet.has(suggestedPath)) {
      selected.add(suggestedPath)
      continue
    }
    const descendants =
      suggestedPath === "." ? normalizedChangedFiles : changedFilesByDirectory.get(suggestedPath)
    for (const changedPath of descendants ?? []) selected.add(changedPath)
  }

  // Before the async Git file list arrives, preserve the suggestion for the loading UI.
  // Submission remains blocked during that state. Once even an empty authoritative list
  // arrives, unmatched suggestions must stay out of the commit request.
  if (!Array.isArray(allChangedFiles) && files.length === 0) {
    for (const suggestedPath of suggested) selected.add(suggestedPath)
  }

  return selected
}
