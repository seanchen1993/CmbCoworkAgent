import { randomUUID } from "node:crypto"
import { afterEach, expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { CLIENT_BOOTSTRAP } from "./client-bootstrap"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import type { ModJson } from "../../../shared/mods/types"
import type { FunctionClientAction, FunctionUiElement } from "../../../shared/mods/v2/ui"

const sessions: FunctionSession[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
})
function control(tree: FunctionUiElement, key: string): FunctionUiElement | undefined {
  if (tree.props.key === key && tree.press) return tree
  for (const child of tree.children ?? []) {
    if (typeof child === "string") continue
    const found = control(child, key)
    if (found) return found
  }
  return undefined
}
async function fixture(hook = "") {
  const state = new Map<string, ModJson>()
  let live = true
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"open-focus",description:"Open"});
      await $.command.register({name:"client-focus",description:"Focus"});return next(e)
    });
    on("command.run",{command:"open-focus"},async($)=>{await $.ui.open({id:"board"});return {}});
    on("command.run",{command:"client-focus"},async($,e)=>{
      try{return {text:JSON.stringify(await $.ui.focus({requestId:"board",key:e.args||"target"}))}}
      catch(error){return {text:"ERROR:"+error.code}}
    });
    on("ui.render",{component:"Pane"},($,e)=>{
      const {Box,Client,Button}=$.ui.resolve(e);
      return Box({children:[Client({key:"surface",module:"surface.js"}),
        Button({key:"native",label:"Native",onPress(){}})]})
    });
    on("ui.message",{element:"surface"},async($,e)=>{
      const answer=await $.ui.focus({requestId:"board",key:e.data.key});
      await $.store.set("focused",answer);return {}
    });${hook}
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "client-focus",
        root: "/plugin",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/project",
      threadId: "thread",
      assertLive() {
        if (!live) throw Error("revoked")
      },
      publish: async (value) => value,
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
        const {Box,Button,Input,Text}=s.elements;
        const state=s.state||{visible:true,label:"Target",count:0};
        s.onKey(e=>{
          if(e.key==="h")s.setState({...state,visible:false});
          if(e.key==="s")s.setState({...state,visible:true});
          if(e.key==="c")s.setState({...state,label:"Changed"});
          if(e.key==="n")s.setState({...state,count:state.count+1});
        });
        return Box({children:[Text({children:[String(state.count)]}),
          Button({key:"post",label:"Post focus",onPress(){s.post({key:"target"})}}),
          ...(state.visible?[Input({key:"target",label:state.label,value:"",onSubmit(){}})]:[])
        ]})
      }}
    `,
          { plugin: "client-focus" }
        )
    }
  )
  sessions.push(session)
  await session.run("open-focus", "")
  const [pane] = await session.panes.snapshot()
  const client = pane.clients![0]
  function act(kind: FunctionClientAction["kind"], value?: ModJson, handle?: number) {
    return session.clients.act({
      pane: pane.key,
      instance: client.id,
      intentId: randomUUID(),
      kind,
      ...(value === undefined ? {} : { value }),
      ...(handle === undefined ? {} : { handle })
    })
  }
  const current = () => session.panes.focus.current(pane.key)
  async function ack(phase: "probe" | "apply") {
    await expect.poll(() => current()?.phase).toBe(phase)
    const request = current()!
    session.panes.focus.ack({ ...request, allowed: true })
    return request
  }
  return {
    session,
    pane,
    client,
    state,
    act,
    current,
    ack,
    revoke() {
      live = false
    }
  }
}

it("focuses a live Client control only after both renderer acknowledgements", async () => {
  const f = await fixture()
  let settled = false
  const result = f.session.run("client-focus", "").then((value) => {
    settled = true
    return value
  })
  const probe = await f.ack("probe")
  expect(probe).toMatchObject({
    client: f.client.id,
    element: "target",
    clientHandle: control(f.client.tree, "target")!.press!.handle
  })
  expect(settled).toBe(false)
  await f.ack("apply")
  expect(await result).toMatchObject({ text: "{}" })
})
it("settles Client post to parent focus without waiting on the same Client queue", async () => {
  const f = await fixture()
  await f.act("press", undefined, control(f.client.tree, "post")!.press!.handle)
  await f.ack("probe")
  expect(f.state.has("focused")).toBe(false)
  await f.ack("apply")
  await expect.poll(() => f.state.get("focused")).toEqual({})
  await f.act("key", { key: "n" })
  expect((await f.session.panes.snapshot())[0].clients![0].error).toBeUndefined()
})
it.each(["c", "h"])("rejects a stale Client target after independent %s redraw", async (key) => {
  const f = await fixture()
  const result = f.session.run("client-focus", "")
  void result.catch(() => {})
  await f.ack("probe")
  await expect.poll(() => f.current()?.phase).toBe("apply")
  const old = f.current()!
  await f.act("key", { key })
  if (key === "h") await f.act("key", { key: "s" })
  // Deliberately do not request a pane snapshot: its cached Client tree is stale.
  expect(() => f.session.panes.focus.ack({ ...old, allowed: true })).toThrow()
  f.session.panes.focus.cancel(f.pane.key)
  expect(await result).toMatchObject({ text: expect.stringContaining("ERROR:") })
})
it("keeps a stable Client control valid across unrelated text updates", async () => {
  const f = await fixture()
  const result = f.session.run("client-focus", "")
  void result.catch(() => {})
  await f.ack("probe")
  await f.act("key", { key: "n" })
  await f.ack("apply")
  expect(await result).toMatchObject({ text: "{}" })
})
it.each([
  ["native", "target"],
  ["target", "native"]
])("rewrites %s to %s within one owned Pane", async (from, to) => {
  const f = await fixture(`on("ui.focus",($,e,next)=>next({...e,element:${JSON.stringify(to)}}));`)
  const result = f.session.run("client-focus", from)
  void result.catch(() => {})
  await f.ack("probe")
  const apply = await f.ack("apply")
  expect(apply.element).toBe(to)
  expect(apply.client).toBe(to === "target" ? f.client.id : undefined)
  expect(await result).toMatchObject({ text: "{}" })
})

it.each(["", "keep focus"])("keeps Client focus unchanged after a late %j veto", async (deny) => {
  const f = await fixture(
    `on("ui.focus",async($,e,next)=>{await next(e);return {deny:${JSON.stringify(deny)}}});`
  )
  const result = f.session.run("client-focus", "")
  await f.ack("probe")
  expect(await result).toMatchObject({ text: JSON.stringify({ deny }) })
  expect(f.current()).toBeUndefined()
})
it("validates the rewritten Client handle at apply ACK, not only the original native target", async () => {
  const f = await fixture('on("ui.focus",($,e,next)=>next({...e,element:"target"}));')
  const result = f.session.run("client-focus", "native")
  void result.catch(() => {})
  await f.ack("probe")
  await expect.poll(() => f.current()?.phase).toBe("apply")
  const apply = f.current()!
  await f.act("key", { key: "c" })
  expect(() => f.session.panes.focus.ack({ ...apply, allowed: true })).toThrow()
  f.session.panes.focus.cancel(f.pane.key)
  expect(await result).toMatchObject({ text: expect.stringContaining("ERROR:") })
})
it("rejects a forged Client control handle and still accepts the original probe", async () => {
  const f = await fixture()
  const result = f.session.run("client-focus", "")
  await expect.poll(() => f.current()?.phase).toBe("probe")
  const probe = f.current()!
  expect(() => f.session.panes.focus.ack({ ...probe, clientHandle: -1, allowed: true })).toThrow()
  await f.ack("probe")
  await f.ack("apply")
  expect(await result).toMatchObject({ text: "{}" })
})

it("cancels a pending Client focus through the original command signal", async () => {
  const f = await fixture()
  const controller = new AbortController()
  const result = f.session.run("client-focus", "", controller.signal)
  const rejected = expect(result).rejects.toThrow()
  await f.ack("probe")
  await expect.poll(() => f.current()?.phase).toBe("apply")
  const old = f.current()!
  controller.abort()
  await rejected
  expect(f.current()).toBeUndefined()
  expect(() => f.session.panes.focus.ack({ ...old, allowed: true })).toThrow()
})
it.each(["unmount", "revoke", "close"])(
  "rejects late Client focus acknowledgements after %s",
  async (mode) => {
    const f = await fixture()
    const result = f.session.run("client-focus", "").catch((error: unknown) => error)
    await f.ack("probe")
    await expect.poll(() => f.current()?.phase).toBe("apply")
    const apply = f.current()!
    if (mode === "unmount") f.session.clients.closePane(f.pane.key)
    else if (mode === "revoke") f.revoke()
    else await f.session.close()
    expect(() => f.session.panes.focus.ack({ ...apply, allowed: true })).toThrow()
    f.session.panes.focus.cancel(f.pane.key)
    expect(await result).not.toEqual({ text: "{}" })
  }
)
