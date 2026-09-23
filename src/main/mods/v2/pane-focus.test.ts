import { randomUUID } from "node:crypto"
import { afterEach, expect, it } from "vitest"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionPanes } from "./panes"
import type { FunctionPaneSnapshot, FunctionUiAction } from "../../../shared/mods/v2/ui"
import type { ModJson } from "../../../shared/mods/types"
import { isModObject } from "../../../shared/mods/v2/contracts"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
})
async function fixture(
  hook = "",
  publish: (value: ModJson) => Promise<ModJson> = async (value) => value,
  onPress = "() => {}"
) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"focus",description:"Focus"});return next(e)});
    on("command.run",{command:"focus"},async($)=>{await $.ui.open({id:"focus",focus:true});return {}});
    on("ui.render",{component:"Pane"},($,e)=>{const {Box,Button}= $.ui.resolve(e);return Box({children:[
      Button({key:"first",label:"First",autoFocus:true,onPress:${onPress}}),
      Button({key:"second",label:"Second",autoFocus:true,onPress(){}})
    ]})});${hook}
  }}`)
  let live = true
  const session = new FunctionSession(
    [
      {
        name: "focus",
        root: "/focus",
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
      publish
    }
  )
  sessions.push(session)
  await session.run("focus", "")
  return {
    session,
    revoke() {
      live = false
    }
  }
}
function request(pane: FunctionPaneSnapshot, focused = true): FunctionUiAction {
  return {
    pane: pane.key,
    generation: pane.generation,
    plugin: pane.plugin,
    handle: 0,
    kind: "focus",
    intentId: randomUUID(),
    value: { focused, request: pane.focusRequest!.id }
  }
}

it("exposes one focus request and grants only the first autoFocus through the real session", async () => {
  const { session } = await fixture()
  const [first] = await session.panes.snapshot()
  expect(first.focusRequest?.pending).toBe(true)
  const result = await session.panes.act(request(first))
  expect(result).toEqual({ focused: true, target: { plugin: "focus", element: "first" } })
  session.panes.invalidate()
  const [redrawn] = await session.panes.snapshot()
  expect(redrawn.focusRequest).toEqual({ id: first.focusRequest!.id, pending: false })
  await expect(session.panes.act(request(redrawn))).rejects.toThrow("MODS_UI_STALE_FOCUS")
})

it("consumes a refused request without taking focus later on an unrelated redraw", async () => {
  const { session } = await fixture()
  const [pane] = await session.panes.snapshot()
  expect(await session.panes.act(request(pane, false))).toEqual({ focused: false })
  session.panes.invalidate()
  expect((await session.panes.snapshot())[0].focusRequest?.pending).toBe(false)
})

it("honors a focus hook refusal and permits a rewrite only to its own drawn control", async () => {
  const denied = await fixture('on("ui.focus",()=>({deny:"keep typing"}));')
  const [pane] = await denied.session.panes.snapshot()
  expect(await denied.session.panes.act(request(pane))).toEqual({ focused: false })
  const rewritten = await fixture('on("ui.focus",($,e,next)=>next({...e,element:"second"}));')
  const [other] = await rewritten.session.panes.snapshot()
  expect(await rewritten.session.panes.act(request(other))).toEqual({
    focused: true,
    target: { plugin: "focus", element: "second" }
  })
})

it("rejects closed, reopened and revoked focus requests", async () => {
  const { session, revoke } = await fixture()
  const [old] = await session.panes.snapshot()
  await session.panes.closePane("focus", "focus")
  await session.run("focus", "")
  const [fresh] = await session.panes.snapshot()
  expect(fresh.focusRequest?.id).not.toBe(old.focusRequest?.id)
  await expect(
    session.panes.act({ ...request(old), generation: fresh.generation })
  ).rejects.toThrow("MODS_UI_STALE_FOCUS")
  revoke()
  expect(() => session.panes.act(request(fresh))).toThrow("revoked")
})

it("does not grant focus when middleware refuses after next or invents a grant", async () => {
  for (const hook of [
    'on("ui.focus",async($,e,next)=>{await next(e);return {deny:"keep existing focus"}});',
    'on("ui.focus",()=>({element:"first",value:{focused:true}}));',
    'on("ui.focus",($,e,next)=>next({...e,element:"missing"}));'
  ]) {
    const { session } = await fixture(hook)
    const [pane] = await session.panes.snapshot()
    expect(await session.panes.act(request(pane))).toEqual({ focused: false })
  }
})

it("keeps the original focus owner when an invalid rewrite is skipped", async () => {
  for (const update of ['plugin:"other"', 'origin:{kind:"person"}']) {
    const { session } = await fixture(`on("ui.focus",($,e,next)=>next({...e,${update}}));`)
    const [pane] = await session.panes.snapshot()
    expect(await session.panes.act(request(pane))).toEqual({
      focused: true,
      target: { plugin: "focus", element: "first" }
    })
  }
})

it("does not hide the original render failure behind a synchronous cleanup failure", async () => {
  const panes = new FunctionPanes({
    assertLive: () => undefined,
    changed: () => undefined,
    publish: async (v) => v,
    callback: async () => {},
    dispatch: async () => {
      throw Error("original render failure")
    },
    plugins: [
      {
        name: "failed",
        root: "/failed",
        tier: "user",
        capabilities: [],
        guest: {
          registrations: [],
          stats: { disposed: true },
          matches: () => true,
          invoke: async () => ({}),
          dispose: () => undefined,
          releaseUi() {
            throw Error("MODS_UNLOADED")
          }
        }
      }
    ]
  })
  panes.open("failed", { id: "failed" })
  await expect(panes.snapshot()).rejects.toThrow("original render failure")
  panes.close()
})

it("invalidates a pending focus grant when a redraw replaces its generation", async () => {
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const { session } = await fixture("", async (value) => {
    if (isModObject(value) && isModObject(value.value) && value.value.focused === true) {
      entered()
      await gate
    }
    return value
  })
  const [pane] = await session.panes.snapshot()
  const result = session.panes.act(request(pane))
  await started
  session.panes.invalidate()
  const [redrawn] = await session.panes.snapshot()
  expect(redrawn.generation).not.toBe(pane.generation)
  release()
  await expect(result).rejects.toThrow("MODS_UI_STALE_ACTION")
})

const focusCommand = `
  on("session.start",{},async($,e,next)=>{await $.command.register({name:"move-focus",description:"Move focus"});return next(e)});
  on("command.run",{command:"move-focus"},async($,e)=>{try{return {text:JSON.stringify(await $.ui.focus({requestId:"focus",key:e.args||"second"}))}}catch(error){return {text:"FOCUS_ERROR:"+error.code}}});
`
it("awaits real guest focus requests through the original session and drawing identity", async () => {
  const { session } = await fixture(focusCommand)
  const [pane] = await session.panes.snapshot()
  const result = session.run("move-focus", "second")
  await expect.poll(() => session.panes.focus.current(pane.key)?.phase).toBe("probe")
  const probe = (await session.panes.snapshot())[0].imperativeFocus!
  expect(probe).toMatchObject({
    pane: pane.key,
    generation: pane.generation,
    plugin: "focus",
    element: "second"
  })
  session.panes.focus.ack({ ...probe, allowed: true })
  await expect.poll(() => session.panes.focus.current(pane.key)?.phase).toBe("apply")
  session.panes.focus.ack({ ...session.panes.focus.current(pane.key)!, allowed: true })
  expect(await result).toMatchObject({ text: "{}" })
})

it("keeps late hook vetoes and missing targets out of the renderer", async () => {
  const { session } = await fixture(
    focusCommand + 'on("ui.focus",async($,e,next)=>{await next(e);return {deny:"keep"}});'
  )
  const [pane] = await session.panes.snapshot()
  const result = session.run("move-focus", "")
  await expect.poll(() => session.panes.focus.current(pane.key)?.phase).toBe("probe")
  session.panes.focus.ack({ ...session.panes.focus.current(pane.key)!, allowed: true })
  expect(await result).toMatchObject({ text: '{"deny":"keep"}' })
  expect(session.panes.focus.current(pane.key)).toBeUndefined()
  const missing = await session.run("move-focus", "missing")
  expect(JSON.parse(String(missing.text))).toEqual({ deny: expect.any(String) })
})

it("settles a callback awaiting focus without putting the renderer ack behind that callback", async () => {
  const { session } = await fixture(
    "",
    undefined,
    'async()=>{$.ui.log(JSON.stringify(await $.ui.focus({requestId:"focus",key:"second"})))}'
  )
  const [pane] = await session.panes.snapshot()
  const node = pane.tree.children![0]
  if (typeof node === "string" || !node.press) throw Error("missing callback")
  const result = session.panes.act({
    pane: pane.key,
    generation: pane.generation,
    plugin: node.press.plugin,
    handle: node.press.handle,
    kind: "press",
    intentId: randomUUID()
  })
  await expect.poll(() => session.panes.focus.current(pane.key)?.phase).toBe("probe")
  session.panes.focus.ack({ ...session.panes.focus.current(pane.key)!, allowed: true })
  await expect.poll(() => session.panes.focus.current(pane.key)?.phase).toBe("apply")
  session.panes.focus.ack({ ...session.panes.focus.current(pane.key)!, allowed: true })
  await result
})

it("invalidates an imperative request when the same pane is opened with new properties", async () => {
  const { session } = await fixture(focusCommand)
  const [pane] = await session.panes.snapshot()
  const pending = session.run("move-focus", "second")
  void pending.catch(() => {})
  await expect.poll(() => session.panes.focus.current(pane.key)?.phase).toBe("probe")
  const probe = session.panes.focus.current(pane.key)!
  session.panes.open("focus", { id: "focus", title: "new drawing pending" })
  expect(() => session.panes.focus.ack({ ...probe, allowed: true })).toThrow("MODS_UI_FOCUS_STALE")
  await expect(pending).resolves.toMatchObject({ text: "FOCUS_ERROR:MODS_UI_FOCUS_STALE" })
})
