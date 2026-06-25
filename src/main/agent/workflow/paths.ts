import { realpathSync } from "fs"
import { dirname, isAbsolute, relative, resolve } from "path"
import { WorkflowFatalError, WorkflowScriptError } from "./types"

export function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel))
}

export function resolveExistingWorkspacePath(
  workspacePath: string,
  requested: string,
  label: string
): string {
  const requestedPath = resolve(workspacePath, requested)
  let workspaceRoot: string
  let resolved: string
  try {
    workspaceRoot = realpathSync(resolve(workspacePath))
    resolved = realpathSync(requestedPath)
  } catch {
    throw new WorkflowScriptError(`${label} not found at ${requestedPath}`)
  }
  if (!isPathInside(workspaceRoot, resolved)) {
    throw new WorkflowFatalError(`${label} must stay inside the workspace (got "${requested}")`)
  }
  return resolved
}

/** For WRITES: the target file may not exist yet, so we can't realpath IT. Resolve
 * lexically under the realpath'd workspace root, reject lexical escapes, then
 * realpath the nearest EXISTING ancestor and re-check — so a symlinked parent
 * directory can't redirect the write outside the workspace. Returns the (possibly
 * not-yet-existing) absolute target path. */
export function resolveWorkspaceWritePath(
  workspacePath: string,
  requested: string,
  label: string
): string {
  let workspaceRoot: string
  try {
    workspaceRoot = realpathSync(resolve(workspacePath))
  } catch {
    throw new WorkflowFatalError(`${label}: workspace root not found`)
  }
  const resolved = resolve(workspaceRoot, requested)
  if (!isPathInside(workspaceRoot, resolved)) {
    throw new WorkflowFatalError(`${label} must stay inside the workspace (got "${requested}")`)
  }
  // Walk up to the nearest existing ancestor and realpath it; catches a symlinked
  // parent that would redirect the write outside the workspace.
  let dir = dirname(resolved)
  while (dir !== dirname(dir)) {
    try {
      const realDir = realpathSync(dir)
      if (realDir !== workspaceRoot && !isPathInside(workspaceRoot, realDir)) {
        throw new WorkflowFatalError(
          `${label} resolves outside the workspace via a symlinked parent`
        )
      }
      break
    } catch (error) {
      if (error instanceof WorkflowFatalError) throw error
      dir = dirname(dir) // ancestor doesn't exist yet — keep walking up
    }
  }
  // The TARGET itself may be a pre-existing symlink — fsp.stat()/writeFile() would
  // follow it. The parent-symlink walk above does NOT cover this. If the target
  // exists, realpath it and re-check containment, so a symlink INSIDE the
  // workspace that points OUT can't redirect the write outside. A not-yet-existing
  // target (the normal create path) realpathSync-throws and keeps the lexical path.
  try {
    const realTarget = realpathSync(resolved)
    if (!isPathInside(workspaceRoot, realTarget)) {
      throw new WorkflowFatalError(`${label} resolves outside the workspace via a symlinked target`)
    }
    return realTarget
  } catch (error) {
    if (error instanceof WorkflowFatalError) throw error
    return resolved // target doesn't exist yet — safe to create at the lexical path
  }
}
