import { afterEach, expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession } from "./session"
import type { ModJson, ModObject } from "../../../shared/mods/types"

const sessions: FunctionSession[] = []
afterEach(async () => { await Promise.all(sessions.splice(0).map(session => session.close())) })
const original: ModObject = { blocks: [{ name: "claudeMd", text: "NATIVE" }], instructionFiles:
  [{ path: "/p/AGENTS.md", kind: "project", content: "PROJECT" }] }
async function fixture(body: string,
  publish = async (value: ModJson): Promise<ModJson> => value) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${body}}}`)
  const session = new FunctionSession([{ name: "context", root: "/context", tier: "user", guest,
    capabilities: [] }], { workspace: "/p", threadId: "t", assertLive() {
      // Native authority checks are covered independently by owner isolation tests.
    }, publish })
  sessions.push(session)
  return session
}
const signal = () => new AbortController().signal
const core = async (input: ModObject) => input

it("synchronizes changed files before a later matcher observes them", async () => {
  const session = await fixture(`
    on("prompt.context",async($,e,next)=>next({...e,instructionFiles:[
      {path:"/never-read/new.md",kind:"managed",content:"CHANGED"}]}));
    on("prompt.context",{blocks:[{name:"claudeMd",text:/CHANGED/}]},async($,e,next)=>{
      if(e.blocks[0].text.includes("NATIVE"))throw Error("stale text");return next(e)
    });`)
  const result = await session.promptComposition("prompt.context", original, signal(), core)
  expect(JSON.stringify(result)).toContain("CHANGED")
  expect(JSON.stringify(result)).not.toContain("NATIVE")
})

it("text rewrite clears the list through downward and upward omitted fields", async () => {
  const session = await fixture(`
    on("prompt.context",async($,e,next)=>{
      const out=await next({...e,blocks:[{name:"claudeMd",text:"CHANGED"}]});
      if("instructionFiles" in out)throw Error("revived");return {blocks:out.blocks}
    });
    on("prompt.context",{blocks:[{name:"claudeMd",text:"CHANGED"}]},async($,e,next)=>{
      if("instructionFiles" in e)throw Error("stale files");return next({blocks:e.blocks})
    });`)
  expect(await session.promptComposition("prompt.context", original, signal(), core))
    .toEqual({ blocks: [{ name: "claudeMd", text: "CHANGED" }] })
})

it("synchronizes upward rewrites and keeps removal authoritative", async () => {
  const session = await fixture(`on("prompt.context",async($,e,next)=>{
    const out=await next(e);return {...out,blocks:[]}
  })`)
  expect(await session.promptComposition("prompt.context", original, signal(), core))
    .toEqual({ blocks: [], instructionFiles: [] })
})

it("invalid answers recover once, and publication errors remain fatal", async () => {
  const session = await fixture(`on("prompt.context",async($,e,next)=>{
    await next(e);return {blocks:[{name:"claudeMd",text:123}]}
  })`)
  let calls = 0
  expect(await session.promptComposition("prompt.context", original, signal(), async input => {
    calls++
    return input
  })).toEqual(original)
  expect(calls).toBe(1)
  const denied = await fixture(`on("prompt.context",async($,e,next)=>next(e))`, async () => {
    throw Error("PROTECTED")
  })
  await expect(denied.promptComposition("prompt.context", original, signal(), core))
    .rejects.toThrow("PROTECTED")
})

it("protects both file contents and rendered text without leaving false provenance", async () => {
  const session = await fixture(`on("prompt.context",async($,e,next)=>next({...e,
    instructionFiles:[{path:"/p/new.md",kind:"project",content:"secret"}]}))`,
  async value => JSON.parse(JSON.stringify(value).replaceAll("secret", "[redacted]")))
  const result = await session.promptComposition("prompt.context", original, signal(), core)
  expect(JSON.stringify(result)).not.toContain("secret")
  expect(JSON.stringify(result)).toContain("[redacted]")
})

it("pins attachment facts and preserves a valid downstream result after forgery", async () => {
  const session = await fixture(`on("prompt.attachment",async($,e,next)=>{
    await next({...e,text:"VALID"});return next({...e,origin:{kind:"plugin",event:"fake"}})
  })`)
  const input: ModObject = { type: "output_style", text: "BODY", origin: { kind: "engine" },
    agentId: "actual-child" }
  expect(await session.promptComposition("prompt.attachment", input, signal(),
    async input => ({ text: input.text }))).toEqual({ text: "VALID" })
})

it("accepts attachment null and rejects downstream failure instead of bypassing it", async () => {
  const session = await fixture(`on("prompt.attachment",async()=>({text:null}))`)
  expect(await session.promptComposition("prompt.attachment",
    { type: "output_style", text: "BODY", origin: { kind: "engine" } }, signal(),
    async () => ({ text: "BODY" }))).toEqual({ text: null })
  const broken = await fixture(`on("prompt.attachment",async($,e,next)=>{
    try{await next(e)}catch{}return {text:"fake success"}
  })`)
  await expect(broken.promptComposition("prompt.attachment",
    { type: "output_style", text: "BODY", origin: { kind: "engine" } }, signal(),
    async () => { throw Error("NATIVE_FAILED") })).rejects.toThrow("NATIVE_FAILED")
})
