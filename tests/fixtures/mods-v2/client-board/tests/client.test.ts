import { test, expect, tier } from "claude-code/testing"
tier("user")
test("Client is a data node with plugin ownership and a resolved surface module", async ($) => {
  const tree = await $.ui.render({
    surface: "desktop",
    component: "Pane",
    requestId: "client-board",
    props: { title: "Client board", isFocused: false, placement: "inline", bodyColumns: 80 }
  })
  expect(tree.type).toBe("Client")
  expect(tree.client).toEqual({ plugin: "client-board" })
  expect(tree.props.key).toBe("counter")
  expect(tree.props.module).toBe("hooks/surface.tsx")
  expect(tree.props.props).toEqual({ label: "Client state" })
})
