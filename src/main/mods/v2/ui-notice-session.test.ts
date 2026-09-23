import { afterEach, expect, it } from "vitest"
import type { ModJson } from "../../../shared/mods/types"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()))
})
async function fixture(
  hooks = "",
  publish = async (v: ModJson): Promise<ModJson> => v,
  owner = "function:notice"
) {
  let open = true
  let removed: ((id: string) => void) | undefined
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"note",description:"notice"});return next(e)});
    on("command.run",{command:"note"},($,e)=>{
      const result=$.ui.notice("call",e.args==="clear"?undefined:"secret");
      if(result!==undefined)throw Error("notice must be void");return {text:"done"}
    }).catch(()=>({text:"REFUSED"}));${hooks}
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "notice",
        root: "/notice",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/workspace",
      threadId: "thread",
      publish,
      assertLive: () => {},
      dialogs: {
        lookup: (id) =>
          open && id === "call" ? { toolUseId: "call", requestId: "request", owner } : undefined,
        subscribeClosed: (listener) => {
          removed = listener
          return () => {
            removed = undefined
          }
        }
      }
    }
  )
  sessions.push(session)
  await session.start()
  return {
    session,
    remove() {
      open = false
      removed?.("request")
    }
  }
}
it("tracks void notice calls, dispatches middleware, publishes and clears only native dialog context", async () => {
  const f = await fixture(
    'on("ui.notice",($,e,next)=>next(e.text===undefined?e:{...e,text:e.text+" rewritten"}));',
    async (v) =>
      typeof v === "object" && v !== null && !Array.isArray(v) && typeof v.text === "string"
        ? { ...v, text: v.text.replace("secret", "redacted") }
        : v
  )
  expect(await f.session.run("note", "")).toEqual({ text: "done" })
  expect(await f.session.feedbackSnapshot()).toMatchObject([
    {
      kind: "notice",
      plugin: "notice",
      requestId: "request",
      toolUseId: "call",
      text: "redacted rewritten"
    }
  ])
  await f.session.run("note", "clear")
  expect(await f.session.feedbackSnapshot()).toEqual([])
  await f.session.run("note", "")
  f.remove()
  expect(await f.session.feedbackSnapshot()).toEqual([])
})
it("notice publication cannot target another dialog via rewritten tool identity", async () => {
  const f = await fixture('on("ui.notice",($,e,next)=>next({...e,tool_use_id:"foreign"}));')
  await f.session.run("note", "")
  expect(await f.session.feedbackSnapshot()).toMatchObject([{ toolUseId: "call", text: "secret" }])
})
it("cancelled publication cannot leave a notice after its caller returns", async () => {
  let release!: () => void
  let entered!: () => void
  const blocked = new Promise<void>((r) => {
    release = r
  })
  const started = new Promise<void>((r) => {
    entered = r
  })
  const f = await fixture("", async (v) => {
    if (v && !Array.isArray(v) && typeof v === "object" && v.text === "secret") {
      entered()
      await blocked
    }
    return v
  })
  const controller = new AbortController()
  const run = f.session.run("note", "", controller.signal).catch(() => ({}))
  await started
  controller.abort()
  release()
  await run
  expect(await f.session.feedbackSnapshot()).toEqual([])
})

it("publication cannot move a native notice into a different dialog", async () => {
  const f = await fixture("", async (v) =>
    Array.isArray(v)
      ? (v.map((row) => ({ ...(row as object), requestId: "foreign" })) as ModJson)
      : v
  )
  await f.session.run("note", "")
  await expect(f.session.feedbackSnapshot()).rejects.toThrow("MODS_UI_FEEDBACK_SNAPSHOT")
})

it("rejects another plugin SDK dialog through the real guest boundary", async () => {
  const f = await fixture("", async (v) => v, "function:other")
  expect(await f.session.run("note", "")).toEqual({ text: "REFUSED" })
  expect(await f.session.feedbackSnapshot()).toEqual([])
})

it("rejects a closed dialog through the real guest boundary", async () => {
  const f = await fixture()
  f.remove()
  expect(await f.session.run("note", "")).toEqual({ text: "REFUSED" })
  expect(await f.session.feedbackSnapshot()).toEqual([])
})
