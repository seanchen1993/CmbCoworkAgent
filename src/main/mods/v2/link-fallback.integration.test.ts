import { randomUUID } from "node:crypto"
import { afterEach, expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { CLIENT_BOOTSTRAP } from "./client-bootstrap"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { functionEngineRefs } from "../../../shared/mods/v2/engine"
import { ordinaryFunctionNode } from "../../../../tests/support/function-ui-node"

const sessions: FunctionSession[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
})

async function fixture(
  href: ModJson,
  client = false,
  publish: (value: ModJson) => Promise<ModJson> = async (value) => value,
  construct = false
) {
  const link = construct
    ? `Link({href:${JSON.stringify(href)},label:"Link text"})`
    : `{type:"Link",props:{href:${JSON.stringify(href)},label:"Link text"},children:[]}`
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    let count=0,overflow=false;
    on("session.start",async($,e,next)=>{for(const name of ["links","links-overflow"])await $.command.register({name,description:name});return next(e)});
    on("command.run",{command:"links"},async($)=>{await $.ui.open({id:"board"});return {}});
    on("command.run",{command:"links-overflow"},async($)=>{overflow=true;await $.ui.invalidate("ui.render");return {}});
    on("ui.fault",async($,e,next)=>{await $.store.set("fault",e);return next(e)});
    on("ui.render",($,e)=>{
      const {Box,Text,Link,Button,Client}=$.ui.resolve(e);
      if(overflow)return Box({children:Array.from({length:700},()=>Link({href:"",label:"Overflow"}))});
      if(${client})return Client({key:"local",module:"surface.tsx"});
      return Box({children:[Text({children:"Sibling remains"}),${link},Button({key:"act",label:"Count:"+count,onPress:async()=>{count++;overflow=false;await $.ui.invalidate("ui.render")}})]})
    }).catch(async($,e,next)=>{await $.store.set("constructor-error",next.error.message);return next(e)});
  }}`)
  const state = new Map<string, ModJson>()
  const session = new FunctionSession(
    [
      {
        name: "links",
        root: "/links",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      threadId: "thread",
      workspace: "/project",
      assertLive: () => {},
      publish,
      loadClient: async () =>
        FunctionGuestRuntime.create(
          CLIENT_BOOTSTRAP +
            `
      var __cmbSurfaceMod={default(_,s){const {Box,Text,Link,Button}=s.elements;
        return Box({children:[Text({children:"Sibling remains"}),${link},Button({key:"act",label:"Count:"+(s.state||0),onPress(){s.setState((s.state||0)+1)}})]})
      }}`,
          { plugin: "links" }
        ),
      state: () => ({
        get: async (key) => state.get(key),
        keys: async () => [...state.keys()],
        set: async (key, value) => {
          state.set(key, value)
        },
        delete: (key) => {
          state.delete(key)
        }
      })
    }
  )
  sessions.push(session)
  await session.run("links", "")
  return { session, state, snapshot: async () => (await session.panes.snapshot())[0] }
}

it.each(["", "javascript:alert(1)", "file:///C:/private", null, 42, { inert: true }])(
  "normalizes actual Pane raw href %j and keeps its sibling control usable",
  async (href) => {
    const f = await fixture(href)
    const pane = await f.snapshot()
    const children = ordinaryFunctionNode(pane.tree).children!.map(ordinaryFunctionNode)
    expect(children[1]).toEqual({ type: "Text", props: {}, children: ["Link text"] })
    await f.session.panes.act({
      pane: pane.key,
      generation: pane.generation,
      intentId: randomUUID(),
      plugin: "links",
      kind: "press",
      handle: ordinaryFunctionNode(children[2]).press!.handle
    })
    expect(ordinaryFunctionNode(ordinaryFunctionNode((await f.snapshot()).tree).children![2]).props.label).toBe(
      "Count:1"
    )
    expect(f.state.has("fault")).toBe(false)
  }
)

it("keeps actual Client local state and sends no fault for an unsupported address", async () => {
  const f = await fixture("javascript:alert(1)", true)
  const pane = await f.snapshot(),
    client = pane.clients![0]
  expect(client.error, JSON.stringify(f.state.get("fault"))).toBeUndefined()
  const children = ordinaryFunctionNode(client.tree).children!.map(ordinaryFunctionNode)
  expect(children[1].type).toBe("Text")
  await f.session.clients.act({
    pane: pane.key,
    instance: client.id,
    generation: client.generation,
    intentId: randomUUID(),
    kind: "press",
    handle: ordinaryFunctionNode(children[2]).press!.handle
  })
  const after = (await f.snapshot()).clients![0]
  expect(after.id).toBe(client.id)
  expect(ordinaryFunctionNode(ordinaryFunctionNode(after.tree).children![2]).props.label).toBe("Count:1")
  expect(f.state.has("fault")).toBe(false)
})

it.each([false, true])(
  "normalizes an unsafe replacement in the final frozen publication, Client=%s",
  async (client) => {
    let replacements = 0
    const f = await fixture("https://example.com/", client, async (value) => {
      const copy = JSON.parse(JSON.stringify(value)) as ModJson
      const replace = (data: ModJson): void => {
        if (Array.isArray(data)) {
          data.forEach(replace)
          return
        }
        if (data && typeof data === "object") {
          if (data.type === "Link") {
            ;(data.props as ModObject).href = "javascript:alert(1)"
            replacements++
          }
          Object.values(data).forEach(replace)
          Object.freeze(data)
        }
      }
      if (Array.isArray(copy)) replace(copy)
      return copy
    })
    const pane = await f.snapshot()
    if (client) expect(pane.clients![0].error, JSON.stringify(f.state.get("fault"))).toBeUndefined()
    const tree = client ? pane.clients![0].tree : pane.tree
    expect(ordinaryFunctionNode(ordinaryFunctionNode(tree).children![1]).type).toBe("Text")
    expect(replacements).toBeGreaterThan(0)
    expect(f.state.has("fault")).toBe(false)
  }
)

it("uses the same final normalization for a real AbovePrompt drawing", async () => {
  const f = await fixture("file:///C:/guide")
  const owner = await f.session.sites.mount("AbovePrompt")
  const result = await f.session.sites.render(owner, {
    isWorking: false,
    bodyColumns: 80,
    maxRows: 8
  })
  expect(ordinaryFunctionNode(ordinaryFunctionNode(result.tree).children![1]).type).toBe("Text")
  await f.session.sites.unmount(owner)
})

it.each([false, true])(
  "refuses non-string Link construction inside the actual VM, Client=%s",
  async (client) => {
    const f = await fixture(42, client, async (value) => value, true)
    if (client) {
      const pane = await f.snapshot()
      expect(pane.clients![0].error).toBeDefined()
      await expect.poll(() => f.state.get("fault")).toBeDefined()
    } else {
      const pane = await f.snapshot()
      // next(e) delegates to the actual native core; it cannot recover the rejected Link.
      const refs = functionEngineRefs(pane.tree)
      expect(pane.tree.type).toBe("engine")
      expect(refs).toHaveLength(1)
      expect(pane.nativeContent?.component).toBe("Pane")
      expect(pane.nativeContent?.entries.map((entry) => entry.ref)).toContain(0)
      expect(pane.nativeContent?.entries.map((entry) => entry.ref)).toContain(refs[0])
      expect(JSON.stringify(pane.nativeContent)).not.toContain('"href"')
      expect(f.state.get("constructor-error")).toContain("MODS_UI_LINK_HREF")
    }
  }
)

it.each([false, true])(
  "refuses a protected publication injecting address controls, Client=%s",
  async (client) => {
    const f = await fixture("https://example.com/", client, async (value) => {
      const copy = JSON.parse(JSON.stringify(value)) as ModJson
      const inject = (data: ModJson): void => {
        if (Array.isArray(data)) {
          data.forEach(inject)
          return
        }
        if (data && typeof data === "object") {
          if (data.type === "Link") (data.props as ModObject).href = "https://example.com/\n"
          Object.values(data).forEach(inject)
        }
      }
      if (Array.isArray(copy)) inject(copy)
      return copy
    })
    await expect(f.snapshot()).rejects.toThrow("MODS_UI_TREE_INVALID")
    expect(f.state.has("fault")).toBe(false)
  }
)

it("preserves the original Pane generation and real callback when normalization rejects a new drawing", async () => {
  const f = await fixture("https://example.com/")
  const original = await f.snapshot()
  const button = ordinaryFunctionNode(ordinaryFunctionNode(original.tree).children![2])
  await f.session.run("links-overflow", "")
  await expect(f.snapshot()).rejects.toThrow("MODS_UI_TREE_INVALID")
  await expect(
    f.session.panes.act({
      pane: original.key,
      generation: original.generation,
      intentId: randomUUID(),
      plugin: "links",
      kind: "press",
      handle: ordinaryFunctionNode(button).press!.handle
    })
  ).resolves.toBeUndefined()
  expect(ordinaryFunctionNode(ordinaryFunctionNode((await f.snapshot()).tree).children![2]).props.label).toBe("Count:1")
})
