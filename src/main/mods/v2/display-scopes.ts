import { randomUUID } from "node:crypto"
import type { ThreadIncarnation } from "../../services/thread-incarnation"
import { normalizeWorkspacePathKey } from "../../../shared/workspace-path"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

const scopeBrand: unique symbol = Symbol("FunctionDisplayScope")
export interface FunctionDisplayScope {
  readonly id: string
  readonly [scopeBrand]: true
}
export interface FunctionDisplayScopeInput {
  database: object
  workspace: string
  threadId: string
  incarnation: ThreadIncarnation
  /** Must recheck the current database, native thread incarnation and workspace. */
  assertCurrent(): void
}
interface ScopeEntry {
  key: string
  scope: FunctionDisplayScope
  assertCurrent(): void
}

/** Main-owned identities; a renderer's scope ID is never proof of current authority. */
export class FunctionDisplayScopes {
  private readonly databases = new WeakMap<object, string>()
  private readonly entries = new Map<string, ScopeEntry>()
  private readonly identities = new Map<string, string>()

  capture(input: FunctionDisplayScopeInput): FunctionDisplayScope {
    input.assertCurrent()
    if (
      !input.database ||
      typeof input.database !== "object" ||
      !input.threadId ||
      !input.workspace ||
      !Number.isFinite(input.incarnation.legacyCreatedAt)
    )
      throw new ModFunctionError("MODS_DISPLAY_SCOPE_INVALID")
    let database = this.databases.get(input.database)
    if (!database) {
      database = randomUUID()
      this.databases.set(input.database, database)
    }
    const key = JSON.stringify([
      database,
      normalizeWorkspacePathKey(input.workspace),
      input.threadId,
      input.incarnation.token,
      input.incarnation.legacyCreatedAt
    ])
    const prior = this.identities.get(key)
    if (prior) {
      const entry = this.entries.get(prior)
      if (entry) {
        try {
          this.assertCurrent(entry.scope)
          return entry.scope
        } catch {
          /* A retired scope can only be replaced by a fresh identity. */
        }
      }
    }
    if (this.entries.size >= 256) throw new ModFunctionError("MODS_DISPLAY_SCOPE_LIMIT")
    input.assertCurrent()
    const scope: FunctionDisplayScope = Object.freeze({
      id: randomUUID(),
      [scopeBrand]: true as const
    })
    this.entries.set(scope.id, { key, scope, assertCurrent: input.assertCurrent })
    this.identities.set(key, scope.id)
    return scope
  }

  assertCurrent(scope: FunctionDisplayScope): void {
    const entry = this.entries.get(scope.id)
    if (!entry || entry.scope !== scope) throw new ModFunctionError("MODS_DISPLAY_SCOPE_CHANGED")
    try {
      entry.assertCurrent()
    } catch (error) {
      this.deleteScope(scope.id)
      throw error
    }
  }

  read(scopeId: string): FunctionDisplayScope | undefined {
    const scope = this.entries.get(scopeId)?.scope
    if (scope) this.assertCurrent(scope)
    return scope
  }

  deleteScope(scopeId: string): void {
    const entry = this.entries.get(scopeId)
    if (!entry) return
    this.entries.delete(scopeId)
    if (this.identities.get(entry.key) === scopeId) this.identities.delete(entry.key)
  }

  clear(): void {
    this.entries.clear()
    this.identities.clear()
  }
}
