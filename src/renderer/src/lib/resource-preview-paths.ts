import type { WorkspaceFilePreviewWorkspacePathKind } from "../../../shared/workspace-file-preview"

export interface ResolvedResourcePreviewPaths {
  inputPath: string
  fullPath: string
  workspaceFilePath: string
  workspacePathKind: WorkspaceFilePreviewWorkspacePathKind
  inWorkspace: boolean
  workspaceKnown: boolean
  inputIsAbsolute: boolean
}

export interface ResourcePreviewFileSourceProps {
  filePath: string
  externalFullPath?: string
  workspacePathKind?: WorkspaceFilePreviewWorkspacePathKind
}

function comparisonPath(filePath: string, windowsStyle: boolean): string {
  return windowsStyle ? filePath.toLocaleLowerCase("en-US") : filePath
}

function isWindowsAbsolutePath(filePath: string): boolean {
  return (
    /^[a-zA-Z]:\//.test(filePath) ||
    /^\/\/[^/]+\/[^/]+(?:\/|$)/.test(filePath) ||
    /^\/\/\?\/UNC\/[^/]+\/[^/]+(?:\/|$)/i.test(filePath)
  )
}

function trimWorkspaceTrailingSeparators(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/")
  if (normalized === "/" || /^[a-zA-Z]:\/$/.test(normalized)) return normalized
  return normalized.replace(/\/+$/, "")
}

function isPathWithinWorkspace(fullPath: string, workspace: string): boolean {
  const windowsStyle = isWindowsAbsolutePath(fullPath) && isWindowsAbsolutePath(workspace)
  const comparableFullPath = comparisonPath(fullPath, windowsStyle)
  const comparableWorkspace = comparisonPath(workspace, windowsStyle)
  const workspaceBoundary = comparableWorkspace.endsWith("/")
    ? comparableWorkspace
    : `${comparableWorkspace}/`
  return (
    comparableFullPath === comparableWorkspace || comparableFullPath.startsWith(workspaceBoundary)
  )
}

/**
 * Infer ordinary OS path semantics for tool arguments. File-tree callers must
 * pass `relative` explicitly because their historical `/src/file.ts` values
 * are index keys, not POSIX absolute paths.
 */
export function inferWorkspacePreviewPathKind(
  filePath: string,
  platform: NodeJS.Platform = "linux"
): Exclude<WorkspaceFilePreviewWorkspacePathKind, "auto"> {
  const input = filePath.trim()
  const normalized = input.replace(/\\/g, "/")
  if (isWindowsAbsolutePath(normalized)) return "absolute"
  if (platform === "win32") return /^[\\/]/.test(input) ? "absolute" : "relative"
  return input.startsWith("/") ? "absolute" : "relative"
}

export function resolveResourcePreviewPaths(
  filePath: string,
  workspacePath: string | null,
  platform: NodeJS.Platform = "linux",
  requestedPathKind?: WorkspaceFilePreviewWorkspacePathKind
): ResolvedResourcePreviewPaths {
  const input = filePath.trim().replace(/\\/g, "/")
  const workspacePathKind = requestedPathKind ?? inferWorkspacePreviewPathKind(filePath, platform)
  const inputIsAbsolute = inferWorkspacePreviewPathKind(filePath, platform) === "absolute"
  if (!workspacePath) {
    return {
      inputPath: input,
      fullPath: input,
      workspaceFilePath: input,
      workspacePathKind,
      inWorkspace: false,
      workspaceKnown: false,
      inputIsAbsolute
    }
  }

  const workspace = trimWorkspaceTrailingSeparators(workspacePath)
  const absoluteCandidateIsInWorkspace = inputIsAbsolute && isPathWithinWorkspace(input, workspace)
  const resolveAgainstWorkspace =
    workspacePathKind === "relative" ||
    (workspacePathKind === "auto" && !absoluteCandidateIsInWorkspace)
  const workspaceSeparator = workspace.endsWith("/") ? "" : "/"
  const fullPath = resolveAgainstWorkspace
    ? `${workspace}${workspaceSeparator}${input.replace(/^\/+/, "")}`
    : input
  const inWorkspace = isPathWithinWorkspace(fullPath, workspace)

  if (!inWorkspace) {
    return {
      inputPath: input,
      fullPath,
      workspaceFilePath: input,
      workspacePathKind,
      inWorkspace: false,
      workspaceKnown: true,
      inputIsAbsolute
    }
  }

  const relativePath = fullPath.slice(workspace.length).replace(/^\/+/, "")
  return {
    inputPath: input,
    fullPath,
    workspaceFilePath: `/${relativePath}`,
    workspacePathKind,
    inWorkspace: true,
    workspaceKnown: true,
    inputIsAbsolute
  }
}

/**
 * A missing renderer-side workspace path is not proof that a file is external:
 * thread metadata is restored asynchronously. During that window, keep an
 * ungranted request on the workspace route and let the main process resolve the
 * authoritative workspace root. Once the workspace is known, an outside path
 * still requires an explicit main-issued capability.
 */
export function selectResourcePreviewFileSource(
  resolved: ResolvedResourcePreviewPaths,
  hasExternalAuthorization: boolean
): ResourcePreviewFileSourceProps {
  if (hasExternalAuthorization) {
    const externalPath = resolved.inputIsAbsolute ? resolved.inputPath : resolved.fullPath
    return { filePath: externalPath, externalFullPath: externalPath }
  }
  if (resolved.inWorkspace || !resolved.workspaceKnown) {
    return {
      filePath: resolved.inputPath,
      workspacePathKind: resolved.workspacePathKind
    }
  }
  // The renderer knows this path is outside the hydrated workspace, but it has
  // no trusted-source capability. Keep it on the external route so FileViewer
  // rejects it before issuing any disk request.
  return { filePath: resolved.fullPath, externalFullPath: resolved.fullPath }
}
