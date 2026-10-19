import { randomUUID } from "node:crypto"
import { afterEach, expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionPanes } from "./panes"
import type { FunctionPaneSnapshot, FunctionUiNode } from "../../../shared/mods/v2/ui"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
})

async function fixture() {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async $=>{await $.command.register({name:"open",description:"open"});await $.command.register({name:"dirty",description:"dirty"})});
    on("command.run",{command:"open"},async $=>{await $.ui.open({id:"one",title:"One"});await $.ui.open({id:"two",title:"Two"});return{}});
    on("command.run",{command:"dirty"},$=>{$.ui.invalidate("ui.render");return{}});
    on("ui.render",{component:"Pane"},($,e)=>$.ui.resolve(e).Button({key:"click",label:e.requestId,onPress(){}}));
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "selection",
        root: "/selection",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/selection",
      threadId: "selection",
      assertLive: () => undefined,
      publish: async (value) => value
    }
  )
  sessions.push(session)
  await session.run("open", "")
  const initial = await session.panes.snapshot()
  await session.run("dirty", "")
  return { session, initial }
}

function action(pane: FunctionPaneSnapshot) {
  const node = pane.tree as FunctionUiNode
  return {
    pane: pane.key,
    generation: pane.generation,
    intentId: randomUUID(),
    plugin: node.press!.plugin,
    handle: node.press!.handle,
    kind: "press" as const
  }
}

it("only renders and publishes panes selected by the native reader", async () => {
  const { session, initial } = await fixture()
  const rows = await session.panes.snapshot((_plugin, id) => id === "one")
  expect(rows.map((row) => row.id)).toEqual(["one"])
  expect(rows[0].generation).not.toBe(initial[0].generation)
})

it("does not retire an unselected pane's currently displayed callback", async () => {
  const { session, initial } = await fixture()
  await session.panes.snapshot((_plugin, id) => id === "one")
  await expect(session.panes.act(action(initial[1]))).resolves.toBeUndefined()
})

it("preserves unselected dirty state until its own reader redraws it", async () => {
  const { session, initial } = await fixture()
  await session.panes.snapshot((_plugin, id) => id === "one")
  const rows = await session.panes.snapshot((_plugin, id) => id === "two")
  expect(rows.map((row) => row.id)).toEqual(["two"])
  expect(rows[0].generation).not.toBe(initial[1].generation)
  await expect(session.panes.act(action(initial[1]))).rejects.toMatchObject({
    code: "MODS_UI_STALE_ACTION"
  })
})

it("keeps default snapshots and their stale generation checks unchanged", async () => {
  const { session, initial } = await fixture()
  expect((await session.panes.snapshot()).map((row) => row.id)).toEqual(["one", "two"])
  await expect(session.panes.act(action(initial[1]))).rejects.toMatchObject({
    code: "MODS_UI_STALE_ACTION"
  })
})

it("evaluates the entire native selection before mutating any drawing", async () => {
  const { session, initial } = await fixture()
  await expect(
    session.panes.snapshot((_plugin, id) => {
      if (id === "two") throw Error("SELECTION_UNAVAILABLE")
      return true
    })
  ).rejects.toThrow("SELECTION_UNAVAILABLE")
  await expect(session.panes.act(action(initial[0]))).resolves.toBeUndefined()
  await expect(session.panes.act(action(initial[1]))).resolves.toBeUndefined()
})

it("does not let a queued old fault receipt redraw a same-key replacement", async () => {
  let unblock!: () => void
  let entered!: () => void
  const ready = new Promise<void>((done) => {
    entered = done
  })
  const held = new Promise<void>((done) => {
    unblock = done
  })
  const rendered: string[] = []
  let hold = false
  const panes = new FunctionPanes({
    plugins: [],
    assertLive: () => undefined,
    changed: () => undefined,
    publish: async (value) => value,
    callback: async () => undefined,
    dispatch: async (_event, input) => {
      rendered.push(String(input.requestId))
      if (hold && input.requestId === "blocker") {
        entered()
        await held
      }
      return { type: "Text", props: {}, children: [String(input.requestId)] }
    }
  })
  try {
    panes.open("owner", { id: "victim" })
    const initial = (await panes.snapshot())[0]
    const receipt = panes.captureClientFault(initial.key, initial.generation)
    expect(receipt).toBeDefined()
    panes.open("owner", { id: "blocker" })
    hold = true
    const waiting = panes.snapshot((_plugin, id) => id === "blocker")
    await ready
    const redraw = receipt!.redraw()
    panes.open("owner", { id: "victim", title: "Replacement" })
    const before = rendered.filter((id) => id === "victim").length
    unblock()
    await waiting
    await redraw
    expect(rendered.filter((id) => id === "victim")).toHaveLength(before)
    await panes.snapshot((_plugin, id) => id === "victim")
    expect(rendered.filter((id) => id === "victim")).toHaveLength(before + 1)
  } finally {
    unblock()
    await panes.close()
  }
})

it("notifies the next reader about panes opened after its frozen inventory", async () => {
  let unblock!: () => void
  let entered!: () => void
  const ready = new Promise<void>((done) => {
    entered = done
  })
  const held = new Promise<void>((done) => {
    unblock = done
  })
  let notified!: () => void
  const notification = new Promise<void>((done) => {
    notified = done
  })
  const panes = new FunctionPanes({
    plugins: [],
    assertLive: () => undefined,
    changed: () => notified(),
    publish: async (value) => value,
    callback: async () => undefined,
    dispatch: async (_event, input) => {
      if (input.requestId === "one") {
        entered()
        await held
      }
      return { type: "Text", props: {}, children: [String(input.requestId)] }
    }
  })
  try {
    panes.open("owner", { id: "one" })
    const reading = panes.snapshot()
    await ready
    panes.open("owner", { id: "two" })
    await notification
    unblock()
    expect((await reading).map((pane) => pane.id)).toEqual(["one"])
    expect((await panes.snapshot()).map((pane) => pane.id)).toEqual(["one", "two"])
  } finally {
    unblock()
    await panes.close()
  }
})
