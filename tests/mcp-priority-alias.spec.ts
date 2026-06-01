/**
 * Unit tests for priority-based MCP alias selection.
 *
 * Run with:
 *   npx tsx tests/mcp-priority-alias.spec.ts
 */
import assert from "node:assert/strict"
import { buildScopedToolAliases } from "../src/main/mcp/aliasing.ts"
import type { McpCapabilityTool } from "../src/main/mcp/capability-types.ts"

function tool(
  partial: Partial<McpCapabilityTool> &
    Pick<McpCapabilityTool, "capabilityId" | "toolName" | "providerKey">
): McpCapabilityTool {
  return {
    toolId: `mcp__${partial.providerKey.replace(/[^a-zA-Z0-9]/g, "_")}__${partial.toolName}`,
    canonicalToolId: `mcp__${partial.providerKey.replace(/[^a-zA-Z0-9]/g, "_")}__${partial.toolName}`,
    providerAlias: partial.providerKey,
    providerDisplayName: partial.providerKey,
    visibility: "eager",
    ...partial
  }
}

const pluginSearch = tool({
  capabilityId: "plugin:p1/search:search",
  providerKey: "plugin:p1/search",
  toolName: "search",
  sourceKind: "plugin",
  pluginId: "p1",
  priority: 200
})
const globalSearch = tool({
  capabilityId: "connector:g1:search",
  providerKey: "g1",
  toolName: "search",
  sourceKind: "connector",
  priority: 100
})

const aliases = buildScopedToolAliases([globalSearch, pluginSearch], (item) => item.priority ?? 0)
const plugin = aliases.find((item) => item.capabilityId === pluginSearch.capabilityId)
const global = aliases.find((item) => item.capabilityId === globalSearch.capabilityId)

assert.equal(global?.toolId, "mcp__search")
assert.equal(plugin?.toolId, pluginSearch.canonicalToolId)

const globalWinsAliases = buildScopedToolAliases(
  [{ ...globalSearch, priority: 100 }, { ...pluginSearch, priority: 100 }],
  (item) => item.priority ?? 0
)
const globalWinner = globalWinsAliases.find((item) => item.capabilityId === globalSearch.capabilityId)
assert.equal(globalWinner?.toolId, "mcp__search")

const suffixCollisionAliases = buildScopedToolAliases(
  [
    tool({
      capabilityId: "connector:first:alpha",
      providerKey: "first",
      toolName: "alpha",
      canonicalToolId: "mcp__dup",
      toolId: "mcp__dup"
    }),
    tool({
      capabilityId: "connector:second:beta",
      providerKey: "second",
      toolName: "beta",
      canonicalToolId: "mcp__dup_2",
      toolId: "mcp__dup_2"
    }),
    tool({
      capabilityId: "connector:winner:search",
      providerKey: "winner",
      toolName: "search",
      priority: 200
    }),
    tool({
      capabilityId: "connector:conflict:search",
      providerKey: "conflict",
      toolName: "search",
      canonicalToolId: "mcp__dup",
      toolId: "mcp__dup",
      priority: 100
    })
  ],
  (item) => item.priority ?? 0
)
const conflict = suffixCollisionAliases.find((item) => item.capabilityId === "connector:conflict:search")
assert.equal(conflict?.toolId, "mcp__dup_3")

const lazyOnlyAliases = buildScopedToolAliases(
  [
    tool({
      capabilityId: "plugin:p1/sync:sync",
      providerKey: "plugin:p1/sync",
      toolName: "sync",
      sourceKind: "plugin",
      visibility: "lazy",
      priority: 50
    }),
    tool({
      capabilityId: "plugin:p2/sync:sync",
      providerKey: "plugin:p2/sync",
      toolName: "sync",
      sourceKind: "plugin",
      visibility: "lazy",
      priority: 40
    })
  ],
  (item) => item.priority ?? 0
)
assert(!lazyOnlyAliases.some((item) => item.toolId === "mcp__sync"))

const pluginOnlyAliases = buildScopedToolAliases(
  [
    tool({
      capabilityId: "plugin:p1/sync:sync",
      providerKey: "plugin:p1/sync",
      toolName: "sync",
      sourceKind: "plugin",
      visibility: "eager",
      priority: 100
    }),
    tool({
      capabilityId: "plugin:p2/sync:sync",
      providerKey: "plugin:p2/sync",
      toolName: "sync",
      sourceKind: "plugin",
      visibility: "eager",
      priority: 90
    })
  ],
  (item) => item.priority ?? 0
)
assert(!pluginOnlyAliases.some((item) => item.toolId === "mcp__sync"))

const caseCollisionTools = [
  tool({
    capabilityId: "connector:upper:Search",
    providerKey: "upper",
    toolName: "Search",
    sourceKind: "connector",
    priority: 100
  }),
  tool({
    capabilityId: "plugin:p1/upper:Search",
    providerKey: "plugin:p1/upper",
    toolName: "Search",
    sourceKind: "plugin",
    priority: 50
  }),
  tool({
    capabilityId: "connector:lower:search",
    providerKey: "lower",
    toolName: "search",
    sourceKind: "connector",
    priority: 100
  }),
  tool({
    capabilityId: "plugin:p1/lower:search",
    providerKey: "plugin:p1/lower",
    toolName: "search",
    sourceKind: "plugin",
    priority: 50
  })
]
const caseCollisionForward = buildScopedToolAliases(caseCollisionTools, (item) => item.priority ?? 0)
  .map((item) => [item.capabilityId, item.toolId])
  .sort()
const caseCollisionReverse = buildScopedToolAliases([...caseCollisionTools].reverse(), (item) => item.priority ?? 0)
  .map((item) => [item.capabilityId, item.toolId])
  .sort()
assert.deepEqual(caseCollisionForward, caseCollisionReverse)

console.log("PASS MCP priority aliases")
