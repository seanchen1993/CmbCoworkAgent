import { randomUUID } from "node:crypto"
import { afterEach, expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionPanes } from "./panes"
import type { FunctionPaneSnapshot, FunctionUiAction } from "../../../shared/mods/v2/ui"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

async function fixture(observed: boolean) {
  let clicks = 0,
    observations = 0,
    live = true
  const guest = await FunctionGuestRuntime.create("var __cmbFunctionMod={register(){}}")
  const panes = new FunctionPanes({
    plugins: [{ name: "p", root: "/p", tier: "user", guest, capabilities: [] }],
    hasEventHooks: () => observed,
    assertLive() {
      if (!live) throw Error("MODS_SCOPE_CHANGED")
    },
    changed() {},
    publish: async (value) => value,
    callback: async () => {
      clicks++
    },
    dispatch: async (event, input, options) => {
      if (event === "ui.render")
        return {
          type: "Button",
          props: { key: "check", label: "Check" },
          press: { plugin: "p", handle: 1 }
        }
      if (event === "ui.scroll" || event === "ui.focus") observations++
      return (await options.core?.(input, options.signal ?? new AbortController().signal)) ?? {}
    }
  })
  panes.open("p", { id: "board" })
  cleanup.push(async () => {
    panes.close()
    guest.dispose()
  })
  return {
    panes,
    facts: () => ({ clicks, observations }),
    revoke: () => {
      live = false
    }
  }
}

function scroll(pane: FunctionPaneSnapshot): FunctionUiAction {
  return {
    pane: pane.key,
    generation: pane.generation,
    plugin: pane.plugin,
    handle: 0,
    intentId: randomUUID(),
    kind: "scroll",
    value: { deltaX: 0, deltaY: 1, top: 1, left: 0 }
  }
}

function press(pane: FunctionPaneSnapshot): FunctionUiAction {
  return {
    pane: pane.key,
    generation: pane.generation,
    plugin: pane.plugin,
    handle: 1,
    intentId: randomUUID(),
    kind: "press"
  }
}

it("retires observed scroll intents with drawings without exhausting real control intents", async () => {
  const f = await fixture(true)
  let [pane] = await f.panes.snapshot()
  for (let index = 0; index < 4100; index++) {
    await f.panes.act(scroll(pane))
    ;[pane] = await f.panes.snapshot()
  }
  const control = press(pane)
  await f.panes.act(control)
  f.panes.invalidate()
  await f.panes.snapshot()
  await f.panes.act(control)
  expect(f.facts()).toEqual({ observations: 4100, clicks: 1 })
}, 20000)

it("keeps current observation retries idempotent and rejects retired replays", async () => {
  const f = await fixture(true)
  const [pane] = await f.panes.snapshot()
  const observation = scroll(pane)
  await f.panes.act(observation)
  await f.panes.act(observation)
  await expect(
    f.panes.act({ ...observation, value: { deltaX: 0, deltaY: 2, top: 2, left: 0 } })
  ).rejects.toThrow("MODS_UI_INTENT_CONFLICT")
  await f.panes.snapshot()
  await expect(f.panes.act(observation)).rejects.toThrow("MODS_UI_STALE_ACTION")
  expect(f.facts().observations).toBe(1)
})

it("leaves unobserved scrolling side-effect free while retaining every admission fence", async () => {
  const f = await fixture(false)
  const [pane] = await f.panes.snapshot()
  for (let index = 0; index < 4100; index++) await f.panes.act(scroll(pane))
  expect((await f.panes.snapshot())[0].generation).toBe(pane.generation)
  expect(f.facts()).toEqual({ observations: 0, clicks: 0 })
  const control = press(pane)
  await f.panes.act(control)
  await expect(f.panes.act({ ...scroll(pane), intentId: control.intentId })).rejects.toThrow(
    "MODS_UI_INTENT_CONFLICT"
  )
  await expect(f.panes.act({ ...scroll(pane), plugin: "other" })).rejects.toThrow(
    "MODS_UI_ACTION_INVALID"
  )
  await expect(f.panes.act({ ...scroll(pane), value: { deltaY: 1 } })).rejects.toThrow(
    "MODS_UI_ACTION_INVALID"
  )
  await expect(f.panes.act({ ...scroll(pane), generation: randomUUID() })).rejects.toThrow(
    "MODS_UI_STALE_ACTION"
  )
  f.revoke()
  expect(() => f.panes.act(scroll(pane))).toThrow("MODS_SCOPE_CHANGED")
  expect(f.facts()).toEqual({ observations: 0, clicks: 1 })
})
