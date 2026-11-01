import { randomUUID } from "node:crypto"
import type {
  DeveloperEditorAck,
  DeveloperEditorEvent,
  DeveloperEditorFrame,
  DeveloperEditorIntent
} from "../../../shared/mods/v2/developer-editor"

export interface EditorNavigationAccess {
  signal: AbortSignal
  assertCurrent(): void
  /** Must recheck original path permission, bytes and current source before each receipt. */
  verify(): Promise<void>
  launchExternal?(): Promise<
    | { mode: string }
    | {
        unavailable: true
        reason?: "path-requires-built-in-preview" | "ide-not-configured"
      }
  >
}
export interface EditorNavigationRetention extends EditorNavigationAccess {
  close(): void
}
export interface EditorNavigationRequest extends EditorNavigationAccess {
  owner: object
  intent: Omit<DeveloperEditorIntent, "id" | "expiresAt">
  text: string
  fingerprint: string
  retain?(): Promise<EditorNavigationRetention>
}
interface Navigation {
  frame: DeveloperEditorFrame
  sender: number
  request: EditorNavigationRequest
  access: EditorNavigationAccess
  retention?: EditorNavigationRetention
  acknowledging: boolean
  settle(result: { status: string; line?: number; column?: number }): void
  timer: ReturnType<typeof setTimeout>
  stop(): void
  accepted: boolean
  loaded: boolean
  launched: boolean
}

/** One bounded native intent per window. No replay queue or guest-supplied sender authority. */
export class EditorNavigationBroker {
  private readonly pending = new Map<string, Navigation>()
  constructor(
    private readonly destination: (threadId: string) => number | undefined,
    private readonly send: (sender: number, event: DeveloperEditorEvent) => void,
    private readonly now = Date.now
  ) {}

  async open(request: EditorNavigationRequest): Promise<{
    status: string
    line?: number
    column?: number
  }> {
    await request.verify()
    request.assertCurrent()
    request.signal.throwIfAborted()
    const sender = this.destination(request.intent.threadId)
    if (sender === undefined) return { status: "unavailable" }
    for (const [id, row] of this.pending) if (row.sender === sender) this.retire(id)
    const frame = {
      ...request.intent,
      id: randomUUID(),
      expiresAt: this.now() + 30_000,
      text: request.text,
      fingerprint: request.fingerprint
    }
    return new Promise((settle) => {
      const abort = () => this.retire(frame.id)
      const row: Navigation = {
        frame,
        sender,
        request,
        access: request,
        acknowledging: false,
        settle,
        accepted: false,
        loaded: false,
        launched: false,
        timer: setTimeout(() => {
          if (!row.loaded) this.retire(frame.id)
        }, 30_000),
        stop: () => request.signal.removeEventListener("abort", abort)
      }
      this.pending.set(frame.id, row)
      request.signal.addEventListener("abort", abort, { once: true })
      try {
        const intent: DeveloperEditorIntent = {
          ...request.intent,
          id: frame.id,
          expiresAt: frame.expiresAt
        }
        this.send(sender, { kind: "offer", intent })
      } catch {
        this.retire(frame.id)
      }
    })
  }

  private async current(sender: number, id: string) {
    const row = this.pending.get(id)
    if (!row || row.sender !== sender || this.destination(row.frame.threadId) !== sender)
      throw Error("EDITOR_NAVIGATION_STALE")
    try {
      row.access.signal.throwIfAborted()
      if (!row.loaded && this.now() >= row.frame.expiresAt) throw Error("EDITOR_NAVIGATION_EXPIRED")
      await row.access.verify()
      row.access.assertCurrent()
      row.access.signal.throwIfAborted()
      if (!row.loaded && this.now() >= row.frame.expiresAt) throw Error("EDITOR_NAVIGATION_EXPIRED")
      if (this.pending.get(id) !== row || this.destination(row.frame.threadId) !== sender)
        throw Error("EDITOR_NAVIGATION_STALE")
      return row
    } catch (error) {
      this.retire(id)
      throw error
    }
  }

  private assertReceiptCurrent(sender: number, row: Navigation): void {
    try {
      if (
        this.pending.get(row.frame.id) !== row ||
        row.sender !== sender ||
        this.destination(row.frame.threadId) !== sender
      )
        throw Error("EDITOR_NAVIGATION_STALE")
      row.access.assertCurrent()
      row.access.signal.throwIfAborted()
      if (!row.loaded && this.now() >= row.frame.expiresAt) throw Error("EDITOR_NAVIGATION_EXPIRED")
    } catch (error) {
      this.retire(row.frame.id)
      throw error
    }
  }

  async accept(sender: number, id: string): Promise<DeveloperEditorFrame> {
    const row = await this.current(sender, id)
    this.assertReceiptCurrent(sender, row)
    if (row.accepted) throw Error("EDITOR_NAVIGATION_ALREADY_ACCEPTED")
    row.accepted = true
    return structuredClone(row.frame)
  }

  async acknowledge(sender: number, ack: DeveloperEditorAck): Promise<void> {
    const row = await this.current(sender, ack.id)
    this.assertReceiptCurrent(sender, row)
    if (
      !row.accepted ||
      row.loaded ||
      row.acknowledging ||
      ack.fingerprint !== row.frame.fingerprint
    )
      throw Error("EDITOR_NAVIGATION_RECEIPT_INVALID")
    if (ack.status === "preview-loaded") {
      if (ack.line !== row.frame.line || ack.column !== row.frame.column)
        throw Error("EDITOR_NAVIGATION_TARGET_NOT_CONFIRMED")
      row.acknowledging = true
      let retained: EditorNavigationRetention | undefined
      try {
        if (!row.request.retain) throw Error("EDITOR_NAVIGATION_RETENTION_UNAVAILABLE")
        retained = await row.request.retain()
        this.assertReceiptCurrent(sender, row)
        await retained.verify()
        this.assertReceiptCurrent(sender, row)
        retained.assertCurrent()
        retained.signal.throwIfAborted()
        row.stop()
        row.access = retained
        row.retention = retained
        const abort = () => this.retire(row.frame.id)
        row.stop = () => retained!.signal.removeEventListener("abort", abort)
        retained.signal.addEventListener("abort", abort, { once: true })
        row.loaded = true
        clearTimeout(row.timer)
        row.settle({ status: "preview-loaded", line: ack.line, column: ack.column })
      } catch (error) {
        retained?.close()
        this.retire(ack.id)
        throw error
      }
    } else if (ack.status === "failed") {
      row.settle({ status: "failed" })
      this.retire(ack.id)
    } else throw Error("EDITOR_NAVIGATION_RECEIPT_INVALID")
  }

  close(sender: number, id: string): void {
    const row = this.pending.get(id)
    if (row && row.sender === sender) this.retire(id)
  }

  /** Only a trusted renderer button may call this sender-bound, one-shot native intent. */
  async launchExternal(sender: number, id: string) {
    const row = await this.current(sender, id)
    this.assertReceiptCurrent(sender, row)
    if (!row.loaded || row.launched) throw Error("EDITOR_NAVIGATION_EXTERNAL_INTENT_INVALID")
    if (!row.access.launchExternal)
      return { status: "unavailable" as const, display: "unknown" as const }
    row.launched = true
    const result = await row.access.launchExternal()
    await this.current(sender, id)
    if ("unavailable" in result)
      return {
        status: "unavailable" as const,
        display: "unknown" as const,
        ...(result.reason ? { reason: result.reason } : {})
      }
    return {
      status: "external-launch-requested" as const,
      display: "unknown" as const,
      mode: result.mode
    }
  }

  /** Wire to original scope/revoke/reload/window-close notifications; no polling. */
  invalidate(sender?: number): void {
    for (const [id, row] of this.pending)
      if (sender === undefined || sender === row.sender) this.retire(id)
  }

  retireOwner(owner: object): void {
    for (const [id, row] of this.pending) if (row.request.owner === owner) this.retire(id)
  }

  invalidateThread(threadId: string): void {
    for (const [id, row] of this.pending) if (row.frame.threadId === threadId) this.retire(id)
  }

  private retire(id: string): void {
    const row = this.pending.get(id)
    if (!row) return
    this.pending.delete(id)
    clearTimeout(row.timer)
    row.stop()
    row.retention?.close()
    row.settle({ status: "unknown" })
    try {
      this.send(row.sender, { kind: "retire", id })
    } catch {
      // A gone renderer is not a completed preview or a replay target.
    }
  }
}
