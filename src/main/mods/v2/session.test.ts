import { afterEach, expect, it } from "vitest"
import { resolve } from "node:path"
import { compileFunctionPlugin } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES, type FunctionSessionHost } from "./session"
import { AsyncLocalStorage } from "node:async_hooks"
import { ModError } from "../errors"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

const sessions: FunctionSession[] = []
it("runs the identical model SDK fixture with independent next results and local short circuits", async () => {
  const compiled = await compileFunctionPlugin(resolve("tests/fixtures/mods-v2/model-sdk"))
  const guest = await FunctionGuestRuntime.create(compiled.code, compiled.options)
  const calls: string[] = []
  const s = new FunctionSession(
    [
      {
        name: compiled.name,
        root: compiled.root,
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      threadId: "thread",
      workspace: "/project",
      assertLive: () => {},
      publish: async (v) => v,
      completeModel: async (_plugin, input) => {
        calls.push(String(input.prompt))
        return String(input.prompt)
      }
    }
  )
  sessions.push(s)
  expect((await s.run("model-probe", "input")).text).toBe("model-sdk:first:second")
  expect((await s.run("model-probe", "short")).text).toBe("local answer")
  expect(calls).toEqual(["first", "second"])
})

it("does not run denied model requests or fall back after a provider failure", async () => {
  let calls = 0
  const s = await session(
    `
    on("session.start", async ($,e,next) => {await $.command.register({name:"model",description:"Model"});return next(e)});
    on("command.run",{command:"model"},async($,e)=>{
      try{return {text:await $.model.complete({model:"chosen",prompt:e.args})}}
      catch(error){if(e.args==="denied")return {text:error.message};throw error}
    });
    on("model.complete",{prompt:"denied"},()=>({deny:"refused"}));
    on("model.complete",{prompt:"fail"},async($,e,next)=>{await next(e);return {value:"fake"}});
  `,
    {
      completeModel: async () => {
        calls++
        throw new ModFunctionError("MODS_MODEL_FAILED")
      }
    }
  )
  expect((await s.run("model", "denied")).text).toBe("refused")
  expect(calls).toBe(0)
  await expect(s.run("model", "fail")).rejects.toMatchObject({
    code: "MODS_MODEL_FAILED",
    downstream: true
  })
  expect(calls).toBe(1)
})
it("runs SDK tool hooks with pinned identity, independent next calls and retained host scope", async () => {
  const context = new AsyncLocalStorage<string>(),
    calls: unknown[] = []
  const s = await session(
    `
    on("session.start",async($,e,next)=>{await $.command.register({name:"tools",description:"Tools"});return next(e)});
    on("command.run",{command:"tools"},async($)=>{
      const result=await $.tool.call({tool:"read_file",file_path:"first",tool_use_id:"forged",agentId:"forged"});
      return {text:JSON.stringify(result)};
    });
    on("tool.call",{tool:"read_file"},async($,e,next)=>{
      await next({...e,file_path:"second"});
      const result=await next({...e,file_path:"third"});
      return {...result,context:[next.origin.plugin]};
    });
  `,
    {
      callTool: async (plugin, input) => {
        calls.push({ plugin: plugin.name, ...input, scope: context.getStore() })
        return { result: input.file_path, text: String(input.file_path) }
      }
    }
  )
  const result = await context.run("owned", () => s.run("tools", ""))
  expect(JSON.parse(String(result.text))).toEqual({
    result: "third",
    text: "third",
    context: ["demo"]
  })
  expect(calls).toHaveLength(2)
  for (const call of calls) {
    expect(call).toMatchObject({ plugin: "demo", tool: "read_file", scope: "owned" })
    expect(call).not.toHaveProperty("agentId")
    expect(call).not.toHaveProperty("tool_use_id", "forged")
  }
})

it("lets a tool hook deny before core and preserves a host refusal without repeating execution", async () => {
  let calls = 0
  const s = await session(
    `
    on("session.start",async($,e,next)=>{await $.command.register({name:"tools",description:"Tools"});return next(e)});
    on("command.run",{command:"tools"},async($,e)=>{
      const result=await $.tool.call({tool:"read_file",file_path:e.args});return {text:JSON.stringify(result)};
    });
    on("tool.call",{file_path:"deny"},()=>({deny:"not allowed"}));
    on("tool.call",{file_path:"fail"},async($,e,next)=>{await next(e);return {result:"fake"}});
  `,
    {
      callTool: async () => {
        calls++
        throw new ModError("MODS_USER_REJECTED")
      }
    }
  )
  expect(JSON.parse(String((await s.run("tools", "deny")).text))).toEqual({ deny: "not allowed" })
  expect(calls).toBe(0)
  await expect(s.run("tools", "fail")).rejects.toMatchObject({
    code: "MODS_USER_REJECTED",
    downstream: true
  })
  expect(calls).toBe(1)
})
async function session(
  body: string,
  host: Partial<FunctionSessionHost> = {},
  extras: string[] = []
) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${body}}}`)
  const result = new FunctionSession(
    [
      {
        name: "demo",
        root: "/demo",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES, ...extras]
      }
    ],
    {
      threadId: "thread",
      workspace: "/project",
      assertLive: () => undefined,
      publish: async (value) => value,
      ...host
    }
  )
  sessions.push(result)
  return result
}
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()))
})

it("registers direct commands once and preserves module state across invocations", async () => {
  const value = await session(`let starts=0,count=0;
    on("session.start",async($,e,next)=>{starts++;await $.command.register({name:"hello",description:"Hello",argumentHint:"[name]"});return next(e)});
    on("command.run",{command:"hello"},async($,e)=>({text:[starts,++count,await $.session.id(),e.args].join(":")}));
  `)
  await Promise.all([value.start(), value.start()])
  expect(await value.commands()).toEqual([
    {
      name: "hello",
      description: "Hello",
      argumentHint: "[name]",
      plugin: "demo"
    }
  ])
  expect(await value.run("hello", "Alice")).toEqual({ text: "1:1:thread:Alice" })
  expect(await value.run("hello", "Bob")).toEqual({ text: "1:2:thread:Bob" })
})

it("SDK-raised dispatch skips only the invoking hook, including other hooks in its plugin", async () => {
  const value = await session(`
    on("session.start",async($,e,next)=>{await $.command.register({name:"nested",description:"Nested"});return next(e)});
    on("session.id",async($)=>({value:await $.session.id()}));
    on("session.id",{},($,e,next)=>({value:next.origin.plugin}));
    on("command.run",{command:"nested"},async($)=>({text:await $.session.id()}));
  `)
  expect(await value.run("nested", "outer")).toEqual({ text: "demo" })
})

it("rejects command SDK waits through both direct and nested operation hooks", async () => {
  const compiled = await compileFunctionPlugin(resolve("tests/fixtures/mods-v2/command-held"))
  const guest = await FunctionGuestRuntime.create(compiled.code, compiled.options)
  const value = new FunctionSession(
    [
      {
        name: compiled.name,
        root: compiled.root,
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      threadId: "thread",
      workspace: "/project",
      assertLive: () => undefined,
      publish: async (v) => v
    }
  )
  sessions.push(value)
  expect(await value.run("held-probe", "")).toEqual({
    text: JSON.stringify({ direct: true, indirect: true, calls: 0 })
  })
})

it("runs mandatory publication for a short-circuited command", async () => {
  const value = await session(
    `
    on("session.start",async($,e,next)=>{await $.command.register({name:"secret",description:"Secret"});return next(e)});
    on("command.run",()=>({text:"secret-value"}));
  `,
    {
      publish: async (value) =>
        JSON.parse(JSON.stringify(value).replaceAll("secret-value", "[hidden]"))
    }
  )
  expect(await value.run("secret", "")).toEqual({ text: "[hidden]" })
})

it("rejects a changed scope before publishing the reply from a pending capability", async () => {
  let allowed = true
  let release!: () => void
  let entered!: () => void
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve
  })
  const value = await session(
    `
    on("session.start",async($,e,next)=>{await $.command.register({name:"wait",description:"Wait"});return next(e)});
    on("command.run",async($)=>({text:await $.probe.wait()}));
  `,
    {
      assertLive() {
        if (!allowed) throw Error("revoked")
      },
      async capability() {
        entered()
        await new Promise<void>((r) => {
          release = r
        })
        return "late"
      }
    },
    ["probe.wait"]
  )
  const pending = value.run("wait", "")
  const rejected = expect(pending).rejects.toThrow("revoked")
  await enteredPromise
  allowed = false
  release()
  await rejected
})

it("description hooks hide menu items without removing the direct command", async () => {
  const value = await session(`
    on("session.start",async($,e,next)=>{await $.command.register({name:"hidden",description:"Hidden"});return next(e)});
    on("command.describe",async($,e,next)=>({...await next(e),isHidden:true}));
    on("command.run",()=>({text:"still available"}));
  `)
  expect(await value.commands()).toEqual([])
  expect(await value.run("hidden", "")).toEqual({ text: "still available" })
})

it("shutdown cancels an ongoing clock wait and invalidates later operations", async () => {
  const value = await session(`
    on("session.start",async($,e,next)=>{await $.command.register({name:"wait",description:"Wait"});return next(e)});
    on("command.run",async($)=>{await $.clock.sleep(60000);return {text:"too late"}});
  `)
  await value.start()
  const pending = value.run("wait", "")
  const rejected = expect(pending).rejects.toThrow()
  await new Promise((r) => setImmediate(r))
  await value.close()
  await rejected
  await expect(value.run("wait", "")).rejects.toThrow()
})

it("invalid hook results fall through to the valid host contract", async () => {
  const value = await session(`
    on("session.start",async($,e,next)=>{await $.command.register({name:"hello",description:"Hello"});return next(e)});
    on("command.describe",()=>({description:42,isHidden:false}));
    on("command.run",()=>({text:42}));
    on("command.run",{},()=>({text:"valid"}));
  `)
  expect((await value.commands())[0].description).toBe("Hello")
  expect(await value.run("hello", "")).toEqual({ text: "valid" })
})

it("routes SDK calls through hooks with structured arguments and the caller origin", async () => {
  const value = await session(`
    let registered;
    on("session.start",async($,e,next)=>{
      registered=await $.command.register({name:"hello",description:"Hello"});
      return next(e)
    });
    on("command.register",async($,e,next)=>next({...e,description:e.description+" changed"}));
    on("session.id",async($,e,next)=>({value:next.origin.plugin+":"+(await next(e)).value}));
    on("clock.now",()=>({value:123}));
    on("command.run",async($)=>({text:JSON.stringify({registered,id:await $.session.id(),now:await $.clock.now(),list:await $.command.list()})}));
  `)
  expect(JSON.parse(String((await value.run("hello", "")).text))).toEqual({
    registered: { command: "hello" },
    id: "demo:thread",
    now: 123,
    list: [{ name: "hello", description: "Hello changed", source: "plugin", plugin: "demo" }]
  })
})

it("preserves undefined for void operations and skips only the invoking SDK hook", async () => {
  const value = await session(`
    let waits=0;
    on("session.start",async($,e,next)=>{await $.command.register({name:"hello",description:"Hello"});return next(e)});
    on("session.id",async($)=>({value:"nested:"+await $.session.id()}));
    on("session.id",{},async($,e,next)=>({value:"other:"+(await next(e)).value}));
    on("clock.sleep",async($,e,next)=>{waits++;if(e.ms!==25)throw Error("shape");return next({...e,ms:0})});
    on("command.run",async($)=>({text:[await $.session.id(),typeof await $.clock.sleep(25),waits].join("|")}));
  `)
  expect(await value.run("hello", "")).toEqual({ text: "nested:other:thread|undefined|1" })
})

it("a void hook can short-circuit its operation without falling through", async () => {
  const value = await session(`
    on("session.start",async($,e,next)=>{await $.command.register({name:"hello",description:"Hello"});return next(e)});
    on("clock.sleep",()=>({value:undefined}));
    on("command.run",async($)=>({text:typeof await $.clock.sleep(60000)}));
  `)
  expect(await value.run("hello", "")).toEqual({ text: "undefined" })
})

it("executes the identical SDK fixture used in Claude's plugin test against the CMB session", async () => {
  const compiled = await compileFunctionPlugin(resolve("tests/fixtures/mods-v2/basic-session"))
  const guest = await FunctionGuestRuntime.create(compiled.code, compiled.options)
  const value = new FunctionSession(
    [
      {
        name: compiled.name,
        root: compiled.root,
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      threadId: "thread",
      workspace: "/project",
      assertLive: () => undefined,
      publish: async (v) => v
    }
  )
  sessions.push(value)
  expect(JSON.parse(String((await value.run("sdk-probe", "")).text))).toEqual({
    registered: { command: "sdk-child" },
    description: "Child!",
    id: "nested:other:thread",
    now: 123,
    short: "undefined",
    next: "undefined"
  })
})
