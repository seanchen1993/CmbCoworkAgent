import { randomUUID } from "node:crypto"
import type { ModObject } from "../../../shared/mods/types"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { TransientClock } from "../../../shared/mods/v2/transient-clock"
import { functionUiTextProjection } from "../../../shared/mods/v2/ui-text"
import {
  validateFunctionFeedback,
  type FunctionFeedbackEntry,
  type FunctionFeedbackMethod
} from "../../../shared/mods/v2/ui-feedback"

/** Session-owned presentation only. No durable transcript, model messages or execution facts. */
export class FunctionUiFeedback {
  private entries: FunctionFeedbackEntry[] = []
  private expiry?: ReturnType<typeof setTimeout>
  private notification?: ReturnType<typeof setTimeout>
  private closed = false
  private readonly clock = new TransientClock()

  constructor(private readonly changed: () => void) {}

  set(plugin: string, method: FunctionFeedbackMethod, input: ModObject): void {
    if (this.closed) throw new ModFunctionError("MODS_SESSION_CLOSED")
    validateFunctionFeedback(method, input)
    const text = typeof input.text === "string"
      ? functionUiTextProjection(input.text, 10000)
      : undefined
    this.prune()
    if (method === "ui.status") {
      const previous = this.entries.find((row) => row.plugin === plugin && row.kind === "status")
      if (input.text === undefined) this.entries = this.entries.filter((row) => row !== previous)
      else if (previous) previous.text = text!
      else
        this.entries.push({ id: randomUUID(), plugin, kind: "status", text: text! })
    } else {
      const own = this.entries.filter((row) => row.plugin === plugin && row.kind === "toast")
      if (own.length >= 4) this.entries = this.entries.filter((row) => row !== own[0])
      this.entries.push({
        id: randomUUID(),
        plugin,
        kind: "toast",
        text: text!,
        timeoutMs: Number(input.timeoutMs ?? 4000)
      })
      const row = this.entries.at(-1)!
      this.clock.add(row.id, row.timeoutMs!)
    }
    // Defense in depth even if a future caller exceeds the manager's eight-plugin limit.
    if (this.entries.length > 40) this.entries = this.entries.slice(-40)
    // UTF-8 wire size, not UTF-16 character count; leave room for publication envelopes.
    // Discard older transient rows before pinned status when the aggregate budget is reached.
    let bytes =
      2 + this.entries.reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row)) + 1, 0)
    while (bytes > 512 * 1024 && this.entries.length) {
      const toast = this.entries.findIndex((row) => row.kind === "toast")
      const [removed] = this.entries.splice(toast < 0 ? 0 : toast, 1)
      bytes -= Buffer.byteLength(JSON.stringify(removed)) + 1
    }
    this.trimClocks()
    this.schedule()
    this.notify()
  }

  snapshot(): FunctionFeedbackEntry[] {
    this.prune()
    return this.entries.map((row) => ({ ...row }))
  }

  private prune(): void {
    const expired = new Set(this.clock.expired())
    this.entries = this.entries.filter((row) => !expired.has(row.id))
    for (const id of expired) this.clock.remove(id)
  }

  private known = new Set<string>()
  private trimClocks(): void {
    const retained = new Set(this.entries.map((row) => row.id))
    for (const id of this.known) if (!retained.has(id)) this.clock.remove(id)
    this.known = retained
  }

  /** Called only by the owner/session/publication-bound native receipt consumer. */
  present(
    shown: readonly string[],
    hovered: readonly string[],
    dismissed: readonly string[],
    held: boolean
  ): void {
    if (this.closed) return
    this.prune()
    const removed = new Set(dismissed)
    const before = this.entries.length
    this.entries = this.entries.filter((row) => row.kind !== "toast" || !removed.has(row.id))
    this.trimClocks()
    const paused = new Set(hovered)
    const active = new Set(
      held
        ? []
        : shown.filter(
            (id) =>
              !paused.has(id) && this.entries.some((row) => row.id === id && row.kind === "toast")
          )
    )
    this.clock.show(active)
    this.schedule()
    if (before !== this.entries.length) this.notify()
  }

  pause(): void {
    this.clock.show(new Set())
    this.schedule()
  }

  private notify(): void {
    if (this.notification || this.closed) return
    this.notification = setTimeout(() => {
      this.notification = undefined
      if (!this.closed) this.changed()
    }, 40)
    this.notification.unref?.()
  }

  private schedule(): void {
    clearTimeout(this.expiry)
    this.expiry = undefined
    const delay = this.clock.next()
    if (delay === undefined || this.closed) return
    this.expiry = setTimeout(() => {
      this.prune()
      this.schedule()
      this.notify()
    }, delay)
    this.expiry.unref?.()
  }

  close(): void {
    this.closed = true
    clearTimeout(this.expiry)
    clearTimeout(this.notification)
    this.entries = []
    this.clock.clear()
    this.known.clear()
  }
}
