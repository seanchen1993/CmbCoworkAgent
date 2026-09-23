import { afterEach, expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES, type FunctionSessionHost } from "./session"
import type { FunctionPlugin } from "./dispatcher"
import { compileFunctionPlugin } from "./loader"
import { resolve } from "node:path"

const sessions: FunctionSession[] = []
const guests: FunctionGuestRuntime[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
  guests.splice(0).forEach((guest) => guest.dispose())
})

async function plugin(name: string, source: string, capabilities = [...SESSION_CAPABILITIES]) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${source}}}`)
  guests.push(guest)
  return { name, root: `/${name}`, tier: "user" as const, guest, capabilities }
}

function session(plugins: FunctionPlugin[], extra: Partial<FunctionSessionHost> = {}) {
  const value = new FunctionSession(plugins, {
    threadId: "thread",
    workspace: "/project",
    assertLive: () => {},
    publish: async (value) => value,
    ...extra
  })
  sessions.push(value)
  return value
}

const consumer = `
  on("session.start",async($,e,next)=>{
    await $.command.register({name:"probe",description:"Probe"});return next(e)
  });
  on("command.run",{command:"probe"},async($,e)=>({text:await $.company.read({text:e.args})}));
`
const provider = `
  on("engine.create",async($,e,next)=>{
    if(Object.keys($).length)throw Error("engine table must be empty");
    const built=await next(e);
    return {...built,company:{read:async(input)=>input.text+":"+await built.session.id()}};
  });
`

it("builds one noun fold across isolated guests and applies operation middleware", async () => {
  const value = session([
    await plugin("consumer", consumer),
    await plugin("provider", provider),
    await plugin(
      "middleware",
      `on("company.read",async($,e,next)=>{
      const result=await next({...e,text:e.text+"!"});return {value:result.value+"?"}
    });`
    )
  ])
  expect(await value.run("probe", "hello")).toEqual({ text: "hello!:thread?" })
  expect(await value.run("probe", "again")).toEqual({ text: "again!:thread?" })
})

it("withholds a core noun from saved provider closures", async () => {
  const value = session([
    await plugin(
      "policy",
      `on("engine.create",async($,e,next)=>{
      const {session,...built}=await next(e);return built
    });`
    ),
    await plugin(
      "consumer",
      consumer.replace(
        "({text:await $.company.read({text:e.args})})",
        `{
      try{return {text:await $.company.read({text:e.args})}}catch(error){return {text:error.message}}
    }`
      )
    ),
    await plugin("provider", provider)
  ])
  expect((await value.run("probe", "hello")).text).toMatch(/MODS_CAPABILITY_DENIED/)
})

it("does not elevate a consumer through a provider's broader capabilities", async () => {
  const value = session([
    await plugin(
      "consumer",
      consumer.replace(
        "({text:await $.company.read({text:e.args})})",
        `{
          try{return {text:await $.company.read({text:e.args})}}catch(error){return {text:typeof $.session.id+":"+error.message}}
    }`
      ),
      SESSION_CAPABILITIES.filter((capability) => capability !== "session.id")
    ),
    await plugin("provider", provider)
  ])
  expect((await value.run("probe", "hello")).text).toMatch(/^undefined:MODS_CAPABILITY_DENIED/)
})

it("fails the build on noun replacement instead of silently keeping half a table", async () => {
  const value = session([
    await plugin(
      "replacement",
      `on("engine.create",async($,e,next)=>{
      const built=await next(e);return {...built,session:{id:async()=>"forged"}}
    });`
    ),
    await plugin("consumer", consumer),
    await plugin("provider", provider)
  ])
  await expect(value.start()).rejects.toThrow(/MODS_ENGINE_NOUN_REPLACED/)
  await expect(value.run("probe", "hello")).rejects.toThrow(/MODS_ENGINE_NOUN_REPLACED/)
})

it("rejects host operations while constructing the noun table", async () => {
  const value = session([
    await plugin(
      "eager",
      `on("engine.create",async($,e,next)=>{
      const built=await next(e);await built.session.id();return built
    });`
    )
  ])
  await expect(value.start()).rejects.toThrow(/MODS_ENGINE_BUILD_CALL/)
})

it("checks both consumer and provider liveness again before publication", async () => {
  let revoked = false
  const value = session([await plugin("consumer", consumer), await plugin("provider", provider)], {
    assertLive: (active) => {
      if (active?.name === "provider" && revoked) throw Error("provider revoked")
    }
  })
  expect((await value.run("probe", "before")).text).toBe("before:thread")
  revoked = true
  await expect(value.run("probe", "after")).rejects.toThrow(/provider revoked/)
})

it("cancels a delegated host call without cancelling another provider invocation", async () => {
  const releases: Array<() => void> = []
  const value = session(
    [
      await plugin("consumer", consumer),
      await plugin("provider", provider.replace("built.session.id()", "built.session.model()"))
    ],
    {
      readSession: async (_method, signal) =>
        new Promise((resolve, reject) => {
          releases.push(() => resolve("model"))
          signal.addEventListener("abort", () => reject(Error("cancelled")), { once: true })
        })
    }
  )
  const controller = new AbortController()
  const first = value.run("probe", "first", controller.signal)
  const rejected = expect(first).rejects.toThrow(/MODS_CANCELLED/)
  const second = value.run("probe", "second")
  await expect.poll(() => releases.length).toBe(2)
  controller.abort()
  await rejected
  releases.forEach((release) => release())
  expect((await second).text).toBe("second:model")
})

it("rejects closed-session handles and rebuilds a fresh provider table on restart", async () => {
  const first = session([await plugin("consumer", consumer), await plugin("provider", provider)])
  expect((await first.run("probe", "first")).text).toBe("first:thread")
  await first.close()
  await expect(first.run("probe", "closed")).rejects.toThrow(/MODS_SESSION_CLOSED/)
  const second = session([
    await plugin("consumer", consumer),
    await plugin("provider", provider.replace('input.text+":"', '"new:"+input.text+":"'))
  ])
  expect((await second.run("probe", "second")).text).toBe("new:second:thread")
})

it("rejects unsupported stream providers instead of publishing an empty JSON object", async () => {
  const value = session([
    await plugin("consumer", consumer),
    await plugin(
      "provider",
      `on("engine.create",async($,e,next)=>({
      ...await next(e),company:{read:async function*(){yield "not a plain value"}}
    }));`
    )
  ])
  await expect(value.run("probe", "stream")).rejects.toThrow(/MODS_ENGINE_STREAM_UNSUPPORTED/)
})

it("does not swallow provider failures or retry its completed side effects", async () => {
  const value = session([
    await plugin("consumer", consumer),
    await plugin(
      "provider",
      `let calls=0;on("engine.create",async($,e,next)=>({
      ...await next(e),company:{read:async()=>{calls++;throw Error("provider-failed:"+calls)}}
    }));`
    )
  ])
  await expect(value.run("probe", "failure")).rejects.toThrow(/provider-failed:1/)
  await expect(value.run("probe", "next invocation")).rejects.toThrow(/provider-failed:2/)
})

it("runs the installable provider/consumer fixtures with per-session provider state", async () => {
  const plugins: FunctionPlugin[] = []
  for (const name of ["engine-noun-consumer", "engine-noun-provider"]) {
    const compiled = await compileFunctionPlugin(resolve("tests/fixtures/mods-v2", name))
    const guest = await FunctionGuestRuntime.create(compiled.code, compiled.options)
    guests.push(guest)
    plugins.push({ ...compiled, guest, tier: "user", capabilities: [...SESSION_CAPABILITIES] })
  }
  const value = session(plugins)
  expect(await value.run("noun-identity", "fixture")).toEqual({
    text: "ENGINE_NOUN:fixture!?:thread:1"
  })
  expect(await value.run("noun-identity", "again")).toEqual({
    text: "ENGINE_NOUN:again!?:thread:2"
  })
})

it("uses the provider's state namespace while preserving consumer and provider origins", async () => {
  const owners: string[] = []
  const value = session(
    [
      await plugin("consumer", consumer),
      await plugin(
        "provider",
        provider.replace("built.session.id()", 'built.store.get("private")')
      ),
      await plugin(
        "observer",
        `
      on("company.read",async($,e,next)=>{
        const result=await next(e);return {value:next.origin.plugin+":"+result.value}
      });
      on("store.get",async($,e,next)=>{
        const result=await next(e);return {value:next.origin.plugin+":"+result.value}
      });
    `
      )
    ],
    {
      state: (owner) => ({
        get: async () => {
          owners.push(owner.name)
          return "state"
        },
        set: async () => {},
        delete: () => {},
        keys: async () => []
      })
    }
  )
  expect((await value.run("probe", "input")).text).toBe("consumer:input:provider:state")
  expect(owners).toEqual(["provider"])
})
