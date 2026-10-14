import { expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionSessionInitializer } from "./session-initializer"
import { trackFunctionGuest } from "./session-guest"
import { FunctionSessionActivity } from "./session-activity"

it("keeps a held startup redraw private after activation, then permits a fresh active redraw", async () => {
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>()
  const initializer = new FunctionSessionInitializer(true)
  const uiChanged = vi.fn(),
    configChanged = vi.fn()
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"redraw",description:"redraw"});
      await $.session.usage(); await $.ui.invalidate("ui.render");return next(e)
    });
    on("command.run",{command:"redraw"},async($)=>{
      await $.ui.invalidate("ui.render");return {text:"redrawn"}
    });
    on("ui.invalidate",async($,e,next)=>next({...e,event:"config.describe"}));
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "candidate",
        root: "/candidate",
        tier: "user",
        capabilities: [...SESSION_CAPABILITIES],
        guest
      }
    ],
    {
      threadId: "thread",
      workspace: "/workspace",
      initializer,
      uiChanged,
      configChanged,
      assertLive: () => {},
      publish: async (value) => value,
      readSession: async () => {
        entered.resolve()
        await resume.promise
        return { context: { window: 1000 }, rateLimits: [] }
      }
    }
  )
  try {
    const pending = session.start()
    await entered.promise
    const held = initializer.captureAdmission()
    initializer.activate()
    expect(held.candidate).toBe(true)
    expect(initializer.captureAdmission().candidate).toBe(false)
    resume.resolve()
    await pending
    expect(uiChanged).not.toHaveBeenCalled()
    expect(configChanged).not.toHaveBeenCalled()
    // Middleware must still work for a fresh active command; only the candidate call was isolated.
    await session.run("redraw", "")
    expect(configChanged).toHaveBeenCalledOnce()
  } finally {
    resume.resolve()
    await session.close()
  }
})

it.each(["config.describe", "tool.describe", "prompt.context", "prompt.attachment"])(
  "does not admit candidate invalidation of %s",
  async (target) => {
    const initializer = new FunctionSessionInitializer(true)
    const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
      on("session.start",async($,e,next)=>{await $.ui.invalidate(${JSON.stringify(target)});return next(e)})
    }}`)
    const changed = vi.fn()
    const session = new FunctionSession(
      [
        {
          name: "candidate",
          root: "/candidate",
          tier: "user",
          capabilities: [...SESSION_CAPABILITIES],
          guest
        }
      ],
      {
        threadId: "thread",
        workspace: "/workspace",
        initializer,
        uiChanged: changed,
        configChanged: changed,
        assertLive: () => {},
        publish: async (value) => value
      }
    )
    try {
      await expect(session.start()).rejects.toThrow("MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED")
      expect(changed).not.toHaveBeenCalled()
    } finally {
      await session.close()
    }
  }
)

it("keeps a caught unsupported invalidation sticky through the real manager guest wrapper", async () => {
  const initializer = new FunctionSessionInitializer(true)
  const activity = new FunctionSessionActivity()
  const guest = trackFunctionGuest(
    await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{
      try { await $.ui.invalidate("config.describe") } catch {}
      return next(e)
    })
  }}`),
    activity,
    initializer
  )
  const changed = vi.fn()
  const session = new FunctionSession(
    [
      {
        name: "candidate",
        root: "/candidate",
        tier: "user",
        capabilities: [...SESSION_CAPABILITIES],
        guest
      }
    ],
    {
      threadId: "thread",
      workspace: "/workspace",
      initializer,
      activity,
      uiChanged: changed,
      configChanged: changed,
      assertLive: () => {},
      publish: async (value) => value
    }
  )
  try {
    await expect(session.start()).rejects.toThrow("MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED")
    expect(changed).not.toHaveBeenCalled()
    expect(() => initializer.assertReady()).toThrowError(
      expect.objectContaining({ code: "MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED" })
    )
    expect(() => initializer.activate()).toThrowError(
      expect.objectContaining({ code: "MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED" })
    )
  } finally {
    await session.close()
  }
})
