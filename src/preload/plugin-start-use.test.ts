import { expect, it, vi } from "vitest"
import { createPluginStartUseBridge } from "./plugin-start-use"

it("forwards the exact installed identity to the dedicated read-only native channel", async () => {
  const result = { kind: "host-project", canOpen: true }
  const invoke = vi.fn().mockResolvedValue(result)
  const input = {
    threadId: "chat",
    expectedWorkspace: "workspace",
    pluginId: "plugin",
    expected: { name: "sample", version: "1.0.0", digest: "a".repeat(64) }
  }
  expect(await createPluginStartUseBridge(invoke).prepareStartUse(input)).toBe(result)
  expect(invoke).toHaveBeenCalledExactlyOnceWith("plugins:prepareStartUse", input)
})

it("keeps explicit enablement on its own native channel and carries the exact digest", async () => {
  const invoke = vi.fn().mockResolvedValue({ canOpen: true })
  const input = {
    threadId: "chat",
    expectedWorkspace: "workspace",
    pluginId: "plugin",
    expected: { name: "sample", version: "1.0.0", digest: "b".repeat(64) }
  }
  await createPluginStartUseBridge(invoke).enableStartUse(input)
  expect(invoke).toHaveBeenCalledExactlyOnceWith("plugins:enableStartUse", input)
})
