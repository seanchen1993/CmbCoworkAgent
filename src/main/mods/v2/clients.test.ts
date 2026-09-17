import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionGuestRuntime } from "./guest-runtime"
import { compileFunctionPlugin } from "./loader"
import { CLIENT_BOOTSTRAP } from "./client-bootstrap"
import type {
  FunctionClientAction,
  FunctionClientSnapshot,
  FunctionUiElement
} from "../../../shared/mods/v2/ui"
import type { ModJson } from "../../../shared/mods/types"
import { isModObject } from "../../../shared/mods/v2/contracts"

const cleanup: Array<() => Promise<void>> = []
function content(node: FunctionUiElement | string): string {
  return typeof node === "string" ? node : (node.children ?? []).map(content).join("")
}
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})
async function fixture(
  surface?: string,
  publish: (v: ModJson) => Promise<ModJson> = async (v) => v,
  decorateHooks = ""
) {
  const compiled = await compileFunctionPlugin(resolve("tests/fixtures/mods-v2/client-board"))
  const guest = await FunctionGuestRuntime.create(compiled.code + "\n" + decorateHooks)
  const other = await FunctionGuestRuntime.create(`__cmbFunctionMod={register(on){
    on("ui.message",()=>({props:{label:"wrong recipient"}}));
  }}`)
  const state = new Map<string, ModJson>()
  const clients: FunctionGuestRuntime[] = []
  const session = new FunctionSession(
    [
      {
        name: compiled.name,
        root: compiled.root,
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      },
      {
        name: "other",
        root: "/other",
        tier: "user",
        guest: other,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      threadId: "thread",
      workspace: "/project",
      assertLive: () => undefined,
      publish,
      loadClient: async (plugin, module) => {
        if (plugin !== compiled.name || !Object.hasOwn(compiled.clients, module))
          throw Error("unapproved")
        const runtime = await FunctionGuestRuntime.create(
          CLIENT_BOOTSTRAP + "\n" + (surface ?? compiled.clients[module]),
          { plugin }
        )
        clients.push(runtime)
        return runtime
      },
      state: () => ({
        get: async (k) => state.get(k),
        keys: async () => [...state.keys()],
        set: async (k, v) => {
          state.set(k, v)
        },
        delete: (k) => {
          state.delete(k)
        }
      })
    }
  )
  cleanup.push(() => session.close())
  await session.run("client-board", "")
  const snapshot = async () => {
    const [pane] = await session.panes.snapshot()
    return { pane, client: pane.clients![0] }
  }
  return { session, state, clients, snapshot, compiled, guest }
}
function action(
  client: FunctionClientSnapshot,
  kind: FunctionClientAction["kind"],
  value?: ModJson,
  key = "increment"
): FunctionClientAction {
  let handle: number | undefined
  const find = (node: FunctionUiElement): void => {
    if (node.props.key === key) handle = node.press?.handle
    for (const child of node.children ?? []) if (typeof child !== "string") find(child)
  }
  find(client.tree)
  return {
    pane: "client-board:client-board",
    instance: client.id,
    intentId: randomUUID(),
    kind,
    ...(handle === undefined ? {} : { handle }),
    ...(value === undefined ? {} : { value })
  }
}

it("matches the upstream Client descriptor and preserves local state across parent redraws", async () => {
  const f = await fixture()
  let { pane, client } = await f.snapshot()
  expect(pane.tree).toEqual({
    type: "Client",
    props: { key: "counter", module: "hooks/surface.tsx", props: { label: "Client state" } },
    client: { plugin: "client-board" }
  })
  expect(client.error).toBeUndefined()
  const click = action(client, "press")
  await Promise.all([f.session.clients.act(click), f.session.clients.act(click)])
  expect(f.state.get("client-message")).toEqual({ count: 1 })
  await expect
    .poll(async () => JSON.stringify((await f.snapshot()).client.tree))
    .toContain("Acknowledged")
  client = (await f.snapshot()).client
  expect(client.id).toBe(click.instance)
  await f.session.clients.act(action(client, "press"))
  f.session.panes.invalidate()
  ;({ pane, client } = await f.snapshot())
  expect(client.id).toBe(click.instance)
  expect(content(client.tree)).toContain("Client state · count:2")
  expect(f.clients).toHaveLength(1)
})

it("supports size, key, pointer, input, select and clock updates, then releases on close", async () => {
  const f = await fixture()
  let { client } = await f.snapshot()
  await f.session.clients.act(action(client, "resize", { columns: 91, rows: 12 }))
  await f.session.clients.act(action(client, "key", { key: "up" }))
  await f.session.clients.act(
    action(client, "pointer", { type: "down", x: 3, y: 4, button: "left" })
  )
  client = (await f.snapshot()).client
  await f.session.clients.act(action(client, "submit", "saved note", "note"))
  client = (await f.snapshot()).client
  await f.session.clients.act(action(client, "select", "b", "mode"))
  const text = content((await f.snapshot()).client.tree)
  expect(text).toContain("count:1")
  expect(text).toContain("size:91x12")
  expect(text).toContain("note:saved note · mode:b · pointer:3,4")
  await expect
    .poll(async () => content((await f.snapshot()).client.tree), { timeout: 2500 })
    .toContain("ticks:1")
  await f.session.panes.closePane("client-board", "client-board")
  await expect.poll(() => f.clients.every((c) => c.stats.disposed)).toBe(true)
  await expect(f.session.clients.act(action(client, "press"))).rejects.toThrow(
    "MODS_CLIENT_UNMOUNTED"
  )
  await f.session.run("client-board", "")
  const fresh = (await f.snapshot()).client
  expect(fresh.id).not.toBe(client.id)
  expect(content(fresh.tree)).toContain("count:0")
})

it("rejects malformed/forged controls and does not send Client messages to another plugin", async () => {
  const f = await fixture()
  const { client } = await f.snapshot()
  await expect(f.session.clients.act({ ...action(client, "press"), handle: 9999 })).rejects.toThrow(
    "MODS_UI_STALE_ACTION"
  )
  await expect(f.session.clients.act(action(client, "select", "forged", "mode"))).rejects.toThrow(
    "MODS_CLIENT_ACTION"
  )
  await expect(
    f.session.clients.act(action(client, "resize", { columns: -1, rows: 5 }))
  ).rejects.toThrow("MODS_CLIENT_ACTION")
  await f.session.clients.act(action(client, "press"))
  await expect
    .poll(async () => JSON.stringify((await f.snapshot()).client.tree))
    .toContain("Acknowledged")
  expect(JSON.stringify((await f.snapshot()).client.tree)).not.toContain("wrong recipient")
})

it("unmounts an over-budget surface without unloading the hooks VM", async () => {
  const f = await fixture("var __cmbSurfaceMod={default(){while(true){}}}")
  const { client } = await f.snapshot()
  expect(client.error).toBe("MODS_CLIENT_FAILED")
  expect(f.clients[0].stats.disposed).toBe(true)
  expect(await f.session.commands()).toHaveLength(1)
})

it("cancels a waiting owner hook on unmount before it can write persistent state", async () => {
  const f = await fixture(
    undefined,
    undefined,
    `
    const original = __cmbFunctionMod.register;
    __cmbFunctionMod = {register(on, options) {
      original((event, matcher, handler) => {
        if(event !== "ui.message") return on(event, matcher, handler);
        on(event, matcher, async ($, e, next) => {
          await $.store.set("entered", true);
          await $.clock.sleep(200);
          return handler($, e, next);
        });
      }, options);
    }};
  `
  )
  const { client } = await f.snapshot()
  const press = f.session.clients.act(action(client, "press")).catch((error) => error)
  await expect.poll(() => f.state.get("entered")).toBe(true)
  await f.session.panes.closePane("client-board", "client-board")
  expect(await press).toBeInstanceOf(Error)
  await new Promise((r) => setTimeout(r, 250))
  expect(f.state.has("client-message")).toBe(false)
  expect(f.guest.stats.frames).toBe(0)
  expect(await f.session.commands()).toHaveLength(1)
})

it.each([undefined, null])("preserves an omitted or null Client props value: %s", async (props) => {
  const f = await fixture(
    `var __cmbSurfaceMod={default(props="default",s){
      return s.elements.Text({children:props===null?"null":props});
    }}`,
    async (value) => {
      const result = JSON.parse(JSON.stringify(value))
      const visit = (node: ModJson): void => {
        if (isModObject(node) && node.type === "Client" && isModObject(node.props)) {
          if (props === undefined) delete node.props.props
          else node.props.props = props
        }
        if (node && typeof node === "object")
          Object.values(node).forEach((v) => {
            if (v && typeof v === "object") visit(v)
          })
      }
      visit(result)
      return result
    }
  )
  expect(content((await f.snapshot()).client.tree)).toBe(props === null ? "null" : "default")
})

it("does not mount a Client after its pane closes while publication is pending", async () => {
  let entered!: () => void, release!: () => void
  const pending = new Promise<void>((r) => {
    release = r
  })
  const started = new Promise<void>((r) => {
    entered = r
  })
  const f = await fixture(undefined, async (value) => {
    if (
      Array.isArray(value) &&
      value.length &&
      typeof value[0] === "object" &&
      value[0] &&
      "generation" in value[0]
    ) {
      entered()
      await pending
    }
    return value
  })
  const snapshot = f.session.panes.snapshot()
  await started
  await f.session.panes.closePane("client-board", "client-board")
  release()
  expect(await snapshot).toEqual([])
  expect(f.clients).toHaveLength(0)
})

it("filters Client output and posted data before it reaches renderer or hooks", async () => {
  const f = await fixture(
    `var __cmbSurfaceMod={default(_,s){
    const {Box,Text,Button}=s.elements;
    return Box({children:[Text({children:"PRIVATE"}),Button({key:"increment",label:"send",
      onPress:()=>s.post({count:"PRIVATE"})})]});
  }}`,
    async (value) => JSON.parse(JSON.stringify(value).replaceAll("PRIVATE", "FILTERED"))
  )
  const { client } = await f.snapshot()
  expect(content(client.tree)).toBe("FILTERED")
  await f.session.clients.act(action(client, "press"))
  expect(f.state.get("client-message")).toEqual({ count: "FILTERED" })
})

it("does not revive a removed control handle when its key is later reused", async () => {
  const f = await fixture(`var __cmbSurfaceMod={default(props,s){
    const {Button}=s.elements;if(s.state===undefined)s.setState(false);
    return Button({key:"same",label:s.state?"new":"old",onPress:()=>s.setState(!s.state)});
  }}`)
  let { client } = await f.snapshot()
  const old = action(client, "press", undefined, "same")
  await f.session.clients.act(old)
  client = (await f.snapshot()).client
  await expect(f.session.clients.act({ ...old, intentId: randomUUID() })).rejects.toThrow(
    "MODS_UI_STALE_ACTION"
  )
  await f.session.clients.act(action(client, "press", undefined, "same"))
  await expect(f.session.clients.act({ ...old, intentId: randomUUID() })).rejects.toThrow(
    "MODS_UI_STALE_ACTION"
  )
})
