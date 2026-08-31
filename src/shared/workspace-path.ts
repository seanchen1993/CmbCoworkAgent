/**
 * Canonical key for a workspace path, shared by the main process (per-workspace
 * task-card storage) and the renderer (cross-component sync events) so both sides
 * always agree on what counts as "the same workspace".
 *
 * Case-folding mirrors the existing path-key convention (src/main/hooks/path-key.ts):
 * only Windows is case-insensitive. On case-sensitive volumes (Linux build target,
 * case-sensitive macOS) `/repo/Foo` and `/repo/foo` are intentionally distinct.
 */
type GlobalWithPlatform = {
  process?: { platform?: string }
  window?: { electron?: { process?: { platform?: string } } }
}

function getPlatform(): string {
  const g = globalThis as GlobalWithPlatform
  // Prefer the explicit renderer bridge when a window exists. Node-based renderer
  // tests still expose the host process, which may not match the platform being simulated.
  return g.window?.electron?.process?.platform ?? g.process?.platform ?? ""
}

export function normalizeWorkspacePathKey(workspacePath: string | null | undefined): string {
  let normalized = (workspacePath || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
  const platform = getPlatform()
  if (platform === "darwin") {
    normalized = normalized.replace(/^\/private\/var\//, "/var/")
  }
  return platform === "win32" ? normalized.toLowerCase() : normalized
}

export function isSameWorkspacePath(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  const normalizedLeft = normalizeWorkspacePathKey(left)
  const normalizedRight = normalizeWorkspacePathKey(right)
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight)
}
