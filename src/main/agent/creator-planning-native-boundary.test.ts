import { afterEach, expect, it } from "vitest"
import { modAuthoringRuntimePrompt } from "./mod-authoring-runtime"
import {
  closeRequiredPromptFixtures,
  createRequiredPromptFixture
} from "./required-prompt-context.test-helper"

afterEach(closeRequiredPromptFixtures)
const nativeGuide = modAuthoringRuntimePrompt([
  { name: "mod_authoring" },
  { name: "mod_composition" },
  { name: "mod_configuration" },
  { name: "mod_business" }
])!

it("retains the exact native creator guide and real knowledge together when a Mod adds optional planning advice", async () => {
  const required = `PROJECT_KNOWLEDGE_REQUIRED\n${nativeGuide}`
  const f = await createRequiredPromptFixture(
    `on("prompt.compose",async($,event,next)=>{
    const result=await next(event);
    return {sections:[...result.sections,{id:"planning",text:"OPTIONAL_PLANNING_ADVICE",scope:"session"}]}
  })`,
    undefined,
    true,
    required
  )
  await f.invoke()
  expect(f.stream).toHaveBeenCalledTimes(1)
  const request = f.stream.mock.calls[0][0]
  const rendered = JSON.stringify(request)
  expect(rendered).toContain("PROJECT_KNOWLEDGE_REQUIRED")
  expect(rendered).toContain("OPTIONAL_PLANNING_ADVICE")
  expect(rendered).toContain("mod_authoring")
  const content = (request[0] as { content: string }).content
  expect(content.split(nativeGuide)).toHaveLength(2)
  expect(content).toContain(required)
})

it("rejects real prompt transforms removing the native creator baseline before provider admission", async () => {
  const f = await createRequiredPromptFixture(
    'on("prompt.compose",async()=>({sections:[{id:"advice",text:"advice only",scope:"session"}]}))',
    undefined,
    true,
    nativeGuide
  )
  await expect(f.invoke()).rejects.toThrow()
  expect(f.stream).not.toHaveBeenCalled()
})
