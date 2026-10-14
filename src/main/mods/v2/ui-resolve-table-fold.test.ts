import { getQuickJS, type QuickJSHandle } from "quickjs-emscripten"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { ModFunctionError, type ModTier } from "../../../shared/mods/v2/contracts"
import type { FunctionUiResolveDriver, FunctionUiResolvePeer } from "./ui-resolve-private-types"
import {
  FUNCTION_UI_RESOLVE_CONSTRUCTORS,
  FunctionUiResolveLedger,
  FunctionUiResolveRegistry,
  installFunctionUiResolveDataCopy
} from "./ui-resolve-registry"
import { FunctionSharedWallCut } from "./shared-wall-cut"
import { validateFunctionTree } from "../../../shared/mods/v2/ui"
import {
  FunctionUiResolveTableFold,
  type FunctionUiResolveFoldDriver,
  type FunctionUiResolverInvocation,
  type FunctionUiResolverSource
} from "./ui-resolve-table-fold"

// Actual QuickJS function/table foundation, not main RPC, renderer or SDK acceptance evidence.
let quickJS: Awaited<ReturnType<typeof getQuickJS>>
beforeAll(async () => {
  quickJS = await getQuickJS()
})
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fixture(ensureHandles?: FunctionUiResolveFoldDriver["ensureHandles"]) {
  const controller = new AbortController()
  let preparationLive = true
  const peers: Array<{ peer: FunctionUiResolvePeer; dispose(): void }> = []
  const held: QuickJSHandle[] = []
  const captures = vi.fn()
  const core = vi.fn()
  const recovered = vi.fn()
  const constructorFailures = vi.fn<(error: unknown) => void>()
  const currentCuts: string[] = []
  const driver: FunctionUiResolveDriver = {
    captureCurrent(target) {
      captures()
      return {
        consumer: target.consumer,
        component: target.component,
        identity: {},
        signal: controller.signal,
        assertCurrent() {
          controller.signal.throwIfAborted()
        }
      }
    },
    createConstructorScope(definition, receipt) {
      const assertCurrent = () => {
        definition.assertCurrent()
        receipt.assertCurrent()
      }
      return {
        assertCurrent,
        runSync(_call, _peer, budget, _phase, run) {
          assertCurrent()
          budget.assertRemaining()
          const value = run()
          assertCurrent()
          budget.assertRemaining()
          return value
        },
        finishNormal() {
          /* This fixture has no asynchronous constructor activity to release. */
        },
        finishFailure: constructorFailures
      }
    },
    captureActions: () => Object.freeze({ actualQActions: true }),
    reconnect: (_call, proof, output) => {
      proof.assertCurrent()
      return output.dup()
    }
  }
  // No CPU timing claim in fold assertions. Shared-cut/interrupt behavior has its own registry gate.
  const ledger = new FunctionUiResolveLedger()
  const registry = new FunctionUiResolveRegistry(driver, ledger, undefined, () => 0)
  const assembly = registry.registerAssembly({}, controller.signal)
  const peer = (name: string) => {
    const runtime = quickJS.newRuntime()
    const context = runtime.newContext()
    const disposeCopy = installFunctionUiResolveDataCopy(context)
    const actual = registry.registerPeer(assembly, Object.freeze({ name }), context, () =>
      controller.signal.throwIfAborted()
    )
    peers.push({
      peer: actual,
      dispose() {
        disposeCopy()
        context.dispose()
        runtime.dispose()
      }
    })
    return actual
  }
  const evaluate = (actual: FunctionUiResolvePeer, source: string) =>
    actual.context.unwrapResult(actual.context.evalCode(`(${source})`))
  const own = (handle: QuickJSHandle) => {
    held.push(handle)
    return handle
  }
  const nativeTable = (consumer: FunctionUiResolvePeer) => {
    core()
    return evaluate(
      consumer,
      `Object.freeze(Object.fromEntries(
      ${JSON.stringify(FUNCTION_UI_RESOLVE_CONSTRUCTORS)}.map(name => [name,
        name === "Markdown" ? p => ({type:name, props:{text:String(p.text ?? name)}})
          : p => ({type:name, props:{}, children:[String(p.value ?? name)]})])))`
    )
  }
  const inspected =
    vi.fn<(peer: FunctionUiResolvePeer, invocation: FunctionUiResolverInvocation) => void>()
  const inspect: FunctionUiResolveFoldDriver["inspect"] = <T>(
    actual: FunctionUiResolvePeer,
    invocation: FunctionUiResolverInvocation,
    run: () => T
  ): T => {
    inspected(actual, invocation)
    actual.assertCurrent()
    invocation.signal.throwIfAborted()
    new FunctionSharedWallCut(invocation.dispatchCutNs).assertLive()
    const value = run()
    actual.assertCurrent()
    invocation.signal.throwIfAborted()
    return value
  }
  const fold = new FunctionUiResolveTableFold(registry, {
    nativeRegistration: Object.freeze({ actualNative: true }),
    assertNativeDefinitionCurrent: () => controller.signal.throwIfAborted(),
    nativeTable,
    inspect,
    ...(ensureHandles ? { ensureHandles } : {}),
    reportRecovery: recovered
  })
  const preparation = (milliseconds = 5000) => ({
    signal: controller.signal,
    startupCutNs: FunctionSharedWallCut.after(milliseconds).expiresAtNs,
    assertCurrent() {
      if (!preparationLive) throw new ModFunctionError("ACTUAL_PREPARATION_RETIRED")
      controller.signal.throwIfAborted()
    }
  })
  const source = (
    actual: FunctionUiResolvePeer,
    options: {
      tier?: ModTier
      matches?: FunctionUiResolverSource["matches"]
      invoke?: FunctionUiResolverSource["invoke"]
      guard?: () => void
      wrap?: string
    } = {}
  ) => {
    const entered = vi.fn()
    const actualInvocations: Promise<QuickJSHandle>[] = []
    const registration = Object.freeze({ actualRegistration: {} })
    const token = fold.register({
      peer: actual,
      registration,
      tier: options.tier ?? "user",
      assertDefinitionCurrent: options.guard ?? (() => actual.assertCurrent()),
      matches: options.matches,
      invoke(invocation, next) {
        entered()
        currentCuts.push(invocation.dispatchCutNs)
        const running = (async () => {
          if (options.invoke) return options.invoke(invocation, next)
          const lower = await next()
          const wrap = evaluate(actual, options.wrap ?? "lower => lower")
          try {
            return actual.context.unwrapResult(
              actual.context.callFunction(wrap, actual.context.undefined, lower)
            )
          } finally {
            wrap.dispose()
            lower.dispose()
          }
        })()
        actualInvocations.push(running)
        return running
      }
    })
    return { token, entered, registration, actualInvocations }
  }
  const invoke = (
    actual: FunctionUiResolvePeer,
    table: QuickJSHandle,
    name: string,
    props = "{}"
  ) => {
    const fn = actual.context.getProp(table, name)
    const argument = evaluate(actual, props)
    try {
      const value = actual.context.unwrapResult(
        actual.context.callFunction(fn, actual.context.undefined, argument)
      )
      try {
        return actual.context.dump(value) as unknown
      } finally {
        value.dispose()
      }
    } finally {
      fn.dispose()
      argument.dispose()
    }
  }
  cleanups.push(() => {
    registry.close()
    for (const handle of held.reverse()) if (handle.alive) handle.dispose()
    for (const entry of peers.reverse()) entry.dispose()
  })
  return {
    registry,
    ledger,
    fold,
    controller,
    peer,
    evaluate,
    own,
    source,
    invoke,
    preparation,
    core,
    recovered,
    captures,
    inspect,
    currentCuts,
    constructorFailures,
    retirePreparation() {
      preparationLive = false
    }
  }
}

describe("private load-time UI resolver table fold foundation", () => {
  it("folds the tenth real Markdown constructor and reserves ten functions plus the table", async () => {
    const reservations = vi.fn<NonNullable<FunctionUiResolveFoldDriver["ensureHandles"]>>(
      async () => undefined
    )
    const f = fixture(reservations)
    const q = f.peer("Q")
    const p = f.peer("P")
    const row = f.source(p, {
      wrap: `lower => ({...lower,Markdown:p=>lower.Markdown({...p,text:"P:"+p.text})})`
    })
    const target = f.registry.target(q, "AssistantMessage")
    const prepared = await f.fold.prepare(target, [row.token], f.preparation())
    const table = f.own(f.registry.readPreparedTable(prepared))
    const actual = f.invoke(q, table, "Markdown", `{text:"[Docs](https://example.com)"}`)
    expect(actual).toEqual({ type: "Markdown", props: { text: "P:[Docs](https://example.com)" } })
    expect(() => validateFunctionTree(actual)).not.toThrow()
    expect(FUNCTION_UI_RESOLVE_CONSTRUCTORS).toHaveLength(10)
    expect(reservations.mock.calls.some(([count]) => count === 11)).toBe(true)
    expect(row.entered).toHaveBeenCalledOnce()
    expect(f.core).toHaveBeenCalledOnce()
  })

  it("uses a real transparent definition when a resolver omits Markdown", async () => {
    const f = fixture()
    const q = f.peer("Q")
    const p = f.peer("P")
    const row = f.source(p, {
      invoke: async () =>
        f.evaluate(p, `({Text:p=>({type:"Text",props:{},children:["only Text"]})})`)
    })
    const target = f.registry.target(q, "Pane")
    const prepared = await f.fold.prepare(target, [row.token], f.preparation())
    expect(f.invoke(q, f.own(f.registry.readPreparedTable(prepared)), "Markdown", `{text:"omitted"}`))
      .toEqual({ type: "fragment", children: [] })
    expect(f.core).not.toHaveBeenCalled()
  })
  it("skips all actual Q registrations before matching and folds stable tier/source order", async () => {
    const f = fixture()
    const q = f.peer("Q")
    const p = f.peer("P")
    const r = f.peer("R")
    const ownMatcher = vi.fn(async () => {
      throw Error("must not enter Q matcher")
    })
    const self1 = f.source(q, { matches: ownMatcher })
    const self2 = f.source(q, { tier: "prepend", matches: ownMatcher })
    const outer = f.source(p, {
      tier: "prepend",
      wrap: `lower => ({...lower,
      Text:p => lower.Text({...p,value:p.value+"|P"})})`
    })
    const inner = f.source(r, {
      wrap: `lower => ({...lower,
      Text:p => lower.Text({...p,value:p.value+"|R"})})`
    })
    const target = f.registry.target(q, "AssistantMessage")
    const prepared = await f.fold.prepare(
      target,
      [self1.token, inner.token, self2.token, outer.token],
      f.preparation()
    )
    const table = f.own(f.registry.readPreparedTable(prepared))
    expect(f.invoke(q, table, "Text", `{value:"native"}`)).toEqual({
      type: "Text",
      props: {},
      children: ["native|P|R"]
    })
    expect(ownMatcher).not.toHaveBeenCalled()
    expect(self1.entered).not.toHaveBeenCalled()
    expect(self2.entered).not.toHaveBeenCalled()
    expect(outer.entered).toHaveBeenCalledOnce()
    expect(inner.entered).toHaveBeenCalledOnce()
    expect(f.core).toHaveBeenCalledOnce()
    expect(new Set(f.currentCuts).size).toBe(1)
    expect(f.captures).toHaveBeenCalledOnce() // Actual Q→P→R→Q call has one root receipt.
  })

  it("retains a frozen same-object table with real closure state for each component", async () => {
    const f = fixture()
    const q = f.peer("Q")
    const p = f.peer("P")
    const row = f.source(p, {
      invoke: async () =>
        f.evaluate(
          p,
          `(() => {
      let count=0; return {Text:() => ({type:"Text",props:{},children:[String(++count)]})}
    })()`
        )
    })
    const target = f.registry.target(q, "Pane")
    const a = await f.fold.prepare(target, [row.token], f.preparation())
    const b = await f.fold.prepare(target, [row.token], f.preparation())
    expect(a).toBe(b)
    const first = f.own(f.registry.readPreparedTable(a))
    const second = f.own(f.registry.readPreparedTable(b))
    expect(q.context.eq(first, second)).toBe(true)
    q.context.setProp(q.context.global, "actual", first)
    const frozen = f.evaluate(q, "Object.isFrozen(actual) && typeof actual.Text==='function'")
    try {
      expect(q.context.dump(frozen)).toBe(true)
    } finally {
      frozen.dispose()
    }
    expect(f.invoke(q, first, "Text")).toMatchObject({ children: ["1"] })
    expect(f.invoke(q, second, "Text")).toMatchObject({ children: ["2"] })
    await f.fold.prepare(f.registry.target(q, "Spinner"), [row.token], f.preparation())
    expect(row.entered).toHaveBeenCalledTimes(2)
    expect(f.core).not.toHaveBeenCalled()
  })

  it("recovers after repeated next calls with the actual lower table and no source/core replay", async () => {
    const f = fixture()
    const q = f.peer("Q")
    const p = f.peer("P")
    const r = f.peer("R")
    const sameObject = vi.fn()
    const inner = f.source(r)
    const outer = f.source(p, {
      invoke: async (_invocation, next) => {
        const a = await next()
        const b = await next()
        try {
          sameObject(p.context.eq(a, b))
          throw Error("optional failure after next")
        } finally {
          a.dispose()
          b.dispose()
        }
      }
    })
    const target = f.registry.target(q, "Pane")
    const table = await f.fold.prepare(target, [outer.token, inner.token], f.preparation())
    expect(
      f.invoke(q, f.own(f.registry.readPreparedTable(table)), "Text", `{value:"lower"}`)
    ).toMatchObject({ children: ["lower"] })
    expect(sameObject).toHaveBeenCalledWith(true)
    expect(inner.entered).toHaveBeenCalledOnce()
    expect(f.core).toHaveBeenCalledOnce()
    expect(f.recovered).toHaveBeenCalledExactlyOnceWith(outer.registration)
  })

  it("caches each explicit next.to route and recovers the last route without replay", async () => {
    const f = fixture()
    const q = f.peer("Q")
    const p = f.peer("P")
    const r = f.peer("R")
    const inner = f.source(r, {
      tier: "append",
      wrap: `lower => ({...lower,
      Text:p => lower.Text({...p,value:p.value+"|append"})})`
    })
    const outer = f.source(p, {
      tier: "prepend",
      invoke: async (_invocation, next) => {
        const a = await next("core")
        const b = await next("core")
        const c = await next("append")
        try {
          expect(p.context.eq(a, b)).toBe(true)
          expect(p.context.eq(a, c)).toBe(false)
          throw Error("optional failure keeps last requested append route")
        } finally {
          a.dispose()
          b.dispose()
          c.dispose()
        }
      }
    })
    const target = f.registry.target(q, "Pane")
    const table = await f.fold.prepare(target, [outer.token, inner.token], f.preparation())
    expect(
      f.invoke(q, f.own(f.registry.readPreparedTable(table)), "Text", `{value:"core"}`)
    ).toMatchObject({ children: ["core|append"] })
    expect(inner.entered).toHaveBeenCalledOnce()
    expect(f.core).toHaveBeenCalledOnce()
    expect(f.recovered).toHaveBeenCalledExactlyOnceWith(outer.registration)
  })

  it("rejects a user-tier next.to without silently changing its route", async () => {
    const f = fixture()
    const q = f.peer("Q")
    const p = f.peer("P")
    const denied = vi.fn()
    const row = f.source(p, {
      invoke: async (_invocation, next) => {
        try {
          await next("builtin")
        } catch (error) {
          denied(error instanceof Error ? error.message : "unexpected")
        }
        return f.evaluate(p, `({Text:()=>({type:"Text",props:{},children:["recovered"]})})`)
      }
    })
    const target = f.registry.target(q, "Pane")
    const table = await f.fold.prepare(target, [row.token], f.preparation())
    expect(denied).toHaveBeenCalledExactlyOnceWith("MODS_TIER_DENIED")
    expect(f.invoke(q, f.own(f.registry.readPreparedTable(table)), "Text")).toMatchObject({
      children: ["recovered"]
    })
    expect(f.core).not.toHaveBeenCalled()
  })

  it.each([
    ["accessor", `Object.defineProperty({},"Text",{enumerable:true,get(){throw Error("getter")}})`],
    ["unknown key", `({Text:()=>({type:"Text",props:{}}),Extra:()=>null})`],
    ["symbol key", `({Text:()=>({type:"Text",props:{}}),[Symbol("bad")]:()=>null})`],
    ["non-function", `({Text:{fakeFunction:1}})`],
    ["Promise table", `Promise.resolve({Text:()=>({type:"Text",props:{}})})`]
  ])("recovers an invalid %s without a JSON function placeholder", async (_name, raw) => {
    const f = fixture()
    const q = f.peer("Q")
    const p = f.peer("P")
    const row = f.source(p, { invoke: async () => f.evaluate(p, raw) })
    const target = f.registry.target(q, "Pane")
    const table = await f.fold.prepare(target, [row.token], f.preparation())
    expect(
      f.invoke(q, f.own(f.registry.readPreparedTable(table)), "Text", `{value:"native"}`)
    ).toMatchObject({ children: ["native"] })
    expect(f.recovered).toHaveBeenCalledExactlyOnceWith(row.registration)
    expect(f.core).toHaveBeenCalledOnce()
  })

  it("fills omissions with a real transparent constructor and retains an empty trailing fragment", async () => {
    const f = fixture()
    const q = f.peer("Q")
    const p = f.peer("P")
    const row = f.source(p, {
      invoke: async () => f.evaluate(p, `({Text:p=>({type:"Text",props:{},children:[p.value]})})`)
    })
    const target = f.registry.target(q, "AskUserQuestion")
    const prepared = await f.fold.prepare(target, [row.token], f.preparation())
    const table = f.own(f.registry.readPreparedTable(prepared))
    expect(
      f.invoke(
        q,
        table,
        "Button",
        `{
      key:"omitted",onPress:()=>{throw Error("must not run")},
      children:["a",[false,2],{type:"fragment",children:[]}]
    }`
      )
    ).toEqual({ type: "fragment", children: ["a", "2", { type: "fragment", children: [] }] })
    expect(f.invoke(q, table, "Button", `{key:"empty"}`)).toEqual({
      type: "fragment",
      children: []
    })
    expect(f.core).not.toHaveBeenCalled()
  })

  it("uses one hard cut across matchers and waits for an admitted next before adoption", async () => {
    const f = fixture()
    const q = f.peer("Q")
    const p = f.peer("P")
    const r = f.peer("R")
    const reached = deferred<void>()
    const release = deferred<void>()
    const lower = f.source(r, {
      matches: async (invocation) => {
        f.currentCuts.push(invocation.dispatchCutNs)
        reached.resolve()
        await release.promise
        return true
      }
    })
    let ignored: Promise<QuickJSHandle> | undefined
    const outer = f.source(p, {
      invoke: async (_invocation, next) => {
        ignored = next()
        void ignored.then((handle) => handle.dispose())
        return f.evaluate(p, `({Text:()=>({type:"Text",props:{},children:["outer"]})})`)
      }
    })
    const target = f.registry.target(q, "Pane")
    let adopted = false
    const actual = f.fold
      .prepare(target, [outer.token, lower.token], f.preparation())
      .then((value) => {
        adopted = true
        return value
      })
    await reached.promise
    await Promise.resolve()
    expect(adopted).toBe(false)
    release.resolve()
    const table = await actual
    await ignored
    expect(f.invoke(q, f.own(f.registry.readPreparedTable(table)), "Text")).toMatchObject({
      children: ["outer"]
    })
    expect(f.core).toHaveBeenCalledOnce()
    expect(new Set(f.currentCuts).size).toBe(1)
  })

  it("does not recover native source/registration failure caught by an upstream resolver", async () => {
    const f = fixture()
    const q = f.peer("Q")
    const p = f.peer("P")
    const r = f.peer("R")
    let sourceLive = true
    const guard = () => {
      if (!sourceLive) throw new ModFunctionError("ACTUAL_SOURCE_REVOKED")
    }
    const lower = f.source(r, { guard })
    const outer = f.source(p, {
      invoke: async (_invocation, next) => {
        sourceLive = false
        try {
          await next()
        } catch {
          /* A native revocation cannot become a healthy parent table. */
        }
        return f.evaluate(p, `({Text:()=>({type:"Text",props:{}})})`)
      }
    })
    const target = f.registry.target(q, "Pane")
    const baselineHandles = f.ledger.stats.handles
    await expect(
      f.fold.prepare(target, [outer.token, lower.token], f.preparation())
    ).rejects.toThrow("ACTUAL_SOURCE_REVOKED")
    expect(f.core).not.toHaveBeenCalled()
    expect(f.recovered).not.toHaveBeenCalled()
    expect(() => f.registry.readTable(target)).toThrow("MODS_UI_RESOLVE_TABLE")
    expect(f.ledger.stats.handles).toBe(baselineHandles)
  })

  it("fences cancellation and disposes a late actual raw handle without republishing", async () => {
    const f = fixture()
    const q = f.peer("Q")
    const p = f.peer("P")
    const raw = deferred<QuickJSHandle>()
    const entered = deferred<void>()
    const row = f.source(p, {
      invoke: async () => {
        entered.resolve()
        return raw.promise
      }
    })
    const target = f.registry.target(q, "Pane")
    const actual = f.fold.prepare(target, [row.token], f.preparation())
    await entered.promise
    f.controller.abort(new ModFunctionError("ACTUAL_CANCELLED"))
    await expect(actual).rejects.toMatchObject({ code: "MODS_CANCELLED" })
    const late = f.evaluate(p, `({Text:()=>({type:"Text",props:{}})})`)
    raw.resolve(late)
    // The resolver's actual returned promise is the native settlement receipt; the raw deferred
    // is only its input and can resolve before async adoption reaches waitHandle's cleanup.
    expect(row.actualInvocations).toHaveLength(1)
    await row.actualInvocations[0]
    expect(late.alive).toBe(false)
    expect(f.recovered).not.toHaveBeenCalled()
    expect(f.core).not.toHaveBeenCalled()
  })

  it("keeps preparation leases out of cached definitions and checks the new call's receipt", async () => {
    const f = fixture()
    const q = f.peer("Q")
    const p = f.peer("P")
    const row = f.source(p)
    const target = f.registry.target(q, "Pane")
    const table = await f.fold.prepare(target, [row.token], f.preparation())
    f.retirePreparation()
    expect(
      f.invoke(q, f.own(f.registry.readPreparedTable(table)), "Text", `{value:"later"}`)
    ).toMatchObject({ children: ["later"] })
    expect(f.captures).toHaveBeenCalledOnce()
    expect(f.core).toHaveBeenCalledOnce()
  })

  it("honors an already expired shared startup cut before any matcher or resolver", async () => {
    const f = fixture()
    const q = f.peer("Q")
    const p = f.peer("P")
    const matcher = vi.fn(async () => true)
    const row = f.source(p, { matches: matcher })
    const target = f.registry.target(q, "Pane")
    await expect(
      f.fold.prepare(target, [row.token], {
        ...f.preparation(),
        startupCutNs: (process.hrtime.bigint() - 1n).toString()
      })
    ).rejects.toMatchObject({ code: "MODS_DISPATCH_TIMEOUT" })
    expect(matcher).not.toHaveBeenCalled()
    expect(row.entered).not.toHaveBeenCalled()
    expect(f.core).not.toHaveBeenCalled()
  })

  it("rejects a real asynchronous constructor result without pumping guest jobs", async () => {
    const f = fixture()
    const q = f.peer("Q")
    const p = f.peer("P")
    const row = f.source(p, {
      invoke: async () =>
        f.evaluate(p, `({Text:async()=>({type:"Text",props:{},children:["not synchronous"]})})`)
    })
    const target = f.registry.target(q, "Pane")
    const table = await f.fold.prepare(target, [row.token], f.preparation())
    expect(() => f.invoke(q, f.own(f.registry.readPreparedTable(table)), "Text")).toThrow(
      "MODS_UI_RESOLVE_CONSTRUCTOR"
    )
    expect(f.constructorFailures).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: "MODS_UI_RESOLVE_CONSTRUCTOR" })
    )
    expect(p.runtime.hasPendingJob()).toBe(false)
  })

  it("rejects lookalike registrations and targets before resolver admission", async () => {
    const f = fixture()
    const q = f.peer("Q")
    const p = f.peer("P")
    const row = f.source(p)
    const target = f.registry.target(q, "Pane")
    expect(() => f.fold.prepare({ ...target }, [row.token], f.preparation())).toThrow(
      "MODS_UI_RESOLVE_IDENTITY"
    )
    expect(() => f.fold.prepare(target, [{ ...row.token }], f.preparation())).toThrow(
      "MODS_UI_RESOLVE_IDENTITY"
    )
    expect(row.entered).not.toHaveBeenCalled()
    expect(f.core).not.toHaveBeenCalled()
  })
})
