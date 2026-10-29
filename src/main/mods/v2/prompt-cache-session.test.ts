import { afterEach, expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { ModRuntimeAuthorities, type ModRuntimeAuthority } from "../runtime-instance"
import { withFunctionAgentExecution } from "./host-call"
import { bindHostPromptOccurrence } from "./prompt-cache"
import type { ModObject } from "../../../shared/mods/types"
import type { FunctionPromptCore } from "../../../shared/mods/v2/prompt-composition"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const input: ModObject = {
  blocks: [{ name: "claudeMd", text: "NATIVE" }],
  instructionFiles: [{ path: "/p/AGENTS.md", kind: "project", content: "NATIVE" }]
}
function within<T>(authority: ModRuntimeAuthority, run: () => Promise<T>) {
  return withFunctionAgentExecution(
    {
      workspace: "/p",
      threadId: "t",
      turnId: authority.turnId,
      agentId: authority.agentId,
      runtimeAuthority: authority,
      userInitiated: false,
      leased: false,
      immediate: false
    },
    run
  )
}
async function fixture(body = "", hooks?: string, protect?: (value: ModObject) => ModObject) {
  const registry = new ModRuntimeAuthorities()
  cleanups.push(() => registry.close())
  const { authority } = registry.create({
    workspace: "/p",
    threadId: "t",
    turnId: "turn",
    agentId: "main"
  })
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    let count=0;
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"cache",description:"Cache test"});return next(e)
    });
    on("command.run",{command:"cache"},async($,e)=>{
      if(e.args==="invalidate"){$.ui.invalidate("prompt.context");return {text:"invalidated"}}
      if(e.args==="sdk")return {text:JSON.stringify(await $.prompt.context({blocks:[{name:"claudeMd",text:"SDK"}]}))};
      if(e.args==="attachment")return {text:JSON.stringify(await $.prompt.attachment({type:"file",text:"SDK",origin:{kind:"engine"},agentId:"claimed"}))};
      if(e.args==="bad-detail")try{await $.prompt.attachment({type:"file",text:"SDK",origin:{kind:"engine"},detail:{claimed:true}});return {text:"accepted"}}catch(error){return {text:String(error)}};
      if(e.args==="invalidate-attachment"){$.ui.invalidate("prompt.attachment");return {text:"invalidated"}}
      if(e.args==="plan-unknown")return {text:JSON.stringify(await $.prompt.attachment({type:"plan_mode_exit",text:"SDK",origin:{kind:"engine"}}))};
      if(e.args==="bad-plan")try{await $.prompt.attachment({type:"plan_mode_exit",text:"SDK",origin:{kind:"engine"},detail:{}});return {text:"accepted"}}catch(error){return {text:String(error)}};
      return {text:"unused"}
    });
    ${
      hooks ??
      `on("prompt.context",async($,e,next)=>{
      const number=++count;const out=await next(e);
      return {...out,blocks:[{name:"count",text:String(number)},...out.blocks]}
    });`
    }
    on("prompt.attachment",async($,e,next)=>{await next(e);return {text:null}});
    ${body}
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "cache",
        root: "/cache",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/p",
      threadId: "t",
      assertLive() {
        /* The fixture checks its real owner separately. */
      },
      publish: async (value) =>
        protect ? protect(structuredClone(value) as ModObject) : structuredClone(value)
    }
  )
  cleanups.push(() => session.close())
  await session.start()
  const request = (
    source: object,
    core: FunctionPromptCore = async (input) => input,
    signal = new AbortController().signal,
    owner = authority
  ) =>
    within(owner, () =>
      session.promptComposition(
        "prompt.context",
        input,
        signal,
        bindHostPromptOccurrence(core, "prompt.context", source)
      )
    )
  const command = (text: string) => within(authority, () => session.run("cache", text))
  return { session, registry, authority, request, command }
}
const count = (output: ModObject) =>
  (output.blocks as ModObject[]).find((block) => block.name === "count")?.text

it("reuses settled results, supports explicit SDK calculation, and invalidates through real core", async () => {
  const f = await fixture()
  const source = {}
  expect(count(await f.request(source))).toBe("1")
  expect(count(await f.request(source))).toBe("1")
  expect((await f.command("sdk")).text).toContain('"text":"2"')
  expect(count(await f.request(source))).toBe("1")
  await f.command("invalidate")
  expect(count(await f.request(source))).toBe("3")
  expect((await f.command("attachment")).text).toBe('{"text":null}')
  expect((await f.command("bad-detail")).text).toContain("MODS_PROMPT_ATTACHMENT_DETAIL")
  expect((await f.command("plan-unknown")).text).toBe('{"text":null}')
  expect((await f.command("bad-plan")).text).toContain("MODS_PROMPT_ATTACHMENT_DETAIL")
})

it("different source and different actual owner cannot borrow the same text's result", async () => {
  const f = await fixture()
  const source = {}
  expect(count(await f.request(source))).toBe("1")
  expect(count(await f.request({}))).toBe("2")
  const { authority } = f.registry.create({
    workspace: "/p",
    threadId: "t",
    turnId: "child",
    agentId: "actual-child"
  })
  expect(count(await f.request(source, undefined, undefined, authority))).toBe("3")
})

it("a late pre-invalidation request cannot fill the next generation", async () => {
  const f = await fixture()
  const source = {}
  let entered!: () => void
  let finish!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  const old = f.request(source, async (input) => {
    entered()
    await gate
    return input
  })
  await started
  await f.command("invalidate")
  expect(count(await f.request(source))).toBe("2")
  finish()
  expect(count(await old)).toBe("1")
  expect(count(await f.request(source))).toBe("2")
})

it("parallel computations retain independent cancellation and never share a pending promise", async () => {
  const f = await fixture()
  const source = {}
  const controller = new AbortController()
  let entered!: () => void
  let finish!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  const first = f.request(
    source,
    async (input) => {
      entered()
      await gate
      return input
    },
    controller.signal
  )
  const rejected = expect(first).rejects.toThrow()
  await started
  const second = await f.request(source)
  controller.abort()
  finish()
  await rejected
  expect(count(second)).toBe("2")
  expect(count(await f.request(source))).toBe("2")
})

it("SDK re-entry skips only its current registration and retains same-plugin neighbors", async () => {
  const f = await fixture(
    "",
    `
    on("prompt.context",async($,e,next)=>{
      const calculated=await $.prompt.context({blocks:[{name:"sdk",text:"SDK"}]});
      const out=await next(e);
      return {...out,blocks:[{name:"calculated",text:JSON.stringify(calculated)},...out.blocks]}
    });
    on("prompt.context",{},async($,e,next)=>{
      const out=await next(e);return {...out,blocks:[{name:"neighbor",text:"KEPT"},...out.blocks]}
    });`
  )
  const result = await f.request({})
  const calculated = (result.blocks as ModObject[]).find((block) => block.name === "calculated")!
  expect(JSON.parse(calculated.text as string)).toEqual({
    blocks: [
      { name: "neighbor", text: "KEPT" },
      { name: "sdk", text: "SDK" }
    ]
  })
})

it("SDK input cannot mint a private host occurrence", async () => {
  const f = await fixture()
  // Extra fields are never accepted as private source metadata.
  await expect(
    within(f.authority, () =>
      f.session.promptComposition(
        "prompt.context",
        { ...input, occurrence: "fake" },
        new AbortController().signal,
        async (input) => input
      )
    )
  ).rejects.toThrow(/MODS_PROMPT_CONTEXT_INVALID/)
})

it("cached deletion bypasses neither invalidation nor its actual native core", async () => {
  const f = await fixture()
  const source = {}
  let cores = 0
  const request = () =>
    within(f.authority, () =>
      f.session.promptComposition(
        "prompt.attachment",
        { type: "file", text: "NATIVE", origin: { kind: "engine" } },
        new AbortController().signal,
        bindHostPromptOccurrence(
          async () => {
            cores++
            return { text: "NATIVE" }
          },
          "prompt.attachment",
          source
        )
      )
    )
  expect(await request()).toEqual({ text: null })
  expect(await request()).toEqual({ text: null })
  expect(cores).toBe(1)
  await f.command("invalidate-attachment")
  expect(await request()).toEqual({ text: null })
  expect(cores).toBe(2)
})

it.each([false, true])(
  "invalidation executes only the actual rewritten target (late deny %s)",
  async (lateDeny) => {
    const f = await fixture(`on("ui.invalidate",async($,e,next)=>{
    const out=await next({...e,event:"prompt.attachment"});
    return ${lateDeny ? '{deny:"too late"}' : "out"}
  });`)
    const source = {}
    let cores = 0
    const attachment = () =>
      within(f.authority, () =>
        f.session.promptComposition(
          "prompt.attachment",
          { type: "file", text: "NATIVE", origin: { kind: "engine" } },
          new AbortController().signal,
          bindHostPromptOccurrence(
            async () => {
              cores++
              return { text: "NATIVE" }
            },
            "prompt.attachment",
            source
          )
        )
      )
    expect(count(await f.request(source))).toBe("1")
    await attachment()
    if (lateDeny) await expect(f.command("invalidate")).rejects.toThrow("MODS_COMMAND_UNHANDLED")
    else await f.command("invalidate")
    expect(count(await f.request(source))).toBe("1")
    await attachment()
    expect(cores).toBe(2)
  }
)

it("cached results are republished and recheck cancellation, revocation, and closure", async () => {
  let redact = false
  const f = await fixture("", undefined, (value) =>
    JSON.parse(JSON.stringify(value).replaceAll(redact ? "NATIVE" : "never-match", "REDACTED"))
  )
  const source = {}
  expect(count(await f.request(source))).toBe("1")
  redact = true
  const result = await f.request(source)
  expect(JSON.stringify(result)).not.toContain("NATIVE")
  // Publication can change the input: the old result cannot claim this new occurrence.
  expect(count(result)).toBe("2")
  const controller = new AbortController()
  controller.abort()
  await expect(f.request(source, undefined, controller.signal)).rejects.toThrow()
  f.registry.closeThread("t")
  await expect(f.request(source)).rejects.toThrow()
  await f.session.close()
  await expect(f.request({})).rejects.toThrow()
})

it("an actual cache hit republishes result-only protected content without rerunning the hook", async () => {
  let redact = false
  const f = await fixture("", `on("prompt.context",async($,e,next)=>{
    const out=await next(e);return {...out,blocks:[{name:"secret",text:"DERIVED_SECRET"},...out.blocks]}
  });`, value => {
    if (redact && Array.isArray(value.blocks))
      value.blocks = value.blocks.map(block => typeof block === "object" && block !== null &&
        !Array.isArray(block) && block.text === "DERIVED_SECRET" ? { ...block, text: "REDACTED" } : block)
    return value
  })
  const source = {}
  expect(JSON.stringify(await f.request(source))).toContain("DERIVED_SECRET")
  redact = true
  const result = await f.request(source, async () => { throw Error("CACHE_MISSED") })
  expect(JSON.stringify(result)).toContain("REDACTED")
  expect(JSON.stringify(result)).not.toContain("DERIVED_SECRET")
})

it.each(["cancel", "revoke"])("a %s during cached publication cannot publish", async mode => {
  let barrier = false
  const controller = new AbortController()
  let stop = () => { /* Assigned after the actual fixture owner is created. */ }
  const f = await fixture("", undefined, value => {
    if (barrier && Array.isArray(value.blocks) && value.blocks.some(block =>
      typeof block === "object" && block !== null && !Array.isArray(block) && block.name === "count")) stop()
    return value
  })
  stop = () => { if (mode === "cancel") controller.abort(); else f.registry.close() }
  const source = {}
  expect(count(await f.request(source))).toBe("1")
  barrier = true
  await expect(f.request(source, async () => { throw Error("CACHE_MISSED") }, controller.signal))
    .rejects.toThrow(mode === "cancel" ? /abort/i : /MODS_RUNTIME_INSTANCE_EXPIRED/)
})
