import type { ModObject } from "../../../shared/mods/types"

/** Methods whose native cores cannot start a worktree writer or an external execution. */
export const WORKTREE_OBSERVER_METHODS = [
  "session.id",
  "session.cwd",
  "session.root",
  "session.version",
  "session.surface",
  "session.surfaces",
  "session.repo",
  "session.model",
  "session.messages",
  "session.turns",
  "session.usage",
  "fs.ancestors",
  "fs.read",
  "fs.exists",
  "fs.stat",
  "fs.list",
  "clock.now",
  "clock.sleep",
  "store.get",
  "store.set",
  "store.delete",
  "store.keys",
  "state.get",
  "state.set",
  "ui.log",
  "settings.read",
  "config.list",
  "env.get"
] as const

/** Host facts only. Client ids identify a roster row, never a renderer or grant credential. */
export interface NativeDesktopBinding {
  readonly threadId: string
  readonly owner: string
  readonly senderId: number
  readonly clientId: string
}

export interface NativeDesktopChange {
  readonly event: "session.attach" | "session.detach"
  readonly binding: NativeDesktopBinding
  readonly input: ModObject
}

/** Captured by the real workflow ledger immediately before its conservative removal attempt. */
export interface NativeWorktreeRemoval {
  readonly workspace: string
  readonly threadId: string
  readonly runId: string
  readonly path: string
}

export interface NativeWorktreeObserver {
  observe(facts: NativeWorktreeRemoval, signal?: AbortSignal): Promise<void>
}
