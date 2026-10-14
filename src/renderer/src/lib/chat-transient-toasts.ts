import type { Action, ExternalToast, ToastT } from "sonner"
import { TransientClock } from "../../../shared/mods/v2/transient-clock"

export type ChatToastKind = "success" | "error" | "info" | "warning" | "message"
export interface ChatToastSink {
  show(kind: ChatToastKind, text: string, options: ExternalToast): string | number
  dismiss(id: string | number): void
  originalIds?(owner: string): Array<string | number>
}
type Row = {
  id: string | number
  nativeId: string
  kind: ChatToastKind
  text: string
  options: ExternalToast
  bytes: number
  created: number
  submitted: boolean
}
const queues = new Set<ChatTransientToasts>()
let ordering = 0

/** Thread/owner-bound temporary text notifications; never controls task or approval state. */
export class ChatTransientToasts {
  private rows: Row[] = []
  private readonly clock = new TransientClock()
  private timer?: ReturnType<typeof setTimeout>
  private held = true
  private batch = 0
  private closed = false
  private version = 0
  private listeners = new Set<() => void>()
  constructor(
    readonly thread: string,
    readonly owner: string,
    private readonly sink: ChatToastSink
  ) {}
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  snapshot = (): number => this.version
  get pending(): number {
    return this.rows.length
  }
  get activeId(): string | undefined {
    return this.rows.find((row) => row.submitted)?.nativeId
  }

  show(kind: ChatToastKind, text: string, options: ExternalToast = {}): string | number {
    if (this.closed) return options.id ?? crypto.randomUUID()
    queues.add(this)
    const duration = options.duration ?? 2200
    const id = options.id ?? crypto.randomUUID()
    const previous = this.rows.find((row) => row.id === id)
    // Persistent/foreign presentation remains owned by the original global Sonner path.
    if (
      !Number.isFinite(duration) ||
      duration > 60000 ||
      duration < 0 ||
      (options.toasterId && options.toasterId !== this.owner)
    ) {
      if (previous) this.remove(previous, "drop")
      return this.sink.show(kind, text, {
        ...options,
        id,
        className: `${options.className ?? ""} devclaw-original-${this.owner}`
      })
    }
    const bytes =
      new TextEncoder().encode(
        text + (typeof options.description === "string" ? options.description : "")
      ).length + 512
    if (bytes > 512 * 1024) return id
    if (this.sink.originalIds?.(this.owner).includes(id)) this.sink.dismiss(id)
    const row: Row = {
      id,
      nativeId: previous?.nativeId ?? crypto.randomUUID(),
      kind,
      text,
      options: { ...options },
      bytes,
      created: previous?.created ?? ++ordering,
      submitted: previous?.submitted ?? false
    }
    if (previous) this.rows[this.rows.indexOf(previous)] = row
    else this.rows.push(row)
    this.clock.add(row.nativeId, duration)
    this.bound()
    if (this.rows.includes(row) && row.submitted) this.submit(row)
    this.admit()
    this.changed()
    return id
  }
  private bound(): void {
    const retained = () => [...queues].flatMap((queue) => queue.rows.map((row) => ({ queue, row })))
    for (;;) {
      const all = retained(),
        own = all.filter((item) => item.queue.thread === this.thread)
      const ownBytes = own.reduce((sum, item) => sum + item.row.bytes, 0)
      const totalBytes = all.reduce((sum, item) => sum + item.row.bytes, 0)
      const candidates = own.length > 40 || ownBytes > 512 * 1024 ? own : all
      if (
        own.length <= 40 &&
        ownBytes <= 512 * 1024 &&
        all.length <= 160 &&
        totalBytes <= 2 * 1024 * 1024
      )
        return
      const oldest = candidates.sort((a, b) => a.row.created - b.row.created)[0]
      oldest.queue.remove(oldest.row, "drop")
    }
  }
  private submit(row: Row): void {
    const wrap = (action: ExternalToast["action"], cancel = false): ExternalToast["action"] => {
      if (!action || typeof action !== "object" || !("onClick" in action)) return action
      const original = action as Action
      return {
        ...original,
        onClick: (event) => {
          original.onClick(event)
          if ((cancel || !event.defaultPrevented) && this.rows.includes(row))
            this.remove(row, "action")
        }
      }
    }
    this.sink.show(row.kind, row.text, {
      ...row.options,
      id: row.nativeId,
      toasterId: this.owner,
      duration: Infinity,
      className: `${row.options.className ?? ""} devclaw-transient-${row.nativeId}`,
      action: wrap(row.options.action),
      cancel: wrap(row.options.cancel, true),
      onAutoClose: undefined,
      onDismiss: () => {
        if (this.rows.includes(row)) this.remove(row, "dismiss")
      }
    })
  }
  private admit(): void {
    if (this.closed || this.batch || this.held || this.rows.some((row) => row.submitted)) return
    const row = this.rows[0]
    if (!row) return
    row.submitted = true
    this.submit(row)
  }
  present(present: boolean, held: boolean, shown: boolean, hovered: boolean): void {
    if (this.closed) return
    this.held = held || !present
    this.admit()
    const id = this.activeId
    this.clock.show(new Set(!this.held && shown && !hovered && id ? [id] : []))
    this.schedule()
  }
  dismiss(id?: string | number): void {
    this.batch++
    try {
      for (const row of [...this.rows])
        if (id === undefined || row.id === id) this.remove(row, "dismiss")
      for (const original of this.sink.originalIds?.(this.owner) ?? [])
        if (id === undefined || id === original) this.sink.dismiss(original)
    } finally {
      this.batch--
      this.admit()
    }
  }
  private remove(row: Row, why: "auto" | "dismiss" | "drop" | "action"): void {
    if (!this.rows.includes(row)) return
    this.rows = this.rows.filter((item) => item !== row)
    this.clock.remove(row.nativeId)
    if (row.submitted) this.sink.dismiss(row.nativeId)
    const callbackToast: ToastT = {
      ...row.options,
      id: row.id,
      title: row.text,
      type: row.kind === "message" ? "normal" : row.kind
    }
    try {
      if (why === "auto") row.options.onAutoClose?.(callbackToast)
      else if (why === "dismiss") row.options.onDismiss?.(callbackToast)
    } finally {
      this.admit()
      this.changed()
      this.schedule()
    }
  }
  private changed(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }
  private schedule(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    const delay = this.clock.next()
    if (delay === undefined || this.closed) return
    this.timer = setTimeout(() => {
      for (const id of this.clock.expired()) {
        const row = this.rows.find((row) => row.nativeId === id)
        if (row) this.remove(row, "auto")
      }
      this.schedule()
    }, delay)
  }
  close(): void {
    this.closed = true
    for (const row of [...this.rows]) this.remove(row, "drop")
    clearTimeout(this.timer)
    this.clock.clear()
    queues.delete(this)
    this.listeners.clear()
  }
}
