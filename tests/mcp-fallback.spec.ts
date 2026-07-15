/**
 * Unit tests for scoped MCP fallback behavior.
 *
 * Run with:
 *   npx tsx tests/mcp-fallback.spec.ts
 */
import assert from "node:assert/strict"
import {
  createScopedMcpCapabilityService,
  isRetryableMcpTransportError
} from "../src/main/agent/runtime.ts"
import { createHookScope } from "../src/main/hooks/scope.ts"
import type {
  McpCapabilityService,
  McpCapabilityTool,
  McpInvocationResult
} from "../src/main/mcp/capability-types.ts"

function makeResult(capabilityId: string, text: string, isError = false): McpInvocationResult {
  return { capabilityId, raw: text, text, isError }
}

function makeTool(partial: Partial<McpCapabilityTool> & Pick<McpCapabilityTool, "capabilityId" | "providerKey" | "toolName">): McpCapabilityTool {
  return {
    toolId: partial.capabilityId.replace(/[^a-zA-Z0-9]/g, "_"),
    providerAlias: partial.providerKey,
    providerDisplayName: partial.providerKey,
    visibility: "eager",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "string" }
      }
    },
    ...partial
  }
}

async function testFallbackOnlyInvokedOnceAfterPrimaryThrow(): Promise<void> {
  const pluginTool = makeTool({
    capabilityId: "plugin:p1/search:write",
    providerKey: "plugin:p1/search",
    toolName: "write",
    sourceKind: "plugin",
    fallback: { enabled: true, to: "global", match: "toolNameAndSchema", safeToRetry: true }
  })
  const globalTool = makeTool({
    capabilityId: "connector:g1:write",
    providerKey: "g1",
    toolName: "write",
    sourceKind: "connector"
  })
  const calls: Record<string, number> = {}
  const service: McpCapabilityService = {
    listTools: async () => [pluginTool, globalTool],
    getTool: async (id) => [pluginTool, globalTool].find((tool) => tool.capabilityId === id || tool.toolId === id) ?? null,
    invoke: async (id) => {
      calls[id] = (calls[id] ?? 0) + 1
      if (id === pluginTool.capabilityId) throw new Error("ECONNRESET")
      return makeResult(id, "ECONNRESET from fallback", true)
    },
    invalidate: async () => undefined,
    close: async () => undefined
  }

  const scoped = createScopedMcpCapabilityService(
    service,
    createHookScope(),
    () => [],
    undefined,
    undefined,
    { workspacePath: process.cwd(), threadId: "thread-1" }
  )

  const result = await scoped.invoke(pluginTool.capabilityId, { value: "x" })

  assert.equal(calls[pluginTool.capabilityId], 1)
  assert.equal(calls[globalTool.capabilityId], 1)
  assert.equal(result.capabilityId, pluginTool.capabilityId)
  assert.equal(result.fallbackCapabilityId, globalTool.capabilityId)
}

async function testFallbackRequiresSafeToRetry(): Promise<void> {
  const pluginTool = makeTool({
    capabilityId: "plugin:p1/search:write",
    providerKey: "plugin:p1/search",
    toolName: "write",
    sourceKind: "plugin",
    fallback: { enabled: true, to: "global", match: "toolNameAndSchema" }
  })
  const globalTool = makeTool({
    capabilityId: "connector:g1:write",
    providerKey: "g1",
    toolName: "write",
    sourceKind: "connector"
  })
  const calls: Record<string, number> = {}
  const service: McpCapabilityService = {
    listTools: async () => [pluginTool, globalTool],
    getTool: async (id) => [pluginTool, globalTool].find((tool) => tool.capabilityId === id || tool.toolId === id) ?? null,
    invoke: async (id) => {
      calls[id] = (calls[id] ?? 0) + 1
      if (id === pluginTool.capabilityId) throw new Error("ECONNRESET")
      return makeResult(id, "fallback should not run")
    },
    invalidate: async () => undefined,
    close: async () => undefined
  }

  const scoped = createScopedMcpCapabilityService(
    service,
    createHookScope(),
    () => [],
    undefined,
    undefined,
    { workspacePath: process.cwd(), threadId: "thread-2" }
  )

  await assert.rejects(() => scoped.invoke(pluginTool.capabilityId, { value: "x" }), /ECONNRESET/)
  assert.equal(calls[pluginTool.capabilityId], 1)
  assert.equal(calls[globalTool.capabilityId] ?? 0, 0)
}

function testRetryableErrorClassifier(): void {
  assert.equal(isRetryableMcpTransportError(new Error("request timed out")), true)
  assert.equal(isRetryableMcpTransportError(new Error("HTTP 503 from MCP")), true)
  assert.equal(
    isRetryableMcpTransportError(Object.assign(new Error("network"), { code: "ECONNRESET" })),
    true
  )
  assert.equal(isRetryableMcpTransportError(new Error("order id 215024")), false)
  assert.equal(isRetryableMcpTransportError(new Error("{code:1502}")), false)
  assert.equal(isRetryableMcpTransportError(new Error("amount 5024.00")), false)
}

async function testScopedSnapshotCacheReusesBaseSnapshot(): Promise<void> {
  const tool = makeTool({
    capabilityId: "connector:g1:search",
    providerKey: "g1",
    toolName: "search",
    sourceKind: "connector"
  })
  let snapshotCalls = 0
  const service: McpCapabilityService = {
    listTools: async () => {
      throw new Error("listTools should not be used when getSnapshot is available")
    },
    getSnapshot: async () => {
      snapshotCalls += 1
      return { fingerprint: "fp-1", tools: [tool] }
    },
    getTool: async (id) => (id === tool.capabilityId || id === tool.toolId ? tool : null),
    invoke: async (id) => makeResult(id, "ok"),
    invalidate: async () => undefined,
    close: async () => undefined
  }

  const scoped = createScopedMcpCapabilityService(
    service,
    createHookScope(),
    () => [],
    undefined,
    undefined,
    { workspacePath: process.cwd(), threadId: "thread-cache" }
  )

  await scoped.listTools()
  await scoped.getTool(tool.capabilityId)
  await scoped.listTools()
  assert.equal(snapshotCalls, 1)

  await scoped.invalidate("test")
  await scoped.listTools()
  assert.equal(snapshotCalls, 2)
}

async function run(): Promise<void> {
  testRetryableErrorClassifier()
  await testFallbackOnlyInvokedOnceAfterPrimaryThrow()
  await testFallbackRequiresSafeToRetry()
  await testScopedSnapshotCacheReusesBaseSnapshot()
  console.log("PASS MCP fallback invokes fallback once")
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  console.error(error.stack)
  process.exit(1)
})
