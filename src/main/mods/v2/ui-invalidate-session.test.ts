import { afterEach, expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import type { ModJson } from "../../../shared/mods/types"

const sessions: FunctionSession[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
})
async function fixture(hook: string, beforeGet?: (key: string) => Promise<void>) {
  let live = true
  const state = new Map<string, ModJson>()
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    let draws=0;
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"open",description:"Open"});
      await $.command.register({name:"redraw",description:"Redraw"});return next(e)
    });
    on("command.run",{command:"open"},async($)=>{await $.ui.open({id:"board"});return {}});
    on("command.run",{command:"redraw"},($,e)=>{
      const result=e.args==="extra-args"?$.ui.invalidate("ui.render",true):$.ui.invalidate(e.args||"ui.render");
      if(result!==undefined)throw Error("SDK_NOT_VOID");return {text:"redraw requested"}
    });
    on("ui.render",{component:"Pane"},($,e)=>$.ui.resolve(e).Text({children:[String(++draws)]}));
    ${hook}
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "invalidate",
        root: "/plugin",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/project",
      threadId: "thread",
      assertLive() {
        if (!live) throw Error("revoked")
      },
      publish: async (value) => value,
      state: () => ({
        get: async (key) => {
          await beforeGet?.(key)
          return state.get(key)
        },
        keys: async () => [...state.keys()],
        set: async (key, value) => {
          state.set(key, value)
        },
        delete: (key) => {
          state.delete(key)
        }
      })
    }
  )
  sessions.push(session)
  await session.run("open", "")
  const [initial] = await session.panes.snapshot()
  return {
    session,
    state,
    initial,
    revoke: () => {
      live = false
    }
  }
}
it("drains the void SDK through the actual invalidate operation hook", async () => {
  const f = await fixture(`on("ui.invalidate",async($,e,next)=>{
    await $.store.set("input",e);const result=await next(e);await $.store.set("after",true);return result
  });`)
  const owner = await f.session.sites.mount("PromptHint")
  const props = { isDraft: false, isWorking: false, hint: "ready" }
  const initialSite = await f.session.sites.render(owner, props)
  await f.session.run("redraw", "")
  expect((await f.session.sites.render(owner, props)).generation).not.toBe(initialSite.generation)
  expect(f.state.get("input")).toEqual({ event: "ui.render" })
  expect(f.state.get("after")).toBe(true)
  expect((await f.session.panes.snapshot())[0].generation).not.toBe(f.initial.generation)
})
it.each(["", "keep drawing"])(
  "honors a before-next deny %j without changing the drawing",
  async (deny) => {
    const f = await fixture(`on("ui.invalidate",()=>({deny:${JSON.stringify(deny)}}));`)
    await f.session.run("redraw", "")
    expect((await f.session.panes.snapshot())[0].generation).toBe(f.initial.generation)
  }
)
it("does not redraw while a delayed invalidation hook is cancelled", async () => {
  const f = await fixture(`on("ui.invalidate",async($,e,next)=>{
    await $.store.set("entered",true);await $.clock.sleep(5000);return next(e)
  });`)
  const controller = new AbortController()
  const result = f.session.run("redraw", "", controller.signal)
  const settled = result.then(
    (value) => ({ value }),
    (error) => ({ error })
  )
  try {
    await expect.poll(() => f.state.get("entered")).toBe(true)
  } finally {
    controller.abort()
    await settled
  }
  expect(await settled).toMatchObject({ error: expect.any(Error) })
  expect((await f.session.panes.snapshot())[0].generation).toBe(f.initial.generation)
})
it.each(["prompt.context", "extra-args"])(
  "rejects invalid SDK target/arguments %s before operation hooks",
  async (args) => {
    const f = await fixture(
      `on("ui.invalidate",async($,e,next)=>{await $.store.set("entered",true);return next(e)});`
    )
    await f.session.run("redraw", args)
    expect(f.state.has("entered")).toBe(false)
    expect((await f.session.panes.snapshot())[0].generation).toBe(f.initial.generation)
  }
)

it("does not recurse into the same registration when its hook calls the void SDK", async () => {
  const f = await fixture(`on("ui.invalidate",async($,e,next)=>{
    const count=await $.store.get("entered")||0;await $.store.set("entered",count+1);
    $.ui.invalidate("ui.render");return next(e)
  });`)
  await f.session.run("redraw", "")
  expect(f.state.get("entered")).toBe(1)
  expect((await f.session.panes.snapshot())[0].generation).not.toBe(f.initial.generation)
})
it("does not roll back a real invalidation when a hook denies after next", async () => {
  const f = await fixture(`on("ui.invalidate",async($,e,next)=>{
    await next(e);await $.store.set("after",true);return {deny:"late veto"}
  });`)
  await f.session.run("redraw", "")
  expect(f.state.get("after")).toBe(true)
  expect((await f.session.panes.snapshot())[0].generation).not.toBe(f.initial.generation)
})
it("rejects a rewritten unsupported target before the invalidation core", async () => {
  const f = await fixture(`on("ui.invalidate",async($,e,next)=>{
    await $.store.set("entered",true);return next({event:"prompt.context"})
  });`)
  await f.session.run("redraw", "")
  expect(f.state.get("entered")).toBe(true)
  expect((await f.session.panes.snapshot())[0].generation).toBe(f.initial.generation)
})
it("recovers an invalid non-void optional hook through the original core", async () => {
  const f = await fixture(`on("ui.invalidate",async($,e,next)=>{
    await $.store.set("entered",true);return "not a void result"
  });`)
  await f.session.run("redraw", "")
  expect(f.state.get("entered")).toBe(true)
  expect((await f.session.panes.snapshot())[0].generation).not.toBe(f.initial.generation)
})

it("closing the real session cancels a delayed operation before either drawing registry changes", async () => {
  const f = await fixture(`on("ui.invalidate",async($,e,next)=>{
    await $.store.set("entered",true);await $.clock.sleep(5000);return next(e)
  });`)
  const panes = vi.spyOn(f.session.panes, "invalidate")
  const sites = vi.spyOn(f.session.sites, "invalidate")
  const settled = f.session.run("redraw", "").then(
    (value) => ({ value }),
    (error) => ({ error })
  )
  try {
    await expect.poll(() => f.state.get("entered")).toBe(true)
  } finally {
    await f.session.close()
    await settled
  }
  expect(await settled).toMatchObject({ error: expect.any(Error) })
  expect(panes).not.toHaveBeenCalled()
  expect(sites).not.toHaveBeenCalled()
})

it("rechecks authority after the operation hook awaits a real SDK read", async () => {
  let release!: () => void
  let entered = false
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture(
    `on("ui.invalidate",async($,e,next)=>{
    await $.store.get("barrier");return next(e)
  });`,
    async (key) => {
      if (key === "barrier") {
        entered = true
        await barrier
      }
    }
  )
  const panes = vi.spyOn(f.session.panes, "invalidate")
  const sites = vi.spyOn(f.session.sites, "invalidate")
  const settled = f.session.run("redraw", "").then(
    (value) => ({ value }),
    (error) => ({ error })
  )
  try {
    await expect.poll(() => entered).toBe(true)
  } finally {
    f.revoke()
    release()
    await settled
  }
  expect(await settled).toMatchObject({ error: expect.any(Error) })
  expect(panes).not.toHaveBeenCalled()
  expect(sites).not.toHaveBeenCalled()
})

it("allows a valid void short-circuit without entering the invalidation core", async () => {
  const f = await fixture(
    `on("ui.invalidate",async($)=>{await $.store.set("entered",true);return {value:undefined}});`
  )
  await f.session.run("redraw", "")
  expect(f.state.get("entered")).toBe(true)
  expect((await f.session.panes.snapshot())[0].generation).toBe(f.initial.generation)
})

it("keeps the optional-hook recovery rule for a bare undefined result", async () => {
  const f = await fixture(`on("ui.invalidate",async($)=>{await $.store.set("entered",true)});`)
  await f.session.run("redraw", "")
  expect(f.state.get("entered")).toBe(true)
  expect((await f.session.panes.snapshot())[0].generation).not.toBe(f.initial.generation)
})
