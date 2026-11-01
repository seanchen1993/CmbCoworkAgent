import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { afterEach, expect, it } from "vitest"
import { compileFunctionPlugin } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionModuleAdmission } from "./module-admission"
import type { FunctionPlugin } from "./dispatcher"
import { scanFunctionModuleUses } from "./module-uses"

const roots: string[] = [],
  sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((value) => value.close(true)))
  for (const root of roots.splice(0)) {
    if (dirname(root) !== tmpdir() || !root.split(/[\\/]/).at(-1)?.startsWith("mods-admission-"))
      throw Error("UNEXPECTED_TEST_CLEANUP_PATH")
    await rm(root, { recursive: true, force: true })
  }
})
async function plugin(name: string, files: Record<string, string>, entries = Object.keys(files)) {
  const root = await mkdtemp(join(tmpdir(), "mods-admission-"))
  roots.push(root)
  await mkdir(join(root, ".claude-plugin"))
  await mkdir(join(root, "hooks"))
  await writeFile(
    join(root, ".claude-plugin/plugin.json"),
    JSON.stringify({ name, version: "1.0.0" })
  )
  await writeFile(
    join(root, "hooks/hooks.json"),
    JSON.stringify({ modules: entries.map((path) => `./${path}`) })
  )
  for (const [path, source] of Object.entries(files))
    await writeFile(join(root, "hooks", path), source)
  const compiled = await compileFunctionPlugin(root)
  const guest = await FunctionGuestRuntime.create(compiled.code, compiled.options)
  return {
    ...compiled,
    guest,
    tier: "user" as const,
    capabilities: [...SESSION_CAPABILITIES]
  } satisfies FunctionPlugin
}
function session(plugins: FunctionPlugin[]) {
  const logs: string[] = []
  const value = new FunctionSession(plugins, {
    threadId: "thread",
    workspace: "/workspace",
    assertLive: () => {},
    publish: async (input) => input,
    debugLog: (_name, text) => {
      logs.push(text)
    }
  })
  sessions.push(value)
  return { value, logs }
}

it("keeps literal state helpers and rejects uncertain aliases only as a gate declaration", () => {
  const source = `import {atom,read,update} from "devclaw-mods";
    const count=atom({plugin:"counter",key:"total"},0);
    export function register(on){on("command.run",async $=>({text:String(await read($,count)+await update($,count,x=>x+1))}))}`
  expect(scanFunctionModuleUses(source)).toEqual({
    uses: {
      events: ["command.run"],
      calls: ["state.get", "state.set"],
      state: {
        reads: [{ plugin: "counter", key: "total" }],
        writes: [{ plugin: "counter", key: "total" }]
      }
    }
  })
  expect(
    scanFunctionModuleUses(
      `export function register(on){const later=on;later("command.run",()=>({}))}`
    ).unknown
  ).toMatch(/aliases/)
})

it("lets only the earlier module judge, refuses one sibling and preserves shared VM state", async () => {
  const provider = await plugin("siblings", {
    "guard.ts": `export let count=0;export function bump(){count++}
      export function register(on){
        on("plugin.register",($,e,next)=>e.uses.calls.includes("fs.write")?{refuse:"no writes"}:next(e));
        on("session.start",async($,e,next)=>{await $.command.register({name:"probe",description:"probe"});return next(e)})}`,
    "denied.ts": `import {bump} from "./guard";export function register(on){
      on("engine.create",async($,e,next)=>{bump();return next(e)});
      on("session.start",async($,e,next)=>{await $.tool.register({name:"ghost",description:"ghost",inputSchema:{type:"object"}});return next(e)});
      on("command.run",{command:"bad"},async $=>{await $.fs.write("forbidden.txt","no");return {}})}`,
    "good.ts": `import {count} from "./guard";export function register(on){
      on("command.run",{command:"probe"},()=>({text:String(count)}))}`
  })
  const { value, logs } = session([provider])
  expect(await value.run("probe", "")).toEqual({ text: "0" })
  expect(value.plugins).toHaveLength(1)
  expect(value.plugins[0].guest.registrations.map((row) => row.module)).not.toContain(
    "hooks/denied.ts"
  )
  expect(logs.some((text) => text.includes("denied.ts") && text.includes("no writes"))).toBe(true)
  const denied = provider.guest.registrations.find((row) => row.module === "hooks/denied.ts")
  expect(denied).toBeUndefined()
})

it("cannot borrow an earlier module's scoped on during a later native registration phase", async () => {
  const root = await mkdtemp(join(tmpdir(), "mods-admission-"))
  roots.push(root)
  await mkdir(join(root, ".claude-plugin"))
  await mkdir(join(root, "hooks"))
  await writeFile(join(root, ".claude-plugin/plugin.json"), JSON.stringify({ name: "borrow" }))
  await writeFile(join(root, "hooks/hooks.json"), JSON.stringify({ modules: ["a.ts", "b.ts"] }))
  await writeFile(
    join(root, "hooks/a.ts"),
    `export let saved;export function register(on){saved=on}`
  )
  await writeFile(
    join(root, "hooks/b.ts"),
    `import {saved} from "./a";let caught="";
    export function register(on){try{saved("session.start",()=>({}))}catch(error){caught=error.message}
      on("command.run",()=>({text:caught}))}`
  )
  const compiled = await compileFunctionPlugin(root)
  const guest = await FunctionGuestRuntime.create(compiled.code)
  try {
    expect(guest.registrations.map((row) => row.pattern)).toEqual(["command.run"])
    expect(
      (
        await guest.invoke(
          "0",
          {},
          async () => {
            throw Error("NO_HOST_EFFECT")
          },
          {
            event: "command.run",
            origin: { plugin: "engine", tier: "core" },
            plugin: { name: "borrow", root },
            capabilities: []
          }
        )
      ).value
    ).toEqual({ text: "MODS_REGISTRATION_MODULE" })
  } finally {
    guest.dispose()
  }
})

it("a throwing judge passes through while a later judge cannot refuse an earlier module", async () => {
  const first = await plugin("first", {
    "a.ts": `export function register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"hello",description:"hello"});return next(e)});
    on("command.run",{command:"hello"},()=>({text:"first"}))}`
  })
  const last = await plugin("last", {
    "a.ts": `export function register(on){on("plugin.register",()=>({refuse:"late"}))}`
  })
  const { value } = session([first, last])
  expect(await value.run("hello", "")).toEqual({ text: "first" })
  const throwing = await plugin("throwing", {
    "a.ts": `export function register(on){on("plugin.register",()=>{throw Error("optional")})}`
  })
  const another = await plugin("another", {
    "a.ts": `export function register(on){on("command.run",{command:"hello"},()=>({text:"another"}))}`
  })
  const second = session([throwing, another]).value
  await second.start()
  expect(second.plugins.map((item) => item.name)).toContain("another")
})

it("has no gate dispatch or new alias rejection when no judge exists", async () => {
  const provider = await plugin("no-judge", {
    "a.ts": `export function register(on){
    const register=on;register("command.run",()=>({text:"legacy alias"}))}`
  })
  expect(provider.admission?.modules[0].unknown).toMatch(/aliases/)
  const admission = new FunctionModuleAdmission([provider])
  expect(admission.gated).toBe(false)
  const { value } = session([provider])
  await value.start()
  expect(value.plugins[0].guest.registrations).toHaveLength(1)
})

it("refuses shadowed trusted helpers and aliased SDK callbacks before their host effect", async () => {
  const guard = await plugin("guard", {
    "a.ts": `export function register(on){
    on("plugin.register",($,e,next)=>e.uses.calls.includes("fs.write")?{refuse:"no writes"}:next(e))}`
  })
  const hidden = await plugin("hidden", {
    "a.ts": `import {atom,read} from "devclaw-mods";
    const safe=atom({plugin:"hidden",key:"safe"},0);
    export function register(on){
      on("session.start",async($,e,next)=>{await read($,safe);return next(e)});
      on("command.run",async $=>{
      function read(api){return api.fs.write("x","y")}
      await read($,{plugin:"safe",key:"x"});return {}})}`
  })
  // esbuild may rename the legitimate import before this scan. Either the duplicate
  // binding or the remaining untrusted SDK forwarding must stay explicitly unknown.
  expect(hidden.admission?.modules[0].unknown).toMatch(/shadowed binding|aliases/)
  const aliased = await plugin("aliased", {
    "a.ts": `export function register(on){
    on("command.run",async api=>{await api.fs.write("x","y");return {}})}`
  })
  expect(aliased.admission?.modules[0].unknown).toMatch(/handler aliases/)
  const { value, logs } = session([guard, hidden, aliased])
  await value.start()
  expect(value.plugins.map((item) => item.name)).toEqual(["guard"])
  expect(hidden.guest.stats.disposed).toBe(true)
  expect(aliased.guest.stats.disposed).toBe(true)
  expect(logs.filter((text) => text.includes("Cannot safely inspect"))).toHaveLength(2)
  expect(() => hidden.guest.matches("0", {})).toThrow("MODS_MODULE_NOT_ADMITTED")
})

it("evaluates local registration JS without host authority and refuses private-global entry access", async () => {
  const guard = await plugin("guard", {
    "a.ts": `export function register(on){
    on("plugin.register",($,e,next)=>next(e))}`
  })
  const unsafe = await plugin("unsafe", {
    "a.ts": `let host=false;
    export function register(on){try{globalThis.__functionHost("fs.write",[])}catch{host=false}
      on("command.run",()=>({text:String(host)}))}`
  })
  expect(unsafe.admission?.modules[0].unknown).toMatch(/private\/global/)
  const { value } = session([guard, unsafe])
  await value.start()
  expect(value.plugins.map((item) => item.name)).toEqual(["guard"])
  expect(() =>
    unsafe.guest.invoke(
      "0",
      {},
      async () => {
        throw Error("HOST_MUST_NOT_RUN")
      },
      {
        event: "command.run",
        origin: { plugin: "engine", tier: "core" },
        plugin: { name: "unsafe", root: unsafe.root },
        capabilities: [...SESSION_CAPABILITIES]
      }
    )
  ).toThrow("MODS_MODULE_NOT_ADMITTED")
})

it("runs a wildcard judge with the real SDK without awaiting its own startup", async () => {
  const guard = await plugin("wildcard", {
    "a.ts": `let checks=0;export function register(on){
    on("*",async($,e,next)=>{if(!e.uses)return next(e);await $.command.list();checks++;
      return e.uses.calls.includes("fs.write")?{refuse:"no writes"}:next(e)});
    on("session.start",async($,e,next)=>{await $.command.register({name:"probe",description:"probe"});return next(e)});
    on("command.run",{command:"probe"},()=>({text:String(checks)}))}`
  })
  const writer = await plugin("writer", {
    "a.ts": `export function register(on){
    on("command.run",async $=>{await $.fs.write("x","y");return {}})}`
  })
  const reader = await plugin("reader", {
    "a.ts": `export function register(on){
    on("command.run",{command:"reader"},()=>({text:"reader"}))}`
  })
  const { value } = session([guard, writer, reader])
  expect(await value.run("probe", "")).toEqual({ text: "2" })
  expect(value.plugins.map((item) => item.name)).toEqual(["wildcard", "reader"])
})

it("honors an explicit fail-closed recovery handler and releases a wholly refused guest", async () => {
  const guard = await plugin("closed", {
    "a.ts": `export function register(on){
    on("plugin.register",()=>{throw Error("closed")}).catch(($,e,next)=>({refuse:"closed by recovery"}))}`
  })
  const target = await plugin("target", {
    "a.ts": `export function register(on){on("command.run",()=>({text:"ghost"}))}`
  })
  const { value, logs } = session([guard, target])
  await value.start()
  expect(value.plugins.map((item) => item.name)).toEqual(["closed"])
  expect(target.guest.stats.disposed).toBe(true)
  expect(logs.some((text) => text.includes("target") && text.includes("closed by recovery"))).toBe(
    true
  )
})

it("uses actual component order and refuses a dependent whose required module was refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "mods-admission-"))
  roots.push(root)
  await mkdir(join(root, "mods"))
  const component = (id: string, dependsOn: string[] = []) => ({
    id,
    name: id,
    kind: "module",
    entry: `${id}.ts`,
    dependsOn,
    actionIds: []
  })
  await writeFile(
    join(root, "mods/manifest.json"),
    JSON.stringify({
      apiVersion: "cmb.mods/v2",
      id: "ordered",
      claw: {
        componentsVersion: 1,
        components: [component("c-view", ["b-core"]), component("b-core"), component("a-guard")],
        actions: []
      }
    })
  )
  await writeFile(
    join(root, "mods/a-guard.ts"),
    `export function register(on){
    on("plugin.register",($,e,next)=>e.uses.events.includes("turn.complete")?{refuse:"no completion"}:next(e))}`
  )
  await writeFile(
    join(root, "mods/b-core.ts"),
    `export function register(on){on("turn.complete",($,e,next)=>next(e))}`
  )
  await writeFile(
    join(root, "mods/c-view.ts"),
    `export function register(on){on("command.run",()=>({text:"ghost"}))}`
  )
  const compiled = await compileFunctionPlugin(root)
  expect(compiled.admission?.modules.map((item) => item.id)).toEqual([
    "mods/a-guard.ts",
    "mods/b-core.ts",
    "mods/c-view.ts"
  ])
  const guest = await FunctionGuestRuntime.create(compiled.code, compiled.options)
  const { value, logs } = session([
    { ...compiled, guest, tier: "user", capabilities: [...SESSION_CAPABILITIES] }
  ])
  await value.start()
  expect(value.plugins[0].guest.registrations.map((item) => item.module)).toEqual([
    "mods/a-guard.ts"
  ])
  expect(
    logs.some((text) => text.includes("c-view.ts") && text.includes("required component"))
  ).toBe(true)
})

it.each([
  `eval('$.fs.write("x","y")')`,
  `(0,eval)('$.fs.write("x","y")')`,
  `(()=>{const evaluate=eval;return evaluate("source")})()`,
  `Function("return 1")()`,
  `new Function("return 1")()`,
  `(()=>{}).constructor("return 1")()`,
  `(()=>{})["constructor"]("return 1")()`,
  `(()=>{})["con"+"structor"]("return 1")()`,
  `(()=>{const key="constructor";return (()=>{})[key]("return 1")()})()`,
  `(()=>{const {constructor:generate}=()=>{};return generate("return 1")()})()`,
  `Reflect.get(()=>{},"constructor")("return 1")()`,
  `Object.getOwnPropertyDescriptor(Object.getPrototypeOf(()=>{}),"constructor")`
])(
  "does not declare dynamically generated or reflected source as an empty call set: %s",
  (expression) => {
    expect(
      scanFunctionModuleUses(`export function register(on){on("command.run",async $=>{
    await ${expression};return {}})}`).unknown
    ).toMatch(/dynamic code|reflective access/)
  }
)

it("refuses a real eval candidate at the gate independently of the VM codegen guard", async () => {
  const guard = await plugin("guard", {
    "a.ts": `export function register(on){
    on("plugin.register",($,e,next)=>e.uses.calls.includes("fs.write")?{refuse:"no writes"}:next(e))}`
  })
  const target = await plugin("dynamic", {
    "a.ts": `export function register(on){
    on("command.run",async $=>{await eval('$.fs.write("x","y")');return {}})}`
  })
  expect(target.admission?.modules[0].uses.calls).toEqual([])
  expect(target.admission?.modules[0].unknown).toMatch(/dynamic code/)
  const { value, logs } = session([guard, target])
  await value.start()
  expect(value.plugins.map((item) => item.name)).toEqual(["guard"])
  expect(target.guest.stats.disposed).toBe(true)
  expect(logs.some((text) => text.includes("dynamic code"))).toBe(true)
  expect(() => target.guest.matches("0", {})).toThrow("MODS_MODULE_NOT_ADMITTED")
})

it("preserves the existing no-judge codegen denial and direct SDK RPC", async () => {
  const dynamic = await plugin("no-judge-dynamic", {
    "a.ts": `export function register(on){
    on("command.run",async $=>{try{await eval('$.fs.write("x","y")');return {text:"unexpected"}}
      catch(error){return {text:error.message}}})}`
  })
  const direct = await plugin("no-judge-direct", {
    "a.ts": `export function register(on){
    on("command.run",async $=>{await $.fs.write("x","y");return {text:"written"}})}`
  })
  const { value } = session([dynamic, direct])
  await value.start()
  expect(value.plugins.map((item) => item.name)).toEqual(["no-judge-dynamic", "no-judge-direct"])
  const calls: string[] = []
  const invoke = (provider: typeof dynamic) =>
    provider.guest.invoke(
      "0",
      {},
      async (method) => {
        calls.push(method)
        return { value: { isWritten: true } }
      },
      {
        event: "command.run",
        origin: { plugin: "engine", tier: "core" },
        plugin: { name: provider.name, root: provider.root },
        capabilities: ["fs.write"]
      }
    )
  expect((await invoke(dynamic)).value).toEqual({ text: "MODS_CODE_GENERATION_DENIED" })
  expect(calls).toEqual([])
  expect((await invoke(direct)).value).toEqual({ text: "written" })
  expect(calls).toEqual(["fs.write"])
})

it("admits indexed data and repeated local result bindings under a composed wildcard judge", async () => {
  const guard = await plugin("indexed-wildcard", {
    "a.ts": `let total=0;
    export function register(on){
      on("*",async($,e,next)=>{if(e.uses){const rows=[{value:2},{value:3}];
        for(let index=0;index<rows.length;index++){
          const field=Object.getOwnPropertyDescriptor(rows[index],"value");
          if(field)total+=field.value;
        }}return next(e)});
      on("session.start",async($,e,next)=>{const result=await $.command.register({name:"probe",description:"probe"});
        if(!result)throw Error("missing command");return next(e)});
      on("command.run",{command:"probe"},()=>{const result=String(total);return {text:result}})
    }`
  })
  const target = await plugin("ordinary-data", {
    "a.ts": `export function register(on){
    on("command.run",{command:"other"},()=>({text:"ok"}))}`
  })
  expect(guard.admission?.modules[0].unknown).toBeUndefined()
  const { value } = session([guard, target])
  expect(await value.run("probe", "")).toEqual({ text: "5" })
  expect(value.plugins.map((item) => item.name)).toEqual(["indexed-wildcard", "ordinary-data"])
})

it("still refuses ambiguous names actually resolved as handlers or state references", () => {
  expect(
    scanFunctionModuleUses(`const listener=()=>({});
    function helper(){const listener=()=>({});return listener}
    export function register(on){on("command.run",listener)}`).unknown
  ).toMatch(/shadowed handler/)
  expect(
    scanFunctionModuleUses(`import{atom,read}from"devclaw-mods";
    export function register(on){
      on("command.run",{command:"one"},async $=>{const ref=atom({plugin:"p",key:"one"},0);return {text:String(await read($,ref))}});
      on("command.run",{command:"two"},async $=>{const ref=atom({plugin:"p",key:"two"},0);return {text:String(await read($,ref))}})
    }`).unknown
  ).toMatch(/state references/)
})

it.each([
  `handler=async api=>{await api.fs.write("x","y");return {text:"written"}}`,
  `[handler]=[async api=>{await api.fs.write("x","y");return {text:"written"}}]`,
  `handler&&=async api=>{await api.fs.write("x","y");return {text:"written"}}`,
  `for(handler of [async api=>{await api.fs.write("x","y");return {text:"written"}}]){}`,
  `({next:handler}={next:async api=>{await api.fs.write("x","y");return {text:"written"}}})`
])("refuses a replaced handler before any SDK RPC: %s", async (replacement) => {
  const guard = await plugin("mutation-guard", {
    "a.ts": `export function register(on){
    on("plugin.register",($,e,next)=>e.uses.calls.includes("fs.write")?{refuse:"no writes"}:next(e))}`
  })
  const target = await plugin("mutable-handler", {
    "a.ts": `function handler($){return {}}
    ${replacement};
    export function register(on){on("command.run",handler)}`
  })
  expect(target.admission?.modules[0].unknown).toMatch(/shadowed handler/)
  expect(target.admission?.modules[0].uses.calls).toEqual([])
  const { value } = session([guard, target])
  await value.start()
  expect(value.plugins.map((item) => item.name)).toEqual(["mutation-guard"])
  expect(target.guest.stats.disposed).toBe(true)
  const calls: string[] = []
  expect(() =>
    target.guest.invoke(
      "0",
      {},
      async (method) => {
        calls.push(method)
        return { value: { isWritten: true } }
      },
      {
        event: "command.run",
        origin: { plugin: "engine", tier: "core" },
        plugin: { name: target.name, root: target.root },
        capabilities: ["fs.write"]
      }
    )
  ).toThrow("MODS_MODULE_NOT_ADMITTED")
  expect(calls).toEqual([])
})

it.each([
  `const recover=on("command.run",()=>({})).catch;recover(api=>api)`,
  `const handle=on("command.run",()=>({}));const recover=handle.catch;recover(api=>api)`,
  `const {catch:recover}=on("command.run",()=>({}));recover(api=>api)`,
  `let handle;handle=on("command.run",()=>({}));handle.catch(api=>api)`,
  `const handles=[on("command.run",()=>({}))];handles[0].catch(api=>api)`,
  `const handle=on("command.run",()=>({}));pass(handle)`
])("marks only an escaped registration handle as uncertain: %s", (registration) => {
  expect(scanFunctionModuleUses(`export function register(on){${registration}}`).unknown).toMatch(
    /registration handle/
  )
})

it("inspects direct recovery aliases and preserves stable handles and Promise data callbacks", () => {
  expect(
    scanFunctionModuleUses(`export function register(on){
      on("command.run",()=>({})).catch(async api=>{await api.fs.write("x","y");return {}})
    }`).unknown
  ).toMatch(/SDK handler aliases/)
  expect(
    scanFunctionModuleUses(`export function register(on){
      let handle=on("command.run",()=>({}));const alias=handle;
      alias.catch(async $=>{await $.fs.read("x");return {}});
      Promise.reject({value:"data"}).catch(api=>api.value)
    }`)
  ).toEqual({ uses: { events: ["command.run"], calls: ["fs.read"] } })
})

it.each([
  `let handle=on("command.run",()=>{throw Error("x")});handle.catch`,
  `const recover=on("command.run",()=>{throw Error("x")}).catch;recover`
])("refuses an uninspectable SDK recovery before any host RPC: %s", async (setup) => {
  const source = `export function register(on){${setup}(async api=>{
    await api.fs.write("x","y");return {text:"recovered"}})}`
  const legacy = await plugin("recovery-no-judge", { "a.ts": source })
  const noJudge = session([legacy]).value
  await noJudge.start()
  const legacyCalls: string[] = []
  // Verify the actual native handle accepts both forms without a judge. The host is
  // controlled by this test; no filesystem is written while exercising the recovery.
  expect(
    (
      await legacy.guest.invoke(
        "0",
        {},
        async (method) => {
          legacyCalls.push(method)
          return { value: { isWritten: true } }
        },
        {
          event: "command.run",
          origin: { plugin: "engine", tier: "core" },
          plugin: { name: legacy.name, root: legacy.root },
          capabilities: ["fs.write"],
          caught: { message: "x", called: false, kind: "throw" }
        }
      )
    ).value
  ).toEqual({ text: "recovered" })
  expect(legacyCalls).toEqual(["fs.write"])

  const guard = await plugin("recovery-guard", {
    "a.ts": `export function register(on){
      on("plugin.register",($,e,next)=>e.uses.calls.includes("fs.write")?{refuse:"no writes"}:next(e))}`
  })
  const target = await plugin("recovery-gated", { "a.ts": source })
  expect(target.admission?.modules[0].unknown).toMatch(/handler aliases|registration handle/)
  const { value } = session([guard, target])
  await value.start()
  expect(value.plugins.map((item) => item.name)).toEqual(["recovery-guard"])
  expect(target.guest.stats.disposed).toBe(true)
  const calls: string[] = []
  expect(() =>
    target.guest.invoke(
      "0",
      {},
      async (method) => {
        calls.push(method)
        return { value: { isWritten: true } }
      },
      {
        event: "command.run",
        origin: { plugin: "engine", tier: "core" },
        plugin: { name: target.name, root: target.root },
        capabilities: ["fs.write"],
        caught: { message: "x", called: false, kind: "throw" }
      }
    )
  ).toThrow("MODS_MODULE_NOT_ADMITTED")
  expect(calls).toEqual([])
})

it("admits stable recovery handles and ordinary Promise.catch under a wildcard judge", async () => {
  const guard = await plugin("recovery-wildcard", {
    "a.ts": `export function register(on){
      on("*",($,e,next)=>next(e));
      on("session.start",async($,e,next)=>{
        await $.command.register({name:"promise",description:"promise"});return next(e)})}`
  })
  const target = await plugin("recovery-data", {
    "a.ts": `export function register(on){
      let handle=on("command.run",{command:"promise"},()=>{throw Error("recover")});
      const alias=handle;alias.catch(async $=>{
        const result=await Promise.reject({value:"data"}).catch(api=>api.value);
        return {text:result}})}`
  })
  expect(target.admission?.modules[0].unknown).toBeUndefined()
  const { value } = session([guard, target])
  expect(await value.run("promise", "")).toEqual({ text: "data" })
  expect(value.plugins.map((item) => item.name)).toEqual(["recovery-wildcard", "recovery-data"])
})
