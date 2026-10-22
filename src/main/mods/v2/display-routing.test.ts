import { build } from "esbuild"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FUNCTION_PASSIVE_DISPLAY_SITES, FUNCTION_UI_SITES } from "../../../shared/mods/v2/sites"
import { FunctionGuestRuntime } from "./guest-runtime"
import { analyzeStaticUiRenderSummary } from "./static-ui-render-summary"
import { FUNCTION_DISPLAY_PROTOCOL } from "./display-rollout"
import {
  describeFunctionDisplayRouting,
  FUNCTION_DISPLAY_STATIC_SOURCE_LIMIT,
  FunctionDisplayRouting
} from "./display-routing"

const guests: FunctionGuestRuntime[] = []
afterEach(async () => {
  for (const guest of guests.splice(0)) await guest.dispose()
})

async function plugin(body: string) {
  const source = `export function register(on) { ${body} }`
  const compiled = await build({
    stdin: { contents: source },
    bundle: true,
    write: false,
    format: "iife",
    globalName: "__cmbFunctionMod",
    target: "es2016",
    platform: "neutral",
    logLevel: "silent"
  })
  const code = compiled.outputFiles[0].text
  const guest = await FunctionGuestRuntime.create(code)
  guests.push(guest)
  return { guest, code }
}
const passive = `on("ui.render",{component:"AssistantMessage"},($,e)=>({type:"Text",props:{text:e.props.text}}))`
const named = `on("ui.render",{component:"AssistantMessage"},async($,e)=>{
  const value = await $.state.get({plugin:"theme",key:"mode",id:"panel"});
  return {type:"Text",props:{text:value.value.label}};
})`

describe("isolated display routing", () => {
  it("uses real compiler/VM registrations without executing guest matchers or callbacks", async () => {
    const value = await plugin(`on("ui.render",{component:"AbovePrompt"},()=>null)`)
    const matches = vi.spyOn(value.guest, "matches"),
      invoke = vi.spyOn(value.guest, "invoke")
    const analyze = vi.fn(analyzeStaticUiRenderSummary)
    const routing = new FunctionDisplayRouting(analyze)
    for (let index = 0; index < 10; index++)
      expect(routing.qualify([value], "AssistantMessage")).toEqual({
        native: true,
        expectedRefs: []
      })
    expect(analyze).toHaveBeenCalledTimes(1)
    expect(matches).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
    expect(routing.qualify([value], "AbovePrompt")).toEqual({ native: false, expectedRefs: [] })
  })

  it("combines proved passive callbacks and returns fresh precise named-state references", async () => {
    const values = [await plugin(passive), await plugin(named), await plugin(named)]
    const routing = new FunctionDisplayRouting()
    const first = routing.qualify(values, "AssistantMessage")
    expect(first).toEqual({
      native: false,
      expectedRefs: [{ plugin: "theme", key: "mode", id: "panel" }]
    })
    first!.expectedRefs[0].plugin = "changed-by-caller"
    first!.expectedRefs.push({ plugin: "forged", key: "other" })
    expect(routing.qualify(values, "AssistantMessage")).toEqual({
      native: false,
      expectedRefs: [{ plugin: "theme", key: "mode", id: "panel" }]
    })
    expect(routing.qualify(values, "UserMessage")).toEqual({ native: true, expectedRefs: [] })
  })

  it.each(["state.get", "state.*", "*", "!session.start"])(
    "keeps named reads on real owners when the graph intercepts %s",
    async (pattern) => {
      const values = [
        await plugin(named),
        await plugin(`on(${JSON.stringify(pattern)},($,e,next)=>next(e))`)
      ]
      expect(new FunctionDisplayRouting().qualify(values, "AssistantMessage")).toBeUndefined()
    }
  )

  it("does not mistake an unrelated state interceptor for a dependency of a stateless drawing", async () => {
    const values = [await plugin(passive), await plugin(`on("state.get",($,e,next)=>next(e))`)]
    expect(new FunctionDisplayRouting().qualify(values, "AssistantMessage")).toEqual({
      native: false,
      expectedRefs: []
    })
  })

  it.each([
    `on("ui.render",{component:"AssistantMessage"},($,e,next)=>next({...e}))`,
    `on("ui.render",e=>e.component==="AssistantMessage",()=>null)`,
    `on("ui.resolve",()=>null)`,
    `let counter=0;on("ui.render",{component:"AssistantMessage"},()=>({type:"Text",props:{text:++counter}}))`,
    `on("ui.render",{component:"AssistantMessage"},()=>({type:"Client",props:{module:"./view"}}))`
  ])("retains legacy for unproved middleware, matcher, resolver or effect: %s", async (body) => {
    const value = await plugin(body)
    expect(new FunctionDisplayRouting().qualify([value], "AssistantMessage")).toBeUndefined()
  })

  it("preserves an identity-next middleware already proved reusable by the existing analyzer", async () => {
    const value = await plugin(`on("ui.render",{component:"AssistantMessage"},($,e,next)=>next(e))`)
    expect(new FunctionDisplayRouting().qualify([value], "AssistantMessage")).toEqual({
      native: false,
      expectedRefs: []
    })
  })

  it("does not accept changed source for an initially irrelevant guest either", async () => {
    const value = await plugin(`on("session.start",()=>null)`),
      routing = new FunctionDisplayRouting()
    expect(routing.qualify([value], "AssistantMessage")).toEqual({ native: true, expectedRefs: [] })
    expect(
      routing.qualify([{ ...value, code: value.code + "\n" }], "AssistantMessage")
    ).toBeUndefined()
  })

  it("retires cached positive proof on same-guest source change, including a later ABA restore", async () => {
    const value = await plugin(passive),
      analyze = vi.fn(analyzeStaticUiRenderSummary)
    const routing = new FunctionDisplayRouting(analyze)
    expect(routing.qualify([value], "AssistantMessage")?.native).toBe(false)
    expect(
      routing.qualify([{ ...value, code: value.code + "\n// changed" }], "AssistantMessage")
    ).toBeUndefined()
    expect(routing.qualify([value], "AssistantMessage")).toBeUndefined()
    expect(analyze).toHaveBeenCalledTimes(1)
  })

  it("does not reuse a positive proof if real registration metadata changes", async () => {
    const value = await plugin(passive),
      routing = new FunctionDisplayRouting()
    expect(routing.qualify([value], "AssistantMessage")?.native).toBe(false)
    Object.defineProperty(value.guest, "registrations", {
      value: value.guest.registrations.map((row) => ({ ...row, hasCatch: true }))
    })
    expect(routing.qualify([value], "AssistantMessage")).toBeUndefined()
  })

  it("bounds unknown analysis and never upgrades a missing or rejected code binding in place", async () => {
    const value = await plugin(passive),
      analyze = vi.fn(analyzeStaticUiRenderSummary)
    const routing = new FunctionDisplayRouting(analyze)
    expect(routing.qualify([{ guest: value.guest }], "AssistantMessage")).toBeUndefined()
    expect(routing.qualify([value], "AssistantMessage")).toBeUndefined()
    const other = await plugin(passive)
    expect(
      routing.qualify(
        [{ ...other, code: "x".repeat(FUNCTION_DISPLAY_STATIC_SOURCE_LIMIT + 1) }],
        "AssistantMessage"
      )
    ).toBeUndefined()
    expect(analyze).not.toHaveBeenCalled()
    const invalid = await plugin(passive),
      invalidCode = { ...invalid, code: "invalid(" }
    expect(routing.qualify([invalidCode], "AssistantMessage")).toBeUndefined()
    expect(routing.qualify([invalidCode], "AssistantMessage")).toBeUndefined()
    // This code is not the VM's actual source, so the native binding rejects it before parsing.
    expect(analyze).not.toHaveBeenCalled()
    const unknown = await plugin(`on("ui.render",e=>e.component==="AssistantMessage",()=>null)`)
    expect(routing.qualify([unknown], "AssistantMessage")).toBeUndefined()
    expect(routing.qualify([unknown], "AssistantMessage")).toBeUndefined()
    expect(analyze).toHaveBeenCalledTimes(1)
  })

  it("does not retain disposed VMs and describes the actual bounded routing contract only", async () => {
    const value = await plugin(passive),
      routing = new FunctionDisplayRouting()
    await value.guest.dispose()
    expect(routing.qualify([value], "AssistantMessage")).toBeUndefined()
    expect(routing.qualify([], "AssistantMessage")).toEqual({ native: true, expectedRefs: [] })
    const description = describeFunctionDisplayRouting()
    expect(description.protocol).toBe(FUNCTION_DISPLAY_PROTOCOL)
    expect(description.passiveSites).toEqual(FUNCTION_PASSIVE_DISPLAY_SITES)
    expect(description.siteVocabulary).toEqual(FUNCTION_UI_SITES)
    expect(description.limits.staticSourceCodeUnits).toBe(FUNCTION_DISPLAY_STATIC_SOURCE_LIMIT)
    expect(description.grantsAuthority).toBe(false)
    expect(description.claimsCompleteSdkCompatibility).toBe(false)
    description.passiveSites.pop()
    expect(describeFunctionDisplayRouting().passiveSites).toEqual(FUNCTION_PASSIVE_DISPLAY_SITES)
  })
})
