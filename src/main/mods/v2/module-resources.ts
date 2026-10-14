import { randomUUID } from "node:crypto"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

export interface FunctionModuleResource {
  readonly id: string
  readonly signal: AbortSignal
  close(): Promise<void>
}

interface Entry<Owner> {
  owner: Owner
  controller: AbortController
  detach(): void
  cleanup(): void | Promise<void>
  closing?: Promise<void>
}

/** Handles are indexes, never authority: every access must name the bound host owner. */
export class FunctionModuleResources<Owner> {
  private readonly entries = new Map<string, Entry<Owner>>()
  private readonly counts = new Map<Owner, number>()
  private closed = false
  private readonly closing = new Set<Promise<void>>()
  private cleanupFailure?: unknown

  constructor(private readonly assertOwner: (owner: Owner) => void) {}

  get size(): number {
    return this.entries.size
  }

  create(
    owner: Owner,
    parent: AbortSignal,
    cleanup: () => void | Promise<void>
  ): FunctionModuleResource {
    this.assertOwner(owner)
    parent.throwIfAborted()
    if (this.closed) throw new ModFunctionError("MODS_SESSION_CLOSED")
    if ((this.counts.get(owner) ?? 0) >= 64) throw new ModFunctionError("MODS_RESOURCE_LIMIT")
    const id = randomUUID()
    const controller = new AbortController()
    const abort = () => {
      void this.closeEntry(id).catch(() => {})
    }
    const entry: Entry<Owner> = {
      owner,
      controller,
      cleanup,
      detach: () => parent.removeEventListener("abort", abort)
    }
    this.entries.set(id, entry)
    this.counts.set(owner, (this.counts.get(owner) ?? 0) + 1)
    parent.addEventListener("abort", abort, { once: true })
    return { id, signal: controller.signal, close: () => this.closeEntry(id) }
  }

  assert(owner: Owner, id: string): AbortSignal {
    this.assertOwner(owner)
    const entry = this.entries.get(id)
    if (!entry || entry.owner !== owner || entry.closing)
      throw new ModFunctionError("MODS_RESOURCE_UNAVAILABLE")
    entry.controller.signal.throwIfAborted()
    return entry.controller.signal
  }

  close(owner: Owner, id: string): Promise<void> {
    this.assertOwner(owner)
    const entry = this.entries.get(id)
    // Idempotent close is allowed; a known foreign handle is never accepted.
    if (entry && entry.owner !== owner) throw new ModFunctionError("MODS_RESOURCE_OWNER")
    return this.closeEntry(id)
  }

  private closeEntry(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return Promise.resolve()
    if (entry.closing) return entry.closing
    entry.detach()
    // Set the promise before abort listeners run, so reentrant close shares cleanup.
    entry.closing = Promise.resolve().then(async () => {
      try {
        await entry.cleanup()
      } catch (error) {
        this.cleanupFailure ??=
          error instanceof Error ? error : new Error("MODS_RESOURCE_CLEANUP_FAILED")
        throw error
      } finally {
        this.entries.delete(id)
        const count = (this.counts.get(entry.owner) ?? 1) - 1
        if (count) this.counts.set(entry.owner, count)
        else this.counts.delete(entry.owner)
      }
    })
    this.closing.add(entry.closing)
    void entry.closing.then(
      () => this.closing.delete(entry.closing!),
      () => this.closing.delete(entry.closing!)
    )
    entry.controller.abort(new ModFunctionError("MODS_RESOURCE_CLOSED"))
    return entry.closing
  }

  async closeOwner(owner: Owner): Promise<void> {
    await Promise.allSettled(
      [...this.entries]
        .filter(([, entry]) => entry.owner === owner)
        .map(([id]) => this.closeEntry(id))
    )
  }

  async closeAll(): Promise<void> {
    this.closed = true
    await Promise.allSettled(
      [...this.entries.keys()].map((id) => this.closeEntry(id)).concat([...this.closing])
    )
  }

  /** A removed entry or a swallowed abort rejection cannot erase real cleanup failure. */
  assertRetired(): void {
    if (!this.closed || this.entries.size || this.closing.size)
      throw new ModFunctionError("MODS_RESOURCE_CLEANUP_PENDING")
    this.assertCleanupHealthy()
  }

  assertCleanupHealthy(): void {
    if (this.cleanupFailure) throw this.cleanupFailure
  }
}

export function functionTimerDelay(value: unknown, every = false): number {
  // Timer event middleware has a bounded invocation budget; longer waits need a pausable frame.
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 60000)
    throw new ModFunctionError("MODS_TIMER_DELAY")
  return every ? Math.max(1, value) : value
}

export function waitFunctionTimer(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    timer.unref()
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
  })
}
