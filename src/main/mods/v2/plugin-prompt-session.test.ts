import { afterEach, expect, it, vi } from "vitest"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionPluginPromptQueue } from "./plugin-prompt-queue"
import { FunctionSessionActivity } from "./session-activity"
import { FunctionSessionInitializer } from "./session-initializer"
import { trackFunctionGuest } from "./session-guest"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
const delay = () => new Promise((resolve) => setTimeout(resolve, 0))
function gate() {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}
async function fixture(hooks: string, initiallyBusy = true) {
  const child = gate(),
    source = gate(),
    native = gate()
  let busy = initiallyBusy,
    live = true
  const stores = new Map<string, ModJson>()
  const runs: Array<{ input: ModObject; start(): void }> = []
  const listeners = new Set<(id: string) => void>()
  const assertLive = () => {
    if (!live) throw Error("REAL_SCOPE_RETIRED")
  }
  const queue = new FunctionPluginPromptQueue({
    busy: () => busy,
    claim: () => ({ assertCurrent: assertLive, release: () => {} }),
    run: async (_, input, __, ___, signal, started) => {
      runs.push({ input, start: started })
      await Promise.race([
        native.wait,
        new Promise<void>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
      ])
    },
    onIdle: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  })
  const activity = new FunctionSessionActivity()
  const runtime = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    let replies=0,errors=0,last=null,captured;
    on("session.start",{},async($,e,next)=>{
      await $.command.register({name:"observe",description:"observe",immediate:true});return next(e)
    });
    on("command.run",{command:"observe"},()=>({text:JSON.stringify({replies,errors,last})}));
    ${hooks}
  }}`)
  const guest = trackFunctionGuest(runtime, activity, new FunctionSessionInitializer(false))
  const lifetime = new AbortController()
  const session = new FunctionSession(
    [
      {
        name: "actual",
        root: "/actual",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/project",
      threadId: "thread",
      activity,
      assertLive,
      publish: async (value) => value,
      reservePluginPrompt: (_, origin, signal) =>
        queue.reserve({
          workspace: "/project",
          threadId: "thread",
          origin,
          signal: AbortSignal.any([signal, lifetime.signal]),
          assertLive
        }),
      preparePluginPrompt: async (_, signal, assertAdmission, __, run) => {
        assertAdmission()
        signal.throwIfAborted()
        return run(assertAdmission)
      },
      state: () => ({
        get: async (key) => {
          if (key === "child-gate") await child.wait
          if (key === "source-gate") await source.wait
          return stores.get(key)
        },
        keys: async () => [...stores.keys()],
        set: async (key, value) => {
          assertLive()
          stores.set(key, value)
        },
        delete: (key) => {
          stores.delete(key)
        }
      })
    }
  )
  cleanup.push(async () => {
    child.release()
    source.release()
    native.release()
    queue.close()
    await session.close()
    activity.close()
  })
  const observe = async () => JSON.parse((await session.run("observe", "")).text as string)
  return {
    session,
    runtime,
    queue,
    runs,
    activity,
    stores,
    child,
    source,
    native,
    observe,
    idle: () => {
      busy = false
      listeners.forEach((listener) => listener("thread"))
    },
    retire: () => {
      live = false
      lifetime.abort(Error("REAL_SCOPE_RETIRED"))
    }
  }
}

it.each(["normal", "throw"])(
  "retains child dispatch after a %s source frame exits",
  async (mode) => {
    const f = await fixture(`
    on("ui.render",{component:"AbovePrompt"},async($,e,next)=>{
      $.prompt.submit({text:"child words"}).then(r=>{replies++;last=r},()=>{errors++});
      ${mode === "throw" ? 'throw Error("OPTIONAL_SOURCE_FAILED")' : "return next(e)"}
    });
    on("prompt.submit",async($,e,next)=>{
      await $.store.get("child-gate");return next({...e,context:["hidden"]})
    });
  `)
    await f.session.start()
    const owner = await f.session.sites.mount("AbovePrompt")
    await f.session.sites.render(owner, {
      isWorking: false,
      bodyColumns: 80,
      maxRows: 8,
      offset: 0
    })
    expect(f.queue.size).toBe(1)
    expect(f.runs).toHaveLength(0)
    expect((await f.observe()).replies).toBe(0)
    // The actual child Hook is foreground until its real finally.
    expect(f.activity.foregroundSize).toBeGreaterThan(0)
    f.child.release()
    await vi.waitFor(() => expect(f.activity.foregroundSize).toBe(0))
    expect((await f.observe()).replies).toBe(0)
    expect(f.activity.size).toBeGreaterThan(0)
    f.idle()
    await vi.waitFor(() => expect(f.runs).toHaveLength(1))
    expect(f.runs[0].input).toMatchObject({
      text: "child words",
      context: ["hidden"],
      origin: { kind: "plugin", name: "actual" },
      wait: false
    })
    expect((await f.observe()).replies).toBe(0)
    f.runs[0].start()
    await vi.waitFor(async () => expect((await f.observe()).replies).toBe(1))
    expect((await f.observe()).errors).toBe(0)
    f.native.release()
  }
)

it("submits void during real Session.start without starting a recursive partial session", async () => {
  const f = await fixture(
    `
    on("session.start",{},async($,e,next)=>{
      $.prompt.submit({text:"startup task"}).then(()=>{replies++},()=>{errors++});
      await $.store.get("source-gate");return next(e)
    });
  `,
    false
  )
  const starting = f.session.start()
  await vi.waitFor(() => expect(f.queue.size).toBe(1))
  await delay()
  expect(f.runs).toHaveLength(0)
  expect(f.session.hasCompletedStartup).toBe(false)
  f.source.release()
  await starting
  await vi.waitFor(() => expect(f.runs).toHaveLength(1))
  expect(f.session.hasCompletedStartup).toBe(true)
  f.runs[0].start()
  await vi.waitFor(async () => expect((await f.observe()).replies).toBe(1))
})

it("rechecks the current command source instead of trusting a captured render SDK", async () => {
  const f = await fixture(`
    on("ui.render",{component:"AbovePrompt"},($,e,next)=>{captured=$;return next(e)});
    on("session.start",{},async($,e,next)=>{
      await $.command.register({name:"captured",description:"captured",immediate:true});return next(e)
    });
    on("command.run",{command:"captured"},async()=>{
      try { await captured.prompt.submit({text:"must not run"}) } catch(e) {errors++;last=String(e)}
      return {text:"checked"}
    });
  `)
  await f.session.start()
  const owner = await f.session.sites.mount("AbovePrompt")
  await f.session.sites.render(owner, { isWorking: false, bodyColumns: 80, maxRows: 8, offset: 0 })
  await f.session.run("captured", "")
  expect(f.queue.size).toBe(0)
  expect(f.runs).toHaveLength(0)
  expect(await f.observe()).toMatchObject({ errors: 1, replies: 0 })
})

it("cancels a waiting SDK promise on real resident retirement and never runs its intent", async () => {
  const f = await fixture(`
    on("ui.render",{component:"AbovePrompt"},($,e,next)=>{
      $.prompt.submit({text:"retired task"}).then(()=>{replies++},()=>{errors++});return next(e)
    });
  `)
  await f.session.start()
  const owner = await f.session.sites.mount("AbovePrompt")
  await f.session.sites.render(owner, { isWorking: false, bodyColumns: 80, maxRows: 8, offset: 0 })
  expect(f.queue.size).toBe(1)
  f.retire()
  f.idle()
  await vi.waitFor(() => expect(f.queue.size).toBe(0))
  expect(f.runs).toHaveLength(0)
})
