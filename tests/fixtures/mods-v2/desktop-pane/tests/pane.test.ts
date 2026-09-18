import { expect, test, tier } from "claude-code/testing"
tier("user")
test("a retained SDK remains usable from a later hook invocation", async ($, on) => {
  let count = 0
  on("session.id", () => ({ value: "frame-" + ++count }))
  expect(await $.command.run({ command: "pane-retained" })).toEqual({ text: "frame-1" })
  expect(await $.command.run({ command: "pane-retained" })).toEqual({ text: "frame-2" })
})
test("pane operations are hookable void operations", async ($, on) => {
  const seen = []
  on("ui.open", (_, e) => {
    seen.push([e.id, e.title, e.rows, e.closeOnEscape])
    return { value: undefined }
  })
  on("ui.close", (_, e) => {
    seen.push([e.id, e.origin.kind])
    return { value: undefined }
  })
  const answer = await $.command.run({ command: "pane-probe" })
  expect(JSON.parse(answer.text)).toEqual({ opened: "undefined", closed: "undefined" })
  expect(seen).toEqual([
    ["probe", "Probe", 8, true],
    ["probe", "plugin"]
  ])
})
test("desktop constructors produce data trees and keep callbacks behind handles", async ($) => {
  const tree = await $.ui.render({
    surface: "desktop",
    component: "Pane",
    requestId: "probe",
    props: { title: "Probe", isFocused: false, placement: "inline", bodyColumns: 80 }
  })
  expect(tree.type).toBe("Box")
  expect(tree.children.map((child) => child.type)).toEqual([
    "Text",
    "Button",
    "Input",
    "Select",
    "Link",
    "Code"
  ])
  expect(tree.children[1].props).toEqual({ key: "Click", label: "Click" })
  expect(tree.children[1].press.plugin).toBe("desktop-pane")
  expect(typeof tree.children[1].press.handle).toBe("number")
  expect(tree.children[1].props.onPress).toBeUndefined()
  expect(tree.children[2].props.value).toBe("hello")
  expect(tree.children[3].props.value).toBe("a")
})
