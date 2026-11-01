import { readFileSync } from "node:fs"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import {
  CLAUDE_CORE_MEMBERS,
  CLAUDE_MODS_DECLARATIONS_SHA256,
  CLAUDE_MODS_DECLARATIONS_VERSION
} from "../../../shared/mods/v2/event-catalog"
import { FUNCTION_SDK_METHODS } from "../v2/sdk-capabilities"
import { SESSION_CAPABILITIES } from "../v2/session"
import { developmentCatalogPage } from "./development-catalog"
import { checkFunctionAuthorTypes } from "./authoring-check"

const roots: string[] = []
async function authorCheck(source: string) {
  const root = await mkdtemp(join(tmpdir(), "mods-nonmedia-author-"))
  roots.push(root)
  await mkdir(join(root, ".claude-plugin"))
  await mkdir(join(root, "hooks"))
  await writeFile(join(root, ".claude-plugin/plugin.json"), JSON.stringify({ name: "nonmedia" }))
  await writeFile(join(root, "hooks/hooks.json"), JSON.stringify({ modules: ["./main.ts"] }))
  await writeFile(join(root, "hooks/main.ts"), source)
  await writeFile(
    join(root, "hooks/counter.ts"),
    'export const create = () => ({ render: () => ({type:"Text",props:{},children:["client"]}) })'
  )
  return checkFunctionAuthorTypes(root)
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("mods-nonmedia-author-")
    )
      throw Error("Unexpected author fixture directory")
    await rm(root, { recursive: true, force: true })
  }
})

it("matches the fixed upstream Core inventory while excluding media and labeling terminal/policy adapters", () => {
  const evidence = JSON.parse(
    readFileSync(resolve("docs/mods-nonmedia-sdk-inventory-2026-11-01.json"), "utf8")
  )
  expect(evidence.upstream).toBe(CLAUDE_MODS_DECLARATIONS_VERSION)
  expect(evidence.declarationsSha256).toBe(CLAUDE_MODS_DECLARATIONS_SHA256)
  expect([...CLAUDE_CORE_MEMBERS].sort()).toEqual([...evidence.members].sort())
  const callable = evidence.members.filter((method: string) => !method.startsWith("plugin."))
  expect(callable).toHaveLength(85)
  expect(
    callable.filter((method: string) => !FUNCTION_SDK_METHODS.includes(method as never)).sort()
  ).toEqual(["audio.play", "audio.speak", "prompt.media"])
  expect(new Set(FUNCTION_SDK_METHODS)).toEqual(new Set(SESSION_CAPABILITIES))
})

it("provides queryable declarations for every actual SDK method under the creator budget", () => {
  for (const method of FUNCTION_SDK_METHODS) {
    const page = developmentCatalogPage("sdk", 0, method)
    expect(page, method).toMatchObject({
      matched: true,
      declarationAvailable: true,
      sdkMethods: [method]
    })
    expect(JSON.stringify({ ok: true, result: page }).length, method).toBeLessThan(8000)
  }
  expect(JSON.stringify({ ok: true, result: developmentCatalogPage() }).length).toBeLessThan(8000)
}, 30000)

it("lets real authors typecheck nonmedia hooks and SDK calls without ambient Node or DOM", async () => {
  const result = await authorCheck(`import type {Register} from "devclaw-mods"
export const register:Register=on=>{
  on("env.set", async($,e,next)=>next(e));
  on("telemetry.log",async($,e,next)=>next(e));
  on("ui.notify",async($,e,next)=>next(e));
  on("command.run",async($)=>{
    await $.env.set("PROJECT_STAGE","review");
    await $.env.get("PROJECT_STAGE");
    await $.telemetry.log({event:"review",props:{count:1}});
    await $.telemetry.mark({feature:"review",kind:"ok"});
    await $.telemetry.records();
    await $.ui.notify("检查完成",{title:"检查",surface:"desktop"});
    await $.prompt.paint({text:"test",decorations:[{start:0,end:4,bold:true}]});
    await $.session.identity();
    await $.fs.ancestors({names:["AGENTS.md"]});
    return {};
  });
  on("ui.render",{component:"Pane"},($,e)=>{
    const {Box,Text,Button,Input,Svg,Link,Client}=$.ui.resolve(e);
    return Box({key:"local-hover",position:"relative",borderDimColor:true,hover:{backgroundColor:"blue"},children:[
      Text({children:"Long text",dir:"rtl",wrap:"middle",hover:{bold:true}}),
      Button({key:"styled",children:[Text({children:"运行",bold:true})],variant:"primary",role:"dismiss",onPress:()=>{}}),
      Input({key:"multiline",rows:3,onSubmit:()=>{}}),
      Svg({source:'<svg viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>'}),
      Link({href:"https://example.com",children:"说明"}),
      Client({key:"counter",module:"./counter.ts",props:{count:0}})
    ]});
  });
}`)
  expect(result.diagnostics).toEqual([])
})

it("exposes the five real VM state helper exports to the isolated author compiler", async () => {
  for (const name of ["atom", "derive", "memberOf", "read", "update"]) {
    const page = developmentCatalogPage("sdk", 0, name)
    expect(page).toMatchObject({
      matched: true,
      declarationAvailable: true,
      runtimeExports: [name]
    })
    expect(JSON.stringify({ ok: true, result: page }).length).toBeLessThan(8000)
  }
  const result = await authorCheck(`import {atom,derive,memberOf,read,update} from "devclaw-mods"
import type {Register} from "devclaw-mods"
const count=atom({plugin:"nonmedia",key:"count"},0);
const doubled=derive([count],n=>n*2);
export const register:Register=on=>{on("command.run",async($)=>{
  const next=await update($,count,n=>n+1);
  const value=await read($,doubled);
  const scoped=memberOf(count,{requestId:"pane"});
  await read($,scoped);
  return {text:String(next+value)};
})}`)
  expect(result.diagnostics).toEqual([])
})

it("declares real engine and UI function-table folds instead of incorrectly requiring JSON returns", async () => {
  const result = await authorCheck(`import type {Register} from "devclaw-mods"
declare module "devclaw-mods" {interface EngineInterface {company:{read(input:{text:string}):Promise<string>}}}
export const register:Register=on=>{
  on("engine.create",async($,e,next)=>{
    const built=await next(e);
    return {...built,company:{read:async(input:{text:string})=>input.text+await built.session.id()}};
  });
  on("ui.resolve",{component:"Pane"},async($,e,next)=>{
    const elements=await next(e);
    return {...elements,Text:props=>elements.Text({...props,color:"blue"})};
  });
  on("company.read",async($,e,next)=>next(e));
}`)
  expect(result.diagnostics).toEqual([])
})
