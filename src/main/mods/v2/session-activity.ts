import { AsyncLocalStorage } from "node:async_hooks"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { retainHostStream } from "./host-stream-lifetime"

interface Token {
  owner: FunctionSessionActivity
  active: boolean
  kind: "foreground" | "resource"
  retirementUi?: boolean
  cleanup?: boolean
  releaseCatalog?: () => void
}

const scopes = new AsyncLocalStorage<Token>()

/** A host-owned native run has its own lifetime, even when admitted by a finished SDK child. */
export function withFreshFunctionSessionActivity<T>(run: () => Promise<T>): Promise<T> {
  return scopes.exit(run)
}

/** Host occupancy follows actual finally/iterator cleanup, never guest-reported counters. */
export class FunctionSessionActivity {
  private readonly tokens = new Set<Token>()
  private readonly waiters = new Set<{ resolve(): void; reject(error: Error): void }>()
  private readonly retirementWaiters = new Set<() => void>()
  private readonly settlementWaiters = new Set<() => void>()
  private paused = false
  private closed = false
  private foregroundIdlePending = false

  constructor(private readonly idle: () => void = () => {},
    private readonly retainCatalog: (cleanup: boolean) => (() => void) = () => () => {},
    private foregroundIdle?: () => void) {}

  get size(): number {
    return this.tokens.size
  }

  /** Physical retirement still waits for the admitted native caller's real finally. */
  whenSettled(): Promise<void> {
    if (!this.tokens.size) return Promise.resolve()
    return new Promise(resolve => this.settlementWaiters.add(resolve))
  }

  get foregroundSize(): number {
    return [...this.tokens].filter((token) => token.kind === "foreground").length
  }

  /** Native UI remains occupied until drain, but can be cancelled during retirement. */
  get retirementBlockingSize(): number {
    return [...this.tokens].filter((token) => token.kind === "foreground" && !token.retirementUi).length
  }

  /** Explicit release preserves background resources; native drawing can retire with its VM. */
  get releaseBlockingSize(): number {
    return [...this.tokens].filter(token => !token.retirementUi).length
  }

  pauseForRelease(): boolean {
    if (this.closed || this.paused || this.releaseBlockingSize) return false
    this.paused = true
    return true
  }

  pauseForRetirement(): boolean {
    if (this.closed || this.paused || this.retirementBlockingSize) return false
    this.paused = true
    return true
  }

  /** Brief native reads may overlap an explicit click. Observe real settlement, never cancel work. */
  async pauseForRetirementWhenIdle(signal: AbortSignal, waitMs = 250): Promise<boolean> {
    signal.throwIfAborted()
    if (this.pauseForRetirement()) return true
    if (this.closed || this.paused) return false
    return new Promise<boolean>((resolve, reject) => {
      const finish = (paused: boolean, error?: unknown) => {
        clearTimeout(timer)
        this.retirementWaiters.delete(attempt)
        signal.removeEventListener("abort", cancel)
        if (error !== undefined) reject(error)
        else resolve(paused)
      }
      const cancel = () => finish(false, signal.reason)
      const attempt = () => {
        if (this.closed) finish(false)
        else if (this.pauseForRetirement()) finish(true)
      }
      const timer = setTimeout(() => finish(false), waitMs)
      this.retirementWaiters.add(attempt)
      signal.addEventListener("abort", cancel, { once: true })
      if (signal.aborted) cancel()
      else attempt()
    })
  }

  /** Explicit stop freezes new entry before awaiting already-owned foreground cleanup. */
  async pauseAndWaitForRetirement(): Promise<void> {
    if (this.closed || this.paused) throw new ModFunctionError("MODS_SESSION_CLOSED")
    this.paused = true
    while (this.retirementBlockingSize && !this.closed)
      await new Promise<void>((resolve) => this.retirementWaiters.add(resolve))
    if (this.closed) throw new ModFunctionError("MODS_SESSION_CLOSED")
  }

  get withinEntry(): boolean {
    return this.inherited() !== undefined
  }

  pauseIfIdle(includeResources = true): boolean {
    if (this.closed || this.paused || (includeResources ? this.size : this.foregroundSize))
      return false
    this.paused = true
    return true
  }

  resume(): void {
    if (this.closed) return
    this.paused = false
    for (const waiter of this.waiters) waiter.resolve()
    this.waiters.clear()
  }

  close(): void {
    this.closed = true
    this.foregroundIdle = undefined
    for (const resolve of this.retirementWaiters) resolve()
    this.retirementWaiters.clear()
    for (const waiter of this.waiters) waiter.reject(new ModFunctionError("MODS_SESSION_CLOSED"))
    this.waiters.clear()
  }

  private inherited(): Token | undefined {
    const token = scopes.getStore()
    if (token?.owner !== this) return undefined
    if (!token.active) throw new ModFunctionError("MODS_ENTRY_EXPIRED")
    return token
  }

  private enter(kind: Token["kind"] = "foreground"): Token {
    const inherited = this.inherited()
    if (this.closed && !inherited?.cleanup) throw new ModFunctionError("MODS_SESSION_CLOSED")
    if (this.paused && inherited?.kind !== "foreground")
      throw new ModFunctionError("MODS_CONFIG_APPLYING")
    const token = { owner: this, active: true, kind, cleanup: inherited?.cleanup,
      releaseCatalog: this.retainCatalog(inherited?.cleanup === true) }
    this.tokens.add(token)
    return token
  }

  private release(token: Token): void {
    if (!token.active) return
    token.active = false
    this.tokens.delete(token)
    token.releaseCatalog?.()
    if (!this.tokens.size) {
      for (const resolve of this.settlementWaiters) resolve()
      this.settlementWaiters.clear()
    }
    if (token.kind === "foreground") this.notifyForegroundIdle()
    if (!this.tokens.size && !this.closed) queueMicrotask(this.idle)
  }

  private notifyForegroundIdle(): void {
    if (!this.retirementBlockingSize) {
      for (const resolve of this.retirementWaiters) resolve()
      this.retirementWaiters.clear()
    }
    if (!this.foregroundIdle || this.closed || this.foregroundIdlePending || this.retirementBlockingSize) return
    this.foregroundIdlePending = true
    queueMicrotask(() => {
      this.foregroundIdlePending = false
      if (this.closed || this.retirementBlockingSize) return
      try { this.foregroundIdle?.() } catch { /* Observation cannot break actual release. */ }
    })
  }

  /** A scope that has a separate dispose/terminal callback, such as a Flow. */
  retain(): () => void {
    const token = this.enter()
    return () => this.release(token)
  }

  /** Independent native constructor work must not inherit its finished drawing entry token. */
  retainFresh(): () => void {
    return scopes.exit(() => this.retain())
  }

  /** Native proof can demote canceled UI waiting; total occupancy remains until real disposal. */
  retainFreshResource(): ReturnType<FunctionSessionActivity["retainResource"]> {
    return scopes.exit(() => this.retainResource())
  }

  /** Only native UI assembly uses this; replacement still waits for its physical drain. */
  retainRetirableUiResource(): ReturnType<FunctionSessionActivity["retainResource"]> {
    return scopes.exit(() => this.createResource(true))
  }

  /** Only a real host resource ACK may demote opening; cleanup always promotes it again. */
  retainResource(): { ready(): void; closing(): void; release(): void } {
    return this.createResource(false)
  }

  private createResource(retirementUi: boolean): ReturnType<FunctionSessionActivity["retainResource"]> {
    const token = this.enter()
    token.retirementUi = retirementUi
    return {
      ready: () => {
        if (token.active && token.kind === "foreground") {
          token.kind = "resource"
          this.notifyForegroundIdle()
        }
      },
      closing: () => {
        if (token.active) token.kind = "foreground"
      },
      release: () => this.release(token)
    }
  }

  /** A cancellable host resource's result wait is not a foreground user operation. */
  resource<T>(operation: () => Promise<T>): Promise<T> {
    return scopes.exit(() => this.run(operation, "resource"))
  }

  /** Only a host core with no matching guest hooks may suspend its native timer wait. */
  async nativeWait<T>(operation: () => Promise<T>): Promise<T> {
    const token = this.inherited()
    if (!token || token.kind !== "foreground" || token.cleanup)
      throw new ModFunctionError("MODS_NATIVE_WAIT_SCOPE")
    token.kind = "resource"
    this.notifyForegroundIdle()
    let value!: T
    let rejected = false
    let failure: unknown
    try {
      value = await operation()
    } catch (error) {
      rejected = true
      failure = error
    }
    // Waking or failing during preflight cannot enter guest code until resume.
    do {
      await this.waitForAdmission()
      if (this.closed) throw new ModFunctionError("MODS_SESSION_CLOSED")
      if (!token.active) throw new ModFunctionError("MODS_ENTRY_EXPIRED")
      if (!this.paused) token.kind = "foreground"
    } while (this.paused)
    if (rejected) throw failure
    return value
  }

  /** Host retirement may drain already-owned resources while new entries stay paused. */
  async cleanup<T>(operation: () => Promise<T>): Promise<T> {
    const token: Token = { owner: this, active: true, kind: "foreground", cleanup: true,
      releaseCatalog: this.retainCatalog(true) }
    this.tokens.add(token)
    try {
      return await scopes.run(token, operation)
    } finally {
      this.release(token)
    }
  }

  sync<T>(operation: () => T): T {
    const token = this.enter()
    try {
      return scopes.run(token, operation)
    } finally {
      this.release(token)
    }
  }

  /** Only trusted independent module/timer entries may discard a creator's expired token. */
  fresh<T>(operation: () => Promise<T>): Promise<T> {
    return scopes.exit(() => this.run(operation))
  }

  /** A timer's scheduling loop is not an entered callback or a perpetual occupancy lease. */
  scheduling<T>(operation: () => Promise<T>): Promise<T> {
    return scopes.exit(operation)
  }

  async run<T>(operation: () => Promise<T>, kind: Token["kind"] = "foreground"): Promise<T> {
    const inherited = this.inherited()
    if (this.paused && inherited?.kind !== "foreground" && !this.closed)
      await this.waitForAdmission()
    const token = this.enter(kind)
    try {
      const value = await scopes.run(token, operation)
      if (this.isStream(value)) return this.stream(value, token) as T
      this.release(token)
      return value
    } catch (error) {
      this.release(token)
      throw error
    }
  }

  private async waitForAdmission(): Promise<void> {
    while (this.paused && !this.closed)
      await new Promise<void>((resolve, reject) => this.waiters.add({ resolve, reject }))
    if (this.closed) throw new ModFunctionError("MODS_SESSION_CLOSED")
  }

  private isStream(value: unknown): value is AsyncGenerator<unknown, unknown> {
    return (
      value !== null &&
      typeof value === "object" &&
      typeof (value as AsyncGenerator)[Symbol.asyncIterator] === "function" &&
      typeof (value as AsyncGenerator).next === "function"
    )
  }

  private stream<T extends AsyncGenerator<unknown, unknown>>(source: T, token: Token): T {
    return retainHostStream(
      source,
      (run) => scopes.run(token, run),
      () => this.release(token)
    )
  }
}
