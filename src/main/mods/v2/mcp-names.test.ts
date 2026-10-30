import { expect, it } from "vitest"
import {
  assertFunctionMcpServerAvailable,
  functionMcpNamePart,
  functionMcpToolCandidates,
  functionMcpToolName
} from "./mcp-names"
import { FunctionToolRegistry } from "./tool-registry"

it("matches the frozen upstream server normalization and all three tool candidates", () => {
  expect(functionMcpNamePart("a.b / c")).toBe("a_b___c")
  expect(functionMcpNamePart("claude.ai   Test ")).toBe("claude_ai_Test")
  expect(functionMcpToolName("my.plugin", "get_item")).toBe("mcp__my_plugin__get_item")
  expect([...functionMcpToolCandidates("my.plugin", "get.item")]).toEqual([
    "mcp__my_plugin__get.item",
    "mcp__my.plugin__get.item",
    "mcp__my_plugin__get_item"
  ])
})

it("keeps normalized plugin ownership unique and preserves identical registration identity", () => {
  const registry = new FunctionToolRegistry()
  const spec = {
    name: "get_item",
    description: "Item",
    inputSchema: { type: "object", properties: { id: { type: "string" } } }
  }
  registry.register("my.plugin", spec)
  const first = registry.get("mcp__my_plugin__get_item")
  expect(registry.resolveMcp("my.plugin", "get.item")).toBe(first)
  expect(registry.resolveMcp("my_plugin", "get_item")).toBe(first)
  expect(registry.resolveMcp("missing", "get_item")).toBeUndefined()
  registry.register("my.plugin", {
    ...spec,
    inputSchema: { properties: { id: { type: "string" } }, type: "object" }
  })
  expect(registry.get(first!.name)).toBe(first)
  expect(() => registry.register("my_plugin", spec)).toThrow("MODS_TOOL_NAME_COLLISION")
  expect(registry.get(first!.name)).toBe(first)
})

it("reserves an entire configured server namespace before any connection or tool discovery", () => {
  expect(() => assertFunctionMcpServerAvailable("my.plugin", ["my_plugin"])).toThrow(
    "MODS_MCP_SERVER_NAME_COLLISION"
  )
  expect(() => assertFunctionMcpServerAvailable("my_plugin", ["my.plugin"])).toThrow(
    "MODS_MCP_SERVER_NAME_COLLISION"
  )
  expect(() => assertFunctionMcpServerAvailable("other", ["my.plugin"])).not.toThrow()
})
