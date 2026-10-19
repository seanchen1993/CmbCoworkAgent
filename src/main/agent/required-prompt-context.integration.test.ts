import { SystemMessage } from "@langchain/core/messages"
import { afterEach, expect, it } from "vitest"
import { extractErrorDetail, isRetryableApiError } from "./failover"
import { closeRequiredPromptFixtures, createRequiredPromptFixture as fixture } from "./required-prompt-context.test-helper"

afterEach(closeRequiredPromptFixtures)

async function expectRequiredBlock(f: Awaited<ReturnType<typeof fixture>>) {
  const error = await f.invoke().then(
    () => undefined,
    (error: unknown) => error
  )
  expect(error).toBeInstanceOf(Error)
  expect(extractErrorDetail(error)).toMatchObject({
    code: "harness_context_unavailable",
    statusLabel: "必需项目知识被提示词处理改写"
  })
  expect(isRetryableApiError(error)).toBe(false)
  expect(f.stream).not.toHaveBeenCalled()
}

it.each([
  'on("prompt.context",async()=>({blocks:[]}))',
  'on("prompt.section",async($,event,next)=>event.name==="cmb:agents"?{text:null}:next(event))',
  'on("prompt.compose",async()=>({sections:[]}))',
  'on("prompt.compose",async()=>({sections:[{id:"fake",text:"PROJECT_CHANGED",scope:"session"}]}))'
])(
  "blocks a real prompt Hook removing resolved project knowledge before provider admission: %s",
  async (hook) => {
    const f = await fixture(hook)
    await expectRequiredBlock(f)
  }
)

it("retains required knowledge through opaque native rewrites and subsequent Mod replacement", async () => {
  const f = await fixture(
    'on("prompt.compose",async()=>({sections:[]}))',
    "NATIVE_PREFIX\nPROJECT_REQUIRED\nNATIVE_TAIL"
  )
  await expectRequiredBlock(f)
})

it("rejects an opaque native rewrite that already removed the required context", async () => {
  const f = await fixture("", "NATIVE_REPLACEMENT")
  await expectRequiredBlock(f)
})

it("allows real prompt extensions that retain required bytes and reports the actual provider input", async () => {
  const f = await fixture(`on("prompt.compose",async($,event,next)=>{
    const value=await next(event);
    return {sections:[...value.sections,{id:"extra",text:"LEGAL_EXTENSION",scope:"session"}]}
  })`)
  await f.invoke()
  expect(f.stream).toHaveBeenCalledTimes(1)
  const messages = f.stream.mock.calls[0][0] as SystemMessage[]
  expect(messages[0].content).toContain("PROJECT_REQUIRED")
  expect(messages[0].content).toContain("LEGAL_EXTENSION")
})

it("keeps ordinary unprotected prompt removal available", async () => {
  const f = await fixture('on("prompt.compose",async()=>({sections:[]}))', undefined, false)
  await f.invoke()
  expect(f.stream).toHaveBeenCalledTimes(1)
})
