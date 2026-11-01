import { randomUUID } from "node:crypto"
import { afterEach, expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import type {
  FunctionUiElement,
  FunctionUiNode,
  FunctionUiAction
} from "../../../shared/mods/v2/ui"
import type { FunctionPlacedAnchor } from "../../../shared/mods/v2/placed"
import { consumeUserViewAction } from "./user-view-action"
import { FunctionUiResolveUtilityAssembly } from "./ui-resolve-utility-assembly"
import { FunctionSharedWallCut } from "./shared-wall-cut"

const sessions: FunctionSession[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
})
function button(tree: FunctionUiElement): FunctionUiNode | undefined {
  if (tree.type === "Button") return tree
  for (const node of tree.type === "engine" ? [] : (tree.children ?? [])) {
    if (typeof node === "string") continue
    const found = button(node)
    if (found) return found
  }
  return undefined
}
async function fixture(extra = "", attached = true, name = "cards", view = false, reveal = false) {
  let live = true,
    anchor: FunctionPlacedAnchor | undefined = {
      kind: "after-message",
      id: "native-answer",
      role: "assistant"
    }
  const state = new Map()
  const program = `var __cmbFunctionMod={register(on){
    let n=0,placed;
    on("session.start",async($,e,next)=>{await $.command.register({name:"place-card",description:"Card"});return next(e)});
    on("command.run",{command:"place-card"},async($,e)=>{try{placed=await $.ui.place({id:e.args||"card"});return {text:JSON.stringify(placed)}}catch(error){return {text:JSON.stringify({error:error.code||error.message})}}});
    ${extra}
    on("ui.render",{component:"Placed"},($,e,next)=>{
      if(e.props.plugin!==$.plugin.name)return next(e);
      const {Box,Text,Button}=$.ui.resolve(e);
      return Box({children:[Text({children:e.props.id+":"+n}),Button({key:"add",label:"Add",onPress:async()=>{${view ? 'await $.ui.view({agentId:"child"});' : ""}${reveal ? 'await $.ui.scroll({to:{requestId:placed.requestId},block:"center"});' : ""}n++;await $.store.set("count",n);$.ui.invalidate("ui.render")}})]})
    });
  }}`
  const guest = await FunctionGuestRuntime.create(program)
  const plugin = {
    name,
    root: "/plugin",
    tier: "user" as const,
    guest,
    capabilities: [...SESSION_CAPABILITIES]
  }
  const session = new FunctionSession([plugin], {
    workspace: "/project",
    threadId: "chat",
    assertLive() {
      if (!live) throw Error("revoked")
    },
    publish: async (value) => value,
    agentTask: async (plugin, method) => {
      if (method === "ui.view") {
        const check = consumeUserViewAction(plugin.name)
        check()
        state.set("view", true)
      }
      return {}
    },
    state: () => ({
      get: async (key) => state.get(key),
      keys: async () => [...state.keys()],
      set: async (key, value) => {
        state.set(key, value)
      },
      delete: (key) => {
        state.delete(key)
      }
    }),
    capturePlacedAnchor: () => anchor,
    placedAttached: () => attached
  })
  sessions.push(session)
  return {
    session,
    plugin,
    state,
    revoke: () => {
      live = false
    },
    anchor: (value: FunctionPlacedAnchor | undefined) => {
      anchor = value
    },
    place: async (id = "card") => {
      const value = JSON.parse(String((await session.run("place-card", id)).text))
      if (value.error) throw Error(value.error)
      return value
    }
  }
}
it("places a real QuickJS drawing and callback without opening a Pane; same id keeps the original anchor", async () => {
  const f = await fixture()
  const first = await f.place()
  expect(first).toMatchObject({ isPlaced: true })
  f.anchor({ kind: "after-message", id: "later-message", role: "user" })
  expect(await f.place()).toEqual(first)
  expect(f.session.placed.list()).toHaveLength(1)
  expect(f.session.placed.list()[0].anchor).toMatchObject({ id: "native-answer" })
  expect(await f.session.panes.snapshot()).toEqual([])
  const lease = randomUUID(),
    drawing = await f.session.placed.read(first.requestId, lease)
  const control = button(drawing.tree)!
  expect(control.props.label).toBe("Add")
  const action: FunctionUiAction = {
    pane: drawing.key,
    generation: drawing.generation,
    intentId: randomUUID(),
    plugin: control.press!.plugin,
    handle: control.press!.handle,
    kind: "press"
  }
  await f.session.placed.act(first.requestId, lease, action)
  await f.session.placed.act(first.requestId, lease, action)
  expect(f.state.get("count")).toBe(1)
  const redrawn = await f.session.placed.read(first.requestId, lease)
  expect(JSON.stringify(redrawn.tree)).toContain("card:1")
  await expect(
    f.session.placed.act(first.requestId, lease, { ...action, intentId: randomUUID() })
  ).rejects.toThrow("STALE")
})
it("returns an honest pending/no-conversation result and rejects bad ids and caps", async () => {
  const f = await fixture("", false)
  expect(await f.place()).toMatchObject({
    isPlaced: false,
    reason: "no-surface",
    requestId: expect.any(String)
  })
  f.anchor(undefined)
  expect(await f.place("absent")).toEqual({ isPlaced: false, reason: "no-supported-conversation" })
  await expect(f.place("bad/id")).rejects.toThrow("MODS_UI_PLACE_ARGUMENTS")
  f.anchor({ kind: "start" })
  for (let i = 1; i < 16; i++) await f.place("row" + i)
  expect(await f.place("over-limit")).toEqual({ isPlaced: false, reason: "placed-row-limit" })
})
it("reveals only the exact owned row after a live mounted drawing acknowledgement", async () => {
  const f = await fixture(), placed = await f.place()
  const pending = f.session.placed.reveal(f.plugin, placed.requestId, "center",
    new AbortController().signal, () => {})
  const row = f.session.placed.list()[0]
  expect(row.reveal).toMatchObject({ block: "center" })
  const lease = randomUUID(), drawing = await f.session.placed.read(row.requestId, lease)
  expect(() => f.session.placed.revealAck({ requestId: row.requestId,
    receipt: "old", allowed: true, lease, generation: drawing.generation })).toThrow("STALE")
  f.session.placed.revealAck({ requestId: row.requestId, receipt: row.reveal!.id,
    allowed: true, lease, generation: drawing.generation })
  expect(await pending).toEqual({})
  expect(f.session.placed.list()[0].reveal).toBeUndefined()
  const missing = f.session.placed.reveal(f.plugin, row.requestId, "nearest",
    new AbortController().signal, () => {})
  const receipt = f.session.placed.list()[0].reveal!.id
  f.session.placed.revealAck({ requestId: row.requestId, receipt, allowed: false })
  expect(await missing).toMatchObject({ deny: expect.any(String) })
})
it("routes the real Guest ui.scroll to its owned Placed row under one native user action", async () => {
  const f = await fixture('on("ui.scroll",async($,e,next)=>{await $.store.set("wrong-scroll-event",true);return next(e)})',
    true, "scroll-cards", false, true)
  const row = await f.place(), lease = randomUUID()
  const drawing = await f.session.placed.read(row.requestId, lease), control = button(drawing.tree)!
  const action = f.session.placed.act(row.requestId, lease, { pane: drawing.key,
    generation: drawing.generation, intentId: randomUUID(), plugin: control.press!.plugin,
    handle: control.press!.handle, kind: "press" })
  await expect.poll(() => f.session.placed.list()[0].reveal?.id).toBeTruthy()
  const receipt = f.session.placed.list()[0].reveal!.id
  f.session.placed.revealAck({ requestId: row.requestId, receipt, allowed: true,
    lease, generation: drawing.generation })
  await action
  expect(f.state.get("count")).toBe(1)
  expect(f.state.get("wrong-scroll-event")).toBeUndefined()
})
it("revokes old view leases and old close cannot invalidate a replacement lease", async () => {
  const f = await fixture(),
    placed = await f.place(),
    first = randomUUID(),
    second = randomUUID()
  const drawing = await f.session.placed.read(placed.requestId, first)
  await f.session.placed.read(placed.requestId, second)
  f.session.placed.release(placed.requestId, first)
  const fresh = await f.session.placed.read(placed.requestId, second)
  expect(fresh.generation).not.toBe(drawing.generation)
  f.session.placed.release(placed.requestId, second)
  const control = button(fresh.tree)!
  await expect(
    f.session.placed.act(placed.requestId, second, {
      pane: fresh.key,
      generation: fresh.generation,
      plugin: control.press!.plugin,
      handle: control.press!.handle,
      intentId: randomUUID(),
      kind: "press"
    })
  ).rejects.toThrow()
})
it("clears transient rows and reusing the same id creates a new requestId; stale source and desktop owner cannot act", async () => {
  const f = await fixture(),
    placed = await f.place()
  let current = true
  const drawing = await f.session.placed.read(placed.requestId, randomUUID(), () => {
    if (!current) throw Error("owner changed")
  })
  current = false
  await expect(
    f.session.placed.read(placed.requestId, randomUUID(), () => {
      throw Error("owner changed")
    })
  ).rejects.toThrow("owner changed")
  f.session.placed.clear()
  expect(f.session.placed.list()).toEqual([])
  const next = await f.place()
  expect(next.requestId).not.toBe(placed.requestId)
  expect(drawing.key).not.toBe(`engine:${next.requestId}`)
  await expect(f.session.placed.read(placed.requestId, randomUUID())).rejects.toThrow("STALE")
  f.revoke()
  await expect(f.session.placed.read(next.requestId, randomUUID())).rejects.toThrow("revoked")
})
it("refuses middleware short-circuit and post-next fake successful receipts", async () => {
  const f = await fixture(
    'on("ui.place",($,e)=>({value:{isPlaced:true,requestId:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}}));'
  )
  await expect(f.place()).rejects.toThrow("MODS_UI_PLACE_RESULT")
  expect(f.session.placed.list()).toEqual([])
  const altered = await fixture(
    'on("ui.place",async($,e,next)=>{await next(e);return {value:{isPlaced:true,requestId:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}}});'
  )
  await expect(altered.place()).rejects.toThrow("MODS_UI_PLACE_RESULT")
})
it("pins the placing id and Placed origin props against another middleware", async () => {
  const renamed = await fixture('on("ui.place",($,e,next)=>next({...e,id:"stolen"}));')
  await renamed.place()
  expect(renamed.session.placed.list()[0].id).toBe("card")
  const origin = await fixture(
    'on("ui.render",{component:"Placed"},($,e,next)=>next({...e,props:{...e.props,plugin:"foreign"}}));'
  )
  const row = await origin.place()
  const drawing = await origin.session.placed.read(row.requestId, randomUUID())
  expect(drawing.nativeContent?.entries[0].props.plugin).toBe("cards")
})
it("mints the shared view permit only after an actual current Placed button is admitted", async () => {
  const f = await fixture(`on("ui.render",{component:"Placed"},($,e)=>{
    const {Button}=$.ui.resolve(e);return Button({key:"view",label:"View",onPress:()=>$.ui.view({agentId:"child"})})
  });`)
  await f.place()
  expect(() => consumeUserViewAction("cards")).toThrow("MODS_UI_VIEW_REQUIRES_USER_ACTION")
  const row = f.session.placed.list()[0],
    lease = randomUUID(),
    drawing = await f.session.placed.read(row.requestId, lease)
  const node = button(drawing.tree)!
  await f.session.placed.act(row.requestId, lease, {
    pane: drawing.key,
    generation: drawing.generation,
    intentId: randomUUID(),
    plugin: node.press!.plugin,
    handle: node.press!.handle,
    kind: "press"
  })
  expect(f.state.get("view")).toBe(true)
})
it("keeps identical ids isolated by their actual placing source, and pass draws an empty row", async () => {
  const guests = await Promise.all(
    ["first", "second"].map(() =>
      FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{await $.ui.place({id:"same"});return next(e)});
    on("ui.render",{component:"Placed"},($,e,next)=>{
      if(e.props.plugin!==$.plugin.name||e.props.plugin==="second")return next(e);
      return $.ui.resolve(e).Text({children:e.props.plugin})
    })
  }}`)
    )
  )
  const plugins = guests.map((guest, index) => ({
    name: index ? "second" : "first",
    root: "/plugin",
    tier: "user" as const,
    guest,
    capabilities: [...SESSION_CAPABILITIES]
  }))
  const session = new FunctionSession(plugins, {
    workspace: "/project",
    threadId: "chat",
    assertLive() {
      /* Native fixture source remains active until explicit close. */
    },
    publish: async (value) => value,
    capturePlacedAnchor: () => ({ kind: "start" }),
    placedAttached: () => true
  })
  sessions.push(session)
  await session.start()
  const rows = session.placed.list()
  expect(rows.map((row) => row.plugin).sort()).toEqual(["first", "second"])
  expect(new Set(rows.map((row) => row.requestId)).size).toBe(2)
  for (const row of rows) {
    const drawing = await session.placed.read(row.requestId, randomUUID())
    if (row.plugin === "first") expect(JSON.stringify(drawing.tree)).toContain("first")
    else expect(drawing.tree).toEqual({ type: "Box", props: {}, children: [] })
  }
})
it("prepares real cross-source constructors for Placed in the production utility assembly", async () => {
  const consumer = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("ui.render",{component:"Placed"},($,e)=>$.ui.resolve(e).Button({key:"go",label:"Go",onPress(){}}))
  }}`)
  const style = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("ui.resolve",async($,e,next)=>{const ui=await next(e);return {...ui,Button:props=>ui.Button({...props,label:"Styled "+props.label})}})
  }}`)
  let revision = 1
  const assembly = new FunctionUiResolveUtilityAssembly({
    identity: Object.freeze({}),
    assembly: "placed-assembly",
    requestId: "prepare-placed",
    participants: [consumer, style].map((guest, index) => ({
      runtimeId: index ? "style" : "cards",
      guest,
      declaration: {
        runtimeId: index ? "style" : "cards",
        name: index ? "style" : "cards",
        root: "/plugin",
        tier: "user",
        modelProtocol: "result-v1",
        capabilities: ["ui.resolve"],
        registrations: [...guest.registrations]
      },
      assertCurrent() {
        if (guest.stats.disposed) throw Error("disposed")
      }
    })),
    credit: { revision, limits: { handles: 0, roots: 0, branches: 0, reactions: 0 } },
    startupCutNs: FunctionSharedWallCut.after(120000).expiresAtNs,
    signal: new AbortController().signal,
    host: {
      assertCurrent() {
        /* Fixture keeps the exact source alive. */
      },
      publish() {
        /* No external publication during this constructor-only assertion. */
      },
      async call() {
        throw Error("No SDK effects in a constructor")
      },
      async requestCredit(limits) {
        return { revision: ++revision, limits: { ...limits } }
      }
    }
  })
  try {
    const prepared = await assembly.prepare()
    expect(prepared.sources.cards.Placed).toBeDefined()
    assembly.adopt(prepared.preparedToken)
    const generation = randomUUID()
    const result = await consumer.invoke(
      "0",
      {
        surface: "desktop",
        component: "Placed",
        requestId: "placed-native",
        props: { id: "same", plugin: "cards" }
      },
      async () => ({ value: {} }),
      {
        event: "ui.render",
        plugin: { name: "cards", root: "/plugin" },
        origin: { plugin: "host", tier: "core" },
        uiGeneration: generation,
        capabilities: ["ui.resolve"]
      },
      { assembly: "placed-assembly", token: generation }
    )
    expect(result.value).toMatchObject({
      type: "Button",
      props: { label: "Styled Go" },
      press: { plugin: "cards" }
    })
  } finally {
    assembly.retire()
    consumer.dispose()
    style.dispose()
  }
})
