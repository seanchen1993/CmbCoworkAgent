import { ModFunctionError } from "../../../shared/mods/v2/contracts"

export interface FunctionUiResolveQuota {
  handles: number
  roots: number
  branches: number
  reactions: number
}

declare const leaseBrand: unique symbol
declare const creditBrand: unique symbol
export interface FunctionUiResolveQuotaLease {
  readonly [leaseBrand]: true
}
export interface FunctionUiResolveQuotaCredit {
  readonly [creditBrand]: true
}

/** Both receipts come from native completion, never abort, a guest counter or sending kill. */
export interface FunctionUiResolvePhysicalLifetime {
  readonly owner: object
  readonly disposed: Promise<void>
  readonly hostDrained: Promise<void>
  assertCurrent(): void
}

interface LeaseRecord {
  owner: object
  assertCurrent(): void
  phase: "live" | "retiring" | "quarantined" | "released"
  limits: Readonly<FunctionUiResolveQuota>
  revision: number
  pending?: CreditRecord
  done: Promise<void>
  resolve(): void
  reject(error: unknown): void
}

interface CreditRecord {
  lease: LeaseRecord
  revision: number
  limits: Readonly<FunctionUiResolveQuota>
  acknowledged: boolean
}

const dimensions = ["handles", "roots", "branches", "reactions"] as const
const empty = (): FunctionUiResolveQuota => ({ handles: 0, roots: 0, branches: 0, reactions: 0 })
const token = <T>(): T => Object.freeze({}) as T
function fail(code = "MODS_UI_RESOLVE_QUOTA_IDENTITY"): never {
  throw new ModFunctionError(code)
}

function quota(value: FunctionUiResolveQuota): Readonly<FunctionUiResolveQuota> {
  if (
    Object.keys(value).length !== dimensions.length ||
    dimensions.some(
      (key) => !Object.hasOwn(value, key) || !Number.isSafeInteger(value[key]) || value[key] < 0
    )
  )
    fail("MODS_UI_RESOLVE_QUOTA_INVALID")
  return Object.freeze({ ...value })
}

/**
 * Main-process capacity shared by the actual thread's live and retiring utilities.
 * Native credit is reserved before delivery, across live, candidate and retiring utilities.
 * Synchronous constructors only consume their utility's already allocated local limits.
 */
export class FunctionUiResolveMainQuota {
  private readonly leases = new WeakMap<FunctionUiResolveQuotaLease, LeaseRecord>()
  private readonly owners = new WeakMap<object, LeaseRecord>()
  private readonly credits = new WeakMap<FunctionUiResolveQuotaCredit, CreditRecord>()
  private readonly occupied = new Set<LeaseRecord>()
  private used: FunctionUiResolveQuota = empty()
  private version = 0
  private closed = false
  readonly capacity: Readonly<FunctionUiResolveQuota>

  constructor(
    capacity: FunctionUiResolveQuota = {
      handles: 4096,
      roots: 32,
      branches: 1024,
      reactions: 1024
    }
  ) {
    this.capacity = quota(capacity)
  }

  get stats() {
    return Object.freeze({
      ...this.used,
      leases: this.occupied.size,
      quarantined: [...this.occupied].filter((record) => record.phase === "quarantined").length
    })
  }

  register(lifetime: FunctionUiResolvePhysicalLifetime): FunctionUiResolveQuotaLease {
    if (
      this.closed ||
      !lifetime.owner ||
      typeof lifetime.owner !== "object" ||
      this.owners.has(lifetime.owner)
    )
      fail()
    lifetime.assertCurrent()
    const owner = lifetime.owner
    if (this.closed || this.owners.has(owner)) fail("MODS_UI_RESOLVE_QUOTA_STALE")
    const guard = lifetime.assertCurrent.bind(lifetime)
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const done = new Promise<void>((accept, refuse) => {
      resolve = accept
      reject = refuse
    })
    void done.catch(() => undefined)
    const record: LeaseRecord = {
      owner,
      assertCurrent: guard,
      phase: "live",
      limits: quota(empty()),
      revision: 0,
      done,
      resolve,
      reject
    }
    const lease = token<FunctionUiResolveQuotaLease>()
    this.leases.set(lease, record)
    this.owners.set(owner, record)
    this.occupied.add(record)
    // Losing the VM cannot settle host work which ignores cancellation, and vice versa.
    void Promise.all([lifetime.disposed, lifetime.hostDrained]).then(
      () => {
        if (record.phase === "released" || record.phase === "quarantined") return
        record.phase = "released"
        for (const key of dimensions) this.used[key] -= record.limits[key]
        this.occupied.delete(record)
        this.version++
        record.resolve()
      },
      (error) => {
        record.phase = "quarantined"
        this.version++
        record.reject(error)
      }
    )
    return lease
  }

  /** Host-only, async table preparation may request more credit; a constructor never does. */
  reserve(
    lease: FunctionUiResolveQuotaLease,
    requested: FunctionUiResolveQuota
  ): FunctionUiResolveQuotaCredit {
    const record = this.current(lease)
    if (record.pending) fail("MODS_UI_RESOLVE_QUOTA_PENDING")
    const limits = quota(requested)
    const revision = record.revision
    const version = this.version
    for (const key of dimensions) {
      if (limits[key] < record.limits[key]) fail("MODS_UI_RESOLVE_QUOTA_SHRINK")
      if (this.used[key] + limits[key] - record.limits[key] > this.capacity[key])
        fail("MODS_UI_RESOLVE_QUOTA_CAPACITY")
    }
    record.assertCurrent()
    if (
      record.phase !== "live" ||
      this.closed ||
      record.revision !== revision ||
      this.version !== version ||
      record.pending
    )
      fail("MODS_UI_RESOLVE_QUOTA_STALE")
    const credit: CreditRecord = {
      lease: record,
      revision: revision + 1,
      limits,
      acknowledged: false
    }
    const receipt = token<FunctionUiResolveQuotaCredit>()
    // Debit is atomic and precedes the native transport's reply. A lost reply keeps the debit.
    for (const key of dimensions) this.used[key] += limits[key] - record.limits[key]
    record.limits = limits
    record.revision = credit.revision
    record.pending = credit
    this.credits.set(receipt, credit)
    this.version++
    return receipt
  }

  /** This is a private wire body, not a public SDK operation or an authority token. */
  wireCredit(lease: FunctionUiResolveQuotaLease, receipt: FunctionUiResolveQuotaCredit) {
    const record = this.current(lease)
    const credit = this.credits.get(receipt)
    if (!credit || credit.lease !== record || credit.revision !== record.revision) fail()
    return Object.freeze({ revision: credit.revision, limits: credit.limits })
  }

  /** The actual transport correlates its native ACK to this exact owner and receipt. */
  acknowledge(
    lease: FunctionUiResolveQuotaLease,
    receipt: FunctionUiResolveQuotaCredit,
    physicalOwner: object
  ): void {
    const record = this.current(lease)
    const credit = this.credits.get(receipt)
    if (
      !credit ||
      credit.lease !== record ||
      physicalOwner !== record.owner ||
      credit.revision !== record.revision
    )
      fail()
    if (credit.acknowledged) return
    if (record.pending !== credit) fail()
    credit.acknowledged = true
    record.pending = undefined
  }

  retire(lease: FunctionUiResolveQuotaLease): void {
    const record = this.record(lease)
    if (record.phase === "live") {
      record.phase = "retiring"
      this.version++
    }
    // Retirement fences admission. Only the two real completion receipts release capacity.
  }

  whenReleased(lease: FunctionUiResolveQuotaLease): Promise<void> {
    return this.record(lease).done
  }

  close(): void {
    this.closed = true
    for (const record of this.occupied) if (record.phase === "live") record.phase = "retiring"
    this.version++
  }

  private record(lease: FunctionUiResolveQuotaLease): LeaseRecord {
    const record = this.leases.get(lease)
    if (!record) fail()
    return record
  }

  private current(lease: FunctionUiResolveQuotaLease): LeaseRecord {
    const record = this.record(lease)
    if (this.closed || record.phase !== "live") fail("MODS_UI_RESOLVE_QUOTA_RETIRED")
    record.assertCurrent()
    if (this.closed || record.phase !== "live") fail("MODS_UI_RESOLVE_QUOTA_RETIRED")
    return record
  }
}
