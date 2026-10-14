import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { compileFunctionPlugin } from "../v2/loader"
import { checkFunctionAuthorTypes } from "./authoring-check"

const roots: string[] = []
const contract = `export type Helper={ping():Promise<string>};declare module "claude-code" {
  interface EngineInterface {helper:Helper}
  interface PluginState {author:{count:number}}
}`
async function fixture(source: string, types = contract, extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "mods-authoring-"))
  roots.push(root)
  await mkdir(join(root, ".claude-plugin"))
  await mkdir(join(root, "hooks"))
  await writeFile(
    join(root, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "author", types: "contract.d.ts", ...extra })
  )
  await writeFile(join(root, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.ts"] }))
  await writeFile(join(root, "hooks/register.ts"), source)
  await writeFile(join(root, "contract.d.ts"), types)
  return root
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it("checks a typed command and owner state against a closed declared contract", async () => {
  const root = await fixture(`import type {Register} from "claude-code";
    export const register:Register<"author">=on=>{on("command.run",async $=>{
      const old=await $.state.get({plugin:"author",key:"count"});
      await $.state.set({plugin:"author",key:"count"},(old.value??0)+1);
      await $.clock.sleep(1,{signal:AbortSignal.abort("cancel")});return {text:"done"};
    })}`)
  const result = await checkFunctionAuthorTypes(root)
  expect(result.diagnostics).toEqual([])
  expect(result).toMatchObject({
    valid: true,
    scope: "authoring-subset",
    runtimeProvidersVerified: false,
    dependencyRegistry: false
  })
  const compiled = await compileFunctionPlugin(root)
  expect(compiled.authorTypes).toMatchObject({ nouns: ["helper"], state: { author: ["count"] } })
  expect(compiled.authoringSources).toBeUndefined()
})

it("checks the shipped typed-counter starter without a generated editor declaration", async () => {
  const result = await checkFunctionAuthorTypes(join(process.cwd(), "examples/mods-typed-counter"))
  expect(result.diagnostics).toEqual([])
})

it.each(["cjs", "cts"])("checks .%s ESM source and does not skip its type errors", async (extension) => {
  const root = await fixture("export function register() {}")
  await writeFile(join(root, "hooks/hooks.json"), JSON.stringify({ modules: [`./main.${extension}`] }))
  await writeFile(join(root, `hooks/main.${extension}`),
    `import { value } from "./helper.${extension}"; export function register(){ value.toUpperCase() }`)
  await writeFile(join(root, `hooks/helper.${extension}`), 'export const value = "valid"')
  expect((await checkFunctionAuthorTypes(root)).diagnostics).toEqual([])
  await writeFile(join(root, `hooks/helper.${extension}`), 'export const value = 42')
  expect((await checkFunctionAuthorTypes(root)).diagnostics.some(
    (entry) => entry.file === `hooks/main.${extension}` && entry.message.includes("toUpperCase")
  )).toBe(true)
})

it("types both lazy and eager registered tools", async () => {
  const source = `import type {Register} from "claude-code";
    export const register:Register<"author">=on=>{on("command.run",async $=>{
      await $.tool.register({name:"probe",description:"Immediately callable",isDeferred:false});
      return {text:"registered"}
    })}`
  const root = await fixture(source)
  expect((await checkFunctionAuthorTypes(root)).diagnostics).toEqual([])
  await writeFile(join(root, "hooks/register.ts"), source.replace("isDeferred:false", "isDeferred:true"))
  expect((await checkFunctionAuthorTypes(root)).valid).toBe(true)
})

it("reports unsupported APIs and wrong declared state values without an any fallback", async () => {
  const root = await fixture(`import type {Register} from "claude-code";
    export const register:Register<"author">=on=>{on("command.run",async $=>{
      await $.state.set({plugin:"author",key:"count"},"wrong");await $.audio.play("x");
      await $.env.set("NAME","unsupported");return {};
    })}`)
  const result = await checkFunctionAuthorTypes(root)
  expect(result.valid).toBe(false)
  expect(result.diagnostics.some((row) => row.message.includes("number"))).toBe(true)
  expect(result.diagnostics.some((row) => row.message.includes("audio"))).toBe(true)
  expect(result.diagnostics.some((row) => row.message.includes("'set'"))).toBe(true)
})

it("includes closed declaration changes in the authorization digest", async () => {
  const root = await fixture("export function register(on){on('command.run',()=>({}))}")
  const first = await compileFunctionPlugin(root)
  await writeFile(join(root, "contract.d.ts"), contract.replace("count:number", "count:string"))
  const second = await compileFunctionPlugin(root)
  expect(second.digest).not.toBe(first.digest)
  expect(second.sources).toContain("contract.d.ts")
})

it("checks the bounded agent registry, explicit spawn and completion authoring chain", async () => {
  const root = await fixture(`import type {Register} from "claude-code";
    export const register:Register<"author">=on=>{
      on("agent.register",async($,event,next)=>next({...event,maxTurns:3}));
      on("agent.spawn",async($,event,next)=>next({...event,model:event.parentModel}));
      on("command.run",async $=>{
        const role=await $.agent.register({name:"reviewer",description:"Review code",prompt:"Inspect changes",
          tools:["read_file"],disallowedTools:["write_file"],maxTurns:3,background:true,
          omitClaudeMd:true,permissionMode:"plan",model:"inherit"});
        const child=await $.agent.spawn({prompt:"Review",subagentType:role.agent});
        return {text:"deny" in child?child.deny:child.agentId??"handled without a child"};
      });
      on("turn.complete",async($,event,next)=>{if(event.agentId)$.ui.log(event.answer);return next(event)});
    }`)
  expect((await checkFunctionAuthorTypes(root)).diagnostics).toEqual([])
})

it("rejects unsupported agent modes and requires callers to handle spawn denial", async () => {
  const root = await fixture(`import type {Register} from "claude-code";
    export const register:Register<"author">=on=>{on("command.run",async $=>{
      await $.agent.register({name:"x",description:"x",prompt:"x",permissionMode:"bypassPermissions"});
      await $.agent.spawn({prompt:"x",fork:true});
      const child=await $.agent.spawn({prompt:"x"});return {text:child.agentId};
    })}`)
  const result = await checkFunctionAuthorTypes(root)
  expect(result.valid).toBe(false)
  expect(result.diagnostics.some((row) => row.message.includes("bypassPermissions"))).toBe(true)
  expect(result.diagnostics.some((row) => row.message.includes("fork"))).toBe(true)
  expect(result.diagnostics.some((row) => row.message.includes("agentId"))).toBe(true)
})

it.each([
  'import type {Stats} from "node:fs";export type X=Stats;',
  'export type X=import("./other").X;',
  '/// <reference path="../outside.d.ts" />\nexport type X=number;',
  '/// <reference types="node" />\nexport type X=number;',
  'declare module "node:fs" {export type X=number;}'
])("rejects open or foreign declaration contracts: %s", async (declaration) => {
  const root = await fixture("export function register(){}", declaration)
  await expect(compileFunctionPlugin(root)).rejects.toThrow(/MODS_TYPES_(CLOSED_CONTRACT|MODULE)/)
})

it("refuses a declaration path escaping the plugin and reports unresolved dependency aggregation", async () => {
  const root = await fixture("export function register(){}", contract, {
    dependencies: { other: "1" }
  })
  const result = await checkFunctionAuthorTypes(root)
  expect(result.valid).toBe(false)
  expect(result.diagnostics.some((row) => row.code === "MODS_TYPES_DEPENDENCIES_UNRESOLVED")).toBe(
    true
  )
  await writeFile(
    join(root, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "author", types: "../outside.d.ts" })
  )
  await expect(compileFunctionPlugin(root)).rejects.toThrow("MODS_TYPES_PATH")
})

it("does not load a user tsconfig, Node types, DOM library or ambient files outside its snapshot", async () => {
  const root = await fixture(`/// <reference types="node" />
    /// <reference lib="dom" />
    /// <reference path="../outside.d.ts" />
    export function register(){process.exit();document.title="escaped";}`)
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { types: ["node"], plugins: [{ name: "malicious" }] } })
  )
  const result = await checkFunctionAuthorTypes(root)
  expect(result.valid).toBe(false)
  expect(result.diagnostics.some((row) => row.message.includes("process"))).toBe(true)
  expect(result.diagnostics.some((row) => row.message.includes("document"))).toBe(true)
  expect(result.diagnostics.some((row) => row.message.includes("outside"))).toBe(true)
})


it("types model results from the approved manifest mode instead of accepting both shapes", async () => {
  const source = `import type {Register} from "claude-code";
    export const register:Register=on=>{on("command.run",async $=>{
      const reply=await $.model.complete({model:"default",prompt:"hi",timeoutMs:100});
      return {text:reply.isAnswered?reply.text:reply.reason};
    })}`
  const modern = await fixture(source, contract, {cmbCompatibility:{modelProtocol:"result-v1"}})
  expect((await checkFunctionAuthorTypes(modern)).diagnostics).toEqual([])
  const undeclared = await fixture(source)
  expect((await compileFunctionPlugin(undeclared)).modelProtocol).toBe("result-v1")
  expect((await checkFunctionAuthorTypes(undeclared)).diagnostics).toEqual([])
  const defaultAsString = await fixture(source.replace(
    "return {text:reply.isAnswered?reply.text:reply.reason};",
    "return {text:reply.toUpperCase()};"
  ))
  const incompatible = await checkFunctionAuthorTypes(defaultAsString)
  expect(incompatible.valid).toBe(false)
  expect(incompatible.diagnostics.some(row => row.message.includes("toUpperCase"))).toBe(true)
  const legacy = await fixture(source, contract, {cmbCompatibility:{modelProtocol:"legacy-v1"}})
  expect((await checkFunctionAuthorTypes(legacy)).valid).toBe(false)
  const old = await fixture(`import type {Register} from "claude-code";
    export const register:Register=on=>{on("command.run",async $=>({text:await $.model.complete({model:"default",prompt:"hi"})}))}`, contract, {cmbCompatibility:{modelProtocol:"legacy-v1"}})
  expect((await checkFunctionAuthorTypes(old)).diagnostics).toEqual([])
})
