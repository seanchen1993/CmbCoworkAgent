import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionGuestRuntime } from "./guest-runtime"
import { compileFunctionPlugin } from "./loader"
import { CLIENT_BOOTSTRAP } from "./client-bootstrap"
import type { ModJson } from "../../../shared/mods/types"
import type { FunctionClientSnapshot } from "../../../shared/mods/v2/ui"

const cleanup: Array<() => Promise<void>> = []
async function frame(ms = 16): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  // QuickJS resumes host replies on setImmediate, independently of the surface's frame clock.
  for (let index = 0; index < 16; index++)
    await new Promise<void>((resolve) => setImmediate(resolve))
}
beforeEach(() =>
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
)
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
  vi.useRealTimers()
})

async function fixture(
  surface: string,
  publish = async (value: ModJson): Promise<ModJson> => value
) {
  const compiled = await compileFunctionPlugin(resolve("tests/fixtures/mods-v2/client-board"))
  const guest = await FunctionGuestRuntime.create(compiled.code)
  const clients: FunctionGuestRuntime[] = []
  const messages: ModJson[] = []
  const state = new Map<string, ModJson>()
  const session = new FunctionSession(
    [
      {
        name: compiled.name,
        root: compiled.root,
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
      loadClient: async (plugin) => {
        const client = await FunctionGuestRuntime.create(CLIENT_BOOTSTRAP + "\n" + surface, {
          plugin
        })
        clients.push(client)
        return client
      },
      state: () => ({
        get: async (key) => state.get(key),
        keys: async () => [...state.keys()],
        set: async (key, value) => {
          state.set(key, value)
          if (key === "client-message") messages.push(value)
        },
        delete: (key) => {
          state.delete(key)
        }
      })
    }
  )
  cleanup.push(() => session.close())
  await session.run("client-board", "")
  const snapshot = async () => (await session.panes.snapshot())[0].clients![0]
  const client = await snapshot()
  const press = (current: FunctionClientSnapshot = client) =>
    session.clients.act({
      pane: "client-board:client-board",
      instance: current.id,
      kind: "press",
      handle: current.tree.press!.handle,
      intentId: randomUUID()
    })
  return { session, clients, messages, snapshot, client, press }
}

it("unmounts exactly on the third uninterrupted render setState and releases its clock", async () => {
  const f = await fixture(`var __cmbSurfaceMod={default(p,s){
    if(s.state===undefined)s.every(1000,()=>{});
    s.setState((s.state||0)+1);return s.elements.Text({children:String(s.state)});
  }}`)
  expect(f.client.tree.children).toEqual(["1"])
  await frame()
  expect((await f.snapshot()).tree.children).toEqual(["2"])
  await frame()
  expect((await f.snapshot()).error).toBe("MODS_CLIENT_RENDER_LOOP")
  expect(f.clients[0].stats.disposed).toBe(true)
  await frame(100) // The owning Pane independently coalesces renderer notifications for 100 ms.
  expect(vi.getTimerCount()).toBe(0)
  expect(await f.session.commands()).toHaveLength(1)
})

it("resets render-loop accounting on real pointer input and timer ticks", async () => {
  const f = await fixture(`var __cmbSurfaceMod={default(p,s){
    if(s.state===undefined){s.every(16,()=>{});s.onPointer(()=>{});}
    s.setState((s.state||0)+1);return s.elements.Text({children:String(s.state)});
  }}`)
  for (let index = 0; index < 4; index++) await frame()
  expect((await f.snapshot()).error).toBeUndefined()
  await f.session.clients.act({
    pane: "client-board:client-board",
    instance: f.client.id,
    intentId: randomUUID(),
    kind: "pointer",
    value: { type: "down", x: 1, y: 1 }
  })
  await frame()
  await frame()
  expect((await f.snapshot()).error).toBeUndefined()
  expect(f.clients[0].stats.disposed).toBe(false)
})

it("coalesces all posts in a frame into the latest value and delivers no more than one", async () => {
  const f = await fixture(`var n=0;var __cmbSurfaceMod={default(p,s){
    return s.elements.Button({key:"send",label:"send",onPress(){s.post({count:++n});s.post({count:++n});}});
  }}`)
  await f.press()
  await f.press()
  expect(f.messages).toEqual([])
  await frame()
  expect(f.messages).toEqual([{ count: 4 }])
  await f.press(await f.snapshot())
  expect(f.messages).toHaveLength(1)
  await frame()
  expect(f.messages).toEqual([{ count: 4 }, { count: 6 }])
})

it.each([
  '"x".repeat(100001)',
  "Array(20001).fill(0)",
  "(()=>{let v=0;for(let i=0;i<31;i++)v={v};return v})()",
  "(()=>{let v={};for(let i=0;i<34;i++)v={v};return v})()",
  "(()=>{const v={};v.self=v;return v})()",
  '({get count(){throw Error("accessor should not run")}})',
  'JSON.parse(\'{"__proto__":{"count":2}}\')',
  "(()=>{})"
])("silently drops invalid post data %s and retains the last valid post", async (invalid) => {
  const f = await fixture(`var __cmbSurfaceMod={default(p,s){
    return s.elements.Button({key:"send",label:"send",onPress(){s.post({count:1});s.post(${invalid});}});
  }}`)
  await f.press()
  await frame()
  expect(f.messages).toEqual([{ count: 1 }])
  expect((await f.snapshot()).error).toBeUndefined()
})

it("copies posted data immediately and coalesces repeated setState into one redraw", async () => {
  const f = await fixture(`var draws=0;var __cmbSurfaceMod={default(p,s){
    draws++;return s.elements.Button({key:"send",label:String(draws),onPress(){
      const data={count:1};s.post(data);data.count=2;s.setState(1);s.setState(2);
    }});
  }}`)
  await f.press()
  expect((await f.snapshot()).tree.props.label).toBe("2")
  await frame()
  expect((await f.snapshot()).tree.props.label).toBe("3")
  expect(f.messages).toEqual([{ count: 1 }])
  await frame()
  expect((await f.snapshot()).tree.props.label).toBe("4") // The owner answered with new props.
  await frame()
  expect((await f.snapshot()).tree.props.label).toBe("4")
})

it.each([28, 29, 30])(
  "delivers host-safe data nested %s levels without losing the instance",
  async (depth) => {
    const f = await fixture(`var __cmbSurfaceMod={default(p,s){
    return s.elements.Button({key:"send",label:"send",onPress(){
      let value=0;for(let i=0;i<${depth};i++)value={v:value};s.post(value);
    }});
  }}`)
    await f.press()
    await frame()
    expect(f.messages).toHaveLength(1)
    expect((await f.snapshot()).error).toBeUndefined()
  }
)

it("bounds a burst of one hundred posts to one owner dispatch, then leaves no surface clock", async () => {
  const f = await fixture(`var n=0;var __cmbSurfaceMod={default(p,s){
    return s.elements.Button({key:"send",label:"send",onPress(){s.post({count:++n});}});
  }}`)
  for (let index = 0; index < 100; index++) await f.press()
  expect(f.messages).toHaveLength(0)
  await frame()
  expect(f.messages).toEqual([{ count: 100 }])
  await f.session.close()
  await frame(100)
  expect(vi.getTimerCount()).toBe(0)
  expect(f.clients[0].stats.disposed).toBe(true)
})

it("drops an undelivered post when the pane closes before its next frame", async () => {
  const f = await fixture(`var __cmbSurfaceMod={default(p,s){
    return s.elements.Button({key:"send",label:"send",onPress(){s.post({count:1});}});
  }}`)
  await f.press()
  await f.session.panes.closePane("client-board", "client-board")
  await frame(100)
  expect(f.messages).toEqual([])
  expect(f.clients[0].stats.disposed).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it("does not enter the owner hook after close during pending post publication", async () => {
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>((resolve) => {
    entered = resolve
  })
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture(
    `var __cmbSurfaceMod={default(p,s){
    return s.elements.Button({key:"send",label:"send",onPress(){s.post({count:1,pendingPost:true});}});
  }}`,
    async (value) => {
      if (value && typeof value === "object" && !Array.isArray(value) && value.pendingPost) {
        entered()
        await pending
      }
      return value
    }
  )
  const press = f.press()
  await press
  await frame()
  await waiting
  await f.session.panes.closePane("client-board", "client-board")
  release()
  await press.catch(() => {})
  await frame(32)
  expect(f.messages).toEqual([])
  expect(f.clients[0].stats.disposed).toBe(true)
})
