import { access } from "fs/promises"

const DEFAULT_RECENT_WORKSPACE_PROBE_TIMEOUT_MS = 750

type WorkspaceAccess = (workspacePath: string) => Promise<void>

function normalizedWorkspaceSetting(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

async function probeWithinTimeout(
  workspacePath: string,
  accessWorkspace: WorkspaceAccess,
  timeoutMs: number
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      accessWorkspace(workspacePath).then(
        () => true,
        () => false
      ),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs)
        timeout.unref?.()
      })
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

/**
 * Resolve the workspace inherited by a newly-created task without ever probing
 * an offline UNC/network path synchronously on Electron's main event loop.
 *
 * The setting is read again after the asynchronous probe. If it changed while
 * I/O was in flight, retry the newest generation once instead of attaching the
 * stale path to the new task.
 */
export async function resolveRecentWorkspacePath(
  readCurrentWorkspace: () => unknown,
  options: {
    accessWorkspace?: WorkspaceAccess
    timeoutMs?: number
  } = {}
): Promise<string | null> {
  const accessWorkspace = options.accessWorkspace ?? access
  const timeoutMs = Math.max(
    1,
    Math.floor(options.timeoutMs ?? DEFAULT_RECENT_WORKSPACE_PROBE_TIMEOUT_MS)
  )

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const candidate = normalizedWorkspaceSetting(readCurrentWorkspace())
    if (!candidate) return null
    const accessible = await probeWithinTimeout(candidate, accessWorkspace, timeoutMs)
    const latest = normalizedWorkspaceSetting(readCurrentWorkspace())
    if (latest !== candidate) continue
    return accessible ? candidate : null
  }

  return null
}
