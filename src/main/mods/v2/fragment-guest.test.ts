import { afterEach, describe, expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import type { FunctionInvocation } from "../../../shared/mods/v2/contracts"
import { validateFunctionAskTree } from "../../../shared/mods/v2/engine"
import { validateFunctionTree } from "../../../shared/mods/v2/ui"

const guests: FunctionGuestRuntime[] = []
const render = { surface: "desktop", component: "Pane", requestId: "board", props: {} }
const metadata: FunctionInvocation = {
  event: "ui.render",
  origin: { plugin: "engine", tier: "core" },
  plugin: { name: "fragment", root: "/fragment" },
  capabilities: ["ui.resolve", "session.id"],
  uiGeneration: "fragment-drawing"
}

async function guest(hook: string) {
  const result = await FunctionGuestRuntime.create(
    `var __cmbFunctionMod={register(on){${hook}}}`
  )
  guests.push(result)
  return result
}
afterEach(() => { for (const runtime of guests.splice(0)) runtime.dispose() })

describe("real guest transparent Fragment provenance", () => {
  it.each([
    'props:{key:"forged"}',
    'press:{plugin:"other",handle:1}',
    'client:{plugin:"other"}',
    "ref:0"
  ])("rejects nonstructural Fragment metadata before any host effect: %s", async extra => {
    const runtime = await guest(
      `on("ui.render",()=>({type:"fragment",children:[],${extra}}));`
    )
    let effects = 0
    await expect(runtime.invoke("0", render, async () => {
      effects++
      return {}
    }, metadata)).rejects.toThrow("MODS_UI_TREE_INVALID")
    expect(effects).toBe(0)
  })

  it("keeps an actual nested control callback on its original owner until release", async () => {
    const runtime = await guest(`on("ui.render",($,e)=>{
      const {Button}=$.ui.resolve(e);
      return h(Fragment,null,h(Fragment,null,Button({key:"real",label:"Real",
        onPress:()=>$.session.id()})))
    });`)
    const result = await runtime.invoke("0", render, async () => ({}), metadata)
    validateFunctionTree(result.value)
    const root = result.value
    if (root.type !== "fragment") throw Error("fragment required")
    const nested = root.children[0]
    if (typeof nested === "string" || nested.type !== "fragment") throw Error("nested required")
    const button = nested.children[0]
    if (typeof button === "string" || button.type !== "Button" || !button.press)
      throw Error("button required")
    expect(Object.keys(root)).toEqual(["type", "children"])
    expect(Object.keys(nested)).toEqual(["type", "children"])
    expect(button.press.plugin).toBe("fragment")
    const event = { ...render, plugin: "fragment", element: "real" }
    const callback: FunctionInvocation = {
      ...metadata, event: "ui.press",
      callback: { handle: button.press.handle, generation: metadata.uiGeneration!, kind: "onPress" }
    }
    let effects = 0
    const host = async (method: string) => {
      expect(method).toBe("session.id")
      effects++
      return { value: "actual" }
    }
    await runtime.invoke("callback", event, host, callback)
    expect(effects).toBe(1)
    runtime.releaseUi(metadata.uiGeneration!)
    await expect(runtime.invoke("callback", event, host, callback)).rejects.toThrow(
      "MODS_UI_STALE_ACTION"
    )
    expect(effects).toBe(1)
  })

  it("does not inherit a forged child callback through a legitimate next Fragment", async () => {
    const runtime = await guest(`on("ui.render",async($,e,next)=>{
      await next(e);
      return h(Fragment,null,{type:"Button",props:{key:"forged",label:"Forged"},
        press:{plugin:"other",handle:7}})
    });`)
    let nextCalls = 0
    await expect(runtime.invoke("0", render, async method => {
      expect(method).toBe("next")
      nextCalls++
      return { value: { type: "fragment", children: [{ type: "engine", ref: 0 }] } }
    }, metadata)).rejects.toThrow("MODS_UI_ACTION_OWNER")
    expect(nextCalls).toBe(1)
  })

  it("preserves an empty tail structurally so the Ask validator can reject it", async () => {
    const runtime = await guest(`on("ui.render",()=>h(Fragment,null,
      {type:"engine",ref:0},h(Fragment,null)));
    `)
    const result = await runtime.invoke("0", render, async () => ({}), metadata)
    expect(result.value).toEqual({
      type: "fragment", children: [{ type: "engine", ref: 0 }, { type: "fragment", children: [] }]
    })
    expect(() => validateFunctionAskTree(result.value)).toThrow("MODS_UI_ASK_TREE_INVALID")
  })
})
