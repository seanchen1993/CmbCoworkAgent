import { describe, expect, it, vi } from "vitest"
import type { McpCapabilityService, McpCapabilityTool } from "../mcp/capability-types"
import { createBotMcpScope } from "./mcp-scope"

describe("Bot connector scope", () => {
  it.each(["browser_snapshot", "playwright", "puppeteer", "selenium", "computer", "inAppBrowser"])(
    "blocks %s through eager, lazy and restored aliases while retaining document tools",
    async (name) => {
      const tools: McpCapabilityTool[] = ["eager", "lazy"].map((visibility) => ({
        capabilityId: `${name}:${visibility}`, toolId: `tool_${visibility}`, providerKey: "connector",
        providerAlias: "opaque", providerDisplayName: "Connector", toolName: name,
        visibility: visibility as "eager" | "lazy"
      }))
      const invoke = vi.fn()
      const scope = createBotMcpScope({
        listTools: async () => tools,
        getTool: async (id) => tools.find(t => t.toolId === id) ?? null,
        invoke, invalidate: async () => {}, close: async () => {}
      })
      expect(await scope.listTools()).toEqual([])
      for (const tool of tools) {
        expect(await scope.getTool(tool.toolId)).toBeNull()
        await expect(scope.invoke(tool.toolId, {})).rejects.toThrow("共享电脑")
      }
      expect(invoke).not.toHaveBeenCalled()
    }
  )
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
