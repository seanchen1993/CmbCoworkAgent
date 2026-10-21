import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { isModObject } from "../../../shared/mods/v2/contracts"
import type { ModJson } from "../../../shared/mods/types"
import type { FunctionPaneSnapshot, FunctionUiAction } from "../../../shared/mods/v2/ui"
import { FunctionPanes } from "./panes"

type Transition = "redraw" | "close" | "reopen" | "revoke" | "generation" | "scope" | "deny"
const registries: FunctionPanes[] = []
afterEach(() => {
  for (const panes of registries.splice(0)) panes.close()
})

function fixture(transition: Transition, targetControl = false) {
  let live = true
  let focusCount = 0
  const panes = new FunctionPanes({
    plugins: [],
    assertLive() {
      if (!live) throw Error("MODS_SCOPE_CHANGED")
    },
    changed() {
      /* The explicit snapshot below deterministically interleaves the host redraw. */
    },
    callback: async () => {},
    publish: async (value) => value,
    dispatch: async (event, input, options): Promise<ModJson> => {
      if (event === "ui.render")
        return targetControl
          ? {
              type: "Button",
              props: { key: "control", label: "Control", autoFocus: true },
              press: { plugin: "p", handle: 1 }
            }
          : {
              type: "Text",
              props: {},
              children: [
                `focus:${focusCount} focused:${isModObject(input.props) && input.props.isFocused}`
              ]
            }
      if (event === "ui.focus" || event === "ui.scroll") {
        focusCount++
        // Same ordering as a ui.focus handler invalidating before returning next(event).
        panes.invalidate()
        const [redrawn] = await panes.snapshot()
        if (transition === "close") await panes.closePane("p", "board")
        if (transition === "reopen") {
          panes.open("p", { id: "board" })
          await panes.snapshot()
        }
        if (transition === "revoke") {
          panes.invalidate(undefined, true)
          await panes.snapshot()
        }
        if (transition === "generation") {
          panes.invalidateGeneration(redrawn.generation)
          await panes.snapshot()
        }
        if (transition === "scope") live = false
        if (transition === "deny") return { deny: "Focus retained by handler" }
      }
      return (await options.core?.(input, options.signal ?? new AbortController().signal)) ?? {}
    }
  })
  registries.push(panes)
  panes.open("p", { id: "board" })
  return { panes, count: () => focusCount }
}
function focus(pane: FunctionPaneSnapshot): FunctionUiAction {
  return {
    pane: pane.key,
    generation: pane.generation,
    plugin: pane.plugin,
    handle: 0,
    intentId: randomUUID(),
    kind: "focus",
    value: { focused: true }
  }
}

describe("admitted Pane focus across a handler-triggered redraw", () => {
  it("records focus after invalidate/render overtakes next without admitting an old action again", async () => {
    const f = fixture("redraw")
    const [before] = await f.panes.snapshot()
    const action = focus(before)
    await expect(f.panes.act(action)).resolves.toEqual({ focused: true })
    const [after] = await f.panes.snapshot()
    expect(after.generation).not.toBe(before.generation)
    expect(JSON.stringify(after.tree)).toContain("focus:1 focused:true")
    // The identical person intent is replay-safe; a new intent with the old drawing is stale.
    await expect(f.panes.act(action)).resolves.toEqual({ focused: true })
    await expect(f.panes.act({ ...action, intentId: randomUUID() })).rejects.toThrow(
      "MODS_UI_STALE_ACTION"
    )
    expect(f.count()).toBe(1)
  })

  it.each(["close", "reopen", "revoke", "generation", "scope"] as const)(
    "still rejects %s during an admitted focus event",
    async (transition) => {
      const f = fixture(transition)
      const [before] = await f.panes.snapshot()
      await expect(f.panes.act(focus(before))).rejects.toThrow(/STALE|CLOSED|SCOPE_CHANGED/)
      expect(f.count()).toBe(1)
      if (transition !== "scope") {
        const remaining = await f.panes.snapshot()
        expect(JSON.stringify(remaining)).not.toContain("focused:true")
      }
    }
  )

  it("keeps control focus pinned to the original drawing even when the same key is redrawn", async () => {
    const f = fixture("redraw", true)
    const [before] = await f.panes.snapshot()
    await expect(f.panes.act(focus(before))).rejects.toThrow("MODS_UI_STALE_ACTION")
    expect(f.count()).toBe(1)
  })

  it("keeps scroll pinned to the original drawing", async () => {
    const f = fixture("redraw")
    const [before] = await f.panes.snapshot()
    await expect(
      f.panes.act({
        ...focus(before),
        kind: "scroll",
        value: { deltaX: 0, deltaY: 1, top: 1, left: 0 }
      })
    ).rejects.toThrow("MODS_UI_STALE_ACTION")
  })

  it("records blur after the focus handler redraws the previously focused Pane", async () => {
    const f = fixture("redraw")
    const [before] = await f.panes.snapshot()
    await f.panes.act(focus(before))
    const [focused] = await f.panes.snapshot()
    await expect(f.panes.act({ ...focus(focused), value: { focused: false } })).resolves.toEqual({
      focused: false
    })
    expect(JSON.stringify((await f.panes.snapshot())[0].tree)).toContain("focus:2 focused:false")
  })

  it("does not synthesize successful focus when a handler denies after redraw", async () => {
    const f = fixture("deny")
    const [before] = await f.panes.snapshot()
    await expect(f.panes.act(focus(before))).resolves.toEqual({ focused: false })
    expect(JSON.stringify((await f.panes.snapshot())[0].tree)).toContain("focused:false")
  })
})
