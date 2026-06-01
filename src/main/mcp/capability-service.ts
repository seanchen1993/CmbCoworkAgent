import { createHash } from "crypto"
import { join } from "path"
import { MultiServerMCPClient } from "@langchain/mcp-adapters"
import { buildMcpServerConfig } from "../ipc/mcp"
import { getEnabledMcpConnectors, getPlugins, getUserInfo, parseMcpJsonFile } from "../storage"
import type { PluginMcpServerConfig } from "../types"
import { buildAliasMaps, buildCapabilityAliases, type McpCapabilitySeed } from "./aliasing"
import { resolveMcpConnectorKind } from "./connector-kind"
import type {
  McpCapabilityAliasMaps,
  McpFallbackPolicy,
  McpCapabilityService,
  McpCapabilityTool,
  McpInvocationResult
} from "./capability-types"
import { resolveMcpHeaders } from "./headers"
import { normalizeMcpInvocationResult } from "./result-utils"
import { SchemaCache } from "./schema-cache"
import { recordSuccessfulToolExample } from "./tool-example-store"

interface CapabilitySource {
  kind: "connector" | "plugin"
  providerKey: string
  providerDisplayName: string
  visibility: "eager" | "lazy"
  priority: number
  scope: "global" | "plugin-active" | "plugin-installed"
  pluginId?: string
  fallback?: McpFallbackPolicy
  serverConfig: Record<string, unknown>
}

interface CapabilityCache {
  fingerprint: string
  client: MultiServerMCPClient
  tools: McpCapabilityTool[]
  aliasMaps: McpCapabilityAliasMaps
}

function toPluginSources(): CapabilitySource[] {
  const plugins = getPlugins().filter((plugin) => plugin.enabled && plugin.mcpServerCount > 0)
  const sources: CapabilitySource[] = []
  const userInfo = getUserInfo()

  for (const plugin of plugins) {
    const configPath = join(plugin.path, ".mcp.json")
    const servers = parseMcpJsonFile(configPath)
    if (!servers) continue

    for (const [serverName, serverConfig] of Object.entries(servers)) {
      sources.push({
        kind: "plugin",
        providerKey: `plugin:${plugin.id}/${serverName}`,
        providerDisplayName: serverName,
        visibility: "eager",
        priority: serverConfig.priority ?? 50,
        scope: serverConfig.scope ?? "plugin-active",
        pluginId: plugin.id,
        fallback: normalizeFallbackPolicy(serverConfig.fallback),
        serverConfig: buildPluginServerConfig(serverConfig, userInfo)
      })
    }
  }

  return sources
}

function normalizeFallbackPolicy(policy: PluginMcpServerConfig["fallback"]): McpFallbackPolicy | undefined {
  if (!policy?.enabled || policy.safeToRetry !== true) return undefined
  return {
    enabled: true,
    to: policy.to ?? "global",
    match: policy.match ?? "toolNameAndSchema",
    safeToRetry: true
  }
}

function buildPluginServerConfig(
  config: PluginMcpServerConfig,
  userInfo: ReturnType<typeof getUserInfo>
): Record<string, unknown> {
  if (config.command) {
    return buildMcpServerConfig({
      kind: "stdio",
      command: config.command,
      args: config.args,
      env: config.env
    })
  }

  if (config.url) {
    return buildMcpServerConfig({
      kind: "remote",
      url: config.url,
      advanced: {
        headers: resolveMcpHeaders({
          headers: config.headers,
          userInfo,
          injectUserHeaders: config.injectUserHeaders
        }),
        transport: config.transport
      }
    })
  }

  throw new Error("Invalid plugin MCP config: expected command or url")
}

function toConnectorSources(): CapabilitySource[] {
  const userInfo = getUserInfo()

  return getEnabledMcpConnectors().map((connector) => {
    const isStdio = resolveMcpConnectorKind(connector) === "stdio"

    return {
      kind: "connector" as const,
      providerKey: connector.id,
      providerDisplayName: connector.name || connector.id,
      visibility: connector.lazyLoad ? "lazy" : "eager",
      priority: 100,
      scope: "global" as const,
      serverConfig: isStdio
        ? buildMcpServerConfig({
            kind: "stdio",
            command: connector.command,
            args: connector.args,
            env: connector.env
          })
        : buildMcpServerConfig({
            kind: "remote",
            url: connector.url,
            advanced: {
              ...connector.advanced,
              headers: resolveMcpHeaders({
                headers: connector.advanced?.headers,
                userInfo
              })
            }
          })
    }
  })
}

function buildFingerprint(sources: CapabilitySource[]): string {
  const payload = JSON.stringify(
    [...sources]
      .sort((left, right) => left.providerKey.localeCompare(right.providerKey))
      .map((source) => ({
        kind: source.kind,
        providerKey: source.providerKey,
        providerDisplayName: source.providerDisplayName,
        visibility: source.visibility,
        priority: source.priority,
        scope: source.scope,
        pluginId: source.pluginId,
        fallback: source.fallback,
        serverConfig: source.serverConfig
      }))
  )

  return createHash("sha256").update(payload).digest("hex")
}

function shouldRetryMcpInvocationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes("terminated") ||
    message.includes("disconnected") ||
    message.includes("ECONN")
  )
}

async function invokeToolWithRetry(
  callTool: (request: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>,
  request: { name: string; arguments: Record<string, unknown> },
  retries = 1
): Promise<unknown> {
  try {
    return await callTool(request)
  } catch (error) {
    if (retries <= 0 || !shouldRetryMcpInvocationError(error)) {
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
    return invokeToolWithRetry(callTool, request, retries - 1)
  }
}

async function listServerTools(
  client: MultiServerMCPClient,
  providerKey: string
): Promise<Array<Record<string, unknown>>> {
  const serverClient = await client.getClient(providerKey)
  if (!serverClient) return []

  const tools: Array<Record<string, unknown>> = []
  let cursor: string | undefined

  do {
    const response = await (serverClient as {
      listTools(input?: { cursor?: string }): Promise<{ tools?: Array<Record<string, unknown>>; nextCursor?: string }>
    }).listTools(cursor ? { cursor } : undefined)

    tools.push(...(response.tools ?? []))
    cursor = response.nextCursor
  } while (cursor)

  return tools
}

class ManagedMcpCapabilityService implements McpCapabilityService {
  private cache: CapabilityCache | null = null
  private initPromise: Promise<void> | null = null
  private readonly schemaCache = new SchemaCache()

  async listTools(): Promise<McpCapabilityTool[]> {
    await this.ensureInitialized()
    return [...(this.cache?.tools ?? [])]
  }

  async getTool(idOrAlias: string): Promise<McpCapabilityTool | null> {
    if (!idOrAlias.trim()) return null
    await this.ensureInitialized()
    return this.resolveTool(idOrAlias)
  }

  async invoke(idOrAlias: string, args: Record<string, unknown>): Promise<McpInvocationResult> {
    await this.ensureInitialized()

    const tool = this.resolveTool(idOrAlias)
    if (!tool) {
      throw new Error(`MCP tool not found: ${idOrAlias}`)
    }

    const client = this.cache?.client
    if (!client) {
      throw new Error("MCP runtime is not initialized")
    }

    const serverClient = await client.getClient(tool.providerKey)
    if (!serverClient) {
      throw new Error(`MCP client is unavailable for provider ${tool.providerDisplayName}`)
    }

    const raw = await invokeToolWithRetry(
      (serverClient as {
        callTool(
          request: { name: string; arguments: Record<string, unknown> }
        ): Promise<unknown>
      }).callTool.bind(serverClient),
      {
        name: tool.toolName,
        arguments: args
      }
    )

    const result = normalizeMcpInvocationResult(tool.capabilityId, raw)

    try {
      recordSuccessfulToolExample(tool, result)
    } catch (error) {
      console.warn(`[MCP] failed to persist tool example for "${tool.toolId}":`, error)
    }

    return result
  }

  async invalidate(reason?: string): Promise<void> {
    if (reason) {
      console.log(`[MCP] invalidate requested: ${reason}`)
    }

    const previous = this.cache
    this.cache = null
    this.schemaCache.clear()

    if (previous?.client) {
      try {
        await previous.client.close()
      } catch (error) {
        console.warn("[MCP] failed to close previous MCP client during invalidation:", error)
      }
    }
  }

  async close(): Promise<void> {
    await this.invalidate("close")
  }

  private async ensureInitialized(): Promise<void> {
    const fingerprint = buildFingerprint(this.readSources())
    if (this.cache?.fingerprint === fingerprint) {
      return
    }

    if (this.initPromise) {
      await this.initPromise
      const refreshedFingerprint = buildFingerprint(this.readSources())
      if (this.cache?.fingerprint === refreshedFingerprint) {
        return
      }
    }

    this.initPromise = this.rebuild()
    try {
      await this.initPromise
    } finally {
      this.initPromise = null
    }
  }

  private readSources(): CapabilitySource[] {
    return [...toConnectorSources(), ...toPluginSources()]
  }

  private resolveTool(idOrAlias: string): McpCapabilityTool | null {
    const maps = this.cache?.aliasMaps
    if (!maps) return null

    const capability = maps.capabilityById.get(idOrAlias)
    if (capability) return capability

    const toolId = maps.toolIds.get(idOrAlias)
    if (toolId) return toolId

    return null
  }

  private async rebuild(): Promise<void> {
    const sources = this.readSources()
    const fingerprint = buildFingerprint(sources)

    if (sources.length === 0) {
      await this.invalidate("no_sources")
      return
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mcpServers: Record<string, any> = {}
    for (const source of sources) {
      mcpServers[source.providerKey] = source.serverConfig
    }

    const client = new MultiServerMCPClient({
      throwOnLoadError: false,
      onConnectionError: "ignore",
      useStandardContentBlocks: true,
      mcpServers
    })

    try {
      await client.initializeConnections()
      const seeds: McpCapabilitySeed[] = []

      for (const source of sources) {
        const serverTools = await listServerTools(client, source.providerKey)
        for (const rawTool of serverTools) {
          const toolName = typeof rawTool.name === "string" ? rawTool.name : ""
          if (!toolName) continue

          seeds.push({
            capabilityId:
              source.kind === "plugin"
                ? `${source.providerKey}:${toolName}`
                : `connector:${source.providerKey}:${toolName}`,
            providerKey: source.providerKey,
            providerDisplayName: source.providerDisplayName,
            toolName,
            description: typeof rawTool.description === "string" ? rawTool.description : "",
            inputSchema:
              rawTool.inputSchema && typeof rawTool.inputSchema === "object"
                ? this.schemaCache.get(rawTool.inputSchema as Record<string, unknown>)
                : undefined,
            outputSchema:
              rawTool.outputSchema && typeof rawTool.outputSchema === "object"
                ? this.schemaCache.get(rawTool.outputSchema as Record<string, unknown>)
                : undefined,
            visibility: source.visibility,
            sourceKind: source.kind,
            scope: source.scope,
            priority: source.priority,
            pluginId: source.pluginId,
            fallback: source.fallback
          })
        }
      }

      const tools = buildCapabilityAliases(seeds).sort((left, right) => {
        const providerCompare = left.providerDisplayName.localeCompare(right.providerDisplayName)
        if (providerCompare !== 0) return providerCompare
        return left.toolName.localeCompare(right.toolName)
      })

      const previous = this.cache
      this.cache = {
        fingerprint,
        client,
        tools,
        aliasMaps: buildAliasMaps(tools)
      }

      if (previous?.client && previous.client !== client) {
        try {
          await previous.client.close()
        } catch (error) {
          console.warn("[MCP] failed to close previous MCP client:", error)
        }
      }

      console.log(`[MCP] capability service ready with ${tools.length} tools`)
    } catch (error) {
      try {
        await client.close()
      } catch {
        // ignore close failure on a broken client
      }
      throw error
    }
  }
}

let globalCapabilityService: ManagedMcpCapabilityService | null = null

export function getGlobalMcpCapabilityService(): McpCapabilityService {
  if (!globalCapabilityService) {
    globalCapabilityService = new ManagedMcpCapabilityService()
  }
  return globalCapabilityService
}

export async function invalidateGlobalMcpCapabilityService(reason?: string): Promise<void> {
  if (!globalCapabilityService) return
  await globalCapabilityService.invalidate(reason)
}

export async function closeGlobalMcpCapabilityService(): Promise<void> {
  if (!globalCapabilityService) return
  await globalCapabilityService.close()
  globalCapabilityService = null
}
