import { resolve } from "node:path"
import { expect, it } from "vitest"
import { compileFunctionPlugin } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { functionCodeRows } from "../../../shared/mods/v2/code"
import type { FunctionUiElement } from "../../../shared/mods/v2/ui"

it("compiles real JSX Code into a validated session pane and releases it on close", async () => {
  const compiled = await compileFunctionPlugin(resolve("tests/fixtures/mods-v2/code-pane"))
  const guest = await FunctionGuestRuntime.create(compiled.code, compiled.options)
  const session = new FunctionSession(
    [{ ...compiled, guest, tier: "user", capabilities: [...SESSION_CAPABILITIES] }],
    {
      workspace: "/project",
      threadId: "thread",
      assertLive: () => undefined,
      publish: async (value) => value
    }
  )
  try {
    expect(await session.run("code-pane", "")).toEqual({ text: "CODE_PREVIEW_OPEN" })
    const [pane] = await session.panes.snapshot()
    const nodes = pane.tree.children!.filter(
      (node): node is FunctionUiElement => typeof node !== "string" && node.type === "Code"
    )
    expect(nodes).toHaveLength(2)
    expect(functionCodeRows(nodes[0].props)[0].newLine).toBe(42)
    expect(functionCodeRows(nodes[1].props)).toContainEqual({
      kind: "add",
      text: "new value",
      newLine: 1
    })
    await session.panes.closePane(pane.plugin, pane.id)
    expect(await session.panes.snapshot()).toEqual([])
  } finally {
    await session.close()
  }
})
