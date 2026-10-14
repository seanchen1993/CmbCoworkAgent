import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ModFunctionError,
  type FunctionHostCall,
  type FunctionHostReply,
  type FunctionRegistration
} from "../../../shared/mods/v2/contracts"
import type {
  FunctionUiResolveWireCredit,
  FunctionUiResolveWireResponse
} from "../../../shared/mods/v2/ui-resolve-wire"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSharedWallCut } from "./shared-wall-cut"
import {
  FunctionUiResolveUtilityAssembly,
  type FunctionUiResolveUtilityCall,
  type FunctionUiResolveUtilityHost,
  type FunctionUiResolveUtilityRuntime
} from "./ui-resolve-utility-assembly"

// Real Guest/QuickJS assembly foundation. This is not utility-process IPC or desktop acceptance.
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function fixture(
  options: {
    resolver?: string
    matcher?: string
    renderer?: string
    consumerResolver?: string
    extraResolver?: string
    hostCall?: (
      runtime: FunctionUiResolveUtilityRuntime,
      registration: Readonly<FunctionRegistration>,
      context: FunctionUiResolveUtilityCall,
      method: string,
      signal: AbortSignal
    ) => Promise<FunctionHostReply>
  } = {}
) {
  const controller = new AbortController()
  const runtimes: FunctionUiResolveUtilityRuntime[] = []
  const retired = new Set<string>()
  const add = async (name: string, body: string) => {
    const guest = await FunctionGuestRuntime.create(
      `globalThis.__cmbFunctionMod={register(on){${body}}};`
    )
    cleanups.push(() => guest.dispose())
    const actual: FunctionUiResolveUtilityRuntime = {
      runtimeId: "actual-" + name,
      guest,
      declaration: {
        runtimeId: "actual-" + name,
        name,
        root: "/actual/" + name,
        tier: "user",
        modelProtocol: "result-v1",
        registrations: [...guest.registrations],
        capabilities: ["ui.resolve", "store.get", "store.set"]
      },
      assertCurrent() {
        if (retired.has(name)) throw new ModFunctionError("ACTUAL_SOURCE_REVOKED")
      }
    }
    runtimes.push(actual)
    return actual
  }
  const q = await add(
    "Q",
    `on("ui.render",($,e)=>{${
      options.renderer ??
      `
    const first=$.ui.resolve({surface:"desktop",component:e.component});
    const second=$.ui.resolve({surface:"desktop",component:e.component});
    if(first!==second||!Object.isFrozen(first))throw Error("native table cache changed");
    return first.Text({children:"Q body"});`
    }});
    ${options.consumerResolver ?? ""}`
  )
  const p =
    options.resolver === undefined
      ? undefined
      : await add(
          "P",
          `on("ui.resolve",${options.matcher ? options.matcher + "," : ""}
      async($,e,next)=>{${options.resolver}});`
        )
  const r =
    options.extraResolver === undefined
      ? undefined
      : await add(
          "R",
          `on("ui.resolve",{component:/^Pane$/},async($,e,next)=>{${options.extraResolver}});`
        )
  const responses: FunctionUiResolveWireResponse[] = []
  const calls: Array<{
    runtime: FunctionUiResolveUtilityRuntime
    registration: Readonly<FunctionRegistration>
    context: FunctionUiResolveUtilityCall
    method: string
    signal: AbortSignal
    credit: FunctionUiResolveWireCredit
  }> = []
  let currentCredit: FunctionUiResolveWireCredit = {
    revision: 1,
    limits: { handles: 0, roots: 0, branches: 0, reactions: 0 }
  }
  const requestCredit = vi.fn<FunctionUiResolveUtilityHost["requestCredit"]>(async (limits) => {
    currentCredit = { revision: currentCredit.revision + 1, limits: { ...limits } }
    return currentCredit
  })
  const host: FunctionUiResolveUtilityHost = {
    assertCurrent() {
      controller.signal.throwIfAborted()
    },
    publish(message) {
      responses.push(message)
    },
    requestCredit,
    async call(runtime, registration, context, method, _args, signal): Promise<FunctionHostReply> {
      calls.push({
        runtime,
        registration,
        context,
        method,
        signal,
        credit: { revision: currentCredit.revision, limits: { ...currentCredit.limits } }
      })
      if (options.hostCall) return options.hostCall(runtime, registration, context, method, signal)
      return { value: method === "store.get" ? { value: "reply" } : {} }
    }
  }
  const assembly = new FunctionUiResolveUtilityAssembly({
    identity: Object.freeze({ actual: "Session" }),
    assembly: "actual-assembly",
    requestId: "actual-prepare",
    participants: runtimes,
    credit: currentCredit,
    startupCutNs: FunctionSharedWallCut.after(120000).expiresAtNs,
    signal: controller.signal,
    host
  })
  cleanups.push(() => assembly.retire())
  const ordinary = vi.fn<FunctionHostCall>(async () => ({ value: {} }))
  const prepare = () => assembly.prepare()
  const render = (token = "actual-drawing-1", generation = "Q:1", component = "Pane") =>
    q.guest.invoke(
      "0",
      { surface: "desktop", component, requestId: "R1", props: {} },
      ordinary,
      {
        event: "ui.render",
        plugin: { name: "Q", root: "/actual/Q" },
        origin: { plugin: "host", tier: "core" },
        capabilities: ["ui.resolve", "store.set"],
        modelProtocol: "result-v1",
        uiGeneration: generation,
        ownBudgetMs: 10000
      },
      { assembly: "actual-assembly", token }
    )
  return {
    q,
    p,
    r,
    assembly,
    controller,
    retired,
    responses,
    requestCredit,
    calls,
    ordinary,
    prepare,
    render,
    credit: () => currentCredit
  }
}

describe("actual utility UI resolver assembly", () => {
  it("keeps native cached real functions and all foreign dimensions zero without resolvers", async () => {
    const f = await fixture()
    const prepared = await f.prepare()
    expect(Object.values(prepared.sources[f.q.runtimeId]).every((rows) => rows.length === 0)).toBe(
      true
    )
    expect(f.requestCredit).not.toHaveBeenCalled()
    expect(f.assembly.ledger.stats).toEqual({ handles: 0, roots: 0, failedDisposals: 0 })
    f.assembly.adopt(prepared.preparedToken)
    expect((await f.render()).value).toMatchObject({ type: "Text", children: ["Q body"] })
    expect(f.calls.length).toBe(0)
    expect(f.responses).toEqual([
      { type: "ui-resolve-credit-ack", assembly: "actual-assembly", revision: 1 }
    ])
  })

  it("skips the receiving plugin before its matcher and never allocates a foreign peer", async () => {
    const f = await fixture({
      consumerResolver: `on("ui.resolve",{component:/./},()=>{throw Error("Q must be skipped")});`
    })
    const matches = vi.spyOn(f.q.guest, "matches")
    const prepared = await f.prepare()
    expect(matches).not.toHaveBeenCalled()
    expect(f.requestCredit).not.toHaveBeenCalled()
    expect(f.assembly.ledger.stats.handles).toBe(0)
    f.assembly.adopt(prepared.preparedToken)
    expect((await f.render()).value).toMatchObject({ type: "Text", children: ["Q body"] })
  })

  it("tests each actual false matcher once per other consumer/component without foreign credit", async () => {
    const f = await fixture({
      matcher: `{component:/^NEVER$/}`,
      resolver: `throw Error("false matcher entered")`
    })
    const p = f.p
    if (!p) throw Error("missing actual P")
    const matches = vi.spyOn(p.guest, "matches")
    const prepared = await f.prepare()
    expect(matches).toHaveBeenCalledTimes(14)
    expect(new Set(matches.mock.calls.map((row) => row[1].component)).size).toBe(14)
    expect(f.requestCredit).not.toHaveBeenCalled()
    expect(f.assembly.ledger.stats.handles).toBe(0)
    f.assembly.adopt(prepared.preparedToken)
    expect((await f.render()).value).toMatchObject({ type: "Text", children: ["Q body"] })
  })

  it("grants and acknowledges exact execution credit before a matched raw resolver runs", async () => {
    const f = await fixture({
      matcher: `{component:/^Pane$/}`,
      resolver: `await $.store.set("prepare",1);const lower=await next(e);
        return {...lower,Text:p=>lower.Text({...p,children:"P actual"})};`
    })
    const prepared = await f.prepare()
    expect(prepared.sources[f.q.runtimeId].Pane).toEqual([
      { runtimeId: "actual-P", registration: "0" }
    ])
    expect(f.requestCredit.mock.calls[0][0]).toMatchObject({ roots: 0, branches: 0, reactions: 0 })
    expect(f.requestCredit.mock.calls[1][0]).toMatchObject({
      roots: 16,
      branches: 512,
      reactions: 512
    })
    f.assembly.adopt(prepared.preparedToken)
    expect((await f.render()).value).toMatchObject({ type: "Text", children: ["P actual"] })
    expect(f.calls[0].runtime === f.p).toBe(true)
    expect({
      registration: f.calls[0].registration,
      context: f.calls[0].context,
      method: f.calls[0].method,
      credit: f.calls[0].credit
    }).toMatchObject({
      registration: { id: "0" },
      context: { kind: "resolver", requestId: "actual-prepare" },
      method: "store.set",
      credit: { limits: { roots: 16, branches: 512, reactions: 512 } }
    })
    expect(f.responses).toContainEqual({
      type: "ui-resolve-credit-ack",
      assembly: "actual-assembly",
      revision: f.calls[0].credit.revision
    })
    expect(f.ordinary).not.toHaveBeenCalled()
  })

  it("retains execution credit after an actually executed invalid optional table falls back", async () => {
    const f = await fixture({
      matcher: `{component:/^Pane$/}`,
      resolver: `await $.store.set("once",1);return {Text:3};`
    })
    const prepared = await f.prepare()
    expect(prepared.sources[f.q.runtimeId].Pane).toEqual([])
    expect(f.calls.length).toBe(1)
    expect(f.credit().limits.roots).toBe(16)
    f.assembly.adopt(prepared.preparedToken)
    expect((await f.render()).value).toMatchObject({ type: "Text", children: ["Q body"] })
    expect(f.calls.length).toBe(1)
  })

  it("derives source permissions from real retained lower definitions rather than matching rows", async () => {
    const f = await fixture({
      matcher: `{component:/^Pane$/}`,
      resolver: `const lower=await next(e);return {...lower,Text:p=>lower.Text(p)};`,
      extraResolver: `const lower=await next(e);return {...lower,Text:p=>
        lower.Text({...p,children:"R through P"})};`
    })
    const prepared = await f.prepare()
    expect(prepared.sources[f.q.runtimeId].Pane).toEqual(
      expect.arrayContaining([
        { runtimeId: "actual-P", registration: "0" },
        { runtimeId: "actual-R", registration: "0" }
      ])
    )
    expect(prepared.sources[f.q.runtimeId].Pane).toHaveLength(2)
    if (!f.p) throw Error("missing actual P")
    expect(prepared.sources[f.p.runtimeId].Pane).not.toContainEqual({
      runtimeId: "actual-P",
      registration: "0"
    })
    f.assembly.adopt(prepared.preparedToken)
    expect((await f.render()).value).toMatchObject({ type: "Text", children: ["R through P"] })
  })

  it("does not adopt a guessed token or expose the table during preparation", async () => {
    const f = await fixture({ matcher: `{component:/^Pane$/}`, resolver: `return await next(e);` })
    const prepared = await f.prepare()
    expect(() => f.assembly.adopt("guessed-token")).toThrow("MODS_UI_RESOLVE_IDENTITY")
    await expect(f.render()).rejects.toThrow()
    f.assembly.adopt(prepared.preparedToken)
    expect((await f.render()).value).toMatchObject({ type: "Text", children: ["Q body"] })
  })

  it("routes held constructor SDK and its real continuation to P while keeping the scope occupied", async () => {
    const gate = Promise.withResolvers<void>()
    cleanups.push(() => gate.resolve())
    const f = await fixture({
      matcher: `{component:/^Pane$/}`,
      resolver: `const lower=await next(e);return {...lower,Text:p=>{
        void $.store.get("first").then(()=>$.store.set("second",1));return lower.Text(p)}};`,
      hostCall: async (_runtime, _registration, _context, method) => {
        if (method === "store.get") await gate.promise
        return { value: {} }
      }
    })
    const prepared = await f.prepare()
    f.assembly.adopt(prepared.preparedToken)
    await f.render()
    await vi.waitFor(() => expect(f.calls.length).toBe(1))
    expect(f.assembly.activity.stats.scopes).toBe(1)
    expect(f.responses.filter((row) => row.type === "ui-constructor-open")).toHaveLength(1)
    gate.resolve()
    await vi.waitFor(() => expect(f.calls.length).toBe(2))
    await vi.waitFor(() =>
      expect(f.responses.filter((row) => row.type === "ui-constructor-drained")).toHaveLength(1)
    )
    expect(
      f.calls.every(
        (row) =>
          row.runtime === f.p && row.registration.id === "0" && row.context.kind === "constructor"
      )
    ).toBe(true)
    expect(f.assembly.activity.stats.scopes).toBe(0)
    expect(f.ordinary).not.toHaveBeenCalled()
  })

  it("closes the captured drawing without borrowing a later Q receipt for a held SDK", async () => {
    const gate = Promise.withResolvers<void>()
    cleanups.push(() => gate.resolve())
    const f = await fixture({
      matcher: `{component:/^Pane$/}`,
      resolver: `const lower=await next(e);return {...lower,Text:p=>{
        if(p.children==="old")void $.store.get("held").then(()=>$.store.set("late",1));
        return lower.Text(p)}};`,
      renderer: `return $.ui.resolve(e).Text({children:e.props.body??"old"});`,
      hostCall: async () => {
        await gate.promise
        return { value: {} }
      }
    })
    const prepared = await f.prepare()
    f.assembly.adopt(prepared.preparedToken)
    await f.render()
    await vi.waitFor(() => expect(f.calls.length).toBe(1))
    f.assembly.closeDrawing("actual-drawing-1")
    await f.q.guest.invoke(
      "0",
      { surface: "desktop", component: "Pane", requestId: "R2", props: { body: "new" } },
      f.ordinary,
      {
        event: "ui.render",
        plugin: { name: "Q", root: "/Q" },
        origin: { plugin: "host", tier: "core" },
        capabilities: ["ui.resolve"],
        uiGeneration: "Q:2",
        ownBudgetMs: 10000
      },
      { assembly: "actual-assembly", token: "actual-drawing-2" }
    )
    expect(f.calls[0].signal.aborted).toBe(true)
    gate.resolve()
    await vi.waitFor(() => expect(f.assembly.activity.stats.scopes).toBe(0))
    expect(f.calls.length).toBe(1)
  })

  it("retires every foreign handle before a real consumer VM is freed", async () => {
    const f = await fixture({ matcher: `{component:/^Pane$/}`, resolver: `return await next(e);` })
    const prepared = await f.prepare()
    f.assembly.adopt(prepared.preparedToken)
    await f.render()
    expect(f.assembly.ledger.stats.handles).toBeGreaterThan(0)
    expect(() => f.q.guest.dispose()).not.toThrow()
    expect(f.q.guest.stats.disposed).toBe(true)
    expect(f.assembly.ledger.stats).toEqual({ handles: 0, roots: 0, failedDisposals: 0 })
    expect(() => f.assembly.adopt(prepared.preparedToken)).toThrow("MODS_UI_RESOLVE_RETIRED")
  })

  it("reports only the admitted closed drawing's quiescent scope without fabricating drain", async () => {
    const f = await fixture({
      matcher: `{component:/^Pane$/}`,
      resolver: `const lower=await next(e);return {...lower,Text:p=>{
        void new Promise(()=>{}).then(()=>$.store.set("never",1));return lower.Text(p)}};`
    })
    const prepared = await f.prepare()
    f.assembly.adopt(prepared.preparedToken)
    await f.render()
    const opened = f.responses.find((row) => row.type === "ui-constructor-open")
    if (!opened || opened.type !== "ui-constructor-open" || !f.p)
      throw new Error("Actual constructor admission missing")
    expect(f.responses.filter((row) => row.type === "ui-constructor-quiescent")).toHaveLength(0)
    expect(f.assembly.activity.stats.scopes).toBe(1)
    f.assembly.closeDrawing("actual-drawing-1")
    await vi.waitFor(() =>
      expect(f.responses.filter((row) => row.type === "ui-constructor-quiescent")).toHaveLength(1)
    )
    expect(
      f.responses.some(
        (row) => row.type === "ui-constructor-quiescent" && row.scopeId === opened.scopeId
      )
    ).toBe(true)
    f.assembly.closeDrawing("actual-drawing-1")
    expect(f.responses.filter((row) => row.type === "ui-constructor-quiescent")).toHaveLength(1)
    expect(f.responses.filter((row) => row.type === "ui-constructor-drained")).toHaveLength(0)
    expect(f.assembly.activity.stats.scopes).toBe(1)
    expect(f.calls.length).toBe(0)
    f.p.guest.dispose()
    await vi.waitFor(() =>
      expect(f.responses.filter((row) => row.type === "ui-constructor-drained")).toHaveLength(1)
    )
    expect(f.assembly.activity.stats.scopes).toBe(0)
  })

  it("keeps one exact quiescent receipt across actual nested P and R wrappers", async () => {
    const f = await fixture({
      matcher: `{component:/^Pane$/}`,
      resolver: `const lower=await next(e);return {...lower,Text:p=>{
        void new Promise(()=>{}).then(()=>$.store.set("nested-never",1));
        return lower.Text(p)}};`,
      extraResolver: `const lower=await next(e);return {...lower,Text:p=>
        lower.Text({...p,children:"R nested through P"})};`
    })
    const prepared = await f.prepare()
    expect(prepared.sources[f.q.runtimeId].Pane).toEqual(
      expect.arrayContaining([
        { runtimeId: "actual-P", registration: "0" },
        { runtimeId: "actual-R", registration: "0" }
      ])
    )
    expect(prepared.sources[f.q.runtimeId].Pane).toHaveLength(2)
    f.assembly.adopt(prepared.preparedToken)
    expect((await f.render()).value).toMatchObject({
      type: "Text",
      children: ["R nested through P"]
    })
    const openings = f.responses.filter((row) => row.type === "ui-constructor-open")
    expect(openings).toHaveLength(1)
    const opened = openings[0]
    if (!opened || opened.type !== "ui-constructor-open" || !f.p || !f.r)
      throw new Error("Actual nested constructor admission missing")
    expect(opened).toMatchObject({
      consumerRuntimeId: f.q.runtimeId,
      runtimeId: f.p.runtimeId,
      registration: "0",
      drawToken: "actual-drawing-1"
    })
    expect(f.assembly.activity.stats.scopes).toBe(1)
    expect(f.responses.filter((row) => row.type === "ui-constructor-quiescent")).toHaveLength(0)
    f.assembly.closeDrawing("actual-drawing-1")
    await vi.waitFor(() =>
      expect(f.responses.filter((row) => row.type === "ui-constructor-quiescent")).toEqual([
        {
          type: "ui-constructor-quiescent",
          assembly: "actual-assembly",
          scopeId: opened.scopeId
        }
      ])
    )
    f.assembly.closeDrawing("actual-drawing-1")
    expect(f.responses.filter((row) => row.type === "ui-constructor-quiescent")).toHaveLength(1)
    expect(f.responses.filter((row) => row.type === "ui-constructor-drained")).toHaveLength(0)
    expect(f.calls).toHaveLength(0)
    expect(f.assembly.activity.stats.scopes).toBe(1)
    f.p.guest.dispose()
    await vi.waitFor(() =>
      expect(f.responses.filter((row) => row.type === "ui-constructor-drained")).toEqual([
        {
          type: "ui-constructor-drained",
          assembly: "actual-assembly",
          scopeId: opened.scopeId
        }
      ])
    )
    expect(f.assembly.activity.stats.scopes).toBe(0)
    expect(f.calls).toHaveLength(0)
  })

  it("never adopts cancelled initialization or releases ignored-abort raw host work early", async () => {
    const gate = Promise.withResolvers<void>()
    cleanups.push(() => gate.resolve())
    const f = await fixture({
      matcher: `{component:/^Pane$/}`,
      resolver: `void $.store.get("held").then(()=>$.store.set("late",1));
        return {Text:p=>({type:"Text",props:{},children:["never adopted"]})};`,
      hostCall: async () => {
        await gate.promise
        return { value: {} }
      }
    })
    const preparing = f.prepare()
    const rejected = expect(preparing).rejects.toThrow()
    await vi.waitFor(() => expect(f.calls.length).toBe(1))
    f.controller.abort(new ModFunctionError("ACTUAL_STARTUP_CANCELLED"))
    await rejected
    expect(f.assembly.activity.stats.scopes).toBe(1)
    expect(f.calls[0].signal.aborted).toBe(true)
    expect(() => f.assembly.adopt("cancelled-token")).toThrow()
    gate.resolve()
    await vi.waitFor(() => expect(f.assembly.activity.stats.scopes).toBe(0))
    expect(f.calls.length).toBe(1)
    expect(f.ordinary).not.toHaveBeenCalled()
  })

  it("rejects forged declaration rows before any table or SDK invocation", async () => {
    const f = await fixture()
    f.assembly.retire()
    const declaration = {
      ...f.q.declaration,
      registrations: [{ id: "0", pattern: "ui.resolve", hasCatch: false, hasMatcher: false }]
    }
    expect(
      () =>
        new FunctionUiResolveUtilityAssembly({
          identity: {},
          assembly: "forged",
          requestId: "forged",
          participants: [{ ...f.q, declaration }],
          credit: { revision: 1, limits: { handles: 0, roots: 0, branches: 0, reactions: 0 } },
          startupCutNs: FunctionSharedWallCut.after(5000).expiresAtNs,
          signal: f.controller.signal,
          host: {
            assertCurrent() {
              /* Forged registration must fail before admission. */
            },
            publish() {
              /* This constructor rejection must publish no native response. */
            },
            call: async () => ({ value: {} }),
            requestCredit: async () => f.credit()
          }
        })
    ).toThrow("MODS_UI_RESOLVE_REGISTRATION_CHANGED")
    expect(f.calls.length).toBe(0)
  })

  it("accepts only exact native credit revisions and never shrinks a live allocation", async () => {
    const f = await fixture()
    f.assembly.increaseCredit({
      revision: 2,
      limits: { handles: 64, roots: 0, branches: 0, reactions: 0 }
    })
    expect(() =>
      f.assembly.increaseCredit({
        revision: 2,
        limits: { handles: 128, roots: 0, branches: 0, reactions: 0 }
      })
    ).toThrow()
    expect(() =>
      f.assembly.increaseCredit({
        revision: 4,
        limits: { handles: 128, roots: 0, branches: 0, reactions: 0 }
      })
    ).toThrow()
    expect(() =>
      f.assembly.increaseCredit({
        revision: 3,
        limits: { handles: 0, roots: 0, branches: 0, reactions: 0 }
      })
    ).toThrow()
    expect(f.assembly.ledger.stats.handles).toBe(0)
  })
})
