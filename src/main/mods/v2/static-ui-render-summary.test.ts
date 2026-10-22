import { build } from "esbuild"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { compileFunctionPlugin } from "./loader"
import { assembleFunctionComponents } from "./component-projection"
import type { ClawComponentExport } from "../../../shared/mods/claw-components"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionNamedState, namedStateInput, type FunctionNamedStateScope } from "./named-state"
import {
  analyzeStaticUiRenderSummary,
  bindStaticUiRenderSummary,
  type StaticUiRenderSummary
} from "./static-ui-render-summary"
import type { FunctionRegistration } from "../../../shared/mods/v2/contracts"

async function compiled(source: string, globalName = "__cmbFunctionMod"): Promise<string> {
  const result = await build({
    stdin: {
      contents:
        source.replace("export function register(", "function authorRegister(") +
        `\nexport function register(on, options) {
          const v0 = authorRegister(on, options);
          if (v0 && typeof v0.then === "function") throw Error("MODS_ASYNC_REGISTER");
        }`
    },
    bundle: true,
    write: false,
    format: "iife",
    globalName,
    target: "es2016",
    platform: "neutral",
    logLevel: "silent"
  })
  return result.outputFiles[0].text
}

const rows = (...values: [string, boolean][]): FunctionRegistration[] =>
  values.map(([pattern, hasMatcher], index) => ({
    id: String(index),
    pattern,
    hasMatcher,
    hasCatch: false
  }))

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("host static ui.render summary", () => {
  it("proves literal components through the real compiler scaffold and wrapper", async () => {
    const code = await compiled(`export function register(on) {
      let pending = false;
      const label = "Review";
      on("ui.render", {component:"AbovePrompt"}, async ($, event, next) => {
        const lower = await next(event);
        pending = !pending;
        return lower;
      });
      on("ui.render", {component:"AssistantMessage", kind:"answer"}, ($,event,next) => next(event));
      on("turn.complete", ($,event,next) => next(event));
    }`)
    const summary = analyzeStaticUiRenderSummary(code)
    expect(summary.kind).toBe("static")
    const proof = bindStaticUiRenderSummary(
      summary,
      code,
      rows(["ui.render", true], ["ui.render", true], ["turn.complete", false])
    )
    expect(proof?.components).toEqual(["AbovePrompt", "AssistantMessage"])
    expect(Object.isFrozen(proof)).toBe(true)
    expect(Object.isFrozen(proof?.components)).toBe(true)
  })

  it("supports a component bundle global and proves an empty render set", async () => {
    const code = await compiled(
      `export function register(on) {
      on("turn.complete", ($,event,next) => next(event));
    }`,
      "__cmbComponent0"
    )
    expect(analyzeStaticUiRenderSummary(code).kind).toBe("unknown")
    const summary = analyzeStaticUiRenderSummary(code, "__cmbComponent0")
    expect(
      bindStaticUiRenderSummary(summary, code, rows(["turn.complete", false]))?.components
    ).toEqual([])
  })

  it("accepts bytes produced by the actual source snapshot loader", async () => {
    const root = await mkdtemp(join(tmpdir(), "static-render-summary-"))
    roots.push(root)
    await mkdir(join(root, ".claude-plugin"))
    await mkdir(join(root, "hooks"))
    await writeFile(
      join(root, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: "static-probe" })
    )
    await writeFile(
      join(root, "hooks/hooks.json"),
      JSON.stringify({ modules: ["./register.ts", "./other.ts"] })
    )
    await writeFile(
      join(root, "hooks/register.ts"),
      `export function register(on) {
      on("ui.render", {component:"AbovePrompt"}, ($,e,next) => next(e))
    }`
    )
    await writeFile(
      join(root, "hooks/other.ts"),
      `export function register(on) {
        on("ui.render", {component:"UserMessage"}, ($,e,next) => next(e))
      }`
    )
    const source = await compileFunctionPlugin(root)
    const summary = analyzeStaticUiRenderSummary(source.code)
    const guest = await FunctionGuestRuntime.create(source.code)
    try {
      expect(
        bindStaticUiRenderSummary(summary, source.code, guest.registrations)?.components
      ).toEqual(["AbovePrompt", "UserMessage"])
    } finally {
      guest.dispose()
    }
  })

  it.each([
    ["mutable alias", `const matcher={component:"AbovePrompt"}; on("ui.render",matcher,()=>null);`],
    [
      "nested mutable alias",
      `const component="AbovePrompt"; on("ui.render",{component},()=>null);`
    ],
    ["getter", `on("ui.render",{get component(){throw Error("must not read")}},()=>null);`],
    ["Proxy", `on("ui.render",new Proxy({},{get(){throw Error("must not read")}}),()=>null);`],
    ["spread", `on("ui.render",{...options,component:"AbovePrompt"},()=>null);`],
    ["computed", `on("ui.render",{["component"]:"AbovePrompt"},()=>null);`],
    ["prototype", `on("ui.render",{__proto__:null,component:"AbovePrompt"},()=>null);`],
    [
      "duplicate field",
      `on("ui.render",{component:"AbovePrompt",component:"UserMessage"},()=>null);`
    ],
    ["nested field", `on("ui.render",{component:"AbovePrompt",extra:{}},()=>null);`],
    ["unknown component", `on("ui.render",{component:"FutureMessage"},()=>null);`],
    ["no matcher", `on("ui.render",()=>null);`],
    ["array matcher", `on("ui.render",[{component:"AbovePrompt"}],()=>null);`],
    ["wildcard", `on("ui.*",{component:"AbovePrompt"},()=>null);`],
    ["negative event", `on("!turn.complete",{component:"AbovePrompt"},()=>null);`],
    ["resolver", `on("ui.resolve",()=>null);`],
    ["dynamic event", `const event="ui.render";on(event,{component:"AbovePrompt"},()=>null);`],
    ["conditional", `if (options.enabled) on("ui.render",{component:"AbovePrompt"},()=>null);`],
    ["loop", `for(const component of ["AbovePrompt"]) on("ui.render",{component},()=>null);`],
    ["on alias", `const hook=on;hook("ui.render",{component:"AbovePrompt"},()=>null);`],
    ["capability", `on.capability({},{});`],
    ["handler alias", `const handler=()=>null;on("ui.render",{component:"AbovePrompt"},handler);`],
    ["escaped on", `on("ui.render",{component:"AbovePrompt"},()=>on);`],
    [
      "handler registration reference",
      `on("ui.render",{component:"AbovePrompt"},()=>authorRegister);`
    ],
    ["mutable on", `on=options.on;on("ui.render",{component:"AbovePrompt"},()=>null);`],
    ["catch", `on("ui.render",{component:"AbovePrompt"},()=>null).catch(()=>null);`],
    ["dynamic code", `on("ui.render",{component:"AbovePrompt"},()=>eval("on"));`],
    ["prototype mutation", `on("turn.complete",()=>{String.prototype.endsWith=()=>true});`],
    [
      "indirect prototype",
      `on("turn.complete",()=>{const value="";value.constructor.prototype.endsWith=()=>true});`
    ],
    [
      "computed escape",
      `on("turn.complete",()=>{const key="constructor";""[key].prototype.endsWith=()=>true});`
    ],
    ["stack reflection", `on("turn.complete",function(){return arguments.callee.caller});`]
  ])("conservatively rejects %s without executing or observing guest objects", async (_, body) => {
    const code = await compiled(`export function register(on,options) { ${body} }`)
    expect(analyzeStaticUiRenderSummary(code).kind).toBe("unknown")
  })

  it.each([
    `globalThis.mutated=true;`,
    `const matcher=(()=>{throw Error("must not run")})();`,
    `globalThis.unexpected = Object.create(null);`
  ])("rejects uncertain top-level effects: %s", async (prefix) => {
    const code = await compiled(`${prefix}\nexport function register(on) {
      on("ui.render",{component:"AbovePrompt"},()=>null);
    }`)
    expect(analyzeStaticUiRenderSummary(code).kind).toBe("unknown")
  })

  it("rejects modified compiler helper behavior", async () => {
    const code = await compiled(`export function register(on) {
      on("ui.render",{component:"AbovePrompt"},()=>null);
    }`)
    const changed = code.replace("Object.defineProperty", "globalThis.evil")
    expect(changed).not.toBe(code)
    expect(analyzeStaticUiRenderSummary(changed).kind).toBe("unknown")
  })

  it("binds exact bytes, count, order and real registration metadata only", async () => {
    const code = await compiled(`export function register(on) {
      on("ui.render",{component:"AbovePrompt"},()=>null);
      on("turn.complete",()=>null);
    }`)
    const summary = analyzeStaticUiRenderSummary(code)
    const actual = rows(["ui.render", true], ["turn.complete", false])
    expect(bindStaticUiRenderSummary(summary, code, actual)?.components).toEqual(["AbovePrompt"])
    expect(bindStaticUiRenderSummary(summary, code + "\n", actual)).toBeUndefined()
    expect(bindStaticUiRenderSummary(summary, code, actual.slice(1))).toBeUndefined()
    expect(bindStaticUiRenderSummary(summary, code, [...actual].reverse())).toBeUndefined()
    for (const patch of [
      { id: "x" },
      { hasMatcher: false },
      { hasMatcher: undefined },
      { hasCatch: true }
    ]) {
      expect(
        bindStaticUiRenderSummary(summary, code, [{ ...actual[0], ...patch }, actual[1]])
      ).toBeUndefined()
    }
    expect(
      bindStaticUiRenderSummary({ ...summary } as StaticUiRenderSummary, code, actual)
    ).toBeUndefined()
  })

  it("adds reusable component proof only when every callback sharing the VM is pure", async () => {
    const code = await compiled(`export function register(on) {
      on("ui.render",{component:"AssistantMessage"},($,e)=>({type:"Text",props:{text:e.props.text}}));
      on("ui.render",{component:"UserMessage"},($,e,next)=>next(e));
      on("turn.complete",($,e,next)=>next(e));
    }`)
    const summary = analyzeStaticUiRenderSummary(code)
    expect(summary.kind === "static" && summary.reusableComponents).toEqual([
      "AssistantMessage",
      "UserMessage"
    ])
    const proof = bindStaticUiRenderSummary(
      summary,
      code,
      rows(["ui.render", true], ["ui.render", true], ["turn.complete", false])
    )
    expect(proof?.reusableComponents).toEqual(["AssistantMessage", "UserMessage"])
    expect(Object.isFrozen(proof?.reusableComponents)).toBe(true)

    const impure = await compiled(`export function register(on) {
      let calls=0;
      on("ui.render",{component:"AssistantMessage"},($,e)=>({type:"Text",props:{text:e.props.text}}));
      on("turn.complete",($,e,next)=>{calls++;return next(e)});
    }`)
    const unsafe = analyzeStaticUiRenderSummary(impure)
    expect(unsafe.kind === "static" && unsafe.components).toEqual(["AssistantMessage"])
    expect(unsafe.kind === "static" && unsafe.reusableComponents).toEqual([])
  })

  it("proves the precise existing component assembly and binds all real guest registrations", async () => {
    const first = await compiled(
      `export function register(on) {
      on("ui.render",{component:"AbovePrompt"},($,e,next)=>next(e));
    }`,
      "__cmbComponent2"
    )
    const second = await compiled(
      `export function register(on) {
      on("ui.render",{component:"AssistantMessage"},($,e)=>({type:"Text",props:{text:e.props.text}}));
    }`,
      "__cmbComponent0"
    )
    const entries: ClawComponentExport[] = [
      {
        id: "first",
        name: "First",
        kind: "module",
        entry: "first.js",
        dependsOn: [],
        actionIds: []
      },
      {
        id: "second",
        name: "Second",
        kind: "module",
        entry: "second.js",
        dependsOn: ["first"],
        actionIds: []
      }
    ]
    const modules = {
      first: {
        code: first,
        globalName: "__cmbComponent2",
        clients: {},
        environment: { read: [], write: [] }
      },
      second: {
        code: second,
        globalName: "__cmbComponent0",
        clients: {},
        environment: { read: [], write: [] }
      }
    }
    const code = assembleFunctionComponents(entries, modules, { first: { title: "Exact config" } })
    const analyzed = analyzeStaticUiRenderSummary(code)
    expect(analyzed.kind).toBe("static")
    const guest = await FunctionGuestRuntime.create(code)
    try {
      const proof = bindStaticUiRenderSummary(analyzed, code, guest.registrations)
      expect(proof?.components).toEqual(["AbovePrompt", "AssistantMessage"])
      expect(proof?.reusableComponents).toEqual(["AbovePrompt", "AssistantMessage"])
      expect(
        bindStaticUiRenderSummary(analyzed, code, guest.registrations.slice(1))
      ).toBeUndefined()
    } finally {
      guest.dispose()
    }
    for (const tampered of [
      code.replace("Object.assign({}, options,", "Object.assign(options, {},"),
      code.replace("__cmbComponent0.register(on,", "__cmbComponent0.register(options,"),
      code + "\nglobalThis.extra=true",
      code.replace("var r1 =", "var r3 =")
    ]) {
      expect(tampered).not.toBe(code)
      expect(analyzeStaticUiRenderSummary(tampered).kind).toBe("unknown")
    }

    const impure = await compiled(
      `export function register(on) {
      let calls=0;
      on("turn.complete",($,e,next)=>{calls++;return next(e)});
    }`,
      "__cmbComponent0"
    )
    const unsafe = assembleFunctionComponents(
      entries,
      { ...modules, second: { ...modules.second, code: impure } },
      {}
    )
    const unsafeSummary = analyzeStaticUiRenderSummary(unsafe)
    expect(unsafeSummary.kind === "static" && unsafeSummary.components).toEqual(["AbovePrompt"])
    expect(unsafeSummary.kind === "static" && unsafeSummary.reusableComponents).toEqual([])

    const dynamic = await compiled(
      `export function register(on) {
      const matcher={component:"AssistantMessage"};
      on("ui.render",matcher,()=>null);
    }`,
      "__cmbComponent0"
    )
    const unknown = assembleFunctionComponents(
      entries,
      { ...modules, second: { ...modules.second, code: dynamic } },
      {}
    )
    expect(analyzeStaticUiRenderSummary(unknown).kind).toBe("unknown")
    const reconfigured = assembleFunctionComponents(entries, modules, {
      first: { title: "Changed" }
    })
    expect(
      bindStaticUiRenderSummary(
        analyzed,
        reconfigured,
        rows(["ui.render", true], ["ui.render", true])
      )
    ).toBeUndefined()
  })

  it("binds literal named-state read declarations to a real lowered guest", async () => {
    const code = await compiled(`export function register(on) {
      on("ui.render",{component:"AssistantMessage"},async($,e)=>{
        const snap=await $.state.get({plugin:"state-probe",key:"theme"});
        const other=await $.state.get({key:"theme",plugin:"state-probe"});
        return {type:"Text",props:{text:snap.value.label,count:other.version}};
      });
      on("turn.complete",async($,e,next)=>{
        await $.state.set({plugin:"state-probe",key:"theme"},{label:"dark"});
        return next(e);
      });
    }`)
    const analyzed = analyzeStaticUiRenderSummary(code)
    expect(analyzed.kind === "static" && analyzed.reusableComponents).toEqual(["AssistantMessage"])
    expect(analyzed.kind === "static" && analyzed.readsNamedState).toEqual({
      AssistantMessage: [{ plugin: "state-probe", key: "theme" }]
    })
    const guest = await FunctionGuestRuntime.create(code)
    try {
      const proof = bindStaticUiRenderSummary(analyzed, code, guest.registrations)
      expect(proof?.readsNamedState).toEqual({
        AssistantMessage: [{ plugin: "state-probe", key: "theme" }]
      })
      expect(Object.isFrozen(proof?.readsNamedState.AssistantMessage)).toBe(true)
      const state = new FunctionNamedState()
      state.write({ plugin: "state-probe", key: "theme", value: { label: "dark" } }, {})
      const scope: FunctionNamedStateScope = { drawing: "native-read-proof" }
      const observed: string[] = []
      const reply = await guest.invoke(
        "0",
        {
          surface: "desktop",
          component: "AssistantMessage",
          requestId: "native-read-proof",
          props: {}
        },
        async (method, args) => {
          if (method !== "state.get" || !Array.isArray(args))
            throw Error("Unexpected native method")
          observed.push(method)
          return { value: state.read(namedStateInput(method, args), scope) }
        },
        {
          event: "ui.render",
          origin: { plugin: "engine", tier: "core" },
          capabilities: ["state.get"],
          plugin: { name: "state-probe", root: "/state-probe" },
          uiGeneration: "native-read-proof"
        }
      )
      expect(reply).toEqual({ value: { type: "Text", props: { text: "dark", count: 1 } } })
      expect(observed).toEqual(["state.get", "state.get"])
      const dependency = state.captureDrawingDependencies("native-read-proof")!
      expect(dependency).toBeDefined()
      state.release("native-read-proof")
      expect(state.drawingDependenciesCurrent(dependency)).toBe(true)
      state.write({ plugin: "state-probe", key: "unrelated", value: 1 }, {})
      expect(state.drawingDependenciesCurrent(dependency)).toBe(true)
      state.write({ plugin: "state-probe", key: "theme", value: { label: "light" } }, {})
      expect(state.drawingDependenciesCurrent(dependency)).toBe(false)
      state.releaseDrawingDependencies(dependency)
    } finally {
      guest.dispose()
    }
  })

  it("merges state refs across the exact aggregate and keeps a separate writer environment-safe", async () => {
    const reader = await compiled(
      `export function register(on){
      on("ui.render",{component:"UserMessage"},async($,e)=>{
        const snap=await $.state.get({plugin:"reader",key:"state",id:""});
        return {type:"Text",props:{text:snap.value}};
      });
    }`,
      "__cmbComponent0"
    )
    const writer = await compiled(
      `export function register(on){
      on("turn.complete",async($,e,next)=>{
        await $.state.set({plugin:"writer",key:"state"},1);return next(e);
      });
    }`,
      "__cmbComponent1"
    )
    const entries: ClawComponentExport[] = ["reader", "writer"].map((id) => ({
      id,
      name: id,
      kind: "module",
      entry: id + ".js",
      actionIds: [],
      dependsOn: []
    }))
    const modules = {
      reader: {
        code: reader,
        globalName: "__cmbComponent0",
        clients: {},
        environment: { read: [], write: [] }
      },
      writer: {
        code: writer,
        globalName: "__cmbComponent1",
        clients: {},
        environment: { read: [], write: [] }
      }
    }
    const code = assembleFunctionComponents(entries, modules, {})
    const analyzed = analyzeStaticUiRenderSummary(code)
    const guest = await FunctionGuestRuntime.create(code)
    try {
      const proof = bindStaticUiRenderSummary(analyzed, code, guest.registrations)
      expect(proof?.reusableComponents).toEqual(["UserMessage"])
      expect(proof?.readsNamedState).toEqual({
        UserMessage: [{ plugin: "reader", key: "state", id: "" }]
      })
    } finally {
      guest.dispose()
    }
  })
})
