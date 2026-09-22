import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { compileFunctionPlugin } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import type { ModJson } from "../../../shared/mods/types"
import type {
  FunctionPaneSnapshot,
  FunctionUiElement,
  FunctionUiAction
} from "../../../shared/mods/v2/ui"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
})

async function fixture(
  extra = "",
  publish: (value: ModJson) => Promise<ModJson> = async (value) => value
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
  value?: string
): FunctionUiAction {
  let found: FunctionUiElement | undefined
  const visit = (node: FunctionUiElement | string): void => {
    if (typeof node === "string") return
    if (node.props.key === key) found = node
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
    const { session } = await fixture()
    for (let index = 0; index < 260; index++) {
      const [pane] = await session.panes.snapshot()
      expect(JSON.stringify(pane.tree)).toContain("加一")
      session.panes.invalidate()
    }
  }, 15000)
})
