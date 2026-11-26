/**
 * PR-11 — Per-workspace Setup hook state.
 *
 * Setup is a workspace-level event (CC's repo init/maintenance concept), not a
 * thread-level one. If we used SessionStart-style per-thread dedupe every new
 * thread in the same workspace would re-fire `Setup({trigger:"init"})`. We
 * persist a tiny marker file in the workspace so init fires exactly once per
 * workspace per machine.
 *
 *   <workspacePath>/.cmbdevclaw/setup-state.json
 *
 * Schema: `{ "initialisedAt": "<ISO>" }`. The file's presence is the dedupe
 * signal; the timestamp is informational. The file is written **after** the
 * Setup hook returns so a crashed/blocked hook does not skip future retries.
 *
 * Co-located with workspace hooks under `<workspacePath>/.cmbdevclaw/` so the
 * whole workspace-local state lives in one directory. The home-level config
 * directory `~/.cmbcoworkagent/` (global hooks etc.) is intentionally a
 * different name; this constant is only ever joined with a workspace path.
 */

import { constants } from "node:fs"
import { mkdir, open, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { waitForAbort } from "../utils/wait-for-abort"

const STATE_DIR = ".cmbdevclaw"
const STATE_FILE = "setup-state.json"

interface SetupState {
  initialisedAt?: string
}

function getStatePath(workspacePath: string): string {
  return join(workspacePath, STATE_DIR, STATE_FILE)
}

/**
 * Returns true when the workspace already has a setup-state marker, false
 * otherwise. Read errors (corrupt JSON, perm denied) intentionally return
 * `false` — better to re-init than skip silently if state is unreadable.
 */
export async function hasWorkspaceBeenInitialised(
  workspacePath: string | undefined,
  signal?: AbortSignal
): Promise<boolean> {
  if (!workspacePath) return true // No workspace → no init concept; treat as done.
  try {
    const read = readFile(getStatePath(workspacePath), { encoding: "utf8", signal })
    const raw = await waitForAbort(read, signal)
    const parsed = JSON.parse(raw) as SetupState
    return typeof parsed.initialisedAt === "string" && parsed.initialisedAt.length > 0
  } catch {
    return false
  }
}

/**
 * Record successful Setup. An already valid marker needs no refresh.
 * Caller should only invoke after Setup hooks completed without
 * fatal blocking; we never want to mark "initialised" if a hook crashed early.
 */
export async function markWorkspaceInitialised(workspacePath: string | undefined): Promise<void> {
  if (!workspacePath) return
  const path = getStatePath(workspacePath)
  try {
    await mkdir(dirname(path), { recursive: true })
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT)
    try {
      const { size } = await file.stat()
      if (size > 0 && await hasWorkspaceBeenInitialised(workspacePath)) return
      const state: SetupState = { initialisedAt: new Date().toISOString() }
      const data = JSON.stringify(state, null, 2)
      // All generated markers have the same byte length. Concurrent retries overwrite
      // from offset zero without emptying a valid marker first. Trim old corrupt tails last.
      await file.writeFile(data, "utf8")
      if (size > Buffer.byteLength(data)) await file.truncate(Buffer.byteLength(data))
    } finally {
      await file.close()
    }
  } catch (e) {
    console.warn(`[Setup] failed to persist init state for ${workspacePath}:`, e)
  }
}
