import { expect, it, vi } from "vitest"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { filterModData } from "../publication"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionSessionActivity } from "./session-activity"
import { trackFunctionSession } from "./session-facade"
import { trackFunctionGuest } from "./session-guest"
import { FunctionSessionInitializer } from "./session-initializer"
import { publishPromptMentionResult } from "./prompt-mention-publication"

const marker = "sk-secret-token-123456789"
const suppressed = { type: "text", text: "[Non-text output suppressed by project policy]" }

it.each(["file", "already_read_file", "pdf_reference", null] as const)(
  "preserves only the validated top-level %s metadata while protecting the entire payload",
  async type => {
    const original: ModObject = {
      type,
      context: [marker, marker],
      extra: { secret: "private-extra", base64: "private-binary", nested: { type: "file", body: "private-media" } }
    }
    const publish = vi.fn(async (payload: ModObject): Promise<ModJson> => {
      expect(Object.hasOwn(payload, "type")).toBe(false)
      expect(payload).not.toBe(original)
      expect(payload.context).not.toBe(original.context)
      expect(payload.extra).not.toBe(original.extra)
      return filterModData(payload, true)
    })
    expect(await publishPromptMentionResult(original, publish)).toEqual({
      type,
      context: ["[REDACTED]", "[REDACTED]"],
      extra: { secret: "[REDACTED]", base64: "[REDACTED]", nested: suppressed }
    })
    expect(publish).toHaveBeenCalledOnce()
    expect(original.context).toEqual([marker, marker])
    expect(filterModData({ type: "file", body: "still-media" }, true)).toEqual(suppressed)
  }
)

it("pins metadata before publication without restoring mutated or unprotected context", async () => {
  const original: ModObject = { type: "file", context: [marker] }
  const result = await publishPromptMentionResult(original, async payload => {
    original.type = "image"
    original.context = ["late raw secret"]
    expect(payload).toEqual({ context: [marker] })
    return filterModData(payload, true)
  })
  expect(result).toEqual({ type: "file", context: ["[REDACTED]"] })
})

it("protects actual denial text and refuses invalid input before the original publisher", async () => {
  const publish = vi.fn(async (payload: ModObject) => filterModData(payload, true))
  expect(await publishPromptMentionResult({ deny: marker }, publish))
    .toEqual({ deny: "[REDACTED]" })
  expect(publish).toHaveBeenCalledOnce()
  let getters = 0
  const invalid: ModObject = { type: "file" }
  Object.defineProperty(invalid, "context", { enumerable: true, get() { getters++; return [marker] } })
  await expect(publishPromptMentionResult(invalid, publish)).rejects.toThrow("MODS_JSON_ACCESSOR")
  await expect(publishPromptMentionResult({ type: "image" }, publish))
    .rejects.toThrow("MODS_PROMPT_MENTION_RESULT")
  expect(getters).toBe(0)
  expect(publish).toHaveBeenCalledOnce()
})

it("never falls back to raw data after rejected, undefined or cancelled publication", async () => {
  const input: ModObject = { type: "file", context: [marker] }
  const failure = Error("actual publisher failed")
  await expect(publishPromptMentionResult(input, async () => { throw failure })).rejects.toBe(failure)
  await expect(publishPromptMentionResult(input, async () => { throw undefined }))
    .rejects.toBeUndefined()
  await expect(publishPromptMentionResult(input, async () => undefined))
    .rejects.toThrow("MODS_PROMPT_MENTION_RESULT")
  const controller = new AbortController()
  await expect(publishPromptMentionResult(input, async () => {
    controller.abort(failure)
    controller.signal.throwIfAborted()
    return input
  })).rejects.toBe(failure)
  expect(input).toEqual({ type: "file", context: [marker] })
})

async function trackedFixture(hook: string) {
  const activity = new FunctionSessionActivity()
  const runtime = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${hook}}}`)
  try {
    const guest = trackFunctionGuest(runtime, activity, new FunctionSessionInitializer(false))
    const payloads: ModJson[] = []
    const actual = new FunctionSession([{
      name: "mention", root: "/plugin/mention", tier: "user", guest,
      capabilities: [...SESSION_CAPABILITIES]
    }], {
      workspace: "C:/project", threadId: "thread", activity,
      assertLive() { /* This fixture checks publication and entry lifetime, not runtime minting. */ },
      publish: async value => {
        // This is the actual production preflight. It does not pretend to run a utilityProcess.
        payloads.push(JSON.parse(JSON.stringify(value)))
        return filterModData(value, true)
      }
    })
    return { activity, session: trackFunctionSession(actual, activity), payloads,
      close: () => actual.close() }
  } catch (error) { runtime.dispose(); throw error }
}
const question: ModObject = { mention: "file.txt", path: "C:/project/file.txt" }

it("keeps the genuine tracked Guest next once and its complete protected context at every result boundary", async () => {
  const f = await trackedFixture(`on("prompt.mention",async($,e,next)=>{
    const first=next(e),second=next({...e,path:"C:/project/other.txt"});
    await first;return {...await second,context:["${marker}","${marker}"]};
  });`)
  const core = vi.fn(async (received: ModObject): Promise<ModObject> => {
    expect(received).toEqual(question)
    expect(f.activity.withinEntry).toBe(true)
    return { type: "file" }
  })
  try {
    await f.session.start()
    const beforePublications = f.payloads.length
    expect(await f.session.promptMention(question, new AbortController().signal, core))
      .toEqual({ type: "file", context: ["[REDACTED]", "[REDACTED]"] })
    expect(core).toHaveBeenCalledOnce()
    expect(f.activity.size).toBe(0)
    expect(f.payloads.filter(value => typeof value === "object" && value !== null &&
      !Array.isArray(value) && Object.hasOwn(value, "type"))).toEqual([])
    expect(f.payloads.slice(beforePublications)).toHaveLength(5)
  } finally { await f.close() }
})

it("does not turn a protected synthetic Hook type into a read or replace an actual Core denial", async () => {
  const synthetic = await trackedFixture('on("prompt.mention",()=>({type:"file",context:["local"]}));')
  const noRead = vi.fn(async (): Promise<ModObject> => ({ type: "file" }))
  try {
    expect(await synthetic.session.promptMention(question, new AbortController().signal, noRead))
      .toEqual({ type: null, context: ["local"] })
    expect(noRead).not.toHaveBeenCalled()
  } finally { await synthetic.close() }
  const denied = await trackedFixture('on("prompt.mention",async($,e,next)=>{await next(e);return {type:"file"}});')
  const core = vi.fn(async (): Promise<ModObject> => ({ deny: "actual permission denial" }))
  try {
    expect(await denied.session.promptMention(question, new AbortController().signal, core))
      .toEqual({ deny: "actual permission denial" })
    expect(core).toHaveBeenCalledOnce()
    expect(denied.activity.size).toBe(0)
  } finally { await denied.close() }
})
