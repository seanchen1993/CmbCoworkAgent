import { afterEach, expect, it, vi } from "vitest"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { validatePromptMentionInput, validatePromptMentionResult } from
  "../../../shared/mods/v2/prompt-mention"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()))
})
const input: ModObject = {
  mention: "file.txt#L10-20", path: "C:/project/file.txt", offset: 10, limit: 11
}
async function fixture(body: string, lower?: string,
  publish = async (value: ModJson): Promise<ModJson> => value) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${body}}}`)
  const guests = [guest]
  try {
    if (lower) guests.push(await FunctionGuestRuntime.create(
      `var __cmbFunctionMod={register(on){${lower}}}`
    ))
    const session = new FunctionSession(guests.map((actual, index) => ({
      name: index ? "lower" : "mention", root: `/plugin/${index}`,
      tier: index ? "append" as const : "user" as const,
      guest: actual, capabilities: [...SESSION_CAPABILITIES]
    })), { workspace: "C:/project", threadId: "thread", assertLive() {}, publish })
    sessions.push(session)
    const core = vi.fn(async (_received: ModObject): Promise<ModObject> => ({ type: "file" }))
    return { session, core, signal: new AbortController().signal }
  } catch (error) {
    for (const actual of guests) actual.dispose()
    throw error
  }
}

it.each([false, true])("reads the first actual next only once with parallel=%s", async parallel => {
  const f = await fixture(`on("prompt.mention",async($,e,next)=>{
    const first=next({...e,path:"C:/project/first.txt",offset:3,limit:2});
    ${parallel ? "" : "await first;"}
    const second=next({...e,path:"C:/project/second.txt",offset:99});
    return {...await second,context:[JSON.stringify(await first)]};
  });`)
  expect(await f.session.promptMention(input, f.signal, f.core)).toEqual({
    type: "file", context: ['{"type":"file"}']
  })
  expect(f.core).toHaveBeenCalledOnce()
  expect(f.core.mock.calls[0][0]).toEqual({ ...input, path: "C:/project/first.txt", offset: 3, limit: 2 })
})

it("keeps real pinned mention and loop while allowing a valid path rewrite", async () => {
  const f = await fixture(`on("prompt.mention",async($,e,next)=>{
    const {mention,agentId,...rest}=e;return next({...rest,path:"C:/project/other.txt"});
  });`)
  await f.session.promptMention({ ...input, agentId: "actual-child" }, f.signal, f.core)
  expect(f.core).toHaveBeenCalledExactlyOnceWith({
    ...input, path: "C:/project/other.txt", agentId: "actual-child"
  }, expect.any(AbortSignal))
})

it("recovers a changed pin without using its rewritten path", async () => {
  const f = await fixture(`on("prompt.mention",($,e,next)=>next({...e,
    mention:"fake",agentId:"fake",path:"C:/project/other.txt"}));`)
  await f.session.promptMention(input, f.signal, f.core)
  expect(f.core).toHaveBeenCalledExactlyOnceWith(input, expect.any(AbortSignal))
})

it("keeps the full context multiset while allowing reordering and new duplicates", async () => {
  const f = await fixture(`on("prompt.mention",async($,e,next)=>{
    const result=await next(e);return {...result,context:["b","a","a","mine","mine"],extra:true};
  });`, `on("prompt.mention",async($,e,next)=>({...await next(e),context:["a","a","b"]}));`)
  expect(await f.session.promptMention(input, f.signal, f.core)).toEqual({
    type: "file", context: ["b", "a", "a", "mine", "mine"]
  })
  expect(f.core).toHaveBeenCalledOnce()
})

it.each(["undefined", '[]', '["a"]', '[""]', '"invalid"', '["x".repeat(100001)]'])(
  "recovers invalid or removed downstream context %s without another read", async context => {
    const f = await fixture(`on("prompt.mention",async($,e,next)=>{
      const result=await next(e);return {...result,context:${context}};
    });`, `on("prompt.mention",async($,e,next)=>({...await next(e),context:["a","a"]}));`)
    expect(await f.session.promptMention(input, f.signal, f.core)).toEqual({
      type: "file", context: ["a", "a"]
    })
    expect(f.core).toHaveBeenCalledOnce()
  }
)

it("does not grant an attachment to a Hook that answered without next", async () => {
  const f = await fixture('on("prompt.mention",()=>({type:"file",context:["local"]}));')
  expect(await f.session.promptMention(input, f.signal, f.core)).toEqual({
    type: null, context: ["local"]
  })
  expect(f.core).not.toHaveBeenCalled()
})

it("forgets a settled read when the actual Hook denies it", async () => {
  const f = await fixture(`on("prompt.mention",async($,e,next)=>{
    await next(e);return {deny:"private"};
  });`)
  expect(await f.session.promptMention(input, f.signal, f.core)).toEqual({ deny: "private" })
  expect(f.core).toHaveBeenCalledOnce()
})

it("recovers deny beside context and retains the real completed read", async () => {
  const f = await fixture(`on("prompt.mention",async($,e,next)=>{
    await next(e);return {deny:"private",context:["invalid"]};
  });`)
  expect(await f.session.promptMention(input, f.signal, f.core)).toEqual({ type: "file" })
  expect(f.core).toHaveBeenCalledOnce()
})

it("keeps actual Core deny even if an upper Hook claims a file", async () => {
  const f = await fixture('on("prompt.mention",async($,e,next)=>{await next(e);return {type:"file"}});')
  f.core.mockResolvedValue({ deny: "real permission" })
  expect(await f.session.promptMention(input, f.signal, f.core)).toEqual({ deny: "real permission" })
  expect(f.core).toHaveBeenCalledOnce()
})

it("propagates real Source failure without optional fallback or another Core", async () => {
  const f = await fixture('on("prompt.mention",async($,e,next)=>next(e));')
  f.core.mockRejectedValue(Error("actual source changed"))
  await expect(f.session.promptMention(input, f.signal, f.core)).rejects.toThrow("actual source changed")
  expect(f.core).toHaveBeenCalledOnce()
})

it("protects context without reintroducing an unprotected downstream block", async () => {
  const f = await fixture('on("prompt.mention",async($,e,next)=>({...await next(e),context:["secret"]}));',
    undefined, async value => JSON.parse(JSON.stringify(value).replaceAll("secret", "safe")))
  expect(await f.session.promptMention(input, f.signal, f.core)).toEqual({ type: "file", context: ["safe"] })
})

it("rejects own accessors and malformed line selections without invoking getters", () => {
  let reads = 0
  const malformed: ModObject = { ...input }
  Object.defineProperty(malformed, "path", { enumerable: true, get() { reads++; return "C:/fake" } })
  expect(() => validatePromptMentionInput(malformed)).toThrow("MODS_JSON_ACCESSOR")
  const invalidFields: ModObject[] = [{ offset: 0 }, { limit: -1 }, { offset: 1.5 }, { path: "relative" }]
  for (const fields of invalidFields)
    expect(() => validatePromptMentionInput({ ...input, ...fields })).toThrow("MODS_PROMPT_MENTION_INPUT")
  expect(() => validatePromptMentionResult({ type: "fake" })).toThrow("MODS_PROMPT_MENTION_RESULT")
  expect(reads).toBe(0)
})
