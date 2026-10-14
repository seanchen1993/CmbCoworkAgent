import { afterEach, expect, it } from "vitest"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionGuestRuntime } from "./guest-runtime"
import type { ModObject } from "../../../shared/mods/types"
import type { ModJson } from "../../../shared/mods/types"
import { ModRuntimeAuthorities } from "../runtime-instance"
import { withFunctionAgentExecution } from "./host-call"

const sessions: FunctionSession[] = []
const owners: ModRuntimeAuthorities[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()))
  for (const owner of owners.splice(0)) owner.close()
})
const facts: ModObject = {
  model: "model",
  promptModel: "model",
  tools: ["read_file"],
  surfaces: ["desktop"],
  outputStyle: null,
  traits: []
}
const original: ModObject = { sections: [{ id: "core", text: "original", scope: "session" }] }
async function fixture(body: string, publish = async (value: ModJson): Promise<ModJson> => value) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${body}}}`)
  const session = new FunctionSession(
    [
      {
        name: "compose",
        root: "/compose",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/workspace",
      threadId: "thread",
      assertLive: () => {},
      publish
    }
  )
  sessions.push(session)
  await session.start()
  const ownersForSession = new ModRuntimeAuthorities()
  owners.push(ownersForSession)
  const { authority } = ownersForSession.create({
    workspace: "/workspace",
    threadId: "thread",
    turnId: "actual-turn",
    agentId: "main"
  })
  const inOwnerScope = <T>(run: () => Promise<T>) =>
    withFunctionAgentExecution(
      {
        workspace: authority.workspace,
        threadId: authority.threadId,
        turnId: authority.turnId,
        agentId: authority.agentId,
        runtimeAuthority: authority,
        userInitiated: false,
        leased: false,
        immediate: false
      },
      run
    )
  const compose = session.promptComposition.bind(session)
  session.promptComposition = (...args) => inOwnerScope(() => compose(...args))
  const run = session.run.bind(session)
  session.run = (...args) => inOwnerScope(() => run(...args))
  return session
}

it.each([
  `{sections:[{id:"s",text:"s",scope:"session"},{id:"h",text:"h",scope:"shared"}]}`,
  `{sections:[{id:"x",text:"a",scope:"session"},{id:"x",text:"b",scope:"session"}]}`,
  `{sections:[{id:"",text:"a",scope:"session"}]}`,
  `{sections:[{id:"x",text:"a",scope:"fake"}]}`,
  `{value:{sections:[]}}`
])("skips an invalid Hook without duplicating its downstream composition: %s", async (invalid) => {
  const session = await fixture(`
    on("prompt.compose",async($,e,next)=>{await next(e);return ${invalid}});
    on("prompt.compose",{model:"model"},async($,e,next)=>next(e));
  `)
  let calls = 0
  expect(
    await session.promptComposition(
      "prompt.compose",
      facts,
      new AbortController().signal,
      async () => {
        calls++
        return original
      }
    )
  ).toEqual(original)
  expect(calls).toBe(1)
})

it("SDK composition skips its current frame, retains other same-plugin Hooks, and returns direct sections", async () => {
  const session = await fixture(`
    on("prompt.compose",async($,e)=>$.prompt.compose());
    on("prompt.compose",{model:"model"},async($,e,next)=>{const out=await next(e);
      return {sections:[...out.sections,{id:"compose:tail",text:e.tools.join(","),scope:"session"}]}});
  `)
  let calls = 0
  const out = await session.promptComposition(
    "prompt.compose",
    facts,
    new AbortController().signal,
    async () => {
      calls++
      return original
    }
  )
  expect(out.sections).toEqual([
    ...(original.sections as ModObject[]),
    {
      id: "compose:tail",
      text: "read_file",
      scope: "session"
    }
  ])
  expect(calls).toBe(1)
})

it("section may omit text, while a next call cannot forge the section name or model", async () => {
  const session = await fixture(`
    on("prompt.section",async()=>({text:null}));
    on("prompt.compose",async($,e,next)=>next({...e,model:"forged"}));
  `)
  expect(
    await session.promptComposition(
      "prompt.section",
      { name: "core", text: "body" },
      new AbortController().signal,
      async (e) => ({ text: e.text })
    )
  ).toEqual({ text: null })
  expect(
    await session.promptComposition(
      "prompt.compose",
      facts,
      new AbortController().signal,
      async () => original
    )
  ).toEqual(original)
})

it("protects section text before guest reads it and protects direct Hook replacement again", async () => {
  const session = await fixture(
    `on("prompt.section",async($,e)=>({text:e.text+" secret"}));`,
    async (value) => JSON.parse(JSON.stringify(value).replaceAll("secret", "[redacted]"))
  )
  expect(
    await session.promptComposition(
      "prompt.section",
      { name: "core", text: "secret" },
      new AbortController().signal,
      async (e) => ({ text: e.text })
    )
  ).toEqual({ text: "[redacted] [redacted]" })
})

it("does not fallback to original text after a host authority failure or cancellation", async () => {
  const session = await fixture(`on("prompt.compose",async($,e,next)=>next(e));`)
  await expect(
    session.promptComposition("prompt.compose", facts, new AbortController().signal, async () => {
      throw Error("authority expired")
    })
  ).rejects.toThrow("authority expired")
  const abort = new AbortController()
  abort.abort()
  await expect(
    session.promptComposition("prompt.compose", facts, abort.signal, async () => original)
  ).rejects.toThrow()
})

it("SDK cannot invent a host request before any actual composition is bound", async () => {
  const session = await fixture(`
    on("session.start",async($,e,next)=>{await $.command.register({name:"inspect",description:"Inspect"});return next(e)});
    on("command.run",async($)=>{try{await $.prompt.compose();return {text:"wrong"}}
      catch(error){return {text:String(error)}}});
  `)
  expect((await session.run("inspect", "")).text).toContain("MODS_PROMPT_COMPOSE_UNAVAILABLE")
})

it("protects a downstream replacement before an upstream guest reads next", async () => {
  const session = await fixture(
    `
    on("prompt.compose",async($,e,next)=>{const out=await next(e);
      return {sections:[{id:"seen",text:out.sections[0].text.includes("secret")?"LEAK":"safe",scope:"session"}]}});
    on("prompt.compose",{model:"model"},async()=>({sections:[{id:"tail",text:"secret",scope:"session"}]}));
  `,
    async (value) => JSON.parse(JSON.stringify(value).replaceAll("secret", "[redacted]"))
  )
  expect(
    await session.promptComposition(
      "prompt.compose",
      facts,
      new AbortController().signal,
      async () => original
    )
  ).toEqual({ sections: [{ id: "seen", text: "safe", scope: "session" }] })
})

it("does not mask an unawaited downstream authority failure with a legal Hook answer", async () => {
  const session = await fixture(
    `on("prompt.compose",async($,e,next)=>{next(e);return {sections:[]}});`
  )
  await expect(
    session.promptComposition("prompt.compose", facts, new AbortController().signal, async () => {
      throw Error("authority expired")
    })
  ).rejects.toThrow("authority expired")
})

it("SDK cannot substitute a different model for the bound provider", async () => {
  const session = await fixture(`on("prompt.compose",async($,e,next)=>{
    try {await $.prompt.compose({model:"forged"});return {sections:[]}}
    catch(error){return {sections:[{id:"error",text:String(error),scope:"session"}]}}
  });`)
  const out = await session.promptComposition(
    "prompt.compose",
    facts,
    new AbortController().signal,
    async () => original
  )
  expect(JSON.stringify(out)).toContain("MODS_PROMPT_COMPOSE_MODEL_UNSUPPORTED")
})
