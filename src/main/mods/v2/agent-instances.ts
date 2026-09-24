import type { FunctionAgentInfo } from "../../../shared/mods/v2/agent-list"
import { validateFunctionAgentList } from "../../../shared/mods/v2/agent-list"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { ModJson } from "../../../shared/mods/types"

type Scope = { workspace: string; threadId: string }
type Terminal = "completed" | "failed" | "killed"
type Entry = Scope & { rows: Map<string, FunctionAgentInfo>; unavailable: boolean }

/** Host observations only. Bounded bookkeeping must never stop the original native task. */
export class FunctionAgentInstances {
  private readonly scopes = new Map<string, Entry>()
  private overflow = false
  constructor(private readonly limits = { maxAgents: 100, maxScopes: 100 }) {}
  private key(scope: Scope): string {
    return JSON.stringify([scope.workspace, scope.threadId])
  }

  start(scope: Scope, info: Omit<FunctionAgentInfo, "status">): (status: Terminal) => void {
    const key = this.key(scope)
    let entry = this.scopes.get(key)
    if (!entry) {
      if (this.scopes.size >= this.limits.maxScopes) {
        this.overflow = true
        return () => {}
      }
      entry = {
        workspace: scope.workspace,
        threadId: scope.threadId,
        rows: new Map(),
        unavailable: false
      }
      this.scopes.set(key, entry)
    }
    const row: FunctionAgentInfo = { ...info, status: "running" }
    try {
      validateFunctionAgentList([row] as unknown as ModJson)
    } catch {
      entry.unavailable = true
      return () => {}
    }
    if (!entry.rows.has(row.id) && entry.rows.size >= this.limits.maxAgents) {
      entry.unavailable = true
      return () => {}
    }
    entry.rows.set(row.id, row)
    const captured = entry
    return (status) => {
      if (
        this.scopes.get(key) !== captured ||
        captured.rows.get(row.id) !== row ||
        row.status !== "running"
      )
        return
      row.status = status
    }
  }

  list(scope: Scope): FunctionAgentInfo[] {
    const entry = this.scopes.get(this.key(scope))
    if (this.overflow || entry?.unavailable) throw new ModFunctionError("MODS_AGENT_LIST_LIMIT")
    return [...(entry?.rows.values() ?? [])].map((row) => ({ ...row }))
  }

  clear(workspace?: string, threadId?: string): void {
    if (workspace === undefined && threadId === undefined) {
      this.scopes.clear()
      this.overflow = false
      return
    }
    for (const [key, entry] of this.scopes)
      if (
        (workspace === undefined || entry.workspace === workspace) &&
        (threadId === undefined || entry.threadId === threadId)
      )
        this.scopes.delete(key)
  }
}
