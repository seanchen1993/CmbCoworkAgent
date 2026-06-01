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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

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
export function hasWorkspaceBeenInitialised(workspacePath: string | undefined): boolean {
  if (!workspacePath) return true // No workspace → no init concept; treat as done.
  try {
    const p = getStatePath(workspacePath)
    if (!existsSync(p)) return false
    const raw = readFileSync(p, "utf-8")
    const parsed = JSON.parse(raw) as SetupState
    return typeof parsed.initialisedAt === "string" && parsed.initialisedAt.length > 0
  } catch {
    return false
  }
}

/**
 * Write the setup-state marker. Idempotent: silently overwrites an existing
 * file (in the unusual case where a maintenance run wants to refresh the
 * timestamp). Caller should only invoke after Setup hooks completed without
 * fatal blocking; we never want to mark "initialised" if a hook crashed early.
 */
export function markWorkspaceInitialised(workspacePath: string | undefined): void {
  if (!workspacePath) return
  try {
    const p = getStatePath(workspacePath)
    const dir = dirname(p)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const state: SetupState = { initialisedAt: new Date().toISOString() }
    writeFileSync(p, JSON.stringify(state, null, 2), "utf-8")
  } catch (e) {
    console.warn(`[Setup] failed to persist init state for ${workspacePath}:`, e)
  }
}
