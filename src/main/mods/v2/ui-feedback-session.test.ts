import { afterEach, expect, it, vi } from "vitest"
import type { ModJson } from "../../../shared/mods/types"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionUiFeedback } from "./ui-feedback"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()))
})
async function fixture(hooks: string, publish = async (v: ModJson): Promise<ModJson> => v) {
  let live = true
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${hooks}}}`)
  const session = new FunctionSession(
    [
      {
        name: "feedback",
        root: "/feedback",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/project",
      threadId: "thread",
      publish,
      assertLive() {
        if (!live) throw Error("revoked")
      }
    }
  )
  sessions.push(session)
  await session.start()
  return {
    session,
    revoke: () => {
      live = false
    }
  }
}

it("real guest void methods settle before return and status(undefined) clears the caller", async () => {
  const { session } = await fixture(`
    on("session.start",{},async($,e,next)=>{
      const result=$.ui.toast("ready"); if(result!==undefined) throw Error("must be void");
      $.ui.status("first"); $.ui.status(undefined); return next(e);
    });
  `)
  expect((await session.feedbackSnapshot()).map((row) => row.text)).toEqual(["ready"])
})

it("operation hooks rewrite through core and publication sanitizes before storage", async () => {
  const { session } = await fixture(
    `
    on("session.start",{},async($,e,next)=>{ $.ui.status("secret"); return next(e); });
    on("ui.status",{},($,e,next)=>next({...e,text:e.text+" rewritten"}));
  `,
    async (v) =>
      typeof v === "object" && v !== null && !Array.isArray(v) && v.text === "secret rewritten"
        ? { ...v, text: "[redacted] rewritten" }
        : v
  )
  expect((await session.feedbackSnapshot())[0].text).toBe("[redacted] rewritten")
})

it.each(["status", "toast"] as const)(
  "protects the full long real guest %s after its hook before storing a display copy",
  async method => {
    const protectedInputs: string[] = []
    const { session } = await fixture(`
      on("session.start", ($, e, next) => { $.ui.${method}("x".repeat(30000)); return next(e); });
      on("ui.${method}", ($, e, next) => {
        if(e.text.length!==30000) throw Error("original feedback was truncated");
        return next({...e,text:"secret:"+e.text+":tail"});
      });
    `, async value => {
      if (value && typeof value === "object" && !Array.isArray(value) &&
        typeof value.text === "string") {
        protectedInputs.push(value.text)
        return { ...value, text: value.text.replace("secret:", "[redacted]:") }
      }
      return value
    })
    expect(protectedInputs[0]).toBe(`secret:${"x".repeat(30000)}:tail`)
    const expected = `[redacted]:${"x".repeat(30000)}:tail`.slice(0, 10000)
    expect((await session.feedbackSnapshot()).map(row => row.text)).toEqual([expected])
  }
)

it("denied notifications never create presentation state", async () => {
  const { session } = await fixture(`
    on("session.start",{},async($,e,next)=>{
      try { await $.command.register({name:"denied-feedback",description:"test"}); } catch {}
      return next(e);
    });
    on("command.run",{command:"denied-feedback"},($)=>{ $.ui.toast("denied"); return {text:"done"}; });
    on("ui.toast",{},()=>({deny:"policy"}));
  `)
  expect(await session.run("denied-feedback", "")).toEqual({})
  expect(await session.feedbackSnapshot()).toEqual([])
})

it("revocation and session close prevent reading or late publication", async () => {
  const f = await fixture(
    `on("session.start",{},($,e,next)=>{ $.ui.status("ready"); return next(e); });`
  )
  f.revoke()
  await expect(f.session.feedbackSnapshot()).rejects.toThrow("revoked")
  await f.session.close()
  await expect(f.session.feedbackSnapshot()).rejects.toThrow()
})

it("keeps the last status when an earlier publication is delayed", async () => {
  const { session } = await fixture(
    `
    on("session.start",{},($,e,next)=>{ $.ui.status("slow"); $.ui.status("last"); return next(e); });
  `,
    async (v) => {
      if (typeof v === "object" && v !== null && !Array.isArray(v) && v.text === "slow")
        await new Promise((resolve) => setTimeout(resolve, 30))
      return v
    }
  )
  expect((await session.feedbackSnapshot()).map((row) => row.text)).toEqual(["last"])
})

it("cancel during publication cannot create a late toast", async () => {
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const { session } = await fixture(
    `
    on("session.start",{},async($,e,next)=>{
      await $.command.register({name:"late-toast",description:"test"}); return next(e);
    });
    on("command.run",{command:"late-toast"},($)=>{ $.ui.toast("late"); return {text:"done"}; });
  `,
    async (v) => {
      if (typeof v === "object" && v !== null && !Array.isArray(v) && v.text === "late") {
        entered()
        await pending
      }
      return v
    }
  )
  const controller = new AbortController()
  const run = session.run("late-toast", "", controller.signal).catch(() => ({}))
  await started
  controller.abort(Error("cancel"))
  release()
  await run
  expect(await session.feedbackSnapshot()).toEqual([])
})

it.each([
  ["toast", "cancel"], ["status", "cancel"],
  ["toast", "revoke"], ["status", "revoke"]
] as const)("does not store long %s after %s during real publication", async (method, ending) => {
  let release!: () => void
  let entered!: () => void
  let completed = false
  const started = new Promise<void>(resolve => { entered = resolve })
  const pending = new Promise<void>(resolve => { release = resolve })
  const store = vi.spyOn(FunctionUiFeedback.prototype, "set")
  const controller = new AbortController()
  let run: Promise<unknown> | undefined
  try {
    const f = await fixture(`
      on("session.start", async ($, e, next) => {
        await $.command.register({name:"long-feedback",description:"test"}); return next(e);
      });
      on("command.run", {command:"long-feedback"}, ($) => {
        $.ui.${method}("x".repeat(30000)); return {text:"done"};
      });
    `, async value => {
      if (value && typeof value === "object" && !Array.isArray(value) &&
        typeof value.text === "string" && value.text.length === 30000) {
        entered()
        await pending
        completed = true
      }
      return value
    })
    run = f.session.run("long-feedback", "", controller.signal)
    const settled = Promise.allSettled([run])
    await started
    if (ending === "cancel") controller.abort(Error("cancel long feedback"))
    else f.revoke()
    release()
    await settled
    await f.session.close()
    expect(completed).toBe(true)
    expect(store).not.toHaveBeenCalled()
  } finally {
    controller.abort()
    release?.()
    if (run) await Promise.allSettled([run])
    store.mockRestore()
  }
})
