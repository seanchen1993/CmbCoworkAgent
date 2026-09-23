import { randomUUID } from "node:crypto"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

export interface FunctionNoticeDialog {
  toolUseId: string
  requestId: string
  /** Undefined denotes a native model call, not another plugin's SDK call. */
  owner?: string
}
export interface FunctionNoticeDialogAccess {
  lookup(toolUseId: string): FunctionNoticeDialog | undefined
  subscribeClosed(listener: (requestId: string) => void): () => void
}
export interface FunctionNoticeEntry {
  id: string
  plugin: string
  kind: "notice"
  requestId: string
  toolUseId: string
  text: string
}
interface Ticket {
  readonly key: string
  readonly plugin: string
  readonly toolUseId: string
  readonly requestId: string
  readonly revision: number
}

/** Host-owned open-dialog annotations. They have no permission or answer capability. */
export class FunctionUiNotices {
  private readonly entries = new Map<string, FunctionNoticeEntry>()
  private readonly order = new Map<
    string,
    { requestId: string; requested: number; committed: number }
  >()
  private readonly pending = new Set<Ticket>()
  private readonly unsubscribe: () => void
  private notification?: ReturnType<typeof setTimeout>
  private closed = false

  constructor(
    private readonly dialogs: FunctionNoticeDialogAccess,
    private readonly changed: () => void
  ) {
    this.unsubscribe = dialogs.subscribeClosed((requestId) => {
      let removed = false
      for (const [key, entry] of this.entries)
        if (entry.requestId === requestId) {
          this.entries.delete(key)
          removed = true
        }
      for (const [key, entry] of this.order)
        if (entry.requestId === requestId) this.order.delete(key)
      if (removed) this.notify()
    })
  }

  private open(plugin: string, toolUseId: string): FunctionNoticeDialog {
    if (this.closed) throw new ModFunctionError("MODS_SESSION_CLOSED")
    const dialog = this.dialogs.lookup(toolUseId)
    if (!dialog) throw new ModFunctionError("MODS_UI_NOTICE_CLOSED")
    if (dialog.owner && dialog.owner !== `function:${plugin}`)
      throw new ModFunctionError("MODS_UI_NOTICE_OWNER")
    return dialog
  }

  reserve(plugin: string, toolUseId: string): Ticket {
    const dialog = this.open(plugin, toolUseId)
    if (this.pending.size >= 32) throw new ModFunctionError("MODS_UI_NOTICE_CAPACITY")
    const key = JSON.stringify([dialog.requestId, plugin])
    if (!this.order.has(key) && this.order.size >= 8)
      throw new ModFunctionError("MODS_UI_NOTICE_CAPACITY")
    const order = this.order.get(key) ?? { requestId: dialog.requestId, requested: 0, committed: 0 }
    this.order.set(key, order)
    const ticket = Object.freeze({
      key,
      plugin,
      toolUseId,
      requestId: dialog.requestId,
      revision: ++order.requested
    })
    this.pending.add(ticket)
    return ticket
  }

  commit(ticket: Ticket, text: string | undefined, assertLive = () => {}): void {
    assertLive()
    if (!this.pending.has(ticket)) throw new ModFunctionError("MODS_UI_NOTICE_STALE")
    const dialog = this.open(ticket.plugin, ticket.toolUseId)
    if (dialog.requestId !== ticket.requestId) throw new ModFunctionError("MODS_UI_NOTICE_CLOSED")
    if (text !== undefined && (typeof text !== "string" || text.length > 10000))
      throw new ModFunctionError("MODS_UI_NOTICE_ARGUMENTS")
    const order = this.order.get(ticket.key)
    if (!order || ticket.revision <= order.committed) return
    order.committed = ticket.revision
    const old = this.entries.get(ticket.key)
    if (text === undefined) {
      if (!this.entries.delete(ticket.key)) return
    } else {
      if (old?.text === text) return
      this.entries.set(ticket.key, {
        id: old?.id ?? randomUUID(),
        plugin: ticket.plugin,
        kind: "notice",
        requestId: ticket.requestId,
        toolUseId: ticket.toolUseId,
        text
      })
    }
    this.notify()
  }

  release(ticket: Ticket): void {
    this.pending.delete(ticket)
  }

  snapshot(): FunctionNoticeEntry[] {
    if (this.closed) return []
    for (const [key, entry] of this.entries)
      if (this.dialogs.lookup(entry.toolUseId)?.requestId !== entry.requestId)
        this.entries.delete(key)
    return [...this.entries.values()].map((entry) => ({ ...entry }))
  }

  private notify(): void {
    if (this.closed || this.notification) return
    this.notification = setTimeout(() => {
      this.notification = undefined
      if (!this.closed) this.changed()
    }, 40)
    this.notification.unref?.()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.unsubscribe()
    clearTimeout(this.notification)
    this.entries.clear()
    this.order.clear()
    this.pending.clear()
  }
}
