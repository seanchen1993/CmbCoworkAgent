import type { QuickJSHandle } from "quickjs-emscripten"
import { MOD_TIERS, ModFunctionError, type ModTier } from "../../../shared/mods/v2/contracts"
import { FunctionDispatchDeadline } from "./dispatch-deadline"
import type {
  FunctionUiResolveDefinition,
  FunctionUiResolvePeer,
  FunctionUiResolvePreparedTable,
  FunctionUiResolveTarget
} from "./ui-resolve-private-types"
import {
  FUNCTION_UI_RESOLVE_CONSTRUCTORS,
  FunctionUiResolveRegistry,
  type FunctionUiResolveConstructor
} from "./ui-resolve-registry"

export interface FunctionUiResolverInvocation {
  readonly input: Readonly<{ surface: "desktop"; component: FunctionUiResolveTarget["component"] }>
  readonly signal: AbortSignal
  /** The same absolute monotonic cut reaches every actual native resolver frame. */
  readonly dispatchCutNs: string
}

export interface FunctionUiResolverSource {
  readonly peer: FunctionUiResolvePeer
  readonly registration: object
  readonly tier: ModTier
  /** Resident Session/guest/registration facts only; never the initial physical lease/deadline. */
  assertDefinitionCurrent(): void
  matches?(invocation: FunctionUiResolverInvocation): Promise<boolean>
  /** Raw caller-owned handle in this peer's actual context; never a JSON function placeholder. */
  invoke(
    invocation: FunctionUiResolverInvocation,
    next: (tier?: ModTier) => Promise<QuickJSHandle>
  ): Promise<QuickJSHandle>
}

declare const resolverBrand: unique symbol
export interface FunctionUiResolverRegistration {
  readonly [resolverBrand]: true
}

export interface FunctionUiResolveFoldDriver {
  readonly nativeRegistration: object
  assertNativeDefinitionCurrent(): void
  /** Actual native constructor table in Q, with actionless lower construction support. */
  nativeTable(consumer: FunctionUiResolvePeer): QuickJSHandle
  /** Table descriptors may run Proxy traps: all SDK routes are sticky effect-forbidden here. */
  inspect<T>(peer: FunctionUiResolvePeer, invocation: FunctionUiResolverInvocation, run: () => T): T
  /** Only asynchronous native preparation may reserve additional credit, before allocation. */
  ensureHandles?(additional: number, invocation: FunctionUiResolverInvocation): Promise<void>
  reportRecovery?(registration: object): void
}

export interface FunctionUiResolveFoldPreparation {
  readonly signal: AbortSignal
  /** Actual shared 120s startup cut, also covering nouns/engine/other table assemblies. */
  readonly startupCutNs: string
  /** Preparation/physical/source/candidate-sticky checks; NOT saved in cached definitions. */
  assertCurrent(): void
}

type Definitions = Readonly<Record<FunctionUiResolveConstructor, FunctionUiResolveDefinition>>

interface Row {
  peer: FunctionUiResolvePeer
  registration: object
  tier: ModTier
  assertDefinitionCurrent(): void
  matches?: FunctionUiResolverSource["matches"]
  invoke: FunctionUiResolverSource["invoke"]
}

function fail(code: string): never {
  throw new ModFunctionError(code)
}

/** Unwired load-time fold. Native permission/SDK/CPU proof admission remains the host driver's job. */
export class FunctionUiResolveTableFold {
  private readonly rows = new WeakMap<FunctionUiResolverRegistration, Row>()
  private readonly cache = new WeakMap<
    FunctionUiResolveTarget,
    Promise<FunctionUiResolvePreparedTable>
  >()

  constructor(
    private readonly registry: FunctionUiResolveRegistry,
    private readonly driver: FunctionUiResolveFoldDriver
  ) {}

  register(source: FunctionUiResolverSource): FunctionUiResolverRegistration {
    // Resolving a canonical target validates an actual registered peer, including lookalike rejection.
    this.registry.target(source.peer, "Pane")
    if (
      !source.registration ||
      typeof source.registration !== "object" ||
      !MOD_TIERS.includes(source.tier)
    )
      fail("MODS_UI_RESOLVE_IDENTITY")
    source.assertDefinitionCurrent()
    const value = Object.freeze({}) as FunctionUiResolverRegistration
    this.rows.set(value, {
      peer: source.peer,
      registration: source.registration,
      tier: source.tier,
      assertDefinitionCurrent: source.assertDefinitionCurrent.bind(source),
      matches: source.matches?.bind(source),
      invoke: source.invoke.bind(source)
    })
    return value
  }

  prepare(
    target: FunctionUiResolveTarget,
    ordered: readonly FunctionUiResolverRegistration[],
    preparation: FunctionUiResolveFoldPreparation
  ): Promise<FunctionUiResolvePreparedTable> {
    if (this.registry.target(target.consumer, target.component) !== target)
      fail("MODS_UI_RESOLVE_IDENTITY")
    preparation.assertCurrent()
    preparation.signal.throwIfAborted()
    const previous = this.cache.get(target)
    if (previous) return previous
    const chain = ordered
      .map((value) => {
        const row = this.rows.get(value)
        if (!row) fail("MODS_UI_RESOLVE_IDENTITY")
        return row
      })
      .filter((row) => row.peer !== target.consumer) // Whole Q group, BEFORE any matcher admission.
      .sort((a, b) => MOD_TIERS.indexOf(a.tier) - MOD_TIERS.indexOf(b.tier))
    const actual = this.build(target, chain, preparation)
    this.cache.set(target, actual)
    // A failed private candidate does not poison a future explicit safe preparation.
    void actual.catch(() => {
      if (this.cache.get(target) === actual) this.cache.delete(target)
    })
    return actual
  }

  private async build(
    target: FunctionUiResolveTarget,
    chain: readonly Row[],
    preparation: FunctionUiResolveFoldPreparation
  ) {
    const deadline = new FunctionDispatchDeadline(
      5000,
      preparation.signal,
      preparation.startupCutNs
    )
    const invocation: FunctionUiResolverInvocation = Object.freeze({
      input: Object.freeze({ surface: "desktop", component: target.component }),
      signal: deadline.signal,
      dispatchCutNs: deadline.sharedCutNs
    })
    const definitions: FunctionUiResolveDefinition[] = []
    const tables: FunctionUiResolvePreparedTable[] = []
    const nextCalls: Promise<QuickJSHandle>[] = []
    const routes = new Map<string, Promise<Definitions>>()
    let core: Promise<Definitions> | undefined
    let fatal: unknown
    let stopped = false
    const assertCurrent = () => {
      if (fatal) throw fatal
      preparation.assertCurrent()
      deadline.assertLive()
      if (stopped) fail("MODS_UI_RESOLVE_PREPARATION_ENDED")
    }
    const native = <T>(run: () => T): T => {
      assertCurrent()
      try {
        const value = run()
        assertCurrent()
        return value
      } catch (error) {
        fatal ??= error
        throw error
      }
    }
    const reserve = async (count: number) => {
      assertCurrent()
      if (this.driver.ensureHandles) {
        try {
          await deadline.wait(this.driver.ensureHandles(count, invocation))
        } catch (error) {
          fatal ??= error
          throw error
        }
      }
      assertCurrent()
    }
    const readDefinitions = async (
      peer: FunctionUiResolvePeer,
      registration: object,
      handle: QuickJSHandle,
      guard: () => void,
      core: boolean,
      dependencies: readonly FunctionUiResolveDefinition[] = []
    ): Promise<Definitions> => {
      const functions = this.driver.inspect(peer, invocation, () =>
        this.registry.readFunctionTable(peer, handle)
      )
      try {
        assertCurrent()
        if (core && FUNCTION_UI_RESOLVE_CONSTRUCTORS.some((name) => !functions[name]))
          fail("MODS_UI_RESOLVE_NATIVE_TABLE")
        await reserve(Object.keys(functions).length + 1)
        const transparent = core
          ? undefined
          : native(() =>
              this.registry.registerTransparentDefinition(peer, registration, guard, dependencies)
            )
        if (transparent) definitions.push(transparent)
        const values = {} as Record<FunctionUiResolveConstructor, FunctionUiResolveDefinition>
        for (const name of FUNCTION_UI_RESOLVE_CONSTRUCTORS) {
          const fn = functions[name]
          if (fn) {
            values[name] = native(() =>
              this.registry.registerDefinition(peer, registration, fn, guard, dependencies)
            )
            definitions.push(values[name])
          } else if (transparent) values[name] = transparent
          else fail("MODS_UI_RESOLVE_NATIVE_TABLE")
        }
        return Object.freeze(values)
      } finally {
        for (const fn of Object.values(functions)) fn.dispose()
      }
    }
    const lowerTable = async (peer: FunctionUiResolvePeer, values: Definitions) => {
      await reserve(FUNCTION_UI_RESOLVE_CONSTRUCTORS.length + 1)
      return native(() => {
        const table = this.registry.prepareTable(target, peer, values)
        tables.push(table)
        return table
      })
    }
    const waitHandle = async (actual: Promise<QuickJSHandle>) => {
      let settled: QuickJSHandle | undefined
      let discarded = false
      const discard = () => {
        discarded = true
        if (settled?.alive) settled.dispose()
      }
      void actual
        .then(
          (value) => {
            settled = value
            if (discarded || stopped) discard()
          },
          () => {}
        )
        .catch((error) => {
          fatal ??= error
        })
      try {
        return await deadline.wait(actual)
      } catch (error) {
        discard()
        throw error
      }
    }
    const execute = async (index: number, floor?: ModTier): Promise<Definitions> => {
      assertCurrent()
      const row = chain[index]
      if (!row) {
        return await (core ??= (async () => {
          native(() => this.driver.assertNativeDefinitionCurrent())
          const handle = native(() => this.driver.nativeTable(target.consumer))
          try {
            return await readDefinitions(
              target.consumer,
              this.driver.nativeRegistration,
              handle,
              this.driver.assertNativeDefinitionCurrent.bind(this.driver),
              true
            )
          } catch (error) {
            fatal ??= error
            throw error
          } finally {
            handle.dispose()
          }
        })())
      }
      if (floor && MOD_TIERS.indexOf(row.tier) < MOD_TIERS.indexOf(floor))
        return await run(index + 1, floor)
      native(() => row.assertDefinitionCurrent())
      const downstream = new Map<ModTier | undefined, Promise<Definitions>>()
      const local = new Map<ModTier | undefined, Promise<FunctionUiResolvePreparedTable>>()
      const imported = new Set<FunctionUiResolveDefinition>()
      const issued: Promise<QuickJSHandle>[] = []
      let lastNext: Promise<Definitions> | undefined
      let count = 0
      const lower = (tier?: ModTier) => {
        let actual = downstream.get(tier)
        if (!actual) {
          actual = run(index + 1, tier)
          downstream.set(tier, actual)
        }
        return actual
      }
      const next = (tier?: ModTier) => {
        const actual = (async () => {
          assertCurrent()
          native(() => row.assertDefinitionCurrent())
          if (++count > 32) fail("MODS_NEXT_LIMIT")
          if (tier !== undefined) {
            const allowed =
              row.tier === "prepend"
                ? ["append", "builtin", "core"]
                : row.tier === "append"
                  ? ["core"]
                  : []
            if (!allowed.includes(tier)) fail("MODS_TIER_DENIED")
          }
          const operation = lower(tier)
          lastNext = operation
          const values = await operation
          assertCurrent()
          let prepared = local.get(tier)
          if (!prepared) {
            prepared = lowerTable(row.peer, values)
            local.set(tier, prepared)
          }
          const table = await prepared
          assertCurrent()
          for (const definition of this.registry.sources(table)) imported.add(definition)
          return native(() => this.registry.readPreparedTable(table))
        })()
        nextCalls.push(actual)
        issued.push(actual)
        // The raw guest adapter owns returned handles, including ignored guest next promises.
        void actual.catch(() => {})
        return actual
      }
      let handle: QuickJSHandle | undefined
      try {
        if (row.matches) {
          const matched = await deadline.wait(row.matches(invocation))
          assertCurrent()
          native(() => row.assertDefinitionCurrent())
          if (typeof matched !== "boolean") fail("MODS_UI_RESOLVE_MATCHER")
          if (!matched) return await run(index + 1, floor)
        }
        assertCurrent()
        native(() => row.assertDefinitionCurrent())
        handle = await waitHandle(row.invoke(invocation, next))
        assertCurrent()
        native(() => row.assertDefinitionCurrent())
        for (let consumed = 0; consumed < issued.length; ) {
          const pending = issued.slice(consumed)
          consumed = issued.length
          await deadline.wait(Promise.allSettled(pending))
          assertCurrent()
        }
        return await readDefinitions(
          row.peer,
          row.registration,
          handle,
          row.assertDefinitionCurrent,
          false,
          [...imported]
        )
      } catch {
        assertCurrent()
        native(() => row.assertDefinitionCurrent())
        // Recovery reuses the last explicitly requested route; it does not replay SDK effects.
        // Different next.to routes are deliberate author calls and retain distinct route caches.
        try {
          this.driver.reportRecovery?.(row.registration)
        } catch {
          /* fixed host diagnostic only */
        }
        return await (lastNext ?? lower(floor))
      } finally {
        handle?.dispose()
      }
    }
    const run = (index: number, floor?: ModTier): Promise<Definitions> => {
      const key = `${index}:${floor ?? "default"}`
      let actual = routes.get(key)
      if (!actual) {
        actual = execute(index, floor)
        routes.set(key, actual)
      }
      return actual
    }
    try {
      const values = await deadline.wait(run(0))
      assertCurrent()
      // A returned raw table cannot outrun next() calls it already admitted. Settled failures are
      // still subject to the same preparation guard and absolute cut, without replaying a source.
      for (let consumed = 0; consumed < nextCalls.length; ) {
        const pending = nextCalls.slice(consumed)
        consumed = nextCalls.length
        await deadline.wait(Promise.allSettled(pending))
        assertCurrent()
      }
      const table = await lowerTable(target.consumer, values)
      assertCurrent()
      native(() => this.registry.adoptTable(table))
      return table
    } catch (error) {
      stopped = true
      // Try every actual disposal. A failed disposal keeps its ledger credit quarantined and must
      // not suppress the original preparation failure or leave unrelated candidates unretired.
      for (const table of tables.reverse()) {
        try {
          this.registry.retireTable(table)
        } catch {
          /* registry retains failed-disposal credit */
        }
      }
      for (const definition of definitions.reverse()) {
        try {
          this.registry.retireDefinition(definition)
        } catch {
          /* same physical disposal rule */
        }
      }
      throw error
    } finally {
      stopped = true
      deadline.close()
    }
  }
}
