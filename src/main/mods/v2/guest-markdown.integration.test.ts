import { afterEach, describe, expect, it, vi } from "vitest"
import { modCompiler } from "../loader"
import type { ModObject } from "../../../shared/mods/types"
import {
  isModObject,
  type FunctionHostCall,
  type FunctionInvocation
} from "../../../shared/mods/v2/contracts"
import { validateFunctionTree } from "../../../shared/mods/v2/ui"
import { FunctionGuestRuntime } from "./guest-runtime"

const guests: FunctionGuestRuntime[] = []
const render = { surface: "desktop", component: "Pane", requestId: "markdown-board", props: {} }
const metadata: FunctionInvocation = {
  event: "ui.render",
  origin: { plugin: "engine", tier: "core" },
  plugin: { name: "markdown-owner", root: "/actual/markdown" },
  capabilities: ["ui.resolve", "store.set", "session.id"],
  uiGeneration: "markdown-drawing-1"
}

afterEach(() => {
  for (const guest of guests.splice(0)) guest.dispose()
})

async function create(body: string, native = true) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("ui.render",($,e)=>{const ui=$.ui.resolve(e);${body}});
  }}`)
  guests.push(guest)
  if (native) guest.bindUiResolveNativeTables()
  return guest
}

async function draw(guest: FunctionGuestRuntime, host: FunctionHostCall = async () => ({})) {
  const result = await guest.invoke("0", render, host, metadata)
  expect(() => validateFunctionTree(result.value)).not.toThrow()
  if (!isModObject(result.value)) throw Error("Actual Markdown drawing required")
  return result.value
}

function callback(guest: FunctionGuestRuntime, tree: ModObject, host: FunctionHostCall,
  event: ModObject = {}, binding: Partial<FunctionInvocation> = {}) {
  if (!isModObject(tree.press) || typeof tree.press.handle !== "number")
    throw Error("Actual private Markdown handle required")
  return guest.invoke("callback", {
    surface: "desktop", component: "Pane", requestId: "markdown-board",
    plugin: "markdown-owner", element: "markdown",
    link: { href: "https://example.test/original" }, ...event
  }, host, {
    ...metadata, event: "ui.press",
    callback: { kind: "onLinkPress", handle: tree.press.handle, generation: "markdown-drawing-1" },
    ...binding
  })
}

describe("real ordinary Guest Markdown", () => {
  it.each([false, true])("preserves the leaf bytes with native cache=%s", async (native) => {
    const text = "# Heading\n\n| A | B |\n| - | - |\n| tab\there | value |\n```ts\nx()\n```\n<context>literal</context>"
    const guest = await create(`return ui.Markdown({text:${JSON.stringify(text)},children:[]});`, native)
    const tree = await draw(guest)
    expect(tree).toEqual({ type: "Markdown", props: { text } })
    expect(Object.hasOwn(tree, "children")).toBe(false)
    expect(Object.hasOwn(tree, "press")).toBe(false)
    expect(guest.stats).toMatchObject({ frames: 0, replies: 0 })
  })

  it("uses the actual TSX compiler and keeps native table/function identity frozen", async () => {
    const compiled = await modCompiler().build({
      stdin: { contents: `export function register(on){on("ui.render",($,e)=>{
        const a=$.ui.resolve(e),b=$.ui.resolve({surface:"desktop",component:"Pane"});
        if(a!==b||a.Markdown!==b.Markdown||!Object.isFrozen(a))throw Error("native cache changed");
        if(Object.keys(a).join(",")!=="Box,Text,Button,Input,Select,Link,Code,Svg,Markdown,Client")
          throw Error("native ten constructors changed");
        const {Markdown}=a;return <><Markdown text={"<context>literal</context>\\n\\ttext"}/></>;
      })}`, loader: "tsx" },
      bundle: true, write: false, format: "iife", globalName: "__cmbFunctionMod",
      platform: "neutral", target: "es2020", logLevel: "silent",
      jsxFactory: "__functionJsx", jsxFragment: "__functionFragment"
    })
    const guest = await FunctionGuestRuntime.create(compiled.outputFiles![0].text)
    guests.push(guest)
    guest.bindUiResolveNativeTables()
    expect(await draw(guest)).toEqual({ type: "fragment", children: [{
      type: "Markdown", props: { text: "<context>literal</context>\n\ttext" }
    }] })
    expect(guest.uiResolverActivityStats).toEqual({ roots: 0, reactions: 0 })
  })

  it("keeps a link closure private and passes the actual link and event to Q", async () => {
    const guest = await create(`return ui.Markdown({key:"markdown",text:"[original](https://example.test/original)",
      onLinkPress:async(link,e)=>{await Promise.resolve();await $.store.set("link",{
        link,event:e.link,plugin:e.plugin,element:e.element,requestId:e.requestId,
        component:e.component,surface:e.surface});}});`)
    const tree = await draw(guest)
    expect(tree.press).toMatchObject({ kind: "onLinkPress", plugin: "markdown-owner" })
    expect((tree.props as ModObject).onLinkPress).toBeUndefined()
    const host = vi.fn<FunctionHostCall>(async () => ({ value: {} }))
    await callback(guest, tree, host, { link: { href: "callback-business-data" } })
    expect(host).toHaveBeenCalledExactlyOnceWith("store.set", ["link", {
      link: { href: "callback-business-data" }, event: { href: "callback-business-data" },
      plugin: "markdown-owner", element: "markdown", requestId: "markdown-board",
      component: "Pane", surface: "desktop"
    }], expect.any(AbortSignal))
  })

  it("does not reapply an original list after the native press chain rewrites href", async () => {
    const guest = await create(`return ui.Markdown({key:"markdown",text:"[original](https://example.test/original)",
      pressableLinks:["https://example.test/original"],onLinkPress:link=>$.store.set("business",link)});`)
    const tree = await draw(guest)
    const host = vi.fn<FunctionHostCall>(async () => ({ value: {} }))
    await callback(guest, tree, host, { link: { href: "https://rewritten.test/business" } })
    expect(host).toHaveBeenCalledExactlyOnceWith("store.set",
      ["business", { href: "https://rewritten.test/business" }], expect.any(AbortSignal))
  })

  it("accepts all adjacent text/list/href limits and omits undefined optional props", async () => {
    const guest = await create(`return ui.Markdown({key:"markdown",text:"x".repeat(10000),dimColor:true,
      pressableLinks:Array.from({length:256},()=>"h".repeat(2048)),onLinkPress:()=>{}});`)
    const tree = await draw(guest)
    const props = tree.props as ModObject
    expect((props.text as string).length).toBe(10000)
    expect(props.pressableLinks).toHaveLength(256)
    const display = await create(`return ui.Markdown({text:"",key:undefined,dimColor:undefined,
      pressableLinks:undefined,onLinkPress:undefined,children:undefined});`)
    expect(await draw(display)).toEqual({ type: "Markdown", props: { text: "" } })
  })

  it.each([
    ["missing text", `{}`],
    ["text limit", `{text:"x".repeat(10001)}`],
    ["control", `{text:"\\u0000"}`],
    ["dimColor", `{text:"x",dimColor:"yes"}`],
    ["empty key", `{text:"x",key:""}`],
    ["callback type", `{text:"x",key:"markdown",onLinkPress:1}`],
    ["callback without key", `{text:"x",onLinkPress:()=>{}}`],
    ["list without callback", `{text:"x",pressableLinks:[]}`],
    ["list limit", `{text:"x",key:"markdown",onLinkPress:()=>{},pressableLinks:Array(257).fill("x")}`],
    ["href limit", `{text:"x",key:"markdown",onLinkPress:()=>{},pressableLinks:["h".repeat(2049)]}`],
    ["empty href", `{text:"x",key:"markdown",onLinkPress:()=>{},pressableLinks:[""]}`],
    ["sparse list", `{text:"x",key:"markdown",onLinkPress:()=>{},pressableLinks:new Array(1)}`],
    ["nonempty children", `{text:"x",children:["child"]}`],
    ["foreign display field", `{text:"x",nativeContent:{component:"Pane",entries:[]}}`]
  ])("rejects %s in the actual constructor", async (_name, input) => {
    const guest = await create(`return ui.Markdown(${input});`)
    const host = vi.fn<FunctionHostCall>(async () => ({}))
    await expect(guest.invoke("0", render, host, metadata)).rejects.toThrow()
    expect(host).not.toHaveBeenCalled()
  })

  it.each(["children", "client"])("rejects raw Markdown %s metadata", async (field) => {
    const guest = await create(`return {type:"Markdown",props:{text:"x"},${field}:[]};`)
    await expect(guest.invoke("0", render, async () => ({}), metadata))
      .rejects.toThrow("MODS_UI_MARKDOWN_INVALID")
  })

  it.each<ModObject | { link: undefined }>([
    { requestId: "other-request" }, { component: "Hint" }, { plugin: "other" },
    { element: "other" }, { link: undefined }, { link: { href: "" } },
    { link: { href: "x", authority: "forged" } }
  ])("rejects stale or malformed callback input %j", async (event) => {
    const guest = await create(`return ui.Markdown({key:"markdown",text:"[x](https://example.test/original)",
      onLinkPress:()=>$.store.set("must-not-write",1)});`)
    const tree = await draw(guest)
    const host = vi.fn<FunctionHostCall>(async () => ({}))
    // An omitted link is represented by actual omission, never undefined ModJSON.
    const actual = { ...event } as ModObject
    if (event.link === undefined && Object.hasOwn(event, "link")) delete actual.link
    const base: ModObject = { surface: "desktop", component: "Pane", requestId: "markdown-board",
      plugin: "markdown-owner", element: "markdown", ...actual }
    if (!Object.hasOwn(event, "link")) base.link = { href: "https://example.test/original" }
    if (!isModObject(tree.press)) throw Error("Actual handle required")
    await expect(guest.invoke("callback", base, host, { ...metadata, event: "ui.press",
      callback: { handle: tree.press.handle as number, generation: "markdown-drawing-1", kind: "onLinkPress" }
    })).rejects.toThrow()
    expect(host).not.toHaveBeenCalled()
  })

  it("releases the actual Markdown handle and leaves old Button link rejection intact", async () => {
    const guest = await create(`return ui.Markdown({key:"markdown",text:"x",onLinkPress:()=>$.session.id()});`)
    const tree = await draw(guest)
    guest.releaseUi("markdown-drawing-1")
    const host = vi.fn<FunctionHostCall>(async () => ({ value: "actual-session" }))
    await expect(callback(guest, tree, host)).rejects.toThrow("MODS_UI_STALE_ACTION")
    expect(host).not.toHaveBeenCalled()
    const button = await create(`return ui.Button({key:"button",label:"Button",onPress:()=>$.session.id()});`)
    const buttonTree = await draw(button)
    if (!isModObject(buttonTree.press)) throw Error("Actual Button handle required")
    await expect(button.invoke("callback", { ...render, plugin: "markdown-owner", element: "button",
      link: { href: "https://example.test/original" } }, host, { ...metadata, event: "ui.press",
      callback: { handle: buttonTree.press.handle as number, generation: "markdown-drawing-1", kind: "onPress" }
    })).rejects.toThrow("MODS_UI_MARKDOWN_INVALID")
    expect(host).not.toHaveBeenCalled()
  })

  it("rejects another drawing generation without borrowing the current handle", async () => {
    const guest = await create(`return ui.Markdown({key:"markdown",text:"x",
      onLinkPress:()=>$.session.id()});`)
    const tree = await draw(guest)
    if (!isModObject(tree.press)) throw Error("Actual Markdown handle required")
    const host = vi.fn<FunctionHostCall>(async () => ({ value: "actual-session" }))
    await expect(callback(guest, tree, host, {}, {
      callback: {
        handle: tree.press.handle as number, kind: "onLinkPress", generation: "another-drawing"
      }
    })).rejects.toThrow("MODS_UI_STALE_ACTION")
    expect(host).not.toHaveBeenCalled()
  })
})
