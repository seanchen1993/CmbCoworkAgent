import { randomUUID } from "node:crypto"
import type {
  FunctionPlacedAnchor,
  FunctionPlacedEntry,
  FunctionPlacedResult
} from "../../../shared/mods/v2/placed"
import { validateFunctionPlacedArgs } from "../../../shared/mods/v2/placed"
import type { FunctionUiAction } from "../../../shared/mods/v2/ui"
import type { ModObject } from "../../../shared/mods/types"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { FunctionPlugin } from "./dispatcher"
import { FunctionPanes, type PaneHost } from "./panes"

interface Row extends FunctionPlacedEntry {
  source: FunctionPlugin
  drawings: FunctionPanes
  lease?: string
  displayCheck?: () => void
  revealPending?: { resolve(value: { deny?: string }): void; cleanup(): void }
}
/** Ephemeral transcript display. It never appends a message or opens a public Pane. */
export class FunctionPlacedRows {
  private readonly rows = new Map<string, Row>()
  private sequence = 0
  private closed = false
  constructor(
    private readonly host: PaneHost & {
      captureAnchor(): FunctionPlacedAnchor | undefined
      isAttached(): boolean
    }
  ) {}
  private current(row: Row): void {
    this.host.assertLive()
    this.native(row)
  }
  private native(row: Row): void {
    if (
      this.closed ||
      this.rows.get(row.requestId) !== row ||
      !this.host.plugins.includes(row.source)
    )
      throw new ModFunctionError("MODS_UI_PLACED_STALE")
  }
  place(source: FunctionPlugin, args: ModObject): FunctionPlacedResult {
    this.host.assertLive()
    validateFunctionPlacedArgs(args)
    if (this.closed) throw new ModFunctionError("MODS_UI_PLACED_STALE")
    let row = [...this.rows.values()].find((r) => r.source === source && r.id === args.id)
    if (row) {
      this.current(row)
      row.drawings.invalidate(undefined, true)
    } else {
      if (
        this.rows.size >= 64 ||
        [...this.rows.values()].filter((r) => r.source === source).length >= 16
      )
        return { isPlaced: false, reason: "placed-row-limit" }
      const anchor = this.host.captureAnchor()
      if (!anchor) return { isPlaced: false, reason: "no-supported-conversation" }
      const requestId = randomUUID()
      const entry = {
        requestId,
        id: args.id,
        plugin: source.name,
        anchor,
        sequence: ++this.sequence,
        source
      } as Row
      entry.drawings = new FunctionPanes({
        ...this.host,
        component: "Placed",
        localNotificationsOnly: true,
        markdownSiteOwner: requestId,
        changed: () => {
          if (this.rows.get(requestId) === entry) this.host.changed("placed")
        },
        assertNativeCurrent: () => this.drawingCurrent(entry),
        captureNativeIntent: () => {
          this.drawingCurrent(entry)
          const lease = entry.lease
          return () => {
            this.drawingCurrent(entry)
            if (entry.lease !== lease) throw new ModFunctionError("MODS_UI_PLACED_STALE")
          }
        },
        assertSiteCurrent: () => this.drawingCurrent(entry),
        site: () => {
          this.native(entry)
          return { component: "Placed", props: { id: entry.id, plugin: entry.plugin } }
        }
      })
      this.rows.set(requestId, entry)
      entry.drawings.open("engine", { id: requestId, title: source.name })
      row = entry
    }
    this.host.changed("placed")
    return this.host.isAttached()
      ? { isPlaced: true, requestId: row.requestId }
      : { isPlaced: false, requestId: row.requestId, reason: "no-surface" }
  }
  list(): FunctionPlacedEntry[] {
    this.host.assertLive()
    if (this.closed) return []
    return [...this.rows.values()].map(({ requestId, id, plugin, anchor, sequence, reveal }) => ({
      requestId,
      id,
      plugin,
      anchor: { ...anchor },
      sequence,
      ...(reveal ? { reveal: { ...reveal } } : {})
    }))
  }
  owns(source: FunctionPlugin, requestId: string): boolean {
    return this.rows.get(requestId)?.source === source
  }
  reveal(
    source: FunctionPlugin,
    requestId: string,
    block: "start" | "center" | "end" | "nearest",
    signal: AbortSignal,
    assertIntent: () => void
  ): Promise<{ deny?: string }> {
    const row = this.get(requestId)
    if (row.source !== source) throw new ModFunctionError("MODS_UI_PLACED_STALE")
    if (row.revealPending) return Promise.resolve({ deny: "A reveal request is already pending" })
    if (!this.host.isAttached()) return Promise.resolve({ deny: "No attached desktop surface" })
    assertIntent()
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
        row.revealPending = undefined
        row.reveal = undefined
        this.host.changed("placed")
      }
      const abort = () => {
        cleanup()
        reject(signal.reason)
      }
      const timer = setTimeout(() => {
        cleanup()
        resolve({ deny: "The owned transcript row could not be shown in time" })
      }, 5000)
      timer.unref()
      row.reveal = { id: randomUUID(), block }
      row.revealPending = {
        cleanup,
        resolve: (value) => {
          try {
            this.current(row)
            assertIntent()
            signal.throwIfAborted()
            cleanup()
            resolve(value)
          } catch (cause) {
            cleanup()
            reject(cause)
          }
        }
      }
      signal.addEventListener("abort", abort, { once: true })
      this.host.changed("placed")
    })
  }
  revealAck(input: import("../../../shared/mods/v2/placed").FunctionPlacedRevealAck): void {
    if (!isModObject(input) || typeof input.requestId !== "string" ||
      typeof input.receipt !== "string" || typeof input.allowed !== "boolean" ||
      (!input.allowed && (input.lease !== undefined || input.generation !== undefined)))
      throw new ModFunctionError("MODS_UI_PLACED_STALE")
    const row = this.get(input.requestId),
      pending = row.revealPending
    if (
      !pending ||
      row.reveal?.id !== input.receipt ||
      typeof input.allowed !== "boolean" ||
      Object.keys(input).some(
        (key) => !["requestId", "receipt", "allowed", "lease", "generation"].includes(key)
      )
    )
      throw new ModFunctionError("MODS_UI_PLACED_STALE")
    if (input.allowed) {
      if (!row.lease || input.lease !== row.lease || typeof input.generation !== "string")
        throw new ModFunctionError("MODS_UI_PLACED_STALE")
      this.drawingCurrent(row)
      const drawing = row.drawings.captureClientDrawing(`engine:${row.requestId}`, input.generation)
      if (!drawing) throw new ModFunctionError("MODS_UI_PLACED_STALE")
      try {
        drawing.assertCurrent()
      } finally {
        drawing.release()
      }
    }
    pending.resolve(
      input.allowed ? {} : { deny: "The exact resident transcript anchor is unavailable" }
    )
  }
  assertReceipt(source: FunctionPlugin, id: string, requestId: string): void {
    const row = this.get(requestId)
    if (row.source !== source || row.id !== id) throw new ModFunctionError("MODS_UI_PLACE_RESULT")
  }
  private get(id: string): Row {
    const row = this.rows.get(id)
    if (!row) throw new ModFunctionError("MODS_UI_PLACED_STALE")
    this.current(row)
    return row
  }
  private drawingCurrent(row: Row): void {
    // This is also called by Session.assertLive's captured drawing proof: no Session recursion.
    this.native(row)
    if (!row.lease) throw new ModFunctionError("MODS_UI_PLACED_STALE")
    row.displayCheck?.()
  }
  async read(id: string, lease: string, displayCheck: () => void = () => {}) {
    const row = this.get(id)
    displayCheck()
    if (typeof lease !== "string" || !/^[\w-]{16,100}$/.test(lease))
      throw new ModFunctionError("MODS_UI_PLACED_STALE")
    if (row.lease !== lease) row.drawings.invalidate(undefined, true)
    row.lease = lease
    row.displayCheck = displayCheck
    const [drawing] = await row.drawings.snapshot()
    this.current(row)
    if (!drawing || row.lease !== lease) throw new ModFunctionError("MODS_UI_PLACED_STALE")
    return drawing
  }
  async act(id: string, lease: string, action: FunctionUiAction) {
    const row = this.get(id)
    if (
      row.lease !== lease ||
      action.pane !== `engine:${id}` ||
      !["press", "change", "submit", "select"].includes(action.kind)
    )
      throw new ModFunctionError("MODS_UI_ACTION_INVALID")
    const displayCheck = row.displayCheck
    const guard = () => {
      this.drawingCurrent(row)
      displayCheck?.()
      if (row.lease !== lease) throw new ModFunctionError("MODS_UI_PLACED_STALE")
    }
    guard()
    const run = () => row.drawings.act(action)
    const result = await (this.host.withNativeIntent
      ? this.host.withNativeIntent(guard, run)
      : run())
    guard()
    this.host.changed("placed")
    return result
  }
  dismiss(id: string): void {
    const row = this.get(id)
    row.revealPending?.resolve({ deny: "The transcript row was dismissed" })
    this.rows.delete(id)
    row.drawings.close()
    this.host.changed("placed")
  }
  /** Virtual unmount revokes callbacks, but keeps the row's original display position. */
  release(id: string, lease: string): void {
    const row = this.rows.get(id)
    if (row?.lease === lease) {
      row.lease = undefined
      this.host.clients?.closePane(`engine:${id}`)
      row.drawings.invalidate(undefined, true)
    }
  }
  invalidate(): void {
    for (const row of this.rows.values()) row.drawings.invalidate(undefined, true)
    if (this.rows.size) this.host.changed("placed")
  }
  private drawing(key: string) {
    return [...this.rows.values()].find((row) => `engine:${row.requestId}` === key)?.drawings
  }
  notifyClient(key: string): boolean {
    const drawing = this.drawing(key)
    if (!drawing) return false
    drawing.notify()
    return true
  }
  captureClientDrawing(key: string, generation: string) {
    return this.drawing(key)?.captureClientDrawing(key, generation)
  }
  captureClientFault(key: string, generation: string) {
    return this.drawing(key)?.captureClientFault(key, generation)
  }
  invalidateGeneration(generation: string): boolean {
    let changed = false
    for (const row of this.rows.values())
      changed = row.drawings.invalidateGeneration(generation) || changed
    if (changed) this.host.changed("placed")
    return changed
  }
  clear(): void {
    if (!this.rows.size) return
    for (const row of this.rows.values()) {
      row.revealPending?.resolve({ deny: "The transcript rows were released" })
      row.drawings.close()
    }
    this.rows.clear()
    this.host.changed("placed")
  }
  close(): void {
    this.clear()
    this.closed = true
  }
}
