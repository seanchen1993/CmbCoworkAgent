import { afterEach, expect, it, vi } from "vitest"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()))
})
async function fixture(
  hooks: string,
  callTool = vi.fn<(plugin: unknown, input: ModObject, signal: AbortSignal) => Promise<ModObject>>(
    async () =>
      ({
        result: JSON.stringify({
          status: "submitted",
          answers: { mod_question: { type: "option", label: "Chosen" } }
        })
      }) as ModObject
  )
) {
  let live = true
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start", async ($, e, next) => {
      await $.command.register({name:"ask",description:"Ask"}); return next(e)
    }); ${hooks}
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "asking",
        root: "/asking",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/project",
      threadId: "thread",
      publish: async (value: ModJson) => value,
      callTool,
      assertLive() {
        if (!live) throw Error("revoked")
      }
    }
  )
  sessions.push(session)
  await session.start()
  return {
    session,
    callTool,
    revoke: () => {
      live = false
    }
  }
}
it("ui.ask uses the tool.call chain once, skips its calling registration and returns the native label", async () => {
  const { session, callTool } = await fixture(`
    on("command.run", {command:"ask"}, async ($) => ({text:await $.ui.ask("Continue?",["Chosen","Other choice"])}));
    on("tool.call", ($,e,next)=>next({...e,questions:e.questions.map(q=>({...q,question:"Rewritten?"}))}));
  `)
  expect(await session.run("ask", "")).toEqual({ text: "Chosen" })
  expect(callTool).toHaveBeenCalledTimes(1)
  expect(callTool.mock.calls[0][1]).toMatchObject({
    tool: "request_user_input",
    questions: [{ question: "Rewritten?" }]
  })
})
it("tool denial prevents the native dialog and reaches the caller as an error", async () => {
  const { session, callTool } = await fixture(`
    on("command.run", {command:"ask"}, async ($) => {try {await $.ui.ask("Continue?")} catch(e){return {text:e.message}}});
    on("tool.call",()=>({deny:"blocked question"}));
  `)
  expect((await session.run("ask", "")).text).toContain("blocked question")
  expect(callTool).not.toHaveBeenCalled()
})
it("cancelled questions do not publish a late answer", async () => {
  let answer!: (value: ModObject) => void
  const callTool = vi.fn(
    (_plugin: unknown, _input: ModObject, signal: AbortSignal) =>
      new Promise<ModObject>((resolve) => {
        answer = resolve
        signal.addEventListener("abort", () => resolve({ result: "late" }), { once: true })
      })
  )
  const { session } = await fixture(
    `on("command.run", {command:"ask"}, async ($) => ({text:await $.ui.ask("Continue?")}));`,
    callTool
  )
  const controller = new AbortController()
  const work = session.run("ask", "", controller.signal)
  const rejected = expect(work).rejects.toThrow()
  await expect.poll(() => callTool.mock.calls.length).toBe(1)
  controller.abort()
  answer({
    result: JSON.stringify({
      status: "submitted",
      answers: { mod_question: { type: "other", text: "late" } }
    })
  })
  await rejected
})

it("skips the calling tool registration when it asks inside a tool hook", async () => {
  const { session, callTool } = await fixture(`
    on("command.run",{command:"ask"},async($)=>({text:(await $.tool.call({tool:"read_file",file_path:"x"})).result}));
    on("tool.call",async($,e)=> {
      if(e.tool!=="read_file") throw Error("recursive question");
      return {result:await $.ui.ask("Continue?")}
    });
  `)
  expect((await session.run("ask", "")).text).toBe("Chosen")
  expect(callTool).toHaveBeenCalledTimes(1)
  expect(callTool.mock.calls[0][1]).toMatchObject({ tool: "request_user_input" })
})

it("reenters classic PreToolUse during an SDK question without waiting on its own command", async () => {
  const native = vi.fn(async () => ({
    result: JSON.stringify({
      status: "submitted",
      answers: { mod_question: { type: "option", label: "Chosen" } }
    })
  }))
  const callTool = vi.fn(async (_plugin: unknown, input: ModObject, signal: AbortSignal) => {
    const result = await session.classicEvent("classic.PreToolUse", input, signal)
    if (typeof result.deny === "string") throw Error(result.deny)
    return native()
  })
  const { session } = await fixture(
    `
    on("command.run",{command:"ask"},async($,e)=> {
      try {return {text:await $.ui.ask(e.args || "Continue?")}}
      catch(e){return {text:e.message}}
    });
    on("classic.PreToolUse",($,e,next)=>e.questions[0].question==="Blocked?"?{deny:"classic denied"}:next(e));
  `,
    callTool
  )
  expect(await session.run("ask", "Continue?")).toEqual({ text: "Chosen" })
  expect(await session.run("ask", "Blocked?")).toEqual({ text: "classic denied" })
  expect(native).toHaveBeenCalledTimes(1)
})
