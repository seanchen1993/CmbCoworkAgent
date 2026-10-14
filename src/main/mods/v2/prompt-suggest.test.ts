import { afterEach, expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { ModRuntimeAuthorities } from "../runtime-instance"
import { withFunctionAgentExecution } from "./host-call"
import type { ModJson, ModObject } from "../../../shared/mods/types"

const sessions: FunctionSession[] = []
const owners: ModRuntimeAuthorities[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
  owners.splice(0).forEach((owner) => owner.close())
})
async function fixture(
  hooks: string,
  shown = true,
  publish = async (value: ModJson): Promise<ModJson> => value
) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"offer",description:"Offer"});return next(e)});
    on("command.run",async($)=>({text:JSON.stringify(await $.prompt.suggest({text:"secret next"}))}));
    ${hooks}
  }}`)
  const calls: ModObject[] = []
  let preparations = 0,
    live = true
  const session = new FunctionSession(
    [
      {
        name: "suggest",
        root: "/suggest",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/workspace",
      threadId: "t",
      assertLive() {
        if (!live) throw Error("revoked")
      },
      publish,
      preparePromptSuggest: async () => {
        preparations++
        return async (value) => {
          calls.push(value)
          return { isShown: shown }
        }
      }
    }
  )
  sessions.push(session)
  await session.start()
  const registry = new ModRuntimeAuthorities()
  owners.push(registry)
  const { authority } = registry.create({
    workspace: "/workspace",
    threadId: "t",
    turnId: "run",
    agentId: "main"
  })
  const run = () =>
    withFunctionAgentExecution(
      {
        ...authority,
        runtimeAuthority: authority,
        leased: false,
        immediate: false,
        userInitiated: false
      },
      () => session.run("offer", "")
    )
  return {
    run,
    calls,
    prepared: () => preparations,
    revoke: () => {
      live = false
    },
    session
  }
}
it("uses the actual plugin origin, protects rewritten text and returns real display acknowledgement", async () => {
  const f = await fixture(
    `on("prompt.suggest",async($,e,next)=>next({...e,
    text:e.text+" secret"}));`,
    true,
    async (value) => JSON.parse(JSON.stringify(value).replaceAll("secret", "[redacted]"))
  )
  expect((await f.run()).text).toBe('{"isShown":true}')
  expect(f.prepared()).toBe(1)
  expect(f.calls).toEqual([
    { text: "[redacted] next [redacted]", origin: { kind: "plugin", name: "suggest" } }
  ])
})
it("cannot forge the origin while rewriting a suggestion", async () => {
  const f = await fixture(`on("prompt.suggest",async($,e,next)=>next({...e,
    text:"spoofed",origin:{kind:"plugin",name:"other"}}));`)
  expect((await f.run()).text).toBe('{"isShown":true}')
  expect(f.calls).toEqual([{ text: "secret next", origin: { kind: "plugin", name: "suggest" } }])
})
it("a hook cannot fabricate success without calling the real composer", async () => {
  const f = await fixture(`on("prompt.suggest",async()=>({isShown:true}));`)
  expect((await f.run()).text).toBe('{"isShown":false}')
  expect(f.calls).toEqual([])
})
it("a real composer refusal stays false even if an after-hook claims success", async () => {
  const f = await fixture(
    `on("prompt.suggest",async($,e,next)=>{await next(e);return {isShown:true}});`,
    false
  )
  expect((await f.run()).text).toBe('{"isShown":false}')
  expect(f.calls).toHaveLength(1)
})
it("an explicit suggestion from its own handler skips only that registration", async () => {
  const f = await fixture(`
    on("prompt.suggest",async($,e)=>$.prompt.suggest({text:e.text+" self"}));
    on("prompt.suggest",{},async($,e,next)=>next({...e,text:e.text+" neighbor"}));`)
  expect((await f.run()).text).toBe('{"isShown":true}')
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0].text).toBe("secret next self neighbor")
})
it("a blocked sibling suggestion cannot borrow the previous sibling's real display proof", async () => {
  const f = await fixture(`
    on("prompt.suggest",async($,e)=>{
      await $.prompt.suggest({text:"shown"});
      return await $.prompt.suggest({text:"blocked"});
    });
    on("prompt.suggest",{},async($,e,next)=>e.text==="blocked"?{isShown:true}:next(e));`)
  expect((await f.run()).text).toBe('{"isShown":false}')
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0].text).toBe("shown")
})
