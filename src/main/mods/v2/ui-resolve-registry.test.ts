import { performance } from "node:perf_hooks"
import { getQuickJS, type QuickJSContext, type QuickJSHandle } from "quickjs-emscripten"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { MODS_MAX_BYTES } from "../../../shared/mods/validation"
import { validateFunctionTree } from "../../../shared/mods/v2/ui"
import { FunctionUiConstructorActivity } from "./ui-constructor-activity"
import type {
  FunctionUiResolveCall,
  FunctionUiResolveDriver,
  FunctionUiResolvePeer,
  FunctionUiResolvePropsProof,
  FunctionUiResolveReceipt,
  FunctionUiResolveSyncBudget
} from "./ui-resolve-private-types"
import {
  FunctionUiResolveLedger,
  FunctionUiResolveRegistry,
  installFunctionUiResolveDataCopy,
  type FunctionUiResolveLimits
} from "./ui-resolve-registry"

// Utility/QuickJS foundation only. No renderer, actual main SDK route or product acceptance claim.
let quickJS: Awaited<ReturnType<typeof getQuickJS>>
beforeAll(async () => {
  quickJS = await getQuickJS()
})
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function fixture(
  limits: Partial<FunctionUiResolveLimits> = {},
  ledger = new FunctionUiResolveLedger(),
  clock: () => number = () => performance.now()
) {
  const activity = new FunctionUiConstructorActivity()
  const controller = new AbortController()
  let generation = 1
  let live = true
  let current: { call: FunctionUiResolveCall; phase: string } | undefined
  const contexts: Array<{ peer: FunctionUiResolvePeer; cleanup(): void }> = []
  const held: QuickJSHandle[] = []
  const receipts: FunctionUiResolveReceipt[] = []
  const props: FunctionUiResolvePropsProof[] = []
  const captured = vi.fn()
  const finished = vi.fn()
  const failed = vi.fn()
  const retain = vi.fn()
  const release = vi.fn()
  const reconnect = vi.fn(
    (call: FunctionUiResolveCall, proof: FunctionUiResolvePropsProof, output: QuickJSHandle) => {
      proof.assertCurrent()
      expect(proof.peer).toBe(call.target.consumer)
      props.push(proof)
      return output.dup()
    }
  )
  const deadlines = new Map<QuickJSContext, number>()
  const driver: FunctionUiResolveDriver = {
    captureCurrent(target, resident) {
      captured(target, resident)
      const original = generation
      return {
        consumer: target.consumer,
        component: target.component,
        identity: Object.freeze({}),
        signal: controller.signal,
        assertCurrent: () => {
          if (!live || original !== generation) throw new ModFunctionError("ACTUAL_DRAW_EXPIRED")
        }
      }
    },
    createConstructorScope(definition, receipt) {
      receipts.push(receipt)
      const scope = activity.begin({
        actor: definition,
        receipt,
        signal: receipt.signal,
        assertCurrent() {
          definition.assertCurrent()
          receipt.assertCurrent()
        },
        retain: () => {
          retain()
          return () => {
            release()
          }
        }
      })
      return {
        assertCurrent: () => activity.assertCurrent(scope, { actor: definition, receipt }),
        runSync<T>(
          call: FunctionUiResolveCall,
          peer: FunctionUiResolvePeer,
          budget: FunctionUiResolveSyncBudget,
          phase: "constructor" | "data" | "reconnect",
          run: () => T
        ): T {
          const previous = current
          const deadline = deadlines.get(peer.context) ?? Infinity
          current = { call, phase }
          deadlines.set(peer.context, budget.expiresAt)
          peer.runtime.setInterruptHandler(
            () => clock() >= (deadlines.get(peer.context) ?? Infinity)
          )
          try {
            budget.assertRemaining()
            return run()
          } finally {
            deadlines.set(peer.context, deadline)
            current = previous
          }
        },
        finishNormal: () => {
          finished()
          activity.finishCall(scope)
        },
        finishFailure: () => {
          failed()
          activity.revoke(scope)
          activity.finishCall(scope)
        }
      }
    },
    captureActions: () => Object.freeze({ originalQGraph: true }),
    reconnect
  }
  const registry = new FunctionUiResolveRegistry(driver, ledger, limits, clock)
  const assembly = registry.registerAssembly(
    Object.freeze({ hostSession: true }),
    controller.signal
  )
  const peer = (name: string, beforeRegister?: (vm: QuickJSContext) => void) => {
    const runtime = quickJS.newRuntime()
    const vm = runtime.newContext()
    const disposeCopy = installFunctionUiResolveDataCopy(vm)
    beforeRegister?.(vm)
    const value = registry.registerPeer(assembly, Object.freeze({ actualActor: name }), vm, () => {
      if (!live) throw new ModFunctionError("ACTUAL_SOURCE_RETIRED")
    })
    contexts.push({
      peer: value,
      cleanup() {
        runtime.removeInterruptHandler()
        disposeCopy()
        vm.dispose()
        runtime.dispose()
      }
    })
    return value
  }
  const evalHandle = (peer: FunctionUiResolvePeer, source: string) => {
    const value = peer.context.unwrapResult(peer.context.evalCode(source))
    held.push(value)
    return value
  }
  const define = (peer: FunctionUiResolvePeer, source: string) =>
    registry.registerDefinition(
      peer,
      Object.freeze({ actualRegistration: {} }),
      evalHandle(peer, source)
    )
  const own = (handle: QuickJSHandle) => {
    held.push(handle)
    return handle
  }
  const invoke = (
    peer: FunctionUiResolvePeer,
    table: QuickJSHandle,
    name: string,
    source = "{}",
    readOutput?: (value: QuickJSHandle) => unknown
  ) => {
    const fn = peer.context.getProp(table, name)
    const argument = peer.context.unwrapResult(peer.context.evalCode(`(${source})`))
    try {
      const result = peer.context.callFunction(fn, peer.context.undefined, argument)
      if (result.error) {
        try {
          return { error: peer.context.dump(result.error) as { message: string } }
        } finally {
          result.error.dispose()
        }
      }
      try {
        return {
          value: readOutput
            ? readOutput(result.value)
            : (peer.context.dump(result.value) as unknown)
        }
      } finally {
        result.value.dispose()
      }
    } finally {
      argument.dispose()
      fn.dispose()
    }
  }
  const setNative = (peer: FunctionUiResolvePeer, name: string, run: () => QuickJSHandle) => {
    const fn = peer.context.newFunction(name, run)
    try {
      peer.context.setProp(peer.context.global, name, fn)
    } finally {
      fn.dispose()
    }
  }
  cleanups.push(() => {
    registry.close()
    activity.close()
    for (const handle of held.reverse()) if (handle.alive) handle.dispose()
    for (const record of contexts.reverse()) record.cleanup()
  })
  return {
    registry,
    assembly,
    ledger,
    activity,
    peer,
    define,
    evalHandle,
    invoke,
    own,
    setNative,
    receipts,
    props,
    captured,
    finished,
    failed,
    retain,
    release,
    reconnect,
    current: () => current,
    replaceDraw() {
      generation++
    },
    retireSource() {
      live = false
    },
    controller,
    driver
  }
}

describe("private synchronous UI resolve registry foundation", () => {
  it("copies a real foreign Markdown constructor without passing its caller's callback", () => {
    const f = fixture()
    const q = f.peer("Q")
    const p = f.peer("P")
    const target = f.registry.target(q, "Pane")
    const definition = f.define(p, `p=>({type:"Markdown",props:{key:p.key,
      text:typeof p.onLinkPress+"|"+p.text},onLinkPress:()=>{throw Error("foreign callback")}})`)
    f.registry.adoptTable(f.registry.prepareTable(target, q, { Markdown: definition }))
    const first = f.own(f.registry.readTable(target))
    const second = f.own(f.registry.readTable(target))
    expect(q.context.eq(first, second)).toBe(true)
    const actual = f.invoke(q, first, "Markdown", `{
      key:"docs",text:"[Docs](https://example.com)",onLinkPress:()=>{throw Error("must not run")}
    }`).value
    expect(actual).toEqual({ type: "Markdown", props: {
      key: "docs", text: "undefined|[Docs](https://example.com)"
    } })
    expect(() => validateFunctionTree(actual)).not.toThrow()
    expect(f.props[0].rootKey).toBe("docs")
    expect(() => f.props[0].callback("onLinkPress")).toThrow("MODS_UI_RESOLVE_PROPS_EXPIRED")
    expect(f.captured).toHaveBeenCalledOnce()
    expect(f.activity.stats.scopes).toBe(0)
  })
  it("requires a pre-load copier and ignores subsequently replaced guest intrinsics", () => {
    const runtime = quickJS.newRuntime()
    const vm = runtime.newContext()
    const f = fixture()
    try {
      expect(() => f.registry.registerPeer(f.assembly, {}, vm, () => {})).toThrow(
        "MODS_UI_RESOLVE_COPY_REQUIRED"
      )
    } finally {
      vm.dispose()
      runtime.dispose()
    }
    const q = f.peer("Q", (context) => {
      const result = context.unwrapResult(
        context.evalCode(`
        Reflect.ownKeys = () => { throw Error("poison"); };
        Object.getOwnPropertyDescriptors = () => { throw Error("poison"); };
        JSON.parse = JSON.stringify = () => { throw Error("poison"); };
      `)
      )
      result.dispose()
    })
    const target = f.registry.target(q, "Pane")
    f.registry.adoptTable(
      f.registry.prepareTable(target, q, {
        Text: f.define(q, `p => ({type:"Text",props:{},children:[p.value]})`)
      })
    )
    expect(
      f.invoke(q, f.own(f.registry.readTable(target)), "Text", `{value:"real"}`).value
    ).toEqual({ type: "Text", props: {}, children: ["real"] })
  })

  it("keeps a frozen same-object actual function table and preserves guest closure state", () => {
    const f = fixture()
    const q = f.peer("Q")
    const target = f.registry.target(q, "Pane")
    const definition = f.define(
      q,
      `(() => { let count=0;
      return () => ({type:"Text",props:{},children:[String(++count)]}); })()`
    )
    f.registry.adoptTable(f.registry.prepareTable(target, q, { Text: definition }))
    const a = f.own(f.registry.readTable(target))
    const b = f.own(f.registry.readTable(target))
    expect(q.context.eq(a, b)).toBe(true)
    q.context.setProp(q.context.global, "actualTable", a)
    const frozen = q.context.unwrapResult(
      q.context.evalCode(`
      Object.isFrozen(actualTable) && typeof actualTable.Text === "function"
    `)
    )
    try {
      expect(q.context.dump(frozen)).toBe(true)
    } finally {
      frozen.dispose()
    }
    expect(f.invoke(q, a, "Text").value).toMatchObject({ children: ["1"] })
    expect(f.invoke(q, b, "Text").value).toMatchObject({ children: ["2"] })
    expect(f.captured).toHaveBeenCalledTimes(2)
    expect(f.receipts[0]).not.toBe(f.receipts[1])
    expect(f.finished).toHaveBeenCalledTimes(2)
    expect(f.activity.stats.scopes).toBe(0)
  })

  it("rejects lookalike assembly, peer, target and definition objects", () => {
    const f = fixture()
    const q = f.peer("Q")
    const target = f.registry.target(q, "Pane")
    const definition = f.define(q, `() => ({type:"Text",props:{}})`)
    expect(() => f.registry.registerPeer({ ...f.assembly }, {}, q.context, () => {})).toThrow()
    expect(() => f.registry.target({ ...q }, "Pane")).toThrow()
    expect(() => f.registry.prepareTable({ ...target }, q, { Text: definition })).toThrow()
    expect(() => f.registry.prepareTable(target, q, { Text: { ...definition } })).toThrow()
    expect(f.ledger.stats.roots).toBe(0)
  })

  it("executes actual A to B to A functions with one Q receipt and one root activity", () => {
    const f = fixture()
    const a = f.peer("A")
    const b = f.peer("B")
    const target = f.registry.target(a, "AssistantMessage")
    const native = f.define(a, `p => ({type:"Text",props:{},children:[p.value*3]})`)
    const lower = f.registry.prepareTable(target, b, { Text: native })
    const lowerHandle = f.own(f.registry.readPreparedTable(lower))
    b.context.setProp(b.context.global, "lower", lowerHandle)
    const wrapped = f.define(b, `p => lower.Text({...p,value:p.value+2})`)
    f.registry.adoptTable(f.registry.prepareTable(target, a, { Text: wrapped }))
    const table = f.own(f.registry.readTable(target))
    expect(f.invoke(a, table, "Text", `{value:4}`).value).toEqual({
      type: "Text",
      props: {},
      children: [18]
    })
    expect(f.captured).toHaveBeenCalledOnce()
    expect(f.receipts).toHaveLength(1)
    expect(f.retain).toHaveBeenCalledOnce()
    expect(f.release).toHaveBeenCalledOnce()
    expect(f.ledger.stats.roots).toBe(0)
  })

  it("strips root callbacks from foreign props and only exposes original Q handles to reconnect", () => {
    const f = fixture()
    const q = f.peer("Q")
    const p = f.peer("P")
    const target = f.registry.target(q, "Pane")
    const def = f.define(
      p,
      `p => ({type:"Button",props:{key:p.key,
      label:typeof p.onPress},onPress:()=>{ throw Error("foreign callback"); }})`
    )
    f.registry.adoptTable(f.registry.prepareTable(target, q, { Button: def }))
    const table = f.own(f.registry.readTable(target))
    expect(
      f.invoke(
        q,
        table,
        "Button",
        `{
      key:"original",onPress:()=>{throw Error("must not run");}
    }`
      ).value
    ).toEqual({ type: "Button", props: { key: "original", label: "undefined" } })
    const proof = f.props[0]
    expect(proof.rootKey).toBe("original")
    expect(() => proof.callback("onPress")).toThrow("MODS_UI_RESOLVE_PROPS_EXPIRED")
    expect(() => f.registry.assertProps({ ...proof })).toThrow("MODS_UI_RESOLVE_PROPS_EXPIRED")
    expect(f.ledger.stats.roots).toBe(0)
  })

  it("offers a real transparent constructor without allocating or calling a Button action", () => {
    const f = fixture()
    const q = f.peer("Q")
    const target = f.registry.target(q, "Pane")
    const transparent = f.registry.registerTransparentDefinition(q, Object.freeze({ native: true }))
    f.registry.adoptTable(f.registry.prepareTable(target, q, { Button: transparent }))
    const table = f.own(f.registry.readTable(target))
    expect(
      f.invoke(
        q,
        table,
        "Button",
        `{
      key:"omit",children:["a",[null,"b",false,3]],onPress:()=>{throw Error("never");}
    }`
      ).value
    ).toEqual({ type: "fragment", children: ["a", "b", "3"] })
    expect(f.reconnect).toHaveBeenCalledOnce()
  })

  it("checks current Q facts on every invocation without binding the cache to its first draw", () => {
    const f = fixture()
    const q = f.peer("Q")
    const target = f.registry.target(q, "Pane")
    f.registry.adoptTable(
      f.registry.prepareTable(target, q, {
        Text: f.define(q, `() => ({type:"Text",props:{},children:["ok"]})`)
      })
    )
    const table = f.own(f.registry.readTable(target))
    expect(f.invoke(q, table, "Text").value).toMatchObject({ children: ["ok"] })
    f.replaceDraw()
    expect(f.invoke(q, table, "Text").value).toMatchObject({ children: ["ok"] })
    expect(f.receipts[0]).not.toBe(f.receipts[1])
    expect(() => f.receipts[0].assertCurrent()).toThrow("ACTUAL_DRAW_EXPIRED")
    expect(() => f.receipts[1].assertCurrent()).not.toThrow()
  })

  it("rejects source retirement between actual constructor execution and publication", () => {
    const f = fixture()
    const q = f.peer("Q")
    f.setNative(q, "retire", () => {
      f.retireSource()
      return q.context.undefined
    })
    const target = f.registry.target(q, "Pane")
    f.registry.adoptTable(
      f.registry.prepareTable(target, q, {
        Text: f.define(q, `() => { retire(); return {type:"Text",props:{}}; }`)
      })
    )
    const table = f.own(f.registry.readTable(target))
    expect(f.invoke(q, table, "Text").error?.message).toContain("ACTUAL_SOURCE_RETIRED")
    expect(f.reconnect).not.toHaveBeenCalled()
    expect(f.failed).toHaveBeenCalledOnce()
    expect(f.ledger.stats.roots).toBe(0)
  })

  it("does not call getters, transfer thenables or run unrelated Promise jobs", () => {
    const f = fixture()
    const q = f.peer("Q")
    const effect = vi.fn()
    f.setNative(q, "effect", () => {
      effect()
      return q.context.undefined
    })
    const target = f.registry.target(q, "Pane")
    f.registry.adoptTable(
      f.registry.prepareTable(target, q, {
        Text: f.define(
          q,
          `() => {
        Promise.resolve().then(effect);
        return Promise.resolve({type:"Text",props:{}});
      }`
        )
      })
    )
    const table = f.own(f.registry.readTable(target))
    expect(f.invoke(q, table, "Text", `{get value(){effect();return "x"}}`).error).toBeDefined()
    expect(effect).not.toHaveBeenCalled()
    expect(f.invoke(q, table, "Text").error).toBeDefined()
    expect(effect).not.toHaveBeenCalled()
    expect(f.reconnect).not.toHaveBeenCalled()
  })

  it("separates data-trap admission from the actual P constructor SDK phase", () => {
    const f = fixture()
    const q = f.peer("Q")
    const p = f.peer("P")
    const admissions: Array<{ phase: string | undefined; actor: object | undefined }> = []
    for (const peer of [q, p])
      f.setNative(peer, "sdk", () => {
        const active = f.current()
        admissions.push({ phase: active?.phase, actor: active?.call.definition.peer.actor })
        if (active?.phase !== "constructor") throw new ModFunctionError("DATA_SDK_DENIED")
        return peer.context.undefined
      })
    const target = f.registry.target(q, "Pane")
    f.registry.adoptTable(
      f.registry.prepareTable(target, q, {
        Text: f.define(p, `() => { sdk(); return {type:"Text",props:{}}; }`)
      })
    )
    const table = f.own(f.registry.readTable(target))
    expect(
      f.invoke(q, table, "Text", `new Proxy({}, {ownKeys(){sdk();return []}})`).error
    ).toBeDefined()
    expect(admissions).toEqual([{ phase: "data", actor: p.actor }])
    admissions.length = 0
    expect(f.invoke(q, table, "Text").value).toEqual({ type: "Text", props: {} })
    expect(admissions).toEqual([{ phase: "constructor", actor: p.actor }])
  })

  it("uses a single monotonic cut across peers and restores interrupt state after failure", () => {
    const f = fixture({ synchronousMs: 8 })
    const q = f.peer("Q")
    const p = f.peer("P")
    const target = f.registry.target(q, "Pane")
    f.registry.adoptTable(
      f.registry.prepareTable(target, q, {
        Text: f.define(p, `() => { while(true){} }`)
      })
    )
    const table = f.own(f.registry.readTable(target))
    expect(f.invoke(q, table, "Text").error).toBeDefined()
    expect(f.failed).toHaveBeenCalledOnce()
    expect(f.ledger.stats.roots).toBe(0)
    const value = p.context.unwrapResult(p.context.evalCode("6 * 7"))
    try {
      expect(p.context.getNumber(value)).toBe(42)
    } finally {
      value.dispose()
    }
  })

  it("rejects depth overflow without granting each nested peer another root allowance", () => {
    const f = fixture({ depth: 2 })
    const q = f.peer("Q")
    const target = f.registry.target(q, "Pane")
    const recursive = f.define(q, `p => table.Text(p)`)
    f.registry.adoptTable(f.registry.prepareTable(target, q, { Text: recursive }))
    const table = f.own(f.registry.readTable(target))
    q.context.setProp(q.context.global, "table", table)
    expect(f.invoke(q, table, "Text").error).toBeDefined()
    expect(f.captured).toHaveBeenCalledOnce()
    expect(f.retain).toHaveBeenCalledOnce()
    expect(f.ledger.stats.roots).toBe(0)
  })

  it("retires old tables and defers actual handles until an entered constructor returns", () => {
    const f = fixture()
    const q = f.peer("Q")
    const target = f.registry.target(q, "Pane")
    f.setNative(q, "retire", () => {
      const before = f.ledger.stats.handles
      f.registry.retireTable(table)
      expect(f.ledger.stats.handles).toBe(before)
      return q.context.undefined
    })
    const table = f.registry.prepareTable(target, q, {
      Text: f.define(q, `() => {retire(); return {type:"Text",props:{}}}`)
    })
    f.registry.adoptTable(table)
    const handle = f.own(f.registry.readTable(target))
    const before = f.ledger.stats.handles
    expect(f.invoke(q, handle, "Text").error).toBeDefined()
    expect(f.ledger.stats.handles).toBeLessThan(before)
    expect(f.invoke(q, handle, "Text").error?.message).toContain("MODS_UI_RESOLVE_RETIRED")
  })

  it("counts candidate and retired bridge handles in one explicitly supplied local ledger", () => {
    const ledger = new FunctionUiResolveLedger({ handles: 5, roots: 1 })
    const f = fixture({}, ledger)
    const q = f.peer("Q")
    const target = f.registry.target(q, "Pane")
    const def = f.define(q, `() => ({type:"Text",props:{}})`)
    const live = f.registry.prepareTable(target, q, { Text: def })
    f.registry.adoptTable(live)
    expect(ledger.stats.handles).toBe(4)
    expect(() => f.registry.prepareTable(target, q, { Text: def })).toThrow("MODS_UI_RESOLVE_LIMIT")
    expect(ledger.stats.handles).toBe(4)
    const a = f.own(f.registry.readTable(target))
    expect(f.invoke(q, a, "Text").value).toEqual({ type: "Text", props: {} })
    f.registry.retireTable(live)
    const replacement = f.registry.prepareTable(target, q, { Text: def })
    f.registry.adoptTable(replacement)
    expect(ledger.stats.handles).toBe(4)
  })

  it("keeps native no-hook caching usable when foreign handle credit is exhausted", () => {
    const f = fixture({}, new FunctionUiResolveLedger({ handles: 2, roots: 1 }))
    const q = f.peer("Q")
    f.define(q, `() => ({type:"Text",props:{}})`)
    expect(f.ledger.stats.handles).toBe(2)
    const target = f.registry.target(q, "Pane")
    const native = f.evalHandle(q, `({Text:p=>({type:"Text",props:{},children:[p.value]})})`)
    f.registry.cacheNativeTable(target, native)
    const a = f.own(f.registry.readTable(target))
    const b = f.own(f.registry.readTable(target))
    expect(q.context.eq(a, b)).toBe(true)
    expect(f.invoke(q, a, "Text", `{value:"native"}`).value).toMatchObject({ children: ["native"] })
    expect(f.captured).not.toHaveBeenCalled()
    expect(f.retain).not.toHaveBeenCalled()
    expect(f.ledger.stats.handles).toBe(2)
  })

  it("raises local credit only for its original host lease and exact next revision", () => {
    const lease = Object.freeze({ actualMainCredit: true })
    const ledger = new FunctionUiResolveLedger(
      { handles: 3, roots: 1 },
      {
        identity: lease,
        revision: 0
      }
    )
    const f = fixture({}, ledger)
    const q = f.peer("Q")
    const target = f.registry.target(q, "Pane")
    const definition = f.define(q, `() => ({type:"Text",props:{}})`)
    expect(() => f.registry.prepareTable(target, q, { Text: definition })).toThrow(
      "MODS_UI_RESOLVE_LIMIT"
    )
    expect(ledger.stats.handles).toBe(2)
    expect(() => ledger.increaseCredit({ ...lease }, 1, { handles: 4, roots: 1 })).toThrow(
      "MODS_UI_RESOLVE_CREDIT"
    )
    expect(() => ledger.increaseCredit(lease, 2, { handles: 4, roots: 1 })).toThrow(
      "MODS_UI_RESOLVE_CREDIT"
    )
    ledger.increaseCredit(lease, 1, { handles: 4, roots: 1 })
    ledger.increaseCredit(lease, 1, { handles: 4, roots: 1 })
    expect(() => ledger.increaseCredit(lease, 0, { handles: 3, roots: 1 })).toThrow(
      "MODS_UI_RESOLVE_CREDIT"
    )
    f.registry.adoptTable(f.registry.prepareTable(target, q, { Text: definition }))
    expect(f.invoke(q, f.own(f.registry.readTable(target)), "Text").value).toEqual({
      type: "Text",
      props: {}
    })
    expect(f.captured).toHaveBeenCalledOnce()
  })

  it("cannot escape data suppression by calling a lower constructor from a caught Proxy trap", () => {
    const f = fixture()
    const q = f.peer("Q")
    const effect = vi.fn()
    f.setNative(q, "effect", () => {
      effect()
      return q.context.undefined
    })
    const target = f.registry.target(q, "Pane")
    const definition = f.define(q, `() => {effect();return {type:"Text",props:{}}}`)
    f.registry.adoptTable(f.registry.prepareTable(target, q, { Text: definition }))
    const table = f.own(f.registry.readTable(target))
    q.context.setProp(q.context.global, "table", table)
    expect(
      f.invoke(
        q,
        table,
        "Text",
        `new Proxy({}, {
      ownKeys(){try{table.Text({})}catch{};return []}
    })`
      ).error?.message
    ).toContain("MODS_UI_RESOLVE_DATA_REENTRY")
    expect(effect).not.toHaveBeenCalled()
    expect(f.reconnect).not.toHaveBeenCalled()
    expect(f.ledger.stats.roots).toBe(0)
  })

  it("copies array data faithfully without invoking a poisoned inherited toJSON", () => {
    const f = fixture()
    const q = f.peer("Q")
    const p = f.peer("P")
    const effects = vi.fn()
    for (const peer of [q, p]) {
      f.setNative(peer, "poison", () => {
        effects()
        return peer.context.newString("POISON")
      })
      f.evalHandle(peer, `Array.prototype.toJSON = poison`)
    }
    const target = f.registry.target(q, "Pane")
    f.registry.adoptTable(
      f.registry.prepareTable(target, q, {
        Text: f.define(p, `p=>({type:"Text",props:{},children:p.children})`)
      })
    )
    const readExactOutput = (value: QuickJSHandle) => {
      // QuickJSContext.dump delegates objects to QTS_Dump, which calls guest serialization.
      // Inspect the real value directly so poisoned toJSON cannot alter the test observation.
      const names = (handle: QuickJSHandle) => {
        const own = q.context.unwrapResult(q.context.getOwnPropertyNames(handle))
        try {
          return own.map((key) => q.context.getString(key)).sort()
        } finally {
          own.dispose()
        }
      }
      expect(names(value)).toEqual(["children", "props", "type"])
      const type = q.context.getProp(value, "type")
      const props = q.context.getProp(value, "props")
      const children = q.context.getProp(value, "children")
      const length = q.context.getProp(children, "length")
      const a = q.context.getProp(children, 0)
      const b = q.context.getProp(children, 1)
      try {
        expect(names(props)).toEqual([])
        expect(names(children)).toEqual(["0", "1", "length"])
        expect(q.context.getNumber(length)).toBe(2)
        return {
          type: q.context.getString(type),
          props: {},
          children: [q.context.getString(a), q.context.getString(b)]
        }
      } finally {
        b.dispose()
        a.dispose()
        length.dispose()
        children.dispose()
        props.dispose()
        type.dispose()
      }
    }
    expect(
      f.invoke(
        q,
        f.own(f.registry.readTable(target)),
        "Text",
        `{children:["a","b"]}`,
        readExactOutput
      ).value
    ).toEqual({ type: "Text", props: {}, children: ["a", "b"] })
    expect(effects).not.toHaveBeenCalled()
  })

  it.each([
    `()=>({["k".repeat(${MODS_MAX_BYTES + 1})]:0})`,
    `()=>({type:"Text",props:{},children:["😀".repeat(${MODS_MAX_BYTES / 4})]})`
  ])("enforces UTF-8 wire size including keys and supplementary characters: %s", (source) => {
    // Keep this wire-validation counterexample independent of the separately tested CPU cut.
    const f = fixture({}, new FunctionUiResolveLedger(), () => 0)
    const q = f.peer("Q")
    const target = f.registry.target(q, "Pane")
    f.registry.adoptTable(f.registry.prepareTable(target, q, { Text: f.define(q, source) }))
    expect(f.invoke(q, f.own(f.registry.readTable(target)), "Text").error).toBeDefined()
    expect(f.reconnect).not.toHaveBeenCalled()
    expect(f.ledger.stats.roots).toBe(0)
  })

  it("preserves an existing valid large Svg source and raw JSON depth independently of UI depth", () => {
    const f = fixture({}, new FunctionUiResolveLedger(), () => 0)
    const q = f.peer("Q")
    const p = f.peer("P")
    const target = f.registry.target(q, "Pane")
    f.registry.adoptTable(
      f.registry.prepareTable(target, q, {
        Svg: f.define(p, `p=>({type:"Svg",props:{source:p.source,alt:"sample"}})`),
        Box: f.define(
          p,
          `()=>{
        let tree={type:"Text",props:{},children:["leaf"]};
        for(let i=0;i<13;i++)tree={type:"Box",props:{},children:[tree]};return tree;
      }`
        )
      })
    )
    const table = f.own(f.registry.readTable(target))
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg"><text>' + "汉".repeat(100000) + "</text></svg>"
    const svg = f.invoke(q, table, "Svg", `{source:${JSON.stringify(source)}}`)
    expect(svg.error).toBeUndefined()
    expect(svg.value).toEqual({ type: "Svg", props: { source, alt: "sample" } })
    expect(() => validateFunctionTree(svg.value)).not.toThrow()
    const nested = f.invoke(q, table, "Box")
    expect(nested.error).toBeUndefined()
    expect(() => validateFunctionTree(nested.value)).not.toThrow()
  })

  it("cannot catch a lower source refusal and use the same scope for a later SDK", () => {
    const f = fixture()
    const q = f.peer("Q")
    const p = f.peer("P")
    let sourceLive = true
    const effects = vi.fn()
    f.setNative(p, "retireLower", () => {
      sourceLive = false
      return p.context.undefined
    })
    f.setNative(p, "sdk", () => {
      f.current()!.call.receipt.assertCurrent()
      effects()
      return p.context.undefined
    })
    const target = f.registry.target(q, "Pane")
    const native = f.registry.registerDefinition(
      q,
      {},
      f.evalHandle(q, `()=>({type:"Text",props:{}})`),
      () => {
        if (!sourceLive) throw new ModFunctionError("ACTUAL_NATIVE_SOURCE_RETIRED")
      }
    )
    const lower = f.registry.prepareTable(target, p, { Text: native })
    p.context.setProp(p.context.global, "lower", f.own(f.registry.readPreparedTable(lower)))
    const wrapping = f.define(
      p,
      `()=>{
      retireLower();try{lower.Text({})}catch{};try{sdk()}catch{};
      return {type:"Text",props:{}};
    }`
    )
    f.registry.adoptTable(f.registry.prepareTable(target, q, { Text: wrapping }))
    expect(f.invoke(q, f.own(f.registry.readTable(target)), "Text").error?.message).toContain(
      "ACTUAL_NATIVE_SOURCE_RETIRED"
    )
    expect(effects).not.toHaveBeenCalled()
    expect(f.reconnect).not.toHaveBeenCalled()
  })
})
