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
      }, "execution")
      expect(await scope.listTools()).toEqual([])
      for (const tool of tools) {
        expect(await scope.getTool(tool.toolId)).toBeNull()
        await expect(scope.invoke(tool.toolId, {})).rejects.toThrow("共享电脑")
      }
      expect(invoke).not.toHaveBeenCalled()
    }
  )

  it.each([
    { toolName: "web-fetch" }, { toolName: "WebFetch" }, { toolName: "fetch_url" },
    { toolName: "fetch", inputSchema: { properties: { url: { type: "string" } } } },
    { providerDisplayName: "web-fetch", toolName: "get" },
    { providerKey: "plugin:extension/web-fetch", toolName: "get" }
  ])("keeps a web reader out of the main chat and discoverable to the executor (%o)", async (metadata) => {
    const reader: McpCapabilityTool = {
      providerDisplayName: "Utilities", providerKey: "opaque", providerAlias: "alias",
      capabilityId: "reader", toolId: "old-reader", visibility: "eager", ...metadata
    }
    const business: McpCapabilityTool = { ...reader, capabilityId: "issue", toolId: "issue",
      providerKey: "plugin:web-fetch-integration/issues", providerDisplayName: "Issues",
      toolName: "fetch_issue", description: "Fetch an issue by URL", inputSchema: { properties: { url: {} } } }
    const tools = [reader, business]
    const base = {
      listTools: async () => tools,
      getSnapshot: async () => ({ fingerprint: "v1", tools }),
      getTool: async (id: string) => tools.find(t => [t.toolId, t.capabilityId].includes(id)) ?? null,
      invoke: vi.fn(async (id: string) => ({ capabilityId: id, raw: "ok", text: "ok", isError: false })),
      invalidate: vi.fn(), close: vi.fn()
    }
    const main = createBotMcpScope(base, "communication")
    const executor = createBotMcpScope(base, "execution")
    const deferred = { ...reader, visibility: "lazy" }
    expect(await main.listTools()).toEqual([business])
    expect(await executor.listTools()).toEqual([deferred, business])
    const mainSnapshot = await main.getSnapshot!()
    const taskSnapshot = await executor.getSnapshot!()
    expect(mainSnapshot.tools).toEqual([business])
    expect(taskSnapshot.tools).toEqual([deferred, business])
    expect(mainSnapshot.fingerprint).not.toBe(taskSnapshot.fingerprint)
    for (const id of [reader.capabilityId, reader.toolId]) {
      expect(await main.getTool(id)).toBeNull()
      await expect(main.invoke(id, {})).rejects.toThrow("交给独立任务")
      expect(await executor.getTool(id)).toEqual(deferred)
    }
    expect(base.invoke).not.toHaveBeenCalled()
    await executor.invoke(reader.toolId, { url: "https://example.test" })
    expect(base.invoke).toHaveBeenCalledWith(reader.capabilityId, { url: "https://example.test" })
    expect(reader.visibility).toBe("eager")
  })
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
    const scoped = createBotMcpScope(base, "execution")
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
