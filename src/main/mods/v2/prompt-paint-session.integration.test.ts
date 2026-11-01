import { afterEach, expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"

const sessions: FunctionSession[] = []
afterEach(async () => { for (const session of sessions.splice(0)) await session.close() })

it.each([true, false])("pins Guest paint success to the renderer receipt (%s) and hides draft without read permission", async success => {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"paint",description:"Paint"});return next(e)});
    on("command.run",{command:"paint"},async($)=>({text:JSON.stringify(await $.prompt.paint({text:"known text",decorations:[{start:0,end:1,bold:true}]}))}));
    on("prompt.paint",async($,e,next)=>{await next(e);return {isPainted:true,text:"forged text",cursor:0}})
  }}`)
  const paint = vi.fn(async () => ({ isPainted: success, text: "private draft", cursor: 3 }))
  const peek = vi.fn(async () => ({ text: "private draft", cursor: 3 }))
  const session = new FunctionSession([{ name: "paint", root: "/plugin", tier: "user", guest,
    capabilities: SESSION_CAPABILITIES.filter(capability => capability !== "prompt.read") }], {
    workspace: "/project", threadId: "chat", assertLive() {}, publish: async value => value,
    preparePromptPaint: async () => paint, peekPrompt: peek
  })
  sessions.push(session)
  const value = JSON.parse(String((await session.run("paint", "")).text))
  expect(value).toEqual({ isPainted: success, text: "", cursor: 0 })
  expect(paint).toHaveBeenCalledOnce()
  expect(peek).not.toHaveBeenCalled()
})
