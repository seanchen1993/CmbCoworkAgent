import { ModError } from "./errors"

const authorityBrand = Symbol("mod-runtime-authority")

export interface ModRuntimeScope {
  workspace: string
  threadId: string
  turnId: string
  agentId?: string
}

/** Host-only object identity. Never include this object in guest events or persisted identities. */
export interface ModRuntimeAuthority extends Readonly<ModRuntimeScope> {
  readonly [authorityBrand]: true
  readonly agentId: string
  readonly parentCallId?: string
  assertLive(): void
}

export function assertModRuntimeAuthority(
  authority: ModRuntimeAuthority,
  scope: ModRuntimeScope
): void {
  authority.assertLive()
  if (
    authority.workspace !== scope.workspace ||
    authority.threadId !== scope.threadId ||
    authority.turnId !== scope.turnId ||
    authority.agentId !== (scope.agentId ?? "main")
  )
    throw new ModError("MODS_RUNTIME_SCOPE_CHANGED")
}

interface Entry {
  authority: ModRuntimeAuthority
  parent?: Entry
  children: Set<Entry>
  release(): void
}

/** One authority per physical runtime, independently of temporary native/MCP adapter leases. */
export class ModRuntimeAuthorities {
  private readonly entries = new Map<string, Entry>()
  private readonly owners = new WeakMap<ModRuntimeAuthority, Entry>()
  private closed = false

  private key(scope: Pick<ModRuntimeScope, "workspace" | "threadId" | "agentId">): string {
    return JSON.stringify([scope.workspace, scope.threadId, scope.agentId ?? "main"])
  }

  create(
    scope: ModRuntimeScope,
    signal?: AbortSignal,
    parent?: ModRuntimeAuthority,
    parentCallId?: string
  ): { authority: ModRuntimeAuthority; release(): void } {
    if (this.closed) throw new ModError("MODS_RUNTIME_CLOSED")
    signal?.throwIfAborted()
    parent?.assertLive()
    const parentEntry = parent && this.owners.get(parent)
    if (parent && (!parentEntry || parent.workspace !== scope.workspace))
      throw new ModError("MODS_RUNTIME_SCOPE_CHANGED")
    const key = this.key(scope)
    for (let ancestor = parentEntry; ancestor; ancestor = ancestor.parent)
      if (key === this.key(ancestor.authority)) throw new ModError("MODS_RUNTIME_SCOPE_CHANGED")
    this.entries.get(key)?.release()
    if (this.entries.size >= 100) throw new ModError("MODS_RUNTIME_CAPACITY")
    const authority: ModRuntimeAuthority = Object.freeze({
      [authorityBrand]: true as const,
      workspace: scope.workspace,
      threadId: scope.threadId,
      turnId: scope.turnId,
      agentId: scope.agentId ?? "main",
      ...(parentCallId ? { parentCallId } : {}),
      assertLive: () => {
        if (this.closed || this.entries.get(key) !== entry)
          throw new ModError("MODS_RUNTIME_INSTANCE_EXPIRED")
        signal?.throwIfAborted()
        parent?.assertLive()
      }
    })
    const entry: Entry = {
      authority,
      parent: parentEntry,
      children: new Set(),
      release: () => {
        signal?.removeEventListener("abort", entry.release)
        for (const child of [...entry.children]) child.release()
        parentEntry?.children.delete(entry)
        if (this.entries.get(key) === entry) this.entries.delete(key)
      }
    }
    this.entries.set(key, entry)
    this.owners.set(authority, entry)
    parentEntry?.children.add(entry)
    signal?.addEventListener("abort", entry.release, { once: true })
    if (signal?.aborted) entry.release()
    authority.assertLive()
    return { authority, release: entry.release }
  }

  get(scope: Pick<ModRuntimeScope, "workspace" | "threadId" | "agentId">) {
    const authority = this.entries.get(this.key(scope))?.authority
    authority?.assertLive()
    return authority
  }

  closeThread(threadId: string): void {
    for (const entry of [...this.entries.values()])
      if (entry.authority.threadId === threadId) entry.release()
  }

  close(): void {
    this.closed = true
    for (const entry of [...this.entries.values()]) entry.release()
  }
}
