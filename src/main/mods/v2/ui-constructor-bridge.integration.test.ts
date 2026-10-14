import { performance } from "node:perf_hooks"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ModFunctionError,
  type FunctionHostCall,
  type FunctionHostReply
} from "../../../shared/mods/v2/contracts"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import type { FunctionModelProtocol } from "../../../shared/mods/v2/model-protocol"
import { validateFunctionTree } from "../../../shared/mods/v2/ui"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionUiConstructorBridge } from "./ui-constructor-bridge"
import {
  FUNCTION_UI_RESOLVE_CONSTRUCTORS,
  FunctionUiResolveLedger,
  FunctionUiResolveRegistry,
  type FunctionUiResolveConstructor
} from "./ui-resolve-registry"
import type { FunctionUiResolveDefinition } from "./ui-resolve-private-types"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close()
})

async function until(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 2000, interval: 5 })
}

async function fixture(
  resolver: string,
  renderer = `const ui=$.ui.resolve({surface:"desktop",component:"Pane"});return ui.Text({children:"Q body"});`,
  asyncRenderer = false,
  options: { hostCall?: FunctionHostCall; modelProtocol?: FunctionModelProtocol } = {}
) {
  const p = await FunctionGuestRuntime.create(`globalThis.__cmbFunctionMod={register(on){
    on("ui.resolve",async($,e,next)=>{${resolver}});
    on("command.run",()=>globalThis.cancel?.());
  }};`)
  const q = await FunctionGuestRuntime.create(`globalThis.__cmbFunctionMod={register(on){
    on("ui.render",${asyncRenderer ? "async " : ""}($,e,next)=>{${renderer}});
    on("command.run",()=>globalThis.saved?.Text({children:"later"}));
  }};`)
  cleanups.push(() => {
    p.dispose()
    q.dispose()
  })
  let live = true
  let generation = 1
  let drawing = false
  let retained = 0
  const controller = new AbortController()
  const drawingController = new AbortController()
  const reads = Promise.withResolvers<void>()
  const writes: Array<{ actor: object; registration: object; method: string; args: unknown }> = []
  const callSignals: AbortSignal[] = []
  const roots: object[] = []
  const admissions: object[] = []
  const quiescents: object[] = []
  const completions: Promise<void>[] = []
  const registration = Object.freeze({ actual: "P resolver" })
  const check = () => {
    if (!live) throw new ModFunctionError("ACTUAL_P_REVOKED")
  }
  const bridge = new FunctionUiConstructorBridge({
    captureCurrent(target) {
      if (!drawing || target.consumer !== qPeer || target.component !== "Pane")
        throw new ModFunctionError("NO_ACTUAL_UI_DRAWING")
      const proof = q.currentUiResolveDrawing()
      if (
        !proof ||
        proof.component !== "Pane" ||
        proof.requestId !== "R1" ||
        proof.generation !== "Q:1" ||
        proof.drawing.token !== "native-draw-1"
      )
        throw new ModFunctionError("NO_PRIVATE_Q_FRAME")
      const captured = generation
      return {
        consumer: qPeer,
        component: "Pane",
        identity: proof,
        signal: AbortSignal.any([controller.signal, drawingController.signal]),
        assertCurrent: () => {
          if (generation !== captured) throw new ModFunctionError("ACTUAL_Q_CHANGED")
        }
      }
    },
    assertCurrent(definition, receipt) {
      check()
      definition.peer.assertCurrent()
      receipt.assertCurrent()
    },
    retain(_definition, _receipt, identity) {
      roots.push(identity)
      retained++
      let active = true
      return () => {
        if (active) {
          active = false
          retained--
        }
      }
    },
    admit(_definition, _receipt, identity) {
      admissions.push(identity)
    },
    quiescent(_definition, receipt, identity) {
      expect(receipt.signal.aborted).toBe(true)
      quiescents.push(identity)
    },
    async call(definition, _receipt, _identity, method, args, signal): Promise<FunctionHostReply> {
      writes.push({
        actor: definition.peer.actor,
        registration: definition.registration,
        method,
        args
      })
      callSignals.push(signal)
      if (options.hostCall) return options.hostCall(method, args, signal)
      if (["store.get", "clock.sleep", "model.complete"].includes(method)) await reads.promise
      return { value: method === "store.get" ? { value: "reply" } : {} }
    },
    drained(_definition, _receipt, _identity, completion) {
      completions.push(completion)
    }
  })
  const ledger = new FunctionUiResolveLedger()
  const registry = new FunctionUiResolveRegistry(bridge, ledger)
  cleanups.push(() => {
    reads.resolve()
    bridge.close()
    registry.close()
  })
  const assembly = registry.registerAssembly(
    Object.freeze({ actual: "fixture Session" }),
    controller.signal
  )
  const pActor = Object.freeze({ actual: "P" })
  const qActor = Object.freeze({ actual: "Q" })
  const pPeer = registry.registerPeer(assembly, pActor, p.uiResolveContext, check)
  const qPeer = registry.registerPeer(assembly, qActor, q.uiResolveContext, check)
  p.bindUiResolvePeer(
    bridge,
    pPeer,
    (component) => registry.readTable(registry.target(pPeer, component)),
    (handle) => ledger.hold(handle),
    () => {
      bridge.close()
      registry.close()
    }
  )
  q.bindUiResolvePeer(
    bridge,
    qPeer,
    (component) => registry.readTable(registry.target(qPeer, component)),
    (handle) => ledger.hold(handle),
    () => {
      bridge.close()
      registry.close()
    }
  )
  const target = registry.target(qPeer, "Pane")
  const native = q.createUiResolveNativeTable("Pane")
  const nativeDefinitions: Partial<
    Record<FunctionUiResolveConstructor, FunctionUiResolveDefinition>
  > = {}
  for (const name of FUNCTION_UI_RESOLVE_CONSTRUCTORS) {
    const fn = q.uiResolveContext.getProp(native, name)
    try {
      nativeDefinitions[name] = registry.registerDefinition(
        qPeer,
        Object.freeze({ native: name }),
        fn
      )
    } finally {
      fn.dispose()
    }
  }
  native.dispose()
  const lower = registry.prepareTable(target, pPeer, nativeDefinitions)
  const raw = await p.invokeUiResolver(
    "0",
    { surface: "desktop", component: "Pane" },
    async () => ({ value: {} }),
    {
      event: "ui.resolve",
      plugin: { name: "P", root: "/actual/P" },
      origin: { plugin: "host", tier: "core" },
      capabilities: ["store.get", "store.set", "ui.resolve", "clock.sleep", "model.complete"],
      ...(options.modelProtocol === undefined ? {} : { modelProtocol: options.modelProtocol }),
      ownBudgetMs: 10000
    },
    async () => registry.readPreparedTable(lower),
    performance.now() + 5000
  )
  const definitions: Partial<Record<FunctionUiResolveConstructor, FunctionUiResolveDefinition>> = {}
  p.runUiResolverInspection(performance.now() + 5000, () => {
    for (const name of FUNCTION_UI_RESOLVE_CONSTRUCTORS) {
      const fn = p.uiResolveContext.getProp(raw, name)
      try {
        if (p.uiResolveContext.typeof(fn) === "function")
          definitions[name] = registry.registerDefinition(pPeer, registration, fn, check)
      } finally {
        fn.dispose()
      }
    }
  })
  raw.dispose()
  const final = registry.prepareTable(target, qPeer, definitions)
  registry.adoptTable(final)
  const ordinary = vi.fn<FunctionHostCall>(async () => ({ value: {} }))
  const render = async (event: ModObject = {}) => {
    drawing = true
    try {
      return await q.invoke(
        "0",
        { surface: "desktop", requestId: "R1", component: "Pane", props: {}, ...event },
        ordinary,
        {
          event: "ui.render",
          plugin: { name: "Q", root: "/actual/Q" },
          origin: { plugin: "host", tier: "core" },
          capabilities: ["ui.resolve", "store.set"],
          uiGeneration: "Q:1",
          ownBudgetMs: 10000
        },
        { assembly: "actual-assembly", token: "native-draw-1" }
      )
    } finally {
      drawing = false
    }
  }
  return {
    p,
    q,
    bridge,
    registry,
    pActor,
    qActor,
    registration,
    writes,
    admissions,
    quiescents,
    roots,
    completions,
    reads,
    callSignals,
    ordinary,
    render,
    retained: () => retained,
    revoke: () => {
      live = false
      controller.abort(new ModFunctionError("ACTUAL_REVOKE"))
    },
    changeDrawing: () => {
      generation++
    },
    closeDrawing: () => {
      generation++
      drawingController.abort(new ModFunctionError("ACTUAL_DRAWING_CLOSED"))
      q.retireUiResolveDrawing({ assembly: "actual-assembly", token: "native-draw-1" })
    }
  }
}

/** Native-only test diagnostics: pending reactions must not be mistaken for actual settlement. */
function activityPhases(activity: FunctionUiConstructorBridge["activity"]) {
  const occupied = Reflect.get(activity, "occupied") as Set<{
    branches: Set<{
      work: Set<{ kind: "host" | "reply-job" }>
      reactions: Set<{ phase: "queued" | "running" | "returned" | "settled" }>
    }>
  }>
  const phases = { queued: 0, running: 0, returned: 0, settled: 0, host: 0, replyJob: 0 }
  for (const scope of occupied) {
    for (const branch of scope.branches) {
      for (const reaction of branch.reactions) phases[reaction.phase]++
      for (const work of branch.work) {
        if (work.kind === "host") phases.host++
        else phases.replyJob++
      }
    }
  }
  return phases
}

describe("actual peer constructor bridge", () => {
  it("returns actual functions through the private raw path and keeps admitted SDK/reactions occupied", async () => {
    const f = await fixture(`const lower=await next(e);return {...lower,Text:props=>{
      void $.store.get("first").then(()=>$.store.set("second",1));
      return lower.Text(props);
    }};`)
    const result = await f.render()
    expect(result.value).toMatchObject({ type: "Text", children: ["Q body"] })
    await until(() => expect(f.writes).toHaveLength(1))
    expect(f.admissions).toHaveLength(1)
    expect(f.admissions[0]).toBe(f.roots[0])
    expect(f.retained()).toBe(1)
    expect(f.bridge.activity.stats.reactions).toBeGreaterThan(0)
    f.reads.resolve()
    await until(() => expect(f.writes).toHaveLength(2))
    await Promise.all(f.completions)
    expect(f.retained()).toBe(0)
    expect(
      f.writes.every((row) => row.actor === f.pActor && row.registration === f.registration)
    ).toBe(true)
    expect(f.ordinary).not.toHaveBeenCalled()
    expect(f.p.stats.replies).toBe(0)
  })

  it("never borrows a newer Q drawing when an actual held SDK reply arrives", async () => {
    const f = await fixture(`const lower=await next(e);return {...lower,Text:props=>{
      void $.store.get("first").then(()=>$.store.set("late",1));return lower.Text(props);
    }};`)
    await f.render()
    await until(() => expect(f.writes).toHaveLength(1))
    f.changeDrawing()
    expect(f.retained()).toBe(1)
    f.reads.resolve()
    await until(() => expect(f.retained()).toBe(0))
    expect(f.bridge.activity.stats).toMatchObject({ scopes: 0, branches: 0, reactions: 0 })
    expect(f.writes).toHaveLength(1)
    expect(f.p.stats.replies).toBe(0)
  })

  it("a saved table has no later command drawing admission", async () => {
    const f = await fixture(
      `return await next(e);`,
      `globalThis.saved=$.ui.resolve({surface:"desktop",component:"Pane"});return saved.Text({children:"now"});`
    )
    await f.render()
    await expect(
      f.q.invoke("1", {}, f.ordinary, {
        event: "command.run",
        plugin: { name: "Q", root: "/actual/Q" },
        origin: { plugin: "host", tier: "core" },
        capabilities: ["ui.resolve"]
      })
    ).rejects.toThrow()
    expect(f.admissions).toHaveLength(0)
    expect(f.writes).toHaveLength(0)
  })

  it("strips foreign root callbacks and reconnects only the actual original Q action", async () => {
    const f = await fixture(
      `const lower=await next(e);return {...lower,Button:props=>{
      if(props.onPress!==undefined)throw Error("foreign callback leaked");
      return lower.Button({...props,label:"replacement",onPress:()=>$.store.set("P-fake",1)});
    }};`,
      `const ui=$.ui.resolve(e);return ui.Button({
      key:"original",label:"Q original",onPress:()=>$.store.set("Q-actual",1)});`
    )
    const result = await f.render()
    expect(result.value).toMatchObject({
      type: "Button",
      props: { key: "original", label: "replacement" },
      press: { plugin: "Q" }
    })
    const press = (result.value as ModObject).press as ModObject
    expect(f.writes).toHaveLength(0)
    await f.q.invoke(
      "0",
      { surface: "desktop", component: "Pane", requestId: "R1", plugin: "Q", element: "original" },
      f.ordinary,
      {
        event: "ui.press",
        plugin: { name: "Q", root: "/actual/Q" },
        origin: { plugin: "host", tier: "core" },
        capabilities: ["store.set"],
        callback: { handle: press.handle as number, generation: "Q:1", kind: "onPress" }
      }
    )
    expect(f.ordinary).toHaveBeenCalledWith("store.set", ["Q-actual", 1], expect.any(AbortSignal))
    expect(f.writes).toHaveLength(0)
  })

  it("the installed table preserves the old actual-event Client envelope and owner", async () => {
    const f = await fixture(
      `return await next(e);`,
      `return $.ui.resolve(e).Client({key:"original-client",module:"ui/panel.ts",props:{count:1}});`
    )
    const result = await f.render()
    expect(result.value).toMatchObject({
      type: "Client",
      client: { plugin: "Q" },
      props: { key: "original-client", module: "ui/panel.ts", props: { count: 1 } }
    })
    expect(f.admissions).toHaveLength(0)
    // This proves true guest ownership metadata, not actual Client VM/source approval.
    expect(f.writes).toHaveLength(0)
  })

  it("resumes the actual private Q frame after await instead of borrowing a latest drawing", async () => {
    const f = await fixture(
      `return await next(e);`,
      `await Promise.resolve();return $.ui.resolve(e).Text({children:"resumed Q"});`,
      true
    )
    expect((await f.render()).value).toMatchObject({ type: "Text", children: ["resumed Q"] })
    expect(f.admissions).toHaveLength(0)
  })

  it("reconnects one original Button inside a layout wrapper without exposing callbacks to P", async () => {
    const f = await fixture(
      `const lower=await next(e);return {...lower,Button:props=>{
      if(props.onPress!==undefined)throw Error("leaked");
      return lower.Box({children:[lower.Button(props)]});
    }};`,
      `return $.ui.resolve(e).Button({key:"original",label:"Q",onPress:()=>$.store.set("Q-wrap",1)});`
    )
    const result = await f.render()
    expect(result.value).toMatchObject({
      type: "Box",
      children: [{ type: "Button", props: { key: "original", label: "Q" }, press: { plugin: "Q" } }]
    })
    const button = ((result.value as ModObject).children as ModObject[])[0]
    const press = button.press as ModObject
    await f.q.invoke(
      "0",
      { surface: "desktop", component: "Pane", requestId: "R1", plugin: "Q", element: "original" },
      f.ordinary,
      {
        event: "ui.press",
        plugin: { name: "Q", root: "/actual/Q" },
        origin: { plugin: "host", tier: "core" },
        capabilities: ["store.set"],
        callback: { handle: press.handle as number, generation: "Q:1", kind: "onPress" }
      }
    )
    expect(f.ordinary).toHaveBeenCalledExactlyOnceWith(
      "store.set",
      ["Q-wrap", 1],
      expect.any(AbortSignal)
    )
    expect(f.writes).toHaveLength(0)
  })

  it("reconnects Markdown's private Q closure through a wrapper and keeps P's final text/list", async () => {
    const f = await fixture(
      `const lower=await next(e);return {...lower,Markdown:props=>{
        if(props.onLinkPress!==undefined)throw Error("foreign callback leaked");
        void $.store.set("P-md",props.text);
        return lower.Box({children:[lower.Markdown({...props,text:"[New](https://new.test/target)",
          pressableLinks:["https://new.test/target"]})]});
      }};`,
      `return $.ui.resolve(e).Markdown({key:"markdown",text:"[Old](https://old.test/target)",
        pressableLinks:["https://old.test/target"],onLinkPress:async(link,event)=>{
          await Promise.resolve();await $.store.set("Q-md",{link,event:event.link,
            plugin:event.plugin,element:event.element,component:event.component,
            requestId:event.requestId,surface:event.surface});}});`
    )
    const rendered = await f.render()
    expect(() => validateFunctionTree(rendered.value)).not.toThrow()
    expect(rendered.value).toMatchObject({ type: "Box", children: [{ type: "Markdown", props: {
      key: "markdown", text: "[New](https://new.test/target)", pressableLinks: ["https://new.test/target"]
    }, press: { kind: "onLinkPress", plugin: "Q" } }] })
    const leaf = ((rendered.value as ModObject).children as ModObject[])[0]
    expect(Object.hasOwn(leaf, "children")).toBe(false)
    expect((leaf.props as ModObject).onLinkPress).toBeUndefined()
    const handle = (leaf.press as ModObject).handle as number
    await f.q.invoke("callback", { surface: "desktop", component: "Pane", requestId: "R1",
      plugin: "Q", element: "markdown", link: { href: "callback-rewritten-business-value" }
    }, f.ordinary, {
      event: "ui.press", plugin: { name: "Q", root: "/actual/Q" },
      origin: { plugin: "host", tier: "core" }, capabilities: ["store.set"],
      callback: { handle, generation: "Q:1", kind: "onLinkPress" }
    })
    expect(f.ordinary).toHaveBeenCalledExactlyOnceWith("store.set", ["Q-md", {
      link: { href: "callback-rewritten-business-value" },
      event: { href: "callback-rewritten-business-value" }, plugin: "Q", element: "markdown",
      component: "Pane", requestId: "R1", surface: "desktop"
    }], expect.any(AbortSignal))
    await until(() => expect(f.writes).toHaveLength(1))
    expect(f.writes[0]).toEqual({ actor: f.pActor, registration: f.registration,
      method: "store.set", args: ["P-md", "[Old](https://old.test/target)"] })
    await until(() => expect(f.retained()).toBe(0))
    expect(f.bridge.activity.stats).toMatchObject({ scopes: 0, branches: 0, reactions: 0 })
  })

  it.each(["duplicate", "changed-key", "changed-type", "omitted"])(
    "does not mint or duplicate a Markdown Q action after %s", async (mode) => {
      const output = mode === "duplicate"
        ? `lower.Box({children:[lower.Markdown(props),lower.Markdown(props)]})`
        : mode === "changed-key" ? `lower.Markdown({...props,key:"changed"})`
          : mode === "changed-type" ? `lower.Text({key:props.key,children:props.text})`
            : `lower.Box({children:[]})`
      const f = await fixture(`const lower=await next(e);return {...lower,Markdown:props=>{
        if(props.onLinkPress!==undefined)throw Error("foreign callback leaked");return ${output};
      }};`, `return $.ui.resolve(e).Markdown({key:"markdown",text:"[Old](https://old.test/target)",
        onLinkPress:()=>$.store.set("must-not-run",1)});`)
      if (mode === "duplicate") {
        const reconnect = vi.spyOn(f.q, "reconnectUiConstructorActions")
        // The trusted helper rejects the second same-key root and substitutes its fixed
        // diagnostic. invoke() then reports the actual failed Hook with that safe message.
        await expect(f.render()).rejects.toMatchObject({
          code: "MODS_HOOK_FAILED", message: "MODS_UI_CONSTRUCTOR_SCOPE"
        })
        expect(reconnect).toHaveBeenCalledTimes(1)
        await until(() => expect(f.retained()).toBe(0))
        expect(f.bridge.activity.stats).toMatchObject({ scopes: 0, branches: 0, reactions: 0 })
      }
      else {
        const rendered = await f.render()
        expect(() => validateFunctionTree(rendered.value)).not.toThrow()
        const tree = rendered.value as ModObject
        expect(tree.press).toBeUndefined()
        if (mode === "changed-key") expect(tree).toMatchObject({
          type: "Markdown", props: { key: "changed", text: "[Old](https://old.test/target)" }
        })
        if (mode === "changed-type") expect(tree.type).toBe("Text")
        if (mode === "omitted") expect(tree).toMatchObject({ type: "Box", children: [] })
      }
      expect(f.ordinary).not.toHaveBeenCalled()
      expect(f.writes).toHaveLength(0)
    }
  )

  it("preserves a Markdown child action through foreign Box data without lending its closure", async () => {
    const f = await fixture(`const lower=await next(e);return {...lower,Box:props=>{
      if(props.children[0].props.onLinkPress!==undefined)throw Error("foreign child callback leaked");
      return lower.Box(props);
    }};`, `const ui=$.ui.resolve(e);return ui.Box({children:[ui.Markdown({key:"markdown",
      text:"[Child](https://child.test/target)",onLinkPress:link=>$.store.set("Q-child-md",link)})]});`)
    const rendered = await f.render()
    expect(() => validateFunctionTree(rendered.value)).not.toThrow()
    const leaf = ((rendered.value as ModObject).children as ModObject[])[0]
    const press = leaf.press as ModObject
    expect(press).toMatchObject({ kind: "onLinkPress", plugin: "Q" })
    await f.q.invoke("callback", { surface: "desktop", component: "Pane", requestId: "R1",
      plugin: "Q", element: "markdown", link: { href: "https://child.test/target" }
    }, f.ordinary, { event: "ui.press", plugin: { name: "Q", root: "/actual/Q" },
      origin: { plugin: "host", tier: "core" }, capabilities: ["store.set"],
      callback: { handle: press.handle as number, generation: "Q:1", kind: "onLinkPress" }
    })
    expect(f.ordinary).toHaveBeenCalledExactlyOnceWith("store.set",
      ["Q-child-md", { href: "https://child.test/target" }], expect.any(AbortSignal))
    expect(f.writes).toHaveLength(0)
  })

  it("does not lend Q's Markdown closure to a saved foreign attempt or a later command", async () => {
    const f = await fixture(`const lower=await next(e);let held;return {...lower,Markdown:props=>{
      if(props.onLinkPress!==undefined)throw Error("foreign callback leaked");held=props.onLinkPress;
      void Promise.resolve().then(()=>held?.({href:"forged"}));
      globalThis.cancel=()=>held?.({href:"later"});
      return lower.Markdown(props);
    }};`, `return $.ui.resolve(e).Markdown({key:"markdown",text:"[Q](https://q.test/target)",
      onLinkPress:()=>$.store.set("must-not-run",1)});`)
    const rendered = await f.render()
    expect(rendered.value).toMatchObject({ type: "Markdown", press: { plugin: "Q", kind: "onLinkPress" } })
    await until(() => expect(f.retained()).toBe(0))
    await f.p.invoke("1", {}, async () => ({}), { event: "command.run",
      plugin: { name: "P", root: "/actual/P" }, origin: { plugin: "host", tier: "core" },
      capabilities: ["store.set"] })
    expect(f.ordinary).not.toHaveBeenCalled()
    expect(f.writes).toHaveLength(0)
  })

  it("ignores a foreign Markdown callback and reconnects only Q's original closure", async () => {
    const f = await fixture(`const lower=await next(e);return {...lower,Markdown:props=>
      lower.Markdown({...props,onLinkPress:()=>$.store.set("foreign-click",1)})
    };`, `return $.ui.resolve(e).Markdown({key:"markdown",text:"[Q](https://q.test/target)",
      onLinkPress:link=>$.store.set("Q-only",link)});`)
    const rendered = await f.render()
    expect(() => validateFunctionTree(rendered.value)).not.toThrow()
    const press = (rendered.value as ModObject).press as ModObject
    expect(press).toMatchObject({ plugin: "Q", kind: "onLinkPress" })
    await f.q.invoke("callback", {
      surface: "desktop", component: "Pane", requestId: "R1", plugin: "Q",
      element: "markdown", link: { href: "https://q.test/target" }
    }, f.ordinary, {
      event: "ui.press", plugin: { name: "Q", root: "/actual/Q" },
      origin: { plugin: "host", tier: "core" }, capabilities: ["store.set"],
      callback: { handle: press.handle as number, generation: "Q:1", kind: "onLinkPress" }
    })
    expect(f.ordinary).toHaveBeenCalledExactlyOnceWith("store.set",
      ["Q-only", { href: "https://q.test/target" }], expect.any(AbortSignal))
    expect(f.writes).toHaveLength(0)
  })

  it.each(["duplicate", "changed-key"])(
    "does not duplicate or change the original wrapped action identity: %s",
    async (mode) => {
      const f = await fixture(
        `const lower=await next(e);return {...lower,Button:props=>
      lower.Box({children:${mode === "duplicate" ? "[lower.Button(props),lower.Button(props)]" : "[lower.Button({...props,key:'changed'})]"}})
    };`,
        `return $.ui.resolve(e).Button({key:"original",label:"Q",onPress:()=>$.store.set("Q-wrap",1)});`
      )
      await expect(f.render()).rejects.toThrow()
      expect(f.ordinary).not.toHaveBeenCalled()
      expect(f.writes).toHaveLength(0)
    }
  )

  it("the no-hook native cache preserves frozen table/function identity and the old event envelope", async () => {
    const q = await FunctionGuestRuntime.create(`globalThis.__cmbFunctionMod={register(on){
      on("ui.render",($,e)=>{const a=$.ui.resolve(e),b=$.ui.resolve({surface:"desktop",component:"Pane"});
        return a.Text({children:String(a===b&&a.Text===b.Text&&Object.isFrozen(a))});});
    }};`)
    cleanups.push(() => q.dispose())
    q.bindUiResolveNativeTables()
    const value = await q.invoke(
      "0",
      { surface: "desktop", component: "Pane", requestId: "R1" },
      async () => ({ value: {} }),
      {
        event: "ui.render",
        plugin: { name: "Q", root: "/Q" },
        origin: { plugin: "host", tier: "core" },
        capabilities: ["ui.resolve"],
        uiGeneration: "Q:1"
      }
    )
    expect(value.value).toMatchObject({ type: "Text", children: ["true"] })
    expect(q.uiResolverActivityStats).toEqual({ roots: 0, reactions: 0 })
  })

  it("an installed table rejects a forged request in the legacy event envelope", async () => {
    const f = await fixture(
      `return await next(e);`,
      `return $.ui.resolve({...e,requestId:"forged"}).Text({children:"must not render"});`
    )
    await expect(f.render()).rejects.toThrow()
    expect(f.roots).toHaveLength(0)
    expect(f.writes).toHaveLength(0)
  })

  it("an admitted native Promise reaction opens the host root before its first later SDK", async () => {
    const f = await fixture(`const lower=await next(e);return {...lower,Text:props=>{
      void Promise.resolve().then(()=>$.store.set("reaction-effect",1));return lower.Text(props);
    }};`)
    await f.render()
    await until(() => expect(f.writes).toHaveLength(1))
    expect(f.admissions).toHaveLength(1)
    await Promise.all(f.completions)
    expect(f.retained()).toBe(0)
  })

  it.each(["legacy-v1", "result-v1"] as const)(
    "drains a deep model adoption chain before a separate pending root closes: %s",
    async (protocol) => {
      const stored = new Map<string, ModJson>()
      const responses: ModJson[] = ["default answer", "explicit answer"].map((text) =>
        protocol === "legacy-v1"
          ? text
          : {
              isAnswered: true,
              text,
              usage: {
                input_tokens: 2,
                output_tokens: 3,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0
              }
            }
      )
      const snapshots: Array<{ stage: string; phases: ReturnType<typeof activityPhases> }> = []
      let modelCalls = 0
      const f = await fixture(
        `const lower=await next(e);let started=false,held=false;return {...lower,Text:props=>{
          if(!started&&String(props.children).includes("Q_BODY_0")){
            started=true;
            void $.store.set("constructor-owner","P")
              .then(()=>$.model.complete({model:"default",prompt:"default",maxTokens:32}))
              .then(first=>$.model.complete({model:"custom:explicit",prompt:"explicit",maxTokens:32})
                .then(second=>$.store.set("constructor-models",{default:first,explicit:second})
                  .then(()=>$.store.set("constructor-model-marker","actual-marker"))))
              .catch(error=>$.store.set("constructor-error",String(error.code||error.message)));
          }
          if(!held&&String(props.children).includes("Q_BODY_1")){
            held=true;
            void new Promise(()=>{}).then(()=>$.store.set("never-revive",1));
          }
          return lower.Text(props);
        }};`,
        `return $.ui.resolve(e).Text({children:e.props.body||"Q_BODY_0"});`,
        false,
        {
          modelProtocol: protocol,
          hostCall: async (method, args): Promise<FunctionHostReply> => {
            if (!Array.isArray(args)) throw new Error("Expected actual SDK arguments")
            if (method === "store.set") {
              if (args.length !== 2 || typeof args[0] !== "string" || args[1] === undefined)
                throw new Error("Expected actual store arguments")
              stored.set(args[0], args[1])
              if (args[0] === "constructor-model-marker")
                snapshots.push({ stage: "marker-written", phases: activityPhases(f.bridge.activity) })
              await Promise.resolve()
              return { value: {} }
            }
            if (method !== "model.complete") throw new Error(`Unexpected SDK: ${method}`)
            const input = args[0] as ModObject
            const index = modelCalls++
            expect(input.model).toBe(index === 0 ? "default" : "custom:explicit")
            snapshots.push({ stage: `model-${index}`, phases: activityPhases(f.bridge.activity) })
            if (index === 0) await f.reads.promise
            else await Promise.resolve()
            return { value: responses[index] }
          }
        }
      )
      await f.render()
      await until(() => expect(modelCalls).toBe(1))
      expect(f.retained()).toBe(1)
      expect(activityPhases(f.bridge.activity).returned).toBeGreaterThan(0)
      f.reads.resolve()
      await until(() => expect(stored.get("constructor-model-marker")).toBe("actual-marker"))
      await until(() =>
        expect({
          retained: f.retained(),
          stats: f.bridge.activity.stats,
          phases: activityPhases(f.bridge.activity)
        }).toEqual({
          retained: 0,
          stats: { scopes: 0, roots: 0, branches: 0, reactions: 0, failedReleases: 0 },
          phases: { queued: 0, running: 0, returned: 0, settled: 0, host: 0, replyJob: 0 }
        })
      )
      await Promise.all(f.completions)
      expect(modelCalls).toBe(2)
      expect(stored.get("constructor-models")).toEqual({
        default: responses[0],
        explicit: responses[1]
      })
      expect(stored.has("constructor-error")).toBe(false)
      expect(snapshots.map((row) => row.stage)).toEqual(["model-0", "model-1", "marker-written"])
      expect(snapshots.every((row) => row.phases.host > 0)).toBe(true)
      expect(f.quiescents).toHaveLength(0)
      const completedAdmissions = f.admissions.length
      await f.render({ props: { body: "Q_BODY_1" } })
      expect(f.admissions).toHaveLength(completedAdmissions + 1)
      const pendingIdentity = f.admissions.at(-1)
      expect(f.retained()).toBe(1)
      expect(activityPhases(f.bridge.activity)).toMatchObject({ running: 0, returned: 0, host: 0 })
      f.closeDrawing()
      expect(f.quiescents).toEqual([pendingIdentity])
      expect(f.retained()).toBe(1)
      expect(f.bridge.activity.stats.reactions).toBeGreaterThan(0)
      expect(stored.has("never-revive")).toBe(false)
      expect(
        f.writes.every((row) => row.actor === f.pActor && row.registration === f.registration)
      ).toBe(true)
      f.p.dispose()
      await until(() => expect(f.retained()).toBe(0))
      expect(f.bridge.activity.stats).toMatchObject({ scopes: 0, branches: 0, reactions: 0 })
      expect(f.quiescents).toEqual([pendingIdentity])
      expect(f.ordinary).not.toHaveBeenCalled()
    }
  )

  it("an explicit constructor SDK signal prevents a canceled call before native host admission", async () => {
    const f = await fixture(`const lower=await next(e);return {...lower,Text:props=>{
      const controller=new AbortController();
      void $.clock.sleep(10000,{signal:controller.signal}).catch(()=>$.store.set("cancel-observed",1));
      controller.abort();return lower.Text(props);
    }};`)
    await f.render()
    // Cancellation happens before native host admission's microtask, so no clock operation
    // is started; the independently admitted rejection reaction may still use the same Q.
    await until(() => expect(f.writes.map((row) => row.method)).toEqual(["store.set"]))
    await Promise.all(f.completions)
    expect(f.retained()).toBe(0)
  })

  it("caller cancellation preserves ignored-abort actual host occupancy and admits a handled reaction", async () => {
    const f = await fixture(`const lower=await next(e);return {...lower,Text:props=>{
      const controller=new AbortController();globalThis.cancel=()=>controller.abort();
      void $.clock.sleep(10000,{signal:controller.signal}).catch(()=>$.store.set("cancel-observed",1));
      return lower.Text(props);
    }};`)
    await f.render()
    await until(() => expect(f.writes.map((row) => row.method)).toEqual(["clock.sleep"]))
    await f.p.invoke("1", {}, async () => ({ value: {} }), {
      event: "command.run",
      plugin: { name: "P", root: "/actual/P" },
      origin: { plugin: "host", tier: "core" },
      capabilities: []
    })
    await until(() =>
      expect(f.writes.map((row) => row.method)).toEqual(["clock.sleep", "store.set"])
    )
    expect(f.callSignals[0].aborted).toBe(true)
    expect(f.callSignals[1].aborted).toBe(false)
    expect(f.retained()).toBe(1)
    f.reads.resolve()
    await Promise.all(f.completions)
    expect(f.retained()).toBe(0)
  })

  it("disposing the consumer VM seals the fixed drawing but retains ignored-abort host finally", async () => {
    const f = await fixture(`const lower=await next(e);return {...lower,Text:props=>{
      void $.store.get("held").then(()=>$.store.set("late",1));return lower.Text(props);
    }};`)
    await f.render()
    await until(() => expect(f.writes).toHaveLength(1))
    f.q.dispose()
    expect(f.callSignals[0].aborted).toBe(true)
    expect(f.retained()).toBe(1)
    f.reads.resolve()
    await until(() => expect(f.retained()).toBe(0))
    expect(f.bridge.activity.stats).toMatchObject({ scopes: 0, branches: 0, reactions: 0 })
    expect(f.writes).toHaveLength(1)
  })

  it("keeps a truly pending reaction until actual VM disposal while a closed drawing rejects a later SDK", async () => {
    const f = await fixture(`const lower=await next(e);return {...lower,Text:props=>{
      void new Promise(()=>{}).then(()=>$.store.set("never",1));
      void new Promise(resolve=>{globalThis.cancel=resolve;}).then(()=>$.store.set("late",1));
      return lower.Text(props);
    }};`)
    await f.render()
    expect(f.retained()).toBe(1)
    expect(f.bridge.activity.stats.reactions).toBeGreaterThanOrEqual(2)
    f.closeDrawing()
    expect(f.retained()).toBe(1)
    expect(f.quiescents).toEqual([f.admissions[0]])
    // Fulfil one actually queued source after closing its fixed Q. The other native Promise
    // stays truly pending; its occupation is not a fabricated cancellation settlement.
    await f.p.invoke("1", {}, f.ordinary, {
      event: "command.run",
      plugin: { name: "P", root: "/actual/P" },
      origin: { plugin: "host", tier: "core" },
      capabilities: [],
      ownBudgetMs: 10000
    })
    expect(f.writes).toHaveLength(0)
    expect(f.retained()).toBe(1)
    expect(f.bridge.activity.stats.reactions).toBeGreaterThan(0)
    expect(f.quiescents).toHaveLength(1)
    f.p.dispose()
    await until(() => expect(f.retained()).toBe(0))
    expect(f.bridge.activity.stats).toMatchObject({
      scopes: 0,
      roots: 0,
      branches: 0,
      reactions: 0
    })
    expect(f.writes).toHaveLength(0)
  })

  it("a raw resolver deadline still rejects and never serializes or exposes a public raw switch", async () => {
    const guest = await FunctionGuestRuntime.create(`globalThis.__cmbFunctionMod={register(on){
      on("ui.resolve",()=>new Promise(()=>{}));
    }};`)
    cleanups.push(() => guest.dispose())
    await expect(
      guest.invokeUiResolver(
        "0",
        { surface: "desktop", component: "Pane" },
        async () => ({ value: {} }),
        {
          event: "ui.resolve",
          plugin: { name: "P", root: "/P" },
          origin: { plugin: "host", tier: "core" },
          capabilities: []
        },
        async () => guest.uiResolveContext.newObject(),
        performance.now() + 20
      )
    ).rejects.toThrow("MODS_BUDGET_EXCEEDED")
    expect(guest.stats.frames).toBe(0)
  })
})
