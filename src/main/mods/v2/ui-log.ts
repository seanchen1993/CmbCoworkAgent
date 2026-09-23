import { randomUUID } from "node:crypto"
import type { ModObject } from "../../../shared/mods/types"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { validateFunctionLog, type FunctionLogEntry } from "../../../shared/mods/v2/ui-log"

interface PendingLog {
  plugin: string
  done: boolean
  value?: ModObject
  live?: () => boolean
}

/** Ordered, bounded presentation history. Never appends model messages or execution facts. */
export class FunctionUiLog {
  private readonly pending = new Map<number, PendingLog>()
  private entries: FunctionLogEntry[] = []
  private sequence = 0
  private notification?: ReturnType<typeof setTimeout>
  private closed = false

  constructor(
    private readonly changed: () => void,
    private readonly debug: (plugin: string, text: string) => void
  ) {}

  reserve(plugin: string): number {
    if (this.closed) throw new ModFunctionError("MODS_SESSION_CLOSED")
    if (this.pending.size >= 32) throw new ModFunctionError("MODS_UI_LOG_CAPACITY")
    const id = ++this.sequence
    this.pending.set(id, { plugin, done: false })
    return id
  }

  settle(id: number, value?: ModObject, live?: () => boolean): void {
    const slot = this.pending.get(id)
    if (!slot || slot.done || this.closed) return
    if (value) validateFunctionLog(value)
    slot.done = true
    slot.value = value
    slot.live = live
    for (const [key, next] of this.pending) {
      if (!next.done) break
      this.pending.delete(key)
      if (!next.value || (next.live && !next.live())) continue
      const text = next.value.text as string
      this.debug(next.plugin, text)
      if (next.value.to === "debug") continue
      this.entries.push({ id: randomUUID(), plugin: next.plugin, text })
      let bytes =
        2 + this.entries.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1, 0)
      while (this.entries.length > 64 || bytes > 256 * 1024) {
        bytes -= Buffer.byteLength(JSON.stringify(this.entries.shift()!)) + 1
      }
      if (!this.notification) {
        this.notification = setTimeout(() => {
          this.notification = undefined
          if (!this.closed) this.changed()
        }, 40)
        this.notification.unref?.()
      }
    }
  }

  snapshot(): FunctionLogEntry[] {
    return this.entries.map((row) => ({ ...row }))
  }

  close(): void {
    this.closed = true
    clearTimeout(this.notification)
    this.pending.clear()
    this.entries = []
  }
}
