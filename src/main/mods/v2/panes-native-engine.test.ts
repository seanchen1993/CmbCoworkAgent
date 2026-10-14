import { randomUUID } from "node:crypto"
import { afterEach, expect, it } from "vitest"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import { functionEngineRefs } from "../../../shared/mods/v2/engine"
import type {
  FunctionPaneSnapshot,
  FunctionUiElement,
  FunctionUiNode
} from "../../../shared/mods/v2/ui"
import type { UserInputRequest } from "../../types"
import { CLIENT_BOOTSTRAP } from "./client-bootstrap"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"

const sessions: FunctionSession[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
})

const questions = [
  {
    id: "choice",
    header: "Plan",
    question: "Actual question?",
    options: [
      { label: "Yes", description: "Proceed" },
      { label: "No", description: "Stop" }
    ]
  }
]
const request = (id: string): Readonly<UserInputRequest> => ({
  requestId: id,
  threadId: "thread",
  createdAt: "2026-10-04T00:00:00.000Z",
  questions: structuredClone(questions)
})
const questionProps = { tool: "request_user_input", questions }
const hintProps = { hint: "private original", isWorking: false, isDraft: false }
const clientCode = `var __cmbSurfaceMod={default(p,s){return s.elements.Button({
  key:"client-button",label:p.label+":"+(s.state||0),onPress(){
    s.setState((s.state||0)+1);s.post({count:s.state})
  }
})}}`

async function fixture(
  hooks = "",
  options: {
    publish?: (value: ModJson) => Promise<ModJson>
    pendingQuestion?: () => Readonly<UserInputRequest> | null
    modules?: Map<string, string>
  } = {}
) {
  let live = true
  const state = new Map<string, ModJson>()
  const waits = new Map<
    string,
    {
      entered: ReturnType<typeof Promise.withResolvers<void>>
      release: ReturnType<typeof Promise.withResolvers<void>>
    }
  >()
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${hooks}}}`)
  const guests: FunctionGuestRuntime[] = []
  const modules = options.modules ?? new Map([["client.js", clientCode]])
  const session = new FunctionSession(
    [
      {
        name: "p",
        root: "/p",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/project",
      threadId: "thread",
      assertLive() {
        if (!live) throw new ModFunctionError("MODS_TEST_REVOKED")
      },
      publish: options.publish ?? (async (value) => value),
      pendingQuestion: options.pendingQuestion,
      checkClientModule(plugin, module) {
        if (plugin !== "p" || !modules.has(module))
          throw new ModFunctionError("MODS_CLIENT_MODULE_UNAPPROVED")
      },
      async loadClient(plugin, module) {
        if (plugin !== "p" || !modules.has(module)) throw Error("unapproved")
        const loaded = await FunctionGuestRuntime.create(
          CLIENT_BOOTSTRAP + "\n" + modules.get(module),
          { plugin }
        )
        guests.push(loaded)
        return loaded
      },
      state: () => ({
        async get(key) {
          const wait = waits.get(key)
          if (wait) {
            wait.entered.resolve()
            await wait.release.promise
          }
          return state.get(key)
        },
        keys: async () => [...state.keys()],
        async set(key, value) {
          state.set(key, value)
        },
        delete(key) {
          state.delete(key)
        }
      })
    }
  )
  sessions.push(session)
  await session.start()
  return {
    session,
    guest,
    state,
    guests,
    revoke() {
      live = false
    },
    barrier(key: string) {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      waits.set(key, { entered, release })
      return {
        entered: entered.promise,
        release() {
          waits.delete(key)
          release.resolve()
        }
      }
    }
  }
}

function findButton(tree: FunctionUiElement, key: string): FunctionUiNode {
  if (tree.type === "engine") throw Error("button missing")
  if (tree.type === "Button" && tree.props.key === key) return tree
  for (const child of tree.children ?? []) {
    if (typeof child !== "string") {
      try {
        return findButton(child, key)
      } catch {
        /* Search the next sibling. */
      }
    }
  }
  throw Error("button missing")
}
async function press(f: Awaited<ReturnType<typeof fixture>>, pane: FunctionPaneSnapshot) {
  const node = findButton(pane.tree, "parent-button")
  await f.session.panes.act({
    pane: pane.key,
    generation: pane.generation,
    plugin: node.press!.plugin,
    handle: node.press!.handle,
    kind: "press",
    intentId: randomUUID()
  })
}
async function clientPress(f: Awaited<ReturnType<typeof fixture>>, pane: FunctionPaneSnapshot) {
  const client = pane.clients![0]
  const node = findButton(client.tree, "client-button")
  await f.session.clients.act({
    pane: pane.key,
    instance: client.id,
    generation: client.generation,
    handle: node.press!.handle,
    kind: "press",
    intentId: randomUUID()
  })
}

it("publishes an actual default Pane delegate with protected native title and no forged Text fallback", async () => {
  const f = await fixture("", {
    publish: async (value) =>
      JSON.parse(JSON.stringify(value).replaceAll("Private title", "Safe title"))
  })
  f.session.panes.open("p", { id: "pane", title: "Private title" })
  const [pane] = await f.session.panes.snapshot()
  expect(pane.tree.type).toBe("engine")
  expect(pane.nativeContent?.component).toBe("Pane")
  expect(pane.nativeContent?.entries.map((entry) => entry.props.title)).toEqual([
    "Safe title",
    "Safe title"
  ])
  expect(pane.title).toBe("Safe title")
  expect(JSON.stringify(pane)).not.toContain("Private title")
})

it("keeps old actual callbacks, VM and accepted props when a protected parent preflight fails", async () => {
  let inject = false
  const f = await fixture(
    `
    on("ui.render",($,e)=>{
      const {Box,Button,Client}=$.ui.resolve(e);
      return Box({children:[Button({key:"parent-button",label:"Parent",async onPress(){
        await $.store.set("parent-click",true)
      }}),Client({key:"surface",module:"client.js",props:{label:"Before"}})]})
    });
    on("ui.message",async($,e)=>{await $.store.set("client-message",e.data);return {props:{label:"Accepted"}}});
  `,
    {
      publish: async (value) => {
        if (!inject || !Array.isArray(value)) return value
        return value.map((row) =>
          isModObject(row) && row.tree
            ? {
                ...row,
                tree: {
                  type: "Client",
                  props: { key: "surface", module: "missing.js", props: { label: "Changed" } },
                  client: { plugin: "p" }
                }
              }
            : row
        )
      }
    }
  )
  f.session.panes.open("p", { id: "pane" })
  let [old] = await f.session.panes.snapshot()
  await clientPress(f, old)
  await expect
    .poll(async () => {
      const [current] = await f.session.panes.snapshot()
      return findButton(current.clients![0].tree, "client-button").props.label
    })
    .toBe("Accepted:1")
  ;[old] = await f.session.panes.snapshot()
  inject = true
  await expect(f.session.panes.snapshot()).rejects.toThrow("MODS_CLIENT_MODULE_UNAPPROVED")
  expect(f.guests).toHaveLength(1)
  expect(f.guests[0].stats.disposed).toBe(false)
  await press(f, old)
  await clientPress(f, old)
  await expect.poll(() => f.state.get("client-message")).toEqual({ count: 2 })
  expect(f.state.get("parent-click")).toBe(true)
  inject = false
  await expect
    .poll(async () => {
      const [current] = await f.session.panes.snapshot()
      return findButton(current.clients![0].tree, "client-button").props.label
    })
    .toBe("Accepted:2")
  const [same] = await f.session.panes.snapshot()
  expect(same.generation).toBe(old.generation)
  expect(same.clients![0].id).toBe(old.clients![0].id)
  expect(findButton(same.clients![0].tree, "client-button").props.label).toBe("Accepted:2")
})

it("protects actual newly referenced core props after the protected tree changes refs", async () => {
  const refs: number[][] = []
  const f = await fixture(
    `on("ui.render",{component:"PromptHint"},async($,e,next)=>{
    await next({...e,props:{...e.props,hint:"private rewritten"}});
    return {type:"engine",ref:0}
  });`,
    {
      publish: async (value) => {
        if (!Array.isArray(value)) return value
        if (value.every((row) => isModObject(row) && typeof row.ref === "number")) {
          refs.push(value.map((row) => (row as ModObject).ref as number))
          return value.map((row) => ({
            ...(row as ModObject),
            props: {
              ...((row as ModObject).props as ModObject),
              hint: "Safe delegate"
            }
          }))
        }
        return value.map((row) =>
          isModObject(row) && row.tree ? { ...row, tree: { type: "engine", ref: 1 } } : row
        )
      }
    }
  )
  const owner = await f.session.sites.mount("PromptHint")
  const pane = await f.session.sites.render(owner, hintProps)
  expect(refs).toEqual([[0], [1]])
  expect(pane.tree).toEqual({ type: "engine", ref: 1 })
  expect(pane.nativeContent?.entries.map((entry) => entry.props.hint)).toEqual([
    "Safe delegate",
    "Safe delegate"
  ])
  expect(JSON.stringify(pane)).not.toContain("private")
})

it("reruns native policy on a cached drawing without rerunning the parent Hook", async () => {
  let policy = "Safe one"
  let publications = 0
  const f = await fixture(
    `on("ui.render",{component:"PromptHint"},async($,e,next)=>{
    await $.store.set("draws",(await $.store.get("draws")||0)+1);return next(e)
  });`,
    {
      publish: async (value) => {
        if (
          !Array.isArray(value) ||
          !value.every((row) => isModObject(row) && typeof row.ref === "number")
        )
          return value
        publications++
        return value.map((row) => ({
          ...(row as ModObject),
          props: {
            ...((row as ModObject).props as ModObject),
            hint: policy
          }
        }))
      }
    }
  )
  const owner = await f.session.sites.mount("PromptHint")
  const first = await f.session.sites.render(owner, hintProps)
  policy = "Safe two"
  const second = await f.session.sites.render(owner, hintProps)
  expect(second.generation).toBe(first.generation)
  expect(f.state.get("draws")).toBe(1)
  expect(publications).toBe(2)
  expect(first.nativeContent?.entries.every((entry) => entry.props.hint === "Safe one")).toBe(true)
  expect(second.nativeContent?.entries.every((entry) => entry.props.hint === "Safe two")).toBe(true)
})

it("keeps the real in-flight message receipt and accepted props across a clean cached parent publication", async () => {
  const f = await fixture(`on("ui.render",($,e)=>$.ui.resolve(e).Client({
    key:"surface",module:"client.js",props:{label:"Before"}
  }));on("ui.message",async($,e)=>{
    await $.store.get("message-barrier");
    await $.store.set("delivered",e.data);return {props:{label:"Accepted"}}
  });`)
  f.session.panes.open("p", { id: "pane" })
  const [old] = await f.session.panes.snapshot()
  const gate = f.barrier("message-barrier")
  await clientPress(f, old)
  await gate.entered
  const [cached] = await f.session.panes.snapshot()
  expect(cached.generation).toBe(old.generation)
  expect(cached.clients![0].id).toBe(old.clients![0].id)
  expect(f.state.has("delivered")).toBe(false)
  gate.release()
  await expect.poll(() => f.state.get("delivered")).toEqual({ count: 1 })
  await expect
    .poll(async () => {
      const [pane] = await f.session.panes.snapshot()
      return findButton(pane.clients![0].tree, "client-button").props.label
    })
    .toBe("Accepted:1")
  expect(f.guests).toHaveLength(1)
  expect(f.guests[0].stats.disposed).toBe(false)
})

it("does not admit an old Client while an actual replacement parent is pending", async () => {
  const f = await fixture(`on("ui.render",async($,e)=>{
    await $.store.get("render-barrier");return $.ui.resolve(e).Client({key:"surface",module:"client.js",props:{label:"Source"}})
  });on("ui.message",async($,e)=>{await $.store.set("message",e.data);return {}});`)
  f.session.panes.open("p", { id: "pane" })
  const [old] = await f.session.panes.snapshot()
  const gate = f.barrier("render-barrier")
  f.session.panes.invalidate()
  const drawing = f.session.panes.snapshot()
  await gate.entered
  await expect(clientPress(f, old)).rejects.toThrow()
  expect(f.state.has("message")).toBe(false)
  expect(f.guests).toHaveLength(1)
  expect(f.guests[0].stats.disposed).toBe(false)
  gate.release()
  const [current] = await drawing
  await clientPress(f, current)
  await expect.poll(() => f.state.get("message")).toEqual({ count: 1 })
})

it("rejects an actual request replacement across native publication and requires the new expected request ID", async () => {
  let actual: Readonly<UserInputRequest> | null = request("R1")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let block = true
  const f = await fixture("", {
    pendingQuestion: () => actual,
    publish: async (value) => {
      if (
        block &&
        Array.isArray(value) &&
        value.some((row) => isModObject(row) && typeof row.ref === "number")
      ) {
        entered.resolve()
        await release.promise
      }
      return value
    }
  })
  await expect(f.session.sites.mount("AskUserQuestion")).rejects.toThrow("MODS_UI_QUESTION_STALE")
  const owner = await f.session.sites.mount("AskUserQuestion", undefined, "R1")
  const pending = f.session.sites.render(owner, questionProps)
  const rejected = expect(pending).rejects.toThrow("MODS_UI_QUESTION_STALE")
  await entered.promise
  actual = request("R2")
  release.resolve()
  await rejected
  await expect(f.session.sites.mount("AskUserQuestion", undefined, "R1")).rejects.toThrow(
    "MODS_UI_QUESTION_STALE"
  )
  block = false
  const nextOwner = await f.session.sites.mount("AskUserQuestion", undefined, "R2")
  const current = await f.session.sites.render(nextOwner, questionProps)
  expect(functionEngineRefs(current.tree)).toHaveLength(1)
  expect(current.nativeContent?.requestId).toBe("R2")
  expect(current.nativeContent?.entries).not.toHaveLength(0)
  for (const entry of current.nativeContent!.entries)
    expect(entry.props.questions).toEqual(questions)
  await expect(f.session.sites.render(owner, questionProps)).rejects.toThrow("MODS_UI_SITE_CLOSED")
})

it("augments legacy Ask descriptions with one actual control delegate at the tail", async () => {
  const actual = request("R1")
  const f = await fixture(
    `on("ui.render",{component:"AskUserQuestion"},($,e)=>
    $.ui.resolve(e).Text({children:"Review context"}));`,
    { pendingQuestion: () => actual }
  )
  const owner = await f.session.sites.mount("AskUserQuestion", undefined, "R1")
  const pane = await f.session.sites.render(owner, questionProps)
  expect(pane.tree).toEqual({
    type: "Box",
    props: {},
    children: [
      { type: "Text", props: {}, children: ["Review context"] },
      { type: "engine", ref: 0 }
    ]
  })
  expect(pane.nativeContent?.requestId).toBe("R1")
  expect(pane.nativeContent?.entries).toEqual([{ ref: 0, props: questionProps }])
})

it("does not let an entered Ask callback borrow the next actual request", async () => {
  let actual: Readonly<UserInputRequest> | null = request("R1")
  const f = await fixture(
    `on("ui.render",{component:"AskUserQuestion"},($,e)=>
    $.ui.resolve(e).Button({key:"parent-button",label:"Context",async onPress(){
      await $.store.get("callback-barrier");await $.store.set("old-request-effect",true)
    }}));`,
    { pendingQuestion: () => actual }
  )
  const owner = await f.session.sites.mount("AskUserQuestion", undefined, "R1")
  const pane = await f.session.sites.render(owner, questionProps)
  const node = findButton(pane.tree, "parent-button")
  const gate = f.barrier("callback-barrier")
  const pending = f.session.sites.act(owner, {
    pane: pane.key,
    generation: pane.generation,
    plugin: node.press!.plugin,
    handle: node.press!.handle,
    kind: "press",
    intentId: randomUUID()
  })
  const settled = pending.then(
    () => ({ rejected: false }),
    () => ({ rejected: true })
  )
  await gate.entered
  actual = request("R2")
  gate.release()
  expect({ ...(await settled), effect: f.state.has("old-request-effect") }).toEqual({
    rejected: true,
    effect: false
  })
})

it("does not let an entered Ask Client message retain authority after the actual request changes", async () => {
  let actual: Readonly<UserInputRequest> | null = request("R1")
  const f = await fixture(
    `on("ui.render",{component:"AskUserQuestion"},($,e)=>{
    const {Box,Client}=$.ui.resolve(e);return Box({children:[Client({
      key:"surface",module:"client.js",props:{label:"Source"}
    }),{type:"engine",ref:0}]})
  });on("ui.message",async($,e)=>{
    await $.store.get("client-request-barrier");await $.store.set("old-client-request-effect",true);return {}
  });`,
    { pendingQuestion: () => actual }
  )
  const owner = await f.session.sites.mount("AskUserQuestion", undefined, "R1")
  const pane = await f.session.sites.render(owner, questionProps)
  const gate = f.barrier("client-request-barrier")
  await clientPress(f, pane)
  await gate.entered
  actual = request("R2")
  gate.release()
  await expect.poll(() => f.guest.stats.frames).toBe(0)
  expect(f.state.has("old-client-request-effect")).toBe(false)
})

it.each([
  '{type:"Box",props:{},children:[{type:"engine",ref:0},{type:"engine",ref:1}]}',
  '{type:"Box",props:{},children:[{type:"engine",ref:0},{type:"Text",props:{},children:[]}]}',
  '{type:"Box",props:{height:0},children:[{type:"engine",ref:0}]}'
])(
  "refuses explicit Ask drawings that duplicate, follow or conceal the real controls: %s",
  async (tree) => {
    const actual = request("R1")
    const f = await fixture(`on("ui.render",{component:"AskUserQuestion"},()=>(${tree}));`, {
      pendingQuestion: () => actual
    })
    const owner = await f.session.sites.mount("AskUserQuestion", undefined, "R1")
    await expect(f.session.sites.render(owner, questionProps)).rejects.toThrow(
      "MODS_UI_ASK_TREE_INVALID"
    )
  }
)

it("refuses a late protected drawing after actual host revocation", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const f = await fixture("", {
    publish: async (value) => {
      if (
        Array.isArray(value) &&
        value.some((row) => isModObject(row) && typeof row.ref === "number")
      ) {
        entered.resolve()
        await release.promise
      }
      return value
    }
  })
  const owner = await f.session.sites.mount("PromptHint")
  const pending = f.session.sites.render(owner, hintProps)
  const rejected = expect(pending).rejects.toThrow("MODS_TEST_REVOKED")
  await entered.promise
  f.revoke()
  release.resolve()
  await rejected
})
