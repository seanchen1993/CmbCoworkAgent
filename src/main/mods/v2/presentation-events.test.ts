import { afterEach, expect, it, vi } from "vitest"
import { FunctionSession, SESSION_CAPABILITIES, type FunctionSessionHost } from "./session"
import { FunctionGuestRuntime } from "./guest-runtime"
import { validatePresentationResult } from "../../../shared/mods/v2/presentation-events"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
})
async function fixture(body: string, host: Partial<FunctionSessionHost> = {}) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${body}}}`)
  const session = new FunctionSession(
    [
      {
        name: "presentation",
        root: "/presentation",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/workspace",
      threadId: "thread",
      assertLive: () => undefined,
      publish: async (value) => value,
      ...host
    }
  )
  sessions.push(session)
  await session.start()
  return session
}
const signal = () => new AbortController().signal
const description = {
  tool: "inspect",
  description: "original",
  provider: { plugin: "engine", tier: "core" }
}

it("rejects a forged next identity before a downstream hook can observe it", async () => {
  const session = await fixture(`
    on("tool.describe",async($,e,next)=>{
      try { await next({...e,provider:{plugin:"fake",tier:"core"}});return {description:"forged"} }
      catch(error){return {description:String(error)}}
    });
    on("tool.describe",{tool:"inspect"},async()=>({description:"downstream saw it"}));
    on("skill.prompt",async($,e,next)=>{
      try { await next({...e,skill:"fake"});return {text:"forged"} }
      catch(error){return {text:String(error)}}
    });
  `)
  expect((await session.presentationEvent("tool.describe", description, signal())).description)
    .toContain("MODS_PINNED_INPUT")
  expect((await session.presentationEvent("skill.prompt", {skill:"review",text:"body"}, signal())).text)
    .toContain("MODS_PINNED_INPUT")
})

it("expands full Skill text and caches tool descriptions until explicit invalidation", async () => {
  const session = await fixture(`
    let count=0;
    on("session.start",async($,e,next)=>{await $.command.register({name:"invalidate",description:"Invalidate"});return next(e)});
    on("command.run",async($)=>{await $.ui.invalidate("tool.describe");return {text:"ok"}});
    on("skill.prompt",async($,e)=>({...e,text:e.text+"\\nexpanded"}));
    on("tool.describe",async($,e)=>({...e,description:e.description+":"+(++count)}));
  `)
  expect(
    await session.presentationEvent(
      "skill.prompt",
      { skill: "review", text: "whole\nbody" },
      signal()
    )
  ).toEqual({ text: "whole\nbody\nexpanded" })
  expect(await session.presentationEvent("tool.describe", description, signal())).toEqual({
    description: "original:1"
  })
  expect(await session.presentationEvent("tool.describe", description, signal())).toEqual({
    description: "original:1"
  })
  await session.run("invalidate", "")
  expect(await session.presentationEvent("tool.describe", description, signal())).toEqual({
    description: "original:2"
  })
})

it("rejects identity/schema changes and preserves a placement override", async () => {
  expect(() =>
    validatePresentationResult("tool.describe", { ...description, tool: "execute" }, description)
  ).toThrow("MODS_PRESENTATION_IDENTITY")
  expect(() =>
    validatePresentationResult("tool.describe", { description: "x", schema: {} }, description)
  ).toThrow("MODS_TOOL_DESCRIPTION_RESULT")
  const session = await fixture(`on("tool.describe",async()=>({description:"x",isDeferred:true}));`)
  expect(await session.presentationEvent("tool.describe", description, signal())).toEqual({
    description: "x", isDeferred: true
  })
})

it("does not refill an invalidated cache with a description that was already in flight", async () => {
  let release: () => void = () => undefined
  let entered: () => void = () => undefined
  const pending = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  let reads = 0
  const session = await fixture(`
    let count=0;
    on("session.start",async($,e,next)=>{await $.command.register({name:"invalidate",description:"Invalidate"});return next(e)});
    on("command.run",async($)=>{await $.ui.invalidate("tool.describe");return {text:"ok"}});
    on("tool.describe",async($)=>{const n=++count;await $.session.model();return {description:String(n)}});
  `, {readSession:async()=>{if(++reads===1){entered();await pending}return "model"}})
  const first = session.presentationEvent("tool.describe", description, signal())
  await started
  await session.run("invalidate", "")
  release()
  expect(await first).toEqual({description:"1"})
  expect(await session.presentationEvent("tool.describe", description, signal())).toEqual({description:"2"})
})

it("routes prompt read/fill through operation hooks with a pinned origin and no submit", async () => {
  const calls: unknown[] = []
  let box = { text: "real draft", cursor: 3 }
  const session = await fixture(
    `
    on("session.start",async($,e,next)=>{await $.command.register({name:"draft",description:"Draft"});return next(e)});
    on("prompt.read",async($,e,next)=>{const out=await next(e);return {value:{...out.value,text:"hook draft",cursor:4}}});
    on("prompt.fill",async($,e,next)=>next({...e,text:e.text+"!"}));
    on("command.run",async($)=>{const draft=await $.prompt.read();return {text:JSON.stringify(await $.prompt.fill({text:draft.text,mode:"insert"}))}});
  `,
    {
      preparePromptFill: async () => {},
      peekPrompt: async () => box,
      prompt: async (_plugin, method, input) => {
        calls.push({ method, input })
        if (method === "prompt.read") return box
        box = { text: String(input.text), cursor: String(input.text).length }
        return { isFilled: true, ...box }
      }
    }
  )
  expect(JSON.parse(String((await session.run("draft", "")).text))).toEqual({
    isFilled: true,
    text: "hook draft!",
    cursor: 11
  })
  expect(calls).toEqual([
    { method: "prompt.read", input: {} },
    {
      method: "prompt.fill",
      input: {
        text: "hook draft!",
        mode: "insert",
        origin: { kind: "plugin", name: "presentation" }
      }
    }
  ])
})

it("rejects invalid prompt input before accessing the renderer", async () => {
  const prompt = vi.fn()
  const session = await fixture(
    `
    on("session.start",async($,e,next)=>{await $.command.register({name:"bad",description:"Bad"});return next(e)});
    on("command.run",async($)=>{try {await $.prompt.fill({text:"x",submit:true});return {text:"unexpected"}} catch(error){return {text:String(error)}}});
  `,
    { prompt }
  )
  expect(String((await session.run("bad", "")).text)).toContain("MODS_PROMPT_INPUT_INVALID")
  expect(prompt).not.toHaveBeenCalled()
})

it.each([`{isFilled:false,refusal:"no_composer"}`, `{isFilled:true}`])(
  "does not trust an invented fill result %s",
  async (result) => {
    const prompt = vi.fn()
    const session = await fixture(
      `
      on("session.start",async($,e,next)=>{await $.command.register({name:"fill",description:"Fill"});return next(e)});
      on("prompt.fill",()=>(${result}));
      on("command.run",async($)=>({text:JSON.stringify(await $.prompt.fill({text:"x"}))}));
    `,
      {
        prompt,
        preparePromptFill: async () => {},
        peekPrompt: async () => ({ text: "user draft", cursor: 4 })
      }
    )
    expect(JSON.parse(String((await session.run("fill", "")).text))).toEqual({
      isFilled: false,
      text: "user draft",
      cursor: 4
    })
    expect(prompt).not.toHaveBeenCalled()
  }
)

it("protects draft text before read after-hooks and keeps the protected cursor valid", async () => {
  const session = await fixture(`
    on("session.start",async($,e,next)=>{await $.command.register({name:"read",description:"Read"});return next(e)});
    on("prompt.read",async($,e,next)=>{
      const out=await next(e);
      if(out.value.text.includes("SECRET"))return {value:{text:"LEAK",cursor:0}};
      return out
    });
    on("command.run",async($)=>({text:JSON.stringify(await $.prompt.read())}));
  `, {prompt:async()=>({text:"SECRET draft",cursor:12}),publish:async value=>{
    if (value && !Array.isArray(value) && typeof value === "object" && value.text === "SECRET draft")
      return {...value,text:"safe"}
    return value
  }})
  expect(JSON.parse(String((await session.run("read", "")).text))).toEqual({text:"safe",cursor:4})
})
