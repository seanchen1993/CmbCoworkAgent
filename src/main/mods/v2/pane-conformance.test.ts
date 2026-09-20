import { resolve } from "node:path"
import { expect, it } from "vitest"
import { compileFunctionPlugin } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionDispatcher, type FunctionPlugin } from "./dispatcher"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { validateFunctionTree } from "../../../shared/mods/v2/ui"

it("uses the official desktop-pane fixture through our operation and rendering pipelines", async () => {
  const compiled = await compileFunctionPlugin(resolve("tests/fixtures/mods-v2/desktop-pane"))
  const guest = await FunctionGuestRuntime.create(compiled.code)
  const plugin: FunctionPlugin = {
    name: compiled.name,
    root: compiled.root,
    tier: "user",
    guest,
    capabilities: [...SESSION_CAPABILITIES]
  }
  const session = new FunctionSession([plugin], {
    workspace: "/project",
    threadId: "thread",
    assertLive: () => {},
    publish: async (value) => value
  })
  try {
    expect(await session.run("pane-retained", "")).toEqual({ text: "thread" })
    expect(await session.run("pane-retained", "")).toEqual({ text: "thread" })
    expect(JSON.parse(String((await session.run("pane-probe", "")).text))).toEqual({
      opened: "undefined",
      closed: "undefined"
    })
    expect(await session.panes.snapshot()).toEqual([])
    const engine = new FunctionDispatcher([plugin])
    const result = await engine.dispatch(
      "ui.render",
      {
        surface: "desktop",
        component: "Pane",
        requestId: "probe",
        props: { title: "Probe", isFocused: false, placement: "inline", bodyColumns: 80 }
      },
      {
        uiGeneration: "probe",
        core: async () => ({ type: "Box", props: {}, children: [] }),
        validateResult: (_, value) => validateFunctionTree(value)
      }
    )
    const tree = result.value as ModObject
    const children = tree.children as ModObject[]
    expect(tree.type).toBe("Box")
    expect(children.map((child) => child.type)).toEqual([
      "Text",
      "Button",
      "Input",
      "Select",
      "Link",
      "Code"
    ])
    expect(children[1].props).toEqual({ key: "Click", label: "Click" })
    expect(children[1].press).toMatchObject({ plugin: "desktop-pane" })
    expect((children[2].props as ModObject).value).toBe("hello")
    expect((children[3].props as ModObject).value).toBe("a")
    const handle = (children[1].press as ModObject).handle as number
    const called: ModJson[] = []
    for (let index = 0; index < 2; index++)
      await guest.invoke(
        "callback",
        {
          surface: "desktop",
          component: "Pane",
          requestId: "probe",
          plugin: "desktop-pane",
          element: "Click"
        },
        async (method, args) => {
          called.push([method, args])
          return { value: "thread" }
        },
        {
          event: "ui.press",
          origin: { plugin: "engine", tier: "core" },
          capabilities: [...SESSION_CAPABILITIES],
          plugin: { name: compiled.name, root: compiled.root },
          callback: { handle, generation: "probe", kind: "onPress" }
        }
      )
    expect(called).toEqual([
      ["session.id", []],
      ["session.id", []]
    ])
  } finally {
    await session.close()
  }
})
