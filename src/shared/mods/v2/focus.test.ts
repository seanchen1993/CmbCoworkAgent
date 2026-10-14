import { expect, it } from "vitest"
import { functionFocusHandle, functionFocusTargets } from "./focus"
import type { FunctionUiElement, FunctionUiNode } from "./ui"

const button: FunctionUiNode = {
  type: "Button",
  props: { key: "review", label: "Review", autoFocus: true },
  press: { plugin: "p", handle: 7 }
}

it("never produces a plugin focus handle from native engine content", () => {
  const engine: FunctionUiElement = { type: "engine", ref: 7 }
  const target = { plugin: "p", element: "review" }
  expect(functionFocusHandle(engine, target)).toBeUndefined()
  expect(functionFocusHandle({ type: "Box", props: {}, children: [engine, button] }, target)).toBe(
    7
  )
})

it("keeps ordinary and Client controls in order around native leaves", () => {
  const tree: FunctionUiElement = {
    type: "Box",
    props: {},
    children: [
      { type: "engine", ref: 0 },
      button,
      {
        type: "Client",
        props: { key: "local", module: "local.ts" },
        client: { plugin: "p" }
      }
    ]
  }
  expect(
    functionFocusTargets({
      tree,
      clients: [
        {
          id: "client-instance",
          generation: "draw-1",
          plugin: "p",
          element: "local",
          module: "local.ts",
          tree: {
            type: "Box",
            props: {},
            children: [
              { type: "engine", ref: 5 },
              {
                ...button,
                props: { key: "local-review", label: "Local review" }
              }
            ]
          }
        }
      ]
    })
  ).toEqual([
    { target: { plugin: "p", element: "review" }, autoFocus: true },
    {
      target: { plugin: "p", element: "local-review", client: "client-instance" },
      autoFocus: false
    }
  ])
})

it("treats even malformed native leaves as no plugin control pending boundary rejection", () => {
  const forged = {
    type: "engine",
    ref: 0,
    props: button.props,
    press: button.press
  } as FunctionUiElement
  expect(functionFocusHandle(forged, { plugin: "p", element: "review" })).toBeUndefined()
  expect(functionFocusTargets({ tree: forged })).toEqual([])
})
