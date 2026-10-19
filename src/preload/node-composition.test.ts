import { expect, it, vi } from "vitest"
import { createNodeCompositionBridge } from "./node-composition"

it("forwards explicit read-only compatibility inspection without an execution request", async () => {
  const invoke = vi.fn(async () => ({ authorization: "not-evaluated" }))
  const input = { threadId: "thread", expectedWorkspace: "workspace", pluginId: "installed" }
  const result = await createNodeCompositionBridge(invoke).compatibility(input)
  expect(invoke.mock.calls).toEqual([["node-composition:compatibility", input]])
  expect(result.authorization).toBe("not-evaluated")
})
