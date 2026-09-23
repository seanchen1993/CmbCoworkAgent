import { resolve } from "node:path"
import { expect, it } from "vitest"
import { compileFunctionPlugin } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { CLIENT_BOOTSTRAP } from "./client-bootstrap"

it("compiles Svg in a real pane and isolated Client and releases both on close", async () => {
  const compiled = await compileFunctionPlugin(resolve("tests/fixtures/mods-v2/svg-pane"))
  const guest = await FunctionGuestRuntime.create(compiled.code, compiled.options)
  const session = new FunctionSession(
    [{ ...compiled, guest, tier: "user", capabilities: [...SESSION_CAPABILITIES] }],
    {
      workspace: "/project",
      threadId: "thread",
      assertLive: () => {},
      publish: async (v) => v,
      loadClient: (plugin, module) =>
        FunctionGuestRuntime.create(CLIENT_BOOTSTRAP + "\n" + compiled.clients[module], { plugin })
    }
  )
  try {
    expect(await session.run("svg-pane", "")).toEqual({ text: "VECTOR_OPEN" })
    const [pane] = await session.panes.snapshot()
    expect(
      pane.tree.children?.slice(0, 2).map((node) => (typeof node === "string" ? null : node.type))
    ).toEqual(["Svg", "Svg"])
    expect(pane.clients?.[0].error).toBeUndefined()
    expect(pane.clients?.[0].tree.type).toBe("Svg")
    await session.panes.closePane(pane.plugin, pane.id)
    expect(await session.panes.snapshot()).toEqual([])
  } finally {
    await session.close()
  }
})
