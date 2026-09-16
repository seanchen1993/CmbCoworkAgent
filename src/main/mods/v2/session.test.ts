import { afterEach, expect, it } from "vitest"
import { resolve } from "node:path"
import { compileFunctionPlugin } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES, type FunctionSessionHost } from "./session"

const sessions: FunctionSession[] = []
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
    on("command.run",{command:"nested"},async($,e)=>$.command.run({command:e.command,args:"inner"}));
    on("command.run",{command:"nested"},($,e,next)=>({text:e.args+":"+next.origin.plugin}));
  `)
  expect(await value.run("nested", "outer")).toEqual({ text: "inner:demo" })
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
