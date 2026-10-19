import { randomUUID } from "node:crypto"
import type {
  PlatformCapabilityInfo,
  PlatformCapabilityActionResult,
  PlatformCapabilityRef
} from "../../../shared/mods/v2/platform-capabilities"
import {
  platformSurfaceEntry,
  type PlatformSurfaceAddress,
  type PlatformSurfaceCatalog,
  type PlatformSurfaceEntry,
  type PlatformSurfaceFrame
} from "../../../shared/mods/v2/platform-surfaces"
import type { FunctionPaneSnapshot, FunctionUiAction } from "../../../shared/mods/v2/ui"
import type { ModObject } from "../../../shared/mods/types"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

export interface PlatformSurfacesHost {
  /** Resident native descriptors only. Listing never loads a guest, runs a matcher or starts a session. */
  capabilities(): readonly PlatformCapabilityInfo[]
  assertCurrent(entry: PlatformSurfaceEntry): void
  paneOwner(entry: PlatformSurfaceEntry): string
  invoke(
    ref: PlatformCapabilityRef,
    action: string,
    input: ModObject,
    requestKey: string,
    signal: AbortSignal
  ): Promise<PlatformCapabilityActionResult>
  /** A native cleanup-only frame. No new task, external effect, approval or nested action. */
  cleanup?(
    ref: PlatformCapabilityRef,
    action: string,
    input: ModObject,
    requestKey: string,
    signal: AbortSignal
  ): Promise<PlatformCapabilityActionResult>
  /** Native owner cleanup proves resources/subscriptions stopped even if the author forgot. */
  retire?(entry: PlatformSurfaceEntry): Promise<void>
  panes: {
    snapshot(select?: (plugin: string, id: string) => boolean): Promise<FunctionPaneSnapshot[]>
    act(action: FunctionUiAction): Promise<unknown>
    closePane(plugin: string, id: string): Promise<void>
  }
  changed(): void
}

/** Session-owned page metadata; drawing, callbacks and grants stay in the original pane runtime. */
export class PlatformSurfaces {
  private fingerprint = ""
  private revision = 0
  private readonly disabled = new Set<string>()
  private readonly cleanupFailures = new Set<string>()
  private readonly retirements = new Map<string, Promise<void>>()
  private readonly openings = new Map<string, Promise<void>>()
  private readonly openIds = new Map<string, string>()
  private closed = false
  constructor(private readonly host: PlatformSurfacesHost) {}

  list(): PlatformSurfaceCatalog {
    if (this.closed) return { revision: this.revision, entries: [], errors: [] }
    const entries: PlatformSurfaceEntry[] = [],
      errors: string[] = []
    for (const info of this.host.capabilities().slice(0, 64)) {
      try {
        const entry = platformSurfaceEntry(info)
        if (entry)
          entries.push({ ...entry, enabled: entry.enabled && !this.disabled.has(entry.key) })
      } catch {
        errors.push(`${info.ref.provider}/${info.ref.id}: 页面声明不可用`)
      }
      if (entries.length >= 32) {
        errors.push("页面登记已达 32 项上限")
        break
      }
    }
    const known = new Set(entries.map((entry) => entry.key))
    for (const key of this.disabled) if (!known.has(key)) this.disabled.delete(key)
    entries.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.key.localeCompare(b.key))
    const fingerprint = JSON.stringify([entries, errors])
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint
      this.revision++
    }
    return { revision: this.revision, entries, errors }
  }

  private current(
    address: PlatformSurfaceAddress,
    allowDisabled = false,
    cleanup = false
  ): PlatformSurfaceEntry {
    const catalog = this.list(),
      entry = catalog.entries.find((entry) => entry.key === address.key)
    if (
      this.closed ||
      (!cleanup && catalog.revision !== address.revision) ||
      !entry ||
      (!allowDisabled && !entry.enabled)
    )
      throw new ModFunctionError("MODS_PLATFORM_SURFACE_STALE")
    if (!cleanup) this.host.assertCurrent(entry)
    if (!allowDisabled && this.retirements.has(this.paneKey(entry)))
      throw new ModFunctionError("MODS_PLATFORM_SURFACE_CLOSING")
    return entry
  }

  private paneKey(entry: PlatformSurfaceEntry): string {
    return `${this.host.paneOwner(entry)}:${entry.paneId}`
  }

  private assertCustody(entry: PlatformSurfaceEntry, address: PlatformSurfaceAddress): void {
    if (!address.openId || this.openIds.get(this.paneKey(entry)) !== address.openId)
      throw new ModFunctionError("MODS_PLATFORM_SURFACE_STALE")
  }

  ownsPane(plugin: string, id: string): boolean {
    return this.list().entries.some(
      (entry) => this.host.paneOwner(entry) === plugin && entry.paneId === id
    )
  }

  async open(
    address: PlatformSurfaceAddress,
    signal: AbortSignal,
    intent: string = randomUUID()
  ): Promise<PlatformSurfaceFrame> {
    const entry = this.current(address)
    const key = this.paneKey(entry)
    if (this.openings.has(key)) throw new ModFunctionError("MODS_PLATFORM_SURFACE_OPENING")
    if (this.cleanupFailures.has(this.paneKey(entry)) || this.cleanupFailures.size >= 64)
      throw new ModFunctionError("MODS_PLATFORM_SURFACE_CLEANUP_UNCONFIRMED")
    if (this.openIds.has(key)) throw new ModFunctionError("MODS_PLATFORM_SURFACE_ALREADY_OPEN")
    const gate = Promise.withResolvers<void>(),
      openId = randomUUID()
    this.openings.set(key, gate.promise)
    this.openIds.set(key, openId)
    try {
      signal.throwIfAborted()
      const result = await this.host.invoke(
        entry.ref,
        entry.openAction,
        { surfaceId: entry.id },
        `surface:${intent}`,
        signal
      )
      this.current(address)
      signal.throwIfAborted()
      if (result.status !== "succeeded")
        throw new ModFunctionError(
          "MODS_PLATFORM_SURFACE_OPEN_FAILED",
          result.error ?? "页面未打开；请核对执行状态"
        )
      return await this.read({ ...address, openId }, signal)
    } catch (error) {
      this.cleanupFailures.add(key)
      throw error
    } finally {
      gate.resolve()
      if (this.openings.get(key) === gate.promise) this.openings.delete(key)
    }
  }

  async read(address: PlatformSurfaceAddress, signal?: AbortSignal): Promise<PlatformSurfaceFrame> {
    const entry = this.current(address),
      owner = this.host.paneOwner(entry)
    this.assertCustody(entry, address)
    signal?.throwIfAborted()
    const panes = await this.host.panes.snapshot(
      (plugin, id) => plugin === owner && id === entry.paneId
    )
    this.current(address)
    this.assertCustody(entry, address)
    signal?.throwIfAborted()
    return {
      openId: address.openId!,
      entry,
      pane: panes.find((pane) => pane.plugin === owner && pane.id === entry.paneId) ?? null
    }
  }

  async act(
    address: PlatformSurfaceAddress,
    action: FunctionUiAction,
    signal?: AbortSignal
  ): Promise<void> {
    const entry = this.current(address),
      expected = `${this.host.paneOwner(entry)}:${entry.paneId}`
    this.assertCustody(entry, address)
    if (action.pane !== expected || action.kind === "close")
      throw new ModFunctionError("MODS_PLATFORM_SURFACE_ACTION_DENIED")
    signal?.throwIfAborted()
    await this.host.panes.act(action)
    this.current(address)
    this.assertCustody(entry, address)
    signal?.throwIfAborted()
  }

  async disable(address: PlatformSurfaceAddress): Promise<void> {
    const entry = this.current(address, true, true)
    this.disabled.add(entry.key)
    this.revision++
    try {
      await this.retirePage(entry)
    } finally {
      this.host.changed()
    }
  }

  enable(address: PlatformSurfaceAddress): void {
    const entry = this.current(address, true)
    if (this.cleanupFailures.has(this.paneKey(entry)) || this.retirements.has(this.paneKey(entry)))
      throw new ModFunctionError("MODS_PLATFORM_SURFACE_CLEANUP_UNCONFIRMED")
    this.disabled.delete(entry.key)
    this.revision++
    this.host.changed()
  }

  async closePage(address: PlatformSurfaceAddress): Promise<void> {
    const entry = this.current(address, true, true)
    if (!address.openId) throw new ModFunctionError("MODS_PLATFORM_SURFACE_STALE")
    if (this.openIds.get(this.paneKey(entry)) !== address.openId) return
    await this.retirePage(entry)
  }

  private retirePage(entry: PlatformSurfaceEntry): Promise<void> {
    const key = this.paneKey(entry),
      existing = this.retirements.get(key)
    if (existing) return existing
    const pending = Promise.resolve()
      .then(() => this.retirePageNow(entry))
      .finally(() => {
        if (this.retirements.get(key) === pending) this.retirements.delete(key)
      })
    this.retirements.set(key, pending)
    return pending
  }

  private async retirePageNow(entry: PlatformSurfaceEntry): Promise<void> {
    const opening = this.openings.get(this.paneKey(entry))
    if (opening) await opening
    let failure: unknown
    try {
      if (entry.closeAction) {
        this.host.assertCurrent(entry)
        if (!this.host.cleanup)
          throw new ModFunctionError("MODS_PLATFORM_SURFACE_CLEANUP_UNCONFIRMED")
        const result = await this.host.cleanup(
          entry.ref,
          entry.closeAction,
          { surfaceId: entry.id },
          `surface-close:${randomUUID()}`,
          new AbortController().signal
        )
        if (result.status !== "succeeded")
          throw new ModFunctionError("MODS_PLATFORM_SURFACE_CLEANUP_UNCONFIRMED")
      }
    } catch (error) {
      failure = error
    }
    try {
      await this.host.retire?.(entry)
    } catch (error) {
      failure ??= error
    }
    // Native drawing retirement never depends on the author returning successfully.
    try {
      await this.host.panes.closePane(this.host.paneOwner(entry), entry.paneId)
    } catch (error) {
      failure ??= error
    }
    if (failure) {
      this.cleanupFailures.add(this.paneKey(entry))
      throw new ModFunctionError("MODS_PLATFORM_SURFACE_CLEANUP_UNCONFIRMED")
    }
    this.cleanupFailures.delete(this.paneKey(entry))
    this.openIds.delete(this.paneKey(entry))
  }

  close(): void {
    this.closed = true
    this.disabled.clear()
    this.cleanupFailures.clear()
    this.openIds.clear()
    this.revision++
  }
}
