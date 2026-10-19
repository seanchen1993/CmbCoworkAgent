import { describe, expect, it, vi } from "vitest"
import type { McpCapabilityService, McpCapabilityTool } from "../mcp/capability-types"
import { createBotMcpScope } from "./mcp-scope"

describe("Bot connector scope", () => {
  it("filters discovery and revalidates old aliases at invocation without closing the shared pool", async () => {
    const make = (name: string): McpCapabilityTool => ({
      capabilityId: name,
      toolId: name,
      providerKey: name,
      providerAlias: name,
      providerDisplayName: name,
      toolName: "invoke",
      visibility: "lazy"
    })
    const browser = make("in-app-browser"),
      docs = make("documents")
    let alias = docs
    const base: McpCapabilityService = {
      configuredServerNames: () => [browser.providerKey, docs.providerKey],
      peekTools: () => [browser, docs],
      listTools: async () => [browser, docs],
      getSnapshot: async () => ({ fingerprint: "v1", tools: [browser, docs] }),
      getTool: async (id) =>
        id === "old-alias"
          ? alias
          : ([browser, docs].find((tool) => tool.capabilityId === id) ?? null),
      invoke: vi.fn(async (id) => ({ capabilityId: id, raw: "ok", text: "ok", isError: false })),
      invalidate: vi.fn(async () => {}),
      close: vi.fn(async () => {})
    }
    const scoped = createBotMcpScope(base)
    expect(scoped.configuredServerNames!()).toEqual(["documents"])
    expect(scoped.peekTools!()).toEqual([docs])
    expect(await scoped.listTools()).toEqual([docs])
    expect((await scoped.getSnapshot!()).tools).toEqual([docs])
    expect(await scoped.getTool(browser.capabilityId)).toBeNull()
    await scoped.invoke("old-alias", {})
    expect(base.invoke).toHaveBeenCalledWith("documents", {})
    alias = browser
    await expect(scoped.invoke("old-alias", {})).rejects.toThrow("共享电脑")
    await expect(scoped.invoke(browser.capabilityId, {})).rejects.toThrow("共享电脑")
    expect(base.invoke).toHaveBeenCalledTimes(1)
    await scoped.close()
    expect(base.close).not.toHaveBeenCalled()
  })
})
