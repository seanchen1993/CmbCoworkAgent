import { randomUUID } from "node:crypto"
import { afterEach, expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { CLIENT_BOOTSTRAP } from "./client-bootstrap"
import type { ModJson } from "../../../shared/mods/types"

const sessions: FunctionSession[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
})
async function fixture(factory = "h", fragment = "Fragment", client = false) {
  const state = new Map<string, ModJson>()
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{for(const name of ["open","inspect"])await $.command.register({name,description:name});return next(e)});
    on("command.run",{command:"open"},async($)=>{await $.ui.open({id:"board"});return {}});
    on("command.run",{command:"inspect"},($,e)=>{
      if(e.args==="descriptors")return {text:JSON.stringify(["h","Fragment"].map(name=>{
        const d=Object.getOwnPropertyDescriptor(globalThis,name);return {name,type:typeof globalThis[name],writable:d?.writable??(typeof d?.set==="function"),configurable:d?.configurable}
      }))};
      if(e.args==="intrinsic"){try{h("script",{})}catch(error){return {text:error.message}}}
      if(e.args==="readonly"){
        const prior=h;let write=false,redefine=false;
        try{Object.defineProperty(globalThis,"h",{value:()=>null})}catch{redefine=true}
        try{Object.defineProperty(globalThis,"Fragment",{writable:true})}catch{write=true}
        return {text:JSON.stringify({same:prior===h,write,redefine,
          assigned:Reflect.set(globalThis,"h",()=>null),deleted:Reflect.deleteProperty(globalThis,"Fragment"),
          aliases:h===__functionJsx&&Fragment===__functionFragment})}
      }
      if(e.args==="children")return {text:JSON.stringify(h(p=>p,{children:["prop"]},"argument").children)};
      if(e.args==="limits"){
        const errors=[];let deep="x";for(let i=0;i<30;i++)deep=[deep];
        for(const children of [deep,Array(1001).fill("x")])try{Fragment({children})}catch(error){errors.push(error.message)}
        return {text:JSON.stringify(errors)}
      }
      return {}
    });
    on("ui.render",{component:"Pane"},($,e)=>{
      const {Text,Button,Client}=$.ui.resolve(e);
      ${
        client
          ? 'return Client({key:"surface",module:"surface.js"})'
          : `return ${factory}(${fragment},null,
        ${factory}(Text,null,"public",0,false,null,undefined),
        ${factory}(Button,{key:"press",label:"Press",onPress:async()=>$.store.set("pressed",true)}),
        ${factory}(()=>null,null),${factory}(()=>undefined,null))`
      }
    })
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "public-jsx",
        root: "/plugin",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/project",
      threadId: "thread",
      assertLive: () => {},
      publish: async (v) => v,
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
      loadClient: async () =>
        FunctionGuestRuntime.create(
          CLIENT_BOOTSTRAP +
            `
      globalThis.__cmbSurfaceMod={default(props,s){
        const {Text,Button}=s.elements;
        return h(Fragment,null,h(Text,null,"CLIENT_",s.state||0),h(Button,{key:"count",label:"Count",onPress(){s.setState((s.state||0)+1)}}))
      }}
    `,
          { plugin: "public-jsx" }
        )
    }
  )
  sessions.push(session)
  await session.run("open", "")
  return { session, state }
}
it("exposes readonly public factory globals in a real hooks VM", async () => {
  const { session } = await fixture()
  expect(JSON.parse((await session.run("inspect", "descriptors")).text as string)).toEqual([
    { name: "h", type: "function", writable: false, configurable: false },
    { name: "Fragment", type: "function", writable: false, configurable: false }
  ])
  expect(JSON.parse((await session.run("inspect", "readonly")).text as string)).toEqual({
    same: true,
    write: true,
    redefine: true,
    assigned: false,
    deleted: false,
    aliases: true
  })
})
it.each([
  ["h", "Fragment"],
  ["__functionJsx", "__functionFragment"]
])(
  "renders column fragments with %s without changing callback ownership",
  async (factory, fragment) => {
    const { session, state } = await fixture(factory, fragment)
    const [pane] = await session.panes.snapshot()
    expect(pane.tree).toMatchObject({ type: "Box", props: { flexDirection: "column" } })
    expect(pane.tree.children).toHaveLength(2)
    expect(pane.tree.children![0]).toMatchObject({ type: "Text", children: ["public", "0"] })
    const button = pane.tree.children![1]
    if (typeof button === "string") throw Error("button required")
    expect(button.press?.plugin).toBe("public-jsx")
    await session.panes.act({
      pane: pane.key,
      generation: pane.generation,
      plugin: "public-jsx",
      handle: button.press!.handle,
      intentId: randomUUID(),
      kind: "press"
    })
    expect(state.get("pressed")).toBe(true)
  }
)
it("keeps factory child precedence and rejects intrinsic string tags", async () => {
  const { session } = await fixture()
  expect((await session.run("inspect", "children")).text).toBe('["argument"]')
  expect((await session.run("inspect", "intrinsic")).text).toBe("MODS_UI_TAG")
})
it("retains fragment depth and node budgets", async () => {
  const { session } = await fixture()
  expect(JSON.parse((await session.run("inspect", "limits")).text as string)).toEqual([
    "MODS_UI_DEPTH",
    "MODS_UI_NODES"
  ])
})
it("uses public factories inside the isolated Client VM and preserves control state", async () => {
  const { session } = await fixture("h", "Fragment", true)
  const [pane] = await session.panes.snapshot()
  const client = pane.clients![0]
  expect(client.error).toBeUndefined()
  expect(client.tree.props.flexDirection).toBe("column")
  const button = client.tree.children![1]
  if (typeof button === "string") throw Error("button required")
  await session.clients.act({
    pane: pane.key,
    instance: client.id,
    handle: button.press!.handle,
    intentId: randomUUID(),
    kind: "press"
  })
  const redrawn = (await session.panes.snapshot())[0].clients![0]
  expect(redrawn.id).toBe(client.id)
  expect(redrawn.tree.children![0]).toMatchObject({ type: "Text", children: ["CLIENT_", "1"] })
})
