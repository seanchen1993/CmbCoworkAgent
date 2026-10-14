import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { compileFunctionPlugin } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import type { ModJson } from "../../../shared/mods/types"
import type {
  FunctionPaneSnapshot,
  FunctionUiElement,
  FunctionUiNode,
  FunctionUiAction
} from "../../../shared/mods/v2/ui"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
})

it("returns placement to unchanged community callers so their finally block closes the pane", async () => {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async $=>{await $.command.register({name:"probe",description:"Probe"})});
    on("command.run",{command:"probe"},async $=>{
      const opened=await $.ui.open({id:"test",title:"Test"});
      try {return {text:JSON.stringify(opened)}}
      finally {if(opened.isPlaced) await $.ui.close({id:"test"})}
    });
  }}`)
  const session = new FunctionSession([
    { name: "open-result", root: "/open-result", tier: "user", guest,
      capabilities: [...SESSION_CAPABILITIES] }
  ], { workspace: "/project", threadId: "open-result", assertLive() {
    // This isolated pane-placement fixture has no external lifecycle to validate.
  }, publish: async v => v })
  sessions.push(session)
  expect(JSON.parse(String((await session.run("probe", "")).text))).toEqual({ isPlaced: true })
  expect(await session.panes.snapshot()).toEqual([])
})

async function fixture(
  extra = "",
  publish: (value: ModJson) => Promise<ModJson> = async (value) => value,
  changed?: (scope?: import("../../../shared/mods/types").ModUiChangeScope) => void
) {
  const compiled = await compileFunctionPlugin(resolve("resources/mods/function-commands"))
  const guest = await FunctionGuestRuntime.create(
    compiled.code +
      (extra
        ? `
    const base=__cmbFunctionMod.register;__cmbFunctionMod={register(on,options){base(on,options);${extra}}};`
        : "")
  )
  const state = new Map<string, ModJson>()
  let live = true
  const session = new FunctionSession(
    [
      {
        name: "function-commands",
        root: compiled.root,
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/project",
      threadId: "thread",
      assertLive() {
        if (!live) throw new ModFunctionError("MODS_SCOPE_CHANGED")
      },
      publish,
      uiChanged: changed,
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
  await session.run("claw-board", "")
  return {
    session,
    state,
    guest,
    revoke: () => {
      live = false
    }
  }
}

function action(
  pane: FunctionPaneSnapshot,
  key: string,
  kind: FunctionUiAction["kind"] = "press",
  value?: ModJson
): FunctionUiAction {
  let found: FunctionUiNode | undefined
  const visit = (node: FunctionUiElement | string): void => {
    if (typeof node === "string" || node.type === "engine") return
    if (node.type !== "fragment" && node.type !== "Markdown" && node.props.key === key) found = node
    node.children?.forEach(visit)
  }
  visit(pane.tree)
  if (!found?.press) throw Error("missing control " + key)
  return {
    pane: pane.key,
    generation: pane.generation,
    intentId: randomUUID(),
    plugin: found.press.plugin,
    handle: found.press.handle,
    kind,
    ...(value === undefined ? {} : { value })
  }
}

describe("desktop function panes through the production session", () => {
  it("publishes pane collection changes without revoking unrelated native drawings", async () => {
    const changed = vi.fn()
    const { session, state } = await fixture("", undefined, changed)
    await vi.waitFor(() => expect(changed).toHaveBeenCalled())
    expect(changed.mock.calls).toEqual([["panes"]])
    changed.mockClear()
    let [pane] = await session.panes.snapshot()
    await session.panes.act(action(pane, "count"))
    await vi.waitFor(() => expect(changed).toHaveBeenCalled())
    expect(changed.mock.calls).toEqual([["panes"]])
    expect(state.get("board-count")).toBe(1)
    ;[pane] = await session.panes.snapshot()
    changed.mockClear()
    await session.panes.act({ ...action(pane, "count"), kind: "close" })
    await vi.waitFor(() => expect(changed).toHaveBeenCalled())
    expect(changed.mock.calls).toEqual([["panes"]])
    expect(await session.panes.snapshot()).toEqual([])
    changed.mockClear()
    session.panes.invalidate()
    await vi.waitFor(() => expect(changed).toHaveBeenCalled())
    expect(changed.mock.calls).toEqual([[undefined]])
  })
  it("metadata is pure, owned and only trusts the current clean drawing", async () => {
    const { session, state } = await fixture(`on("ui.render", async ($,e,next)=>{await $.store.set("renders", (await $.store.get("renders")??0)+1);return next(e)});`)
    const [pane] = await session.panes.snapshot()
    const renders = state.get("renders")
    const drawings = [{ key: pane.key, generation: pane.generation,
      isShown: true, isPlaced: true, isFocused: true }]
    expect(session.panes.metadata("another-plugin", drawings)).toEqual([])
    expect(session.panes.metadata(pane.plugin, drawings)).toEqual([
      {id:pane.id,title:pane.title,isShown:true,isPlaced:true,isFocused:true}
    ])
    expect(session.panes.metadata(pane.plugin, [{...drawings[0],generation:"old"}])[0].isShown).toBe(false)
    session.panes.invalidate()
    expect(session.panes.metadata(pane.plugin, drawings)[0].isShown).toBe(false)
    expect(state.get("renders")).toBe(renders)
    // Querying the metadata cannot trigger the pending redraw.
    expect(session.panes.metadata(pane.plugin, drawings)[0].isShown).toBe(false)
  })
  it("protects pane titles as well as rendered content at publication", async () => {
    const { session } = await fixture("", async (value) =>
      JSON.parse(
        JSON.stringify(value)
          .replaceAll("我的 Claw", "[filtered title]")
          .replaceAll("用插件定制你的 Claw", "[filtered body]")
      )
    )
    const [pane] = await session.panes.snapshot()
    expect(pane.title).toBe("[filtered title]")
    expect(JSON.stringify(pane.tree)).toContain("[filtered body]")
  })
  it("opens a TSX tree, repeats presses, stores input and selection, closes and reopens", async () => {
    const { session, state, guest } = await fixture()
    let [pane] = await session.panes.snapshot()
    expect(pane.title).toBe("我的 Claw")
    for (const count of [1, 2, 3]) {
      await session.panes.act(action(pane, "count"))
      ;[pane] = await session.panes.snapshot()
      expect(JSON.stringify(pane.tree)).toContain(String(count))
      expect(state.get("board-count")).toBe(count)
    }
    await session.panes.act(action(pane, "note", "change", "draft"))
    expect(state.has("board-note")).toBe(false)
    await session.panes.act(action(pane, "note", "submit", "保存的备注"))
    ;[pane] = await session.panes.snapshot()
    await session.panes.act(action(pane, "mode", "select", "build"))
    ;[pane] = await session.panes.snapshot()
    expect(state.get("board-note")).toBe("保存的备注")
    expect(state.get("board-mode")).toBe("build")
    await session.panes.act({ ...action(pane, "count"), kind: "close" })
    expect(await session.panes.snapshot()).toEqual([])
    await session.run("claw-board", "")
    expect(JSON.stringify(await session.panes.snapshot())).toContain("保存的备注")
    expect(guest.stats).toMatchObject({ frames: 0, replies: 0 })
  })

  it("deduplicates an IPC retry, rejects conflicts and permits a distinct second click", async () => {
    const { session, state } = await fixture()
    const [pane] = await session.panes.snapshot()
    const click = action(pane, "count")
    await Promise.all([session.panes.act(click), session.panes.act(click)])
    expect(state.get("board-count")).toBe(1)
    await expect(session.panes.act({ ...click, handle: click.handle + 1 })).rejects.toThrow(
      "MODS_UI_INTENT_CONFLICT"
    )
    await session.panes.act({ ...click, intentId: randomUUID() })
    expect(state.get("board-count")).toBe(2)
  })

  it("rejects old drawings, fabricated handles, wrong kinds and invalid selections", async () => {
    const { session, state } = await fixture()
    const [old] = await session.panes.snapshot()
    await session.panes.act(action(old, "count"))
    const [pane] = await session.panes.snapshot()
    await expect(session.panes.act(action(old, "count"))).rejects.toThrow("MODS_UI_STALE_ACTION")
    await expect(session.panes.act({ ...action(pane, "count"), handle: 999999 })).rejects.toThrow(
      "MODS_UI_STALE_ACTION"
    )
    await expect(session.panes.act(action(pane, "count", "select", "build"))).rejects.toThrow(
      "MODS_UI_ACTION_INVALID"
    )
    await expect(session.panes.act(action(pane, "mode", "select", "forged"))).rejects.toThrow(
      "MODS_UI_ACTION_INVALID"
    )
    expect(state.get("board-count")).toBe(1)
  })

  it("runs press/input hooks before closures and allows a close hook to retain the pane", async () => {
    const { session, state } = await fixture(`
      on("ui.press",{element:"count"},()=>({element:"count"}));
      on("ui.input",{kind:"submit"},($,e,next)=>next({...e,value:e.value.toUpperCase()}));
      on("ui.close",()=>({value:undefined}));
    `)
    const [pane] = await session.panes.snapshot()
    await session.panes.act(action(pane, "count"))
    expect(state.has("board-count")).toBe(false)
    await session.panes.act(action(pane, "note", "submit", "abc"))
    expect(state.get("board-note")).toBe("ABC")
    const [updated] = await session.panes.snapshot()
    await session.panes.act({ ...action(updated, "count"), kind: "close" })
    expect(await session.panes.snapshot()).toHaveLength(1)
  })

  it("routes Pane focus and scroll lifecycle events through the host hooks", async () => {
    const { session, state } = await fixture(`
      on("ui.focus",($,e)=>$.store.set("pane-focus", e.focused));
      on("ui.scroll",($,e)=>$.store.set("pane-scroll", e.value));
    `)
    const [pane] = await session.panes.snapshot()
    const focus = action(pane, "count", "focus", { focused: true })
    Reflect.deleteProperty(focus, "handle")
    await session.panes.act(focus)
    await session.panes.act({
      ...action(pane, "count", "scroll", { deltaX: 0, deltaY: 12, top: 12, left: 0 }),
      handle: 0,
      plugin: pane.plugin
    })
    expect(state.get("pane-focus")).toBe(true)
    expect(state.get("pane-scroll")).toEqual({ deltaX: 0, deltaY: 12, top: 12, left: 0 })
  })

  it("cancels a pending Pane focus hook when the pane closes", async () => {
    const { session, state } = await fixture(`
      on("ui.focus", async ($)=>{
        await $.store.set("focus-entered", true);
        await $.clock.sleep(200);
        await $.store.set("focus-completed", true);
      });
    `)
    const [pane] = await session.panes.snapshot()
    const focus = session.panes.act({
      ...action(pane, "count", "focus", { focused: true }),
      handle: 0,
      plugin: pane.plugin
    })
    await expect.poll(() => state.get("focus-entered")).toBe(true)
    await session.panes.closePane(pane.plugin, pane.id)
    await expect(focus).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(state.has("focus-completed")).toBe(false)
  })

  it("checks grants again even when an intent was already settled", async () => {
    const { session, state, revoke } = await fixture()
    const [pane] = await session.panes.snapshot()
    const click = action(pane, "count")
    await session.panes.act(click)
    revoke()
    expect(() => session.panes.act(click)).toThrow("MODS_SCOPE_CHANGED")
    expect(state.get("board-count")).toBe(1)
  })

  it("reclaims callback generations through hundreds of redraws", async () => {
    const { session, guest } = await fixture()
    const failures: string[] = []
    const generations = new Set<string>()
    const invoke = guest.invoke.bind(guest)
    const releases = vi.spyOn(guest, "releaseUi")
    vi.spyOn(guest, "invoke").mockImplementation(async (...args) => {
      try { return await invoke(...args) }
      catch (error) {
        failures.push(error instanceof ModFunctionError ? JSON.stringify({ code: error.code,
          downstream: error.downstream, stack: error.stack, event: args[3].event }) : String(error))
        throw error
      }
    })
    for (let index = 0; index < 260; index++) {
      const [pane] = await session.panes.snapshot()
      generations.add(pane.generation)
      const tree = JSON.stringify(pane.tree)
      const diagnostic = tree.includes("加一") ? undefined : JSON.stringify({
        index, pane, guest: guest.stats, failures, logs: await session.logSnapshot()
      })
      expect(tree, diagnostic).toContain("加一")
      expect(failures).toEqual([])
      session.panes.invalidate()
      // Production invalidations coalesce for 100 ms. This is a handle-retention test,
      // not an attempt to exceed the separate guest CPU budget with a busy render loop.
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(generations.size).toBe(260)
    expect(releases).toHaveBeenCalledTimes(260)
    expect(guest.stats).toMatchObject({ frames: 0, replies: 0, disposed: false })
  }, 45000)
})

it("keeps explicit pane open identity across redraws but replaces it on reopen", async () => {
  const { session } = await fixture()
  const [initial] = await session.panes.snapshot()
  expect(initial.openRequestId).toBeTruthy()
  session.panes.invalidate()
  const [redrawn] = await session.panes.snapshot()
  expect(redrawn.generation).not.toBe(initial.generation)
  expect(redrawn.openRequestId).toBe(initial.openRequestId)
  session.panes.open(initial.plugin, { id: initial.id, title: initial.title })
  const [openedAgain] = await session.panes.snapshot()
  expect(openedAgain.openRequestId).not.toBe(initial.openRequestId)
  await session.panes.closePane(initial.plugin, initial.id)
  session.panes.open(initial.plugin, { id: initial.id, title: initial.title })
  const [reopened] = await session.panes.snapshot()
  expect(reopened.openRequestId).not.toBe(openedAgain.openRequestId)
})

it.each(["replace", "delete"])("rejects publication attempting to %s native pane open identity", async mode => {
  const { session } = await fixture("", async value => {
    if (!Array.isArray(value)) return value
    return value.map(row => {
      if (!row || typeof row !== "object" || Array.isArray(row) || !("openRequestId" in row)) return row
      const copy = { ...row }
      if (mode === "delete") delete copy.openRequestId
      else copy.openRequestId = "changed-open-identity"
      return copy
    })
  })
  await expect(session.panes.snapshot()).rejects.toThrow(
    mode === "delete" ? "MODS_JSON_TYPE" : "MODS_UI_PUBLICATION"
  )
})
