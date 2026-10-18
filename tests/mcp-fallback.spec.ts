/**
 * Unit tests for scoped MCP fallback behavior.
 *
 * Run with:
 *   npx tsx tests/mcp-fallback.spec.ts
 */
import assert from "node:assert/strict"
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  createScopedMcpCapabilityService,
  isRetryableMcpTransportError
} from "../src/main/agent/runtime.ts"
import { createHookScope } from "../src/main/hooks/scope.ts"
import { createBotMcpScope } from "../src/main/bots/mcp-scope.ts"
import type {
  McpCapabilityService,
  McpCapabilityTool,
  McpInvocationResult
} from "../src/main/mcp/capability-types.ts"

function makeResult(capabilityId: string, text: string, isError = false): McpInvocationResult {
  return { capabilityId, raw: text, text, isError }
}

function makeTool(
  partial: Partial<McpCapabilityTool> &
    Pick<McpCapabilityTool, "capabilityId" | "providerKey" | "toolName">
): McpCapabilityTool {
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
    getTool: async (id) =>
      [pluginTool, globalTool].find((tool) => tool.capabilityId === id || tool.toolId === id) ??
      null,
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
    getTool: async (id) =>
      [pluginTool, globalTool].find((tool) => tool.capabilityId === id || tool.toolId === id) ??
      null,
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

async function testMcpHookKeepsBoundAdapterIdentity(): Promise<void> {
  const tool = makeTool({
    capabilityId: "plugin:tool-owner/tools:run",
    providerKey: "plugin:tool-owner/tools",
    toolName: "run",
    sourceKind: "plugin"
  })
  const service: McpCapabilityService = {
    listTools: async () => [tool],
    getTool: async () => tool,
    invoke: async (id) => makeResult(id, "ok"),
    invalidate: async () => undefined,
    close: async () => undefined
  }
  const scope = createHookScope()
  scope.activatePlugin("tool-owner")
  let observedContext: { pluginId?: string; harnessAdapterId?: string } | undefined
  const scoped = createScopedMcpCapabilityService(
    service,
    scope,
    (event, context) => {
      if (event === "PreToolUse") observedContext = context
      return []
    },
    undefined,
    undefined,
    {
      workspacePath: process.cwd(),
      threadId: "bound-adapter-context",
      harnessProjectId: "project-1",
      harnessAdapterId: "bound-adapter",
      harnessAdapterName: "Bound Adapter"
    }
  )

  await scoped.invoke(tool.capabilityId, {})
  assert.equal(observedContext?.pluginId, "tool-owner")
  assert.equal(observedContext?.harnessAdapterId, "bound-adapter")
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
  for (const status of [502, 503, 504]) {
    assert.equal(
      isRetryableMcpTransportError(new StreamableHTTPError(status, "CB_HTTP_FAILURE")),
      true,
      `MCP SDK HTTP ${status} must be recognized without relying on response body text`
    )
  }
  assert.equal(isRetryableMcpTransportError(new StreamableHTTPError(401, "denied")), false)
  assert.equal(isRetryableMcpTransportError(new StreamableHTTPError(403, "denied")), false)
  assert.equal(isRetryableMcpTransportError(new StreamableHTTPError(400, "invalid input")), false)
  assert.equal(
    isRetryableMcpTransportError(
      Object.assign(new Error("business validation rejected"), { code: 503 })
    ),
    false,
    "an unrelated numeric business code must not grant transport fallback"
  )
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
  await testMcpHookKeepsBoundAdapterIdentity()
  await testScopedSnapshotCacheReusesBaseSnapshot()
  await testScopedPermissionSnapshot()
  await testBotScopeSurvivesRuntimeFallback()
  console.log("PASS MCP fallback invokes fallback once")
}

async function testBotScopeSurvivesRuntimeFallback(): Promise<void> {
  const primary = makeTool({
    capabilityId: "plugin:docs/tools:read",
    providerKey: "plugin:docs/tools",
    toolName: "read",
    sourceKind: "plugin",
    fallback: { enabled: true, to: "global", match: "toolNameAndSchema", safeToRetry: true }
  })
  const sharedBrowser = makeTool({
    capabilityId: "connector:shared:read",
    providerKey: "in-app-browser",
    toolName: "read",
    sourceKind: "connector"
  })
  const documents = makeTool({
    capabilityId: "connector:docs:read",
    providerKey: "documents",
    toolName: "read",
    sourceKind: "connector"
  })
  let available = [primary, sharedBrowser, documents]
  const calls: string[] = []
  const base: McpCapabilityService = {
    listTools: async () => available,
    getTool: async (id) =>
      available.find((tool) => tool.capabilityId === id || tool.toolId === id) ?? null,
    invoke: async (id) => {
      calls.push(id)
      if (id === primary.capabilityId) throw new Error("ECONNRESET")
      return makeResult(id, "ok")
    },
    invalidate: async () => undefined,
    close: async () => undefined
  }
  const scope = createHookScope()
  scope.activatePlugin("docs")
  const scoped = createScopedMcpCapabilityService(
    createBotMcpScope(base),
    scope,
    () => [],
    undefined,
    undefined,
    { workspacePath: process.cwd(), threadId: "bot-fallback" }
  )
  const discovered = await scoped.listTools()
  assert.equal(
    discovered.some((tool) => tool.capabilityId === sharedBrowser.capabilityId),
    false
  )
  await assert.rejects(() => scoped.invoke(sharedBrowser.capabilityId, {}), /共享电脑/)
  assert.deepEqual(calls, [], "direct invocation cannot bypass Bot discovery restrictions")
  const result = await scoped.invoke(primary.capabilityId, { value: "x" })
  assert.equal(result.fallbackCapabilityId, documents.capabilityId)
  assert.deepEqual(
    calls,
    [primary.capabilityId, documents.capabilityId],
    "fallback uses an allowed connector only"
  )
  // The runtime caches discovery; the Bot wrapper must revalidate the actual target at invocation.
  available = [primary, sharedBrowser, { ...documents, providerKey: "in-app-browser" }]
  await assert.rejects(() => scoped.invoke(documents.capabilityId, {}), /共享电脑/)
  assert.equal(
    calls.length,
    2,
    "a stale discovery entry cannot restore access to the shared browser"
  )
}

async function testScopedPermissionSnapshot(): Promise<void> {
  let discovers = 0
  let valid = true
  const pluginTool = makeTool({
    capabilityId: "plugin:mail/tools:echo",
    providerKey: "plugin:mail/tools",
    toolName: "echo",
    toolId: "mcp__plugin__echo",
    sourceKind: "plugin",
    scope: "plugin-active"
  })
  const globalTool = makeTool({
    capabilityId: "connector:mail:echo",
    providerKey: "connector:mail",
    toolName: "echo",
    toolId: "mcp__mail__echo",
    sourceKind: "connector"
  })
  const service: McpCapabilityService = {
    listTools: async () => {
      discovers++
      return [pluginTool, globalTool]
    },
    peekTools: () => (valid ? structuredClone([pluginTool, globalTool]) : null),
    getTool: async () => {
      throw Error("query must not resolve a connection")
    },
    invoke: async () => {
      throw Error("query must not execute")
    },
    invalidate: async () => undefined,
    close: async () => undefined
  }
  const scope = createHookScope()
  const scoped = createScopedMcpCapabilityService(service, scope, () => [], undefined, undefined, {
    workspacePath: process.cwd(),
    threadId: "permission-snapshot"
  })
  const cold = scoped.peekTools!()!
  assert.equal(discovers, 0)
  assert.equal(
    cold.find((tool) => tool.capabilityId === globalTool.capabilityId)?.toolId,
    "mcp__echo"
  )
  assert.equal(
    cold.find((tool) => tool.capabilityId === pluginTool.capabilityId)?.visibility,
    "lazy"
  )
  assert.deepEqual(cold, await scoped.listTools())
  valid = false
  assert.equal(scoped.peekTools!(), null, "stale config cannot reuse the run's discovery cache")
  assert.equal(discovers, 1)
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  console.error(error.stack)
  process.exit(1)
})
