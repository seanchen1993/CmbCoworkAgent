/** Host-only lifecycle fence. It does not execute, retry, cancel or reconcile any action. */
export const FUNCTION_DISPLAY_PROTOCOL = "mods.display/v1" as const
/** Includes same-key followers, not only unique producer jobs. Released on physical settlement. */
export const FUNCTION_DISPLAY_MAX_PENDING = 256
export type HostDisplayPath = "projection-v1" | "legacy"
export type HostDisplayPhase = "active" | "draining" | "unknown"
const leaseBrand: unique symbol = Symbol("HostDisplayLease")

export interface HostDisplayLease {
  readonly [leaseBrand]: true
  readonly path: HostDisplayPath
  readonly epoch: number
  readonly protocol: typeof FUNCTION_DISPLAY_PROTOCOL | "legacy"
  /** Main calls this only after the underlying physical operation actually settles. */
  completePhysical(): void
}
export interface HostDisplayRolloutSnapshot {
  readonly path: HostDisplayPath
  readonly epoch: number
  readonly phase: HostDisplayPhase
  readonly physicalPending: number
  readonly physicalUnknown: number
}
interface LeaseEntry {
  path: HostDisplayPath
  epoch: number
  released: boolean
  unknown: boolean
}
export interface HostDisplayRolloutOptions {
  /** Main startup configuration only. Never accept this value from Mod or renderer input. */
  enabled?: boolean
  /** Pure projection invalidation only; must never replay or approve action/tool owners. */
  invalidateProjection(input: Readonly<{ epoch: number; reason: string }>): void
}

/** No second scheduler: the manager still owns quotas, physical execution and all authority. */
export class HostDisplayRollout {
  private path: HostDisplayPath
  private epoch = 1
  private transitioning = false
  private invalidationFailed = false
  private physicalPending = 0
  private physicalUnknown = 0
  private reason = "startup"
  private readonly leases = new WeakMap<HostDisplayLease, LeaseEntry>()

  constructor(private readonly options: HostDisplayRolloutOptions) {
    this.path =
      (options.enabled ?? process.env.DEVCLAW_MODS_DISPLAY_PROJECTION !== "0")
        ? "projection-v1"
        : "legacy"
  }

  snapshot(): Readonly<HostDisplayRolloutSnapshot> {
    return Object.freeze({
      path: this.path,
      epoch: this.epoch,
      phase:
        this.invalidationFailed || this.physicalUnknown
          ? "unknown"
          : this.transitioning
            ? "draining"
            : "active",
      physicalPending: this.physicalPending,
      physicalUnknown: this.physicalUnknown
    })
  }

  admit(...peer: [unknown?]): HostDisplayLease {
    const peerProtocol = peer.length ? peer[0] : FUNCTION_DISPLAY_PROTOCOL
    if (this.snapshot().phase !== "active") throw Error("MODS_DISPLAY_DRAINING")
    if (this.physicalPending >= FUNCTION_DISPLAY_MAX_PENDING)
      throw Error("MODS_DISPLAY_PENDING_LIMIT")
    const path =
      this.path === "projection-v1" && peerProtocol === FUNCTION_DISPLAY_PROTOCOL
        ? "projection-v1"
        : "legacy"
    const entry: LeaseEntry = { path, epoch: this.epoch, released: false, unknown: false }
    const lease: HostDisplayLease = Object.freeze({
      [leaseBrand]: true as const,
      path,
      epoch: entry.epoch,
      protocol: path === "projection-v1" ? FUNCTION_DISPLAY_PROTOCOL : "legacy",
      completePhysical: () => this.completePhysical(lease)
    })
    this.leases.set(lease, entry)
    this.physicalPending++
    return lease
  }

  canPublish(lease: HostDisplayLease, path: HostDisplayPath = lease.path): boolean {
    const entry = this.leases.get(lease)
    return (
      !!entry &&
      !entry.released &&
      !entry.unknown &&
      entry.path === path &&
      entry.epoch === this.epoch &&
      this.snapshot().phase === "active"
    )
  }

  /** A lasting cache guard captures epoch/path, never the ephemeral request lease. */
  assertVersion(epoch: number, path: HostDisplayPath): void {
    if (epoch !== this.epoch || path !== this.path || this.snapshot().phase !== "active")
      throw Error("MODS_DISPLAY_VERSION_CHANGED")
  }

  switchPath(path: HostDisplayPath, reason = "host-path-change"): void {
    if (path !== "projection-v1" && path !== "legacy") throw Error("MODS_DISPLAY_PATH_INVALID")
    if (path === this.path) return
    this.transition(path, reason)
  }

  /** Source/policy/scope retirement shares the fence; it cannot reinstate an old owner. */
  invalidate(reason: string): void {
    this.transition(this.path, reason)
  }

  markPhysicalUnknown(lease: HostDisplayLease): void {
    const entry = this.leases.get(lease)
    if (!entry || entry.released) throw Error("MODS_DISPLAY_LEASE_INVALID")
    if (entry.unknown) return
    entry.unknown = true
    this.physicalUnknown++
    this.transition(this.path, "physical-outcome-unknown")
  }

  /** Explicit host retry of cache invalidation only. Never retries a drawing or external action. */
  retryInvalidation(): void {
    if (!this.invalidationFailed) return
    this.invalidateCurrentProjection()
  }

  private transition(path: HostDisplayPath, reason: string): void {
    this.transitioning = true
    this.path = path
    this.reason = reason
    this.epoch++
    this.invalidateCurrentProjection()
  }

  private invalidateCurrentProjection(): void {
    this.invalidationFailed = true
    // A failure leaves this flag set and admission closed. Never retry automatically.
    const result: unknown = this.options.invalidateProjection(
      Object.freeze({ epoch: this.epoch, reason: this.reason })
    )
    if (
      result &&
      typeof result === "object" &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      // Observe an accidentally returned rejection, without treating completion as valid retirement.
      void Promise.resolve(result).catch(() => {})
      throw Error("MODS_DISPLAY_INVALIDATION_MUST_BE_SYNCHRONOUS")
    }
    this.invalidationFailed = false
    this.finishDrain()
  }

  private completePhysical(lease: HostDisplayLease): void {
    const entry = this.leases.get(lease)
    if (!entry || entry.released) return
    entry.released = true
    this.physicalPending--
    if (entry.unknown) this.physicalUnknown--
    this.finishDrain()
  }

  private finishDrain(): void {
    if (!this.physicalPending && !this.invalidationFailed && !this.physicalUnknown)
      this.transitioning = false
  }
}
