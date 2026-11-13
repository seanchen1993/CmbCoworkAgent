import { AsyncLocalStorage } from "node:async_hooks"

interface Admission {
  exclusive: boolean
  resolve(release: () => void): void
  signal?: AbortSignal
  cancel?: () => void
}
class DatabaseGate {
  private readers = 0
  private writer = false
  private pending: Admission[] = []
  acquire(exclusive: boolean, signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted()
      const entry: Admission = { exclusive, resolve, signal }
      entry.cancel = () => {
        const index = this.pending.indexOf(entry)
        if (index < 0) return
        this.pending.splice(index, 1)
        signal?.removeEventListener("abort", entry.cancel!)
        reject(signal?.reason ?? new DOMException("Database admission cancelled", "AbortError"))
        this.pump()
      }
      this.pending.push(entry)
      signal?.addEventListener("abort", entry.cancel, { once: true })
      if (signal?.aborted) entry.cancel()
      else this.pump()
    })
  }
  private pump(): void {
    if (this.writer) return
    while (this.pending.length) {
      const next = this.pending[0]
      if (next.exclusive && this.readers) return
      this.pending.shift()
      if (next.cancel) next.signal?.removeEventListener("abort", next.cancel)
      if (next.exclusive) this.writer = true
      else this.readers++
      let active = true
      next.resolve(() => {
        if (!active) return
        active = false
        if (next.exclusive) this.writer = false
        else this.readers--
        this.pump()
      })
      if (next.exclusive) return
    }
  }
  idle(): boolean { return !this.writer && !this.readers && !this.pending.length }
}
interface Lease { references: number; release(): void; exclusive: boolean }
interface Call { active: boolean; lease: Lease }
interface Scope { databases: ReadonlyMap<string, Call>; owners: ReadonlyMap<object, readonly Call[]> }
interface OwnerDrain { count: number; idle: Promise<void>; release(): void }
const gates = new Map<string, DatabaseGate>()
const calls = new AsyncLocalStorage<Scope>()
const owners = new WeakMap<object, OwnerDrain>()

export function checkpointDatabaseMaintenanceIsCurrent(key: string): boolean {
  const current = calls.getStore()?.databases.get(key)
  return current?.active === true && current.lease.exclusive
}
export function checkpointDatabaseAdmissionIsCurrent(key: string): boolean {
  return calls.getStore()?.databases.get(key)?.active === true
}
export function checkpointDatabaseOperationIsCurrent(owner: object): boolean {
  return calls.getStore()?.owners.get(owner)?.some(call => call.active) === true
}
export async function waitForCheckpointDatabaseOperations(owner: object): Promise<void> {
  while (owners.get(owner)?.count) await owners.get(owner)!.idle
}
function retainOwner(owner: object): () => void {
  let state = owners.get(owner)
  if (!state) {
    let release!: () => void
    const idle = new Promise<void>(done => { release = done })
    state = { count: 0, idle, release }
    owners.set(owner, state)
  }
  state.count++
  const actual = state
  return () => {
    if (--actual.count === 0) { owners.delete(owner); actual.release() }
  }
}

/** Physical public-call lifetime, including initialization and database admission waits. */
export function retainCheckpointDatabaseOperationLifetime(owner: object): () => void {
  return retainOwner(owner)
}

/** Concurrency only. Each nested call has its own active lifetime and physical hold. */
async function run<T>(key: string, exclusive: boolean, work: () => Promise<T>, owner?: object,
  signal?: AbortSignal): Promise<T> {
  const current = calls.getStore()?.databases.get(key)
  if (current?.active && (exclusive || current.lease.exclusive))
    throw new Error(exclusive ? "SQLJS_SAVER_MAINTENANCE_INSIDE_OPERATION"
      : "SQLJS_SAVER_OPERATION_DURING_MAINTENANCE")
  signal?.throwIfAborted()
  const releaseOwner = owner ? retainOwner(owner) : undefined
  let call: Call | undefined
  try {
  const inherited = current?.active ? current.lease : undefined
  let lease = inherited
  if (!lease) {
    let gate = gates.get(key)
    if (!gate) { gate = new DatabaseGate(); gates.set(key, gate) }
    const original = gate
    const release = await gate.acquire(exclusive, signal).catch(error => {
      if (original.idle() && gates.get(key) === original) gates.delete(key)
      throw error
    })
    lease = { references: 0, exclusive, release() {
      release()
      if (original.idle() && gates.get(key) === original) gates.delete(key)
    } }
  }
  lease.references++
  call = { active: true, lease }
  const databases = new Map(calls.getStore()?.databases)
  databases.set(key, call)
  const scopeOwners = new Map(calls.getStore()?.owners)
  if (owner) scopeOwners.set(owner, [...(scopeOwners.get(owner) ?? []), call])
  return await calls.run({ databases, owners: scopeOwners }, work)
  }
  finally {
    if (call) call.active = false
    releaseOwner?.()
    if (call && --call.lease.references === 0) call.lease.release()
  }
}
export function runCheckpointDatabaseOperation<T>(key: string, work: () => Promise<T>, owner?: object,
  signal?: AbortSignal): Promise<T> {
  return run(key, false, work, owner, signal)
}
export function runCheckpointDatabaseMaintenance<T>(key: string, work: () => Promise<T>,
  signal?: AbortSignal): Promise<T> {
  return run(key, true, work, undefined, signal)
}
