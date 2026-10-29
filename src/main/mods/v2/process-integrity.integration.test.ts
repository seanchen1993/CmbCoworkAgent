import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { isModObject } from "../../../shared/mods/v2/contracts"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES, type FunctionSessionHost } from "./session"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
})
const argv = JSON.stringify([process.execPath, "-e", "process.stdout.write('native')"])
async function fixture(
  hooks = "",
  extra: Partial<FunctionSessionHost> = {},
  options = '{integrity:"native",stdin:"original",env:{FIRST:"a",SECOND:"b"},timeoutMs:30000}'
) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,event,next)=>{
      await $.command.register({name:"test",description:"Process integrity contract"});return next(event)
    });
    on("command.run",async($)=>await $.process.run(${argv},${options}));
    ${hooks}
  }}`)
  const authorize = vi.fn(async () => {})
  const effect = vi.fn<NonNullable<FunctionSessionHost["runEffect"]>>(
    async (_plugin, _method, _request, _signal, run) => run()
  )
  const session = new FunctionSession(
    [
      {
        name: "integrity-contract",
        root: "/plugin",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: process.cwd(),
      threadId: "process-integrity-contract",
      assertLive: vi.fn(),
      authorizeProcess: authorize,
      runEffect: effect,
      publish: async (value) => value,
      ...extra
    }
  )
  sessions.push(session)
  return { session, authorize, effect }
}

it("accepts observing middleware and equivalent normalization without exposing the integrity option", async () => {
  const f = await fixture(`on("process.run",async($,event,next)=>{
    if(Object.hasOwn(event.init,"integrity"))throw Error("private option leaked");
    return next({...event,init:{...event.init,cwd:"./",env:{SECOND:"b",FIRST:"a"}}})
  })`)
  expect(await f.session.run("test", "")).toEqual({ exitCode: 0, stdout: "native", stderr: "" })
  expect(f.authorize).toHaveBeenCalledOnce()
  expect(f.effect).toHaveBeenCalledOnce()
})

it("preserves default programmable short circuit behavior and rejects it for native integrity", async () => {
  const hook = 'on("process.run",async()=>({value:{exitCode:0,stdout:"replacement",stderr:""}}))'
  const ordinary = await fixture(hook, {}, "{}")
  expect(await ordinary.session.run("test", "")).toEqual({
    exitCode: 0,
    stdout: "replacement",
    stderr: ""
  })
  expect(ordinary.authorize).not.toHaveBeenCalled()
  const native = await fixture(hook)
  await expect(native.session.run("test", "")).rejects.toThrow("MODS_PROCESS_INTEGRITY")
  expect(native.authorize).not.toHaveBeenCalled()
  expect(native.effect).not.toHaveBeenCalled()
})

it.each([
  '{...event,argv:[...event.argv,"changed"]}',
  '{...event,init:{...event.init,stdin:"changed"}}',
  '{...event,init:{...event.init,env:{FIRST:"changed",SECOND:"b"}}}',
  `{...event,init:{...event.init,cwd:${JSON.stringify(tmpdir())}}}`,
  "{...event,init:{...event.init,timeoutMs:20000}}"
])("rejects changed normalized request before native authorization: %s", async (request) => {
  const f = await fixture(`on("process.run",async($,event,next)=>next(${request}))`)
  await expect(f.session.run("test", "")).rejects.toThrow("MODS_PROCESS_INTEGRITY")
  expect(f.authorize).not.toHaveBeenCalled()
})

it("rejects a second core even if middleware keeps the first original result", async () => {
  const f = await fixture(`on("process.run",async($,event,next)=>{
    const original=await next(event);try{await next(event)}catch{};return original
  })`)
  await expect(f.session.run("test", "")).rejects.toThrow("MODS_PROCESS_INTEGRITY")
  expect(f.authorize).toHaveBeenCalledOnce()
  expect(f.effect).toHaveBeenCalledOnce()
})

it("rejects repeated execution inside effect handling before a second authorization", async () => {
  const f = await fixture("", {
    runEffect: async (_plugin, _method, _request, _signal, run) => {
      const original = await run()
      try {
        await run()
      } catch {
        /* The integrity failure stays latched. */
      }
      return original
    }
  })
  await expect(f.session.run("test", "")).rejects.toThrow("MODS_PROCESS_INTEGRITY")
  expect(f.authorize).toHaveBeenCalledOnce()
})

it("rejects post-core middleware result changes", async () => {
  const f = await fixture(`on("process.run",async($,event,next)=>{
    const original=await next(event);return {...original,value:{...original.value,stdout:"replacement"}}
  })`)
  await expect(f.session.run("test", "")).rejects.toThrow("MODS_PROCESS_INTEGRITY")
  expect(f.authorize).toHaveBeenCalledOnce()
})

it.each(["raw", "dispatch"])(
  "rejects %s publication changes without exposing original output",
  async (phase) => {
    const f = await fixture("", {
      publish: async (value) => {
        if (phase === "raw" && isModObject(value) && Object.hasOwn(value, "exitCode"))
          return { ...value, stdout: "replacement" }
        if (
          phase === "dispatch" &&
          isModObject(value) &&
          isModObject(value.value) &&
          Object.hasOwn(value.value, "exitCode")
        )
          return { ...value, value: { ...value.value, stderr: "replacement" } }
        return value
      }
    })
    await expect(f.session.run("test", "")).rejects.toThrow("MODS_PROCESS_INTEGRITY")
    expect(f.authorize).toHaveBeenCalledOnce()
  }
)

it("does not accept host internal waits as native process execution", async () => {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,event,next)=>{
      await $.command.register({name:"test",description:"Internal wait integrity"});return next(event)
    });
    on("command.run",async($)=>await $.process.run(["sleep","0"],{integrity:"native"}))
  }}`)
  const authorize = vi.fn(async () => {})
  const session = new FunctionSession(
    [
      {
        name: "internal-wait",
        root: "/plugin",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: process.cwd(),
      threadId: "internal-wait",
      assertLive: vi.fn(),
      authorizeProcess: authorize,
      publish: async (value) => value
    }
  )
  sessions.push(session)
  await expect(session.run("test", "")).rejects.toThrow("MODS_PROCESS_INTEGRITY")
  expect(authorize).not.toHaveBeenCalled()
})
