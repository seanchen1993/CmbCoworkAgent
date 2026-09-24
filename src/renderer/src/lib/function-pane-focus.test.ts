import { expect, it } from "vitest"
import { canRequestPaneFocus, paneFocusElement } from "./function-pane-focus"

it("accepts only the active empty composer or the transient empty body focus", () => {
  const ready = {
    visible: true,
    active: true,
    emptyComposer: true,
    composerReady: true,
    dialog: false,
    current: "composer" as const
  }
  expect(canRequestPaneFocus(ready)).toBe(true)
  expect(canRequestPaneFocus({ ...ready, current: "body" })).toBe(true)
  for (const state of [
    { ...ready, visible: false },
    { ...ready, active: false },
    { ...ready, emptyComposer: false },
    { ...ready, composerReady: false },
    { ...ready, dialog: true },
    { ...ready, current: "other" as const }
  ])
    expect(canRequestPaneFocus(state)).toBe(false)
})

it("selects the current owned Client handle and rejects a stale or foreign drawing", () => {
  const node = (plugin: string, client?: string, handle = "7") =>
    ({
      dataset: { functionPlugin: plugin, functionControl: "target", functionHandle: handle },
      closest: () => (client ? { dataset: { functionClientInstance: client } } : null)
    }) as unknown as HTMLElement
  const native = node("owner")
  const current = node("owner", "current")
  const section = {
    querySelectorAll: () => [native, node("foreign", "current"), node("owner", "old"), current]
  } as unknown as HTMLElement
  const target = { plugin: "owner", element: "target", client: "current", clientHandle: 7 }
  expect(paneFocusElement(section, target)).toBe(current)
  expect(paneFocusElement(section, { ...target, clientHandle: 8 })).toBeUndefined()
  expect(paneFocusElement(section, { ...target, client: "replaced" })).toBeUndefined()
  expect(paneFocusElement(section, { plugin: "owner", element: "target" })).toBe(native)
  expect(paneFocusElement(section, { ...target, clientHandle: undefined })).toBe(current)
})
