import { AsyncResource } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import type { IpcMain, IpcMainInvokeEvent, MessageBoxOptions } from "electron"
import type {
  ModApprovalSnapshot,
  ModApprovalRequest,
  ModApprovalSource
} from "../../shared/mods/approval-inbox"
import { ModError } from "../mods/errors"

type Scope = { workspace: string; threadId: string; modId: string }
type Pending = {
  key: string
  view: ModApprovalRequest
  signal: AbortSignal
  assertCurrent(): void
  finish(response: number, error?: unknown): void
}

/** Main-owned, ephemeral human decisions. Repeated callers never inherit an allow. */
export class ModApprovalInbox {
  private pending = new Map<string, Pending>()
  private paused = new Map<string, ModApprovalSource>()
  constructor(private changed: () => void) {}
  private notify() {
    try {
      this.changed()
    } catch {
      /* A remount reads the retained inbox; notification is not authority. */
    }
  }
  private key(scope: Scope) {
    // A rewrite must not evade a user pause by changing its digest.
    return JSON.stringify([scope.workspace, scope.threadId, scope.modId])
  }
  assertAllowed(scope: Scope) {
    const key = this.key(scope)
    if (this.paused.has(key)) throw new ModError("MODS_APPROVAL_PAUSED")
    if ([...this.pending.values()].some((row) => row.key === key))
      throw new ModError("MODS_APPROVAL_PENDING")
    if (this.pending.size >= 32 || this.paused.size >= 1024)
      throw new ModError("MODS_APPROVAL_CAPACITY")
  }
  request(
    scope: Scope,
    options: MessageBoxOptions,
    assertCurrent: () => void
  ): Promise<{ response: number }> {
    const signal = options.signal
    if (!signal) throw new ModError("MODS_APPROVAL_SIGNAL_REQUIRED")
    signal.throwIfAborted()
    assertCurrent()
    this.assertAllowed(scope)
    // Decisions arrive on renderer IPC, outside the original native execution context.
    const guard = AsyncResource.bind(assertCurrent)
    const key = this.key(scope)
    const requestId = randomUUID()
    const view: ModApprovalRequest = {
      id: randomUUID(),
      modId: scope.modId,
      threadId: scope.threadId,
      requestId,
      title: options.title ?? "灵件请求",
      message: options.message,
      detail: options.detail ?? "",
      allowLabel: options.buttons?.[1] ?? "允许本次请求",
      canViewRequest: options.buttons?.[2] === "查看完整请求"
    }
    return new Promise((resolve, reject) => {
      let settled = false
      const abort = () => finish(0, signal.reason ?? new ModError("MODS_CANCELLED"))
      const finish = (response: number, error?: unknown) => {
        if (settled) return
        settled = true
        signal.removeEventListener("abort", abort)
        this.pending.delete(requestId)
        if (error !== undefined) reject(error)
        else resolve({ response })
        this.notify()
      }
      this.pending.set(requestId, { key, view, signal, assertCurrent: guard, finish })
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
      else this.notify()
    })
  }
  prune(): void {
    for (const row of this.pending.values()) {
      try {
        row.signal.throwIfAborted()
        row.assertCurrent()
      } catch (error) {
        row.finish(0, error)
      }
    }
  }
  snapshot(): ModApprovalSnapshot {
    this.prune()
    const first = this.pending.values().next().value as Pending | undefined
    return {
      current: first ? { ...first.view } : null,
      queued: Math.max(0, this.pending.size - 1),
      paused: [...this.paused.values()].map((row) => ({ ...row }))
    }
  }
  decide(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new ModError("MODS_IPC_ARGUMENTS")
    const { requestId, decision } = input as Record<string, unknown>
    if (
      typeof requestId !== "string" ||
      typeof decision !== "string" ||
      !["allow", "deny", "details"].includes(decision)
    )
      throw new ModError("MODS_IPC_ARGUMENTS")
    const row = this.pending.get(requestId)
    if (!row) throw new ModError("MODS_APPROVAL_STALE")
    try {
      row.signal.throwIfAborted()
      row.assertCurrent()
    } catch (error) {
      row.finish(0, error)
      throw error
    }
    if (decision === "deny") {
      this.paused.set(row.key, {
        id: row.view.id,
        modId: row.view.modId,
        threadId: row.view.threadId
      })
      row.finish(0)
    } else if (decision === "allow") row.finish(1)
    else if (row.view.canViewRequest) row.finish(2)
    else throw new ModError("MODS_IPC_ARGUMENTS")
  }
  resume(sourceId: unknown) {
    if (typeof sourceId !== "string") throw new ModError("MODS_IPC_ARGUMENTS")
    const entry = [...this.paused].find(([, source]) => source.id === sourceId)
    if (!entry) throw new ModError("MODS_APPROVAL_STALE")
    this.paused.delete(entry[0])
    // Resuming permits future requests; it does not replay or approve any operation.
    this.notify()
  }
  reset() {
    for (const row of this.pending.values()) row.finish(0, new ModError("MODS_CANCELLED"))
    this.paused.clear()
    this.notify()
  }
}

export function registerModApprovalInbox(
  ipc: IpcMain,
  inbox: ModApprovalInbox,
  trusted: (event: IpcMainInvokeEvent) => void
) {
  ipc.handle("mods:approval-snapshot", (event) => {
    trusted(event)
    return inbox.snapshot()
  })
  ipc.handle("mods:approval-decide", (event, input: unknown) => {
    trusted(event)
    inbox.decide(input)
  })
  ipc.handle("mods:approval-resume", (event, input: unknown) => {
    trusted(event)
    inbox.resume(input)
  })
}
