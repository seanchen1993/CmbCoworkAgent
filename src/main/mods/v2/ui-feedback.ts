import { randomUUID } from "node:crypto"
import type { ModObject } from "../../../shared/mods/types"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
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

  constructor(private readonly changed: () => void) {}

  set(plugin: string, method: FunctionFeedbackMethod, input: ModObject): void {
    if (this.closed) throw new ModFunctionError("MODS_SESSION_CLOSED")
    validateFunctionFeedback(method, input)
    this.prune()
    if (method === "ui.status") {
      const previous = this.entries.find((row) => row.plugin === plugin && row.kind === "status")
      if (input.text === undefined) this.entries = this.entries.filter((row) => row !== previous)
      else if (previous) previous.text = input.text as string
      else
        this.entries.push({ id: randomUUID(), plugin, kind: "status", text: input.text as string })
    } else {
      const own = this.entries.filter((row) => row.plugin === plugin && row.kind === "toast")
      if (own.length >= 4) this.entries = this.entries.filter((row) => row !== own[0])
      this.entries.push({
        id: randomUUID(),
        plugin,
        kind: "toast",
        text: input.text as string,
        expiresAt: Date.now() + Number(input.timeoutMs ?? 4000)
      })
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
    this.schedule()
    this.notify()
  }

  snapshot(): FunctionFeedbackEntry[] {
    this.prune()
    return this.entries.map((row) => ({ ...row }))
  }

  private prune(): void {
    this.entries = this.entries.filter(
      (row) => row.expiresAt === undefined || row.expiresAt > Date.now()
    )
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
    const deadlines = this.entries.flatMap((row) =>
      row.expiresAt === undefined ? [] : [row.expiresAt]
    )
    if (!deadlines.length || this.closed) return
    this.expiry = setTimeout(
      () => {
        this.prune()
        this.schedule()
        this.notify()
      },
      Math.max(0, Math.min(...deadlines) - Date.now())
    )
    this.expiry.unref?.()
  }

  close(): void {
    this.closed = true
    clearTimeout(this.expiry)
    clearTimeout(this.notification)
    this.entries = []
  }
}
