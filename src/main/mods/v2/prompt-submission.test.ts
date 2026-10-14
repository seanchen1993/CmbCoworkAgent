import { afterEach, expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { validatePromptSubmissionResult } from "../../../shared/mods/v2/prompt-submission"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()))
})
const input: ModObject = { text: "original", origin: { kind: "composer" }, wait: false }
async function fixture(code: string, publish = async (v: ModJson): Promise<ModJson> => v) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${code}}}`)
  const session = new FunctionSession(
    [
      {
        name: "submit",
        root: "/submit",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/workspace",
      threadId: "thread",
      assertLive() {
        /* The fixture validates admission independently of native transport. */
      },
      publish
    }
  )
  sessions.push(session)
  const signal = new AbortController().signal
  const committed: ModObject[] = []
  const core = vi.fn(async (e: ModObject): Promise<ModObject> => {
    committed.push(e)
    return { text: e.text, origin: e.origin, ...(e.context ? { context: e.context } : {}) }
  })
  return { session, committed, core, signal }
}

it("commits only next's protected text/context once, ignoring later rewrite or drop", async () => {
  const f = await fixture(
    `on("prompt.submit",async($,e,next)=>{
    await next({...e,text:"first secret",context:["hidden secret"]});
    await next({...e,text:"second"});return {drop:"after acceptance"}
  });`,
    async (v) => JSON.parse(JSON.stringify(v).replaceAll("secret", "[redacted]"))
  )
  expect(await f.session.promptSubmission(input, f.signal, f.core)).toEqual({
    text: "first [redacted]",
    context: ["hidden [redacted]"],
    origin: input.origin
  })
  expect(f.core).toHaveBeenCalledTimes(1)
  expect(f.committed[0]).toMatchObject({ text: "first [redacted]", context: ["hidden [redacted]"] })
})

it.each([`{drop:"Please add a task"}`, `{text:"local answer"}`])(
  "does not accept an official answer without next: %s",
  async (answer) => {
    const f = await fixture(`on("prompt.submit",async()=>(${answer}));`)
    expect(await f.session.promptSubmission(input, f.signal, f.core)).toHaveProperty("drop")
    expect(f.committed).toEqual([])
  }
)

it("propagates failed durable admission and cancellation without fallback or repeat", async () => {
  const f = await fixture(`on("prompt.submit",async($,e,next)=>next({...e,text:"rewrite"}));`)
  f.core.mockRejectedValueOnce(Error("storage unavailable"))
  await expect(f.session.promptSubmission(input, f.signal, f.core)).rejects.toThrow(
    "storage unavailable"
  )
  expect(f.core).toHaveBeenCalledTimes(1)
  const controller = new AbortController()
  controller.abort()
  await expect(f.session.promptSubmission(input, controller.signal, f.core)).rejects.toThrow()
  expect(f.core).toHaveBeenCalledTimes(1)
})

it("keeps host origin/wait/turnId and accepts a result with omitted origin", async () => {
  const f = await fixture(`on("prompt.submit",async($,e,next)=>next({...e,
    origin:{kind:"plugin",name:"spoof"},wait:true,turnId:"spoof"}));`)
  const event = { ...input, turnId: "actual-running-turn" }
  await f.session.promptSubmission(event, f.signal, f.core)
  expect(f.committed[0]).toEqual(event)
  expect(() => validatePromptSubmissionResult({ text: "local" }, input)).not.toThrow()
  expect(() => validatePromptSubmissionResult({ drop: "reason" }, input)).not.toThrow()
  expect(() => validatePromptSubmissionResult({ drop: true }, input)).toThrow()
})
