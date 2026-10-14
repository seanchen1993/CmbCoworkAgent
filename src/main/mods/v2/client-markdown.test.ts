import { afterEach, describe, expect, it } from "vitest"
import { CLIENT_BOOTSTRAP } from "./client-bootstrap"
import { FunctionGuestRuntime } from "./guest-runtime"
import { ModSurfaceRuntime } from "./surface-runtime"
import type { ModObject } from "../../../shared/mods/types"

const close: Array<() => void> = []
afterEach(() => close.splice(0).forEach((dispose) => dispose()))

async function client(body: string) {
  const runtime = await FunctionGuestRuntime.create(
    CLIENT_BOOTSTRAP + `\nvar __cmbSurfaceMod={default(props,surface){${body}}}`,
    { plugin: "markdown-client" }
  )
  close.push(() => runtime.dispose())
  const registration = runtime.registrations.find((row) => row.pattern === "surface.update")!
  const update = async (event: ModObject) => (await runtime.invoke(registration.id, event,
    async () => { throw Error("No ambient host capability") }, {
      event: "surface.update", origin: { plugin: "engine", tier: "core" },
      capabilities: [], plugin: { name: "markdown-client", root: "" }
    })).value
  return { update }
}

describe("independent Client Markdown constructors", () => {
  it("publishes a frozen leaf with no children, closure or host metadata", async () => {
    const current = await client(`const {Markdown}=surface.elements;
      const leaf=Markdown({text:"# Report",dimColor:true,children:[]});
      if(!Object.isFrozen(leaf)||!Object.isFrozen(leaf.props))throw Error("not frozen");
      return leaf;`)
    const result = await current.update({ kind: "render", props: {}, columns: 10, rows: 5 })
    if (!result || typeof result !== "object" || Array.isArray(result)) throw Error("snapshot")
    expect(result.tree).toEqual({ type: "Markdown", props: { text: "# Report", dimColor: true } })
  })

  it.each([
    `onLinkPress:()=>{throw Error("must not execute")}`,
    `pressableLinks:["https://example.test/report"]`,
    `press:{plugin:"Q",handle:1}`,
    `children:["not a leaf"]`,
    `text:"x".repeat(10001)`,
    `text:"bad\\u0000text"`
  ])("rejects ordinary Hook privileges or invalid leaf fields: %s", async (field) => {
    const current = await client(`return surface.elements.Markdown({text:"Report",${field}});`)
    await expect(current.update({ kind: "render", props: {}, columns: 10, rows: 5 }))
      .rejects.toThrow("MODS_UI_MARKDOWN_INVALID")
  })

  it("rejects a getter before executing it", async () => {
    const current = await client(`const value={};
      Object.defineProperty(value,"text",{enumerable:true,get(){throw Error("getter executed")}});
      return surface.elements.Markdown(value);`)
    await expect(current.update({ kind: "render", props: {}, columns: 10, rows: 5 }))
      .rejects.toThrow("MODS_UI_MARKDOWN_INVALID")
  })

  it("retains the real surface pointer state and existing Button callback", async () => {
    const current = await client(`const {Box,Markdown,Button}=surface.elements;
      if(surface.state===undefined){surface.setState(0);
        surface.onPointer(()=>surface.setState(surface.state+1));}
      return Box({children:[Markdown({text:"Count "+surface.state}),
        Button({key:"old",label:"Old button",onPress:()=>surface.setState(surface.state+1)})]});`)
    const first = await current.update({ kind: "render", props: {}, columns: 10, rows: 5 })
    expect(JSON.stringify(first)).toContain("Count 0")
    await current.update({ kind: "pointer", value: { type: "down", x: 0, y: 0 } })
    const second = await current.update({ kind: "frame" })
    expect(JSON.stringify(second)).toContain("Count 1")
    if (!second || typeof second !== "object" || Array.isArray(second)) throw Error("snapshot")
    const tree = second.tree
    if (!tree || typeof tree !== "object" || Array.isArray(tree) || !Array.isArray(tree.children))
      throw Error("tree")
    const button = tree.children[1]
    if (!button || typeof button !== "object" || Array.isArray(button)) throw Error("button")
    const press = button.press
    if (!press || typeof press !== "object" || Array.isArray(press) ||
      typeof press.handle !== "number") throw Error("press")
    await current.update({ kind: "control", handle: press.handle, callback: "onPress",
      event: { element: "old" } })
    expect(JSON.stringify(await current.update({ kind: "frame" }))).toContain("Count 2")
  })

  it("uses the same strict leaf in the original isolated surface runtime", async () => {
    const runtime = await ModSurfaceRuntime.create(`var __cmbSurfaceMod={default(_,surface){
      return h(Fragment,null,h(surface.elements.Markdown,{text:"# Surface"}));}}`)
    close.push(() => runtime.dispose())
    expect((await runtime.update({ kind: "render", props: {}, columns: 10, rows: 5 })).tree)
      .toEqual({ type: "fragment", children: [{ type: "Markdown", props: { text: "# Surface" } }] })
  })
})
