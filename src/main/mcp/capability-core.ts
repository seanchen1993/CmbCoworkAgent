/** Shared Cmb MCP implementation, extracted from capability-service.ts.
 * The desktop supplies configuration and Mods hooks; detached Hosts supply their own scope.
 * This module imports neither Electron nor the desktop settings singleton.
 */
import { createHash, randomUUID } from "crypto"
import { MultiServerMCPClient } from "@langchain/mcp-adapters"
import { shouldSuppressInAppBrowserMcpTool } from "../browser/cdp/in-app-browser-mcp-tools"
import { buildAliasMaps, buildCapabilityAliases, type McpCapabilitySeed } from "./aliasing"
import type {
  McpCapabilityAliasMaps,
  McpFallbackPolicy,
  McpCapabilityService,
  McpCapabilityTool,
  McpInvocationResult,
  McpInvocationOptions,
  McpResourceProvider
} from "./capability-types"
import { normalizeMcpInvocationResult } from "./result-utils"
import { SchemaCache } from "./schema-cache"

export interface McpCallRequest {
  name: string
  arguments: Record<string, unknown>
}
export interface McpCapabilityCoreOptions {
  readSources(): CapabilitySource[]
  connectionExpired?(): Error
  strictConnections?: boolean
  signal?(): AbortSignal | undefined
  aroundInvoke?(
    tool: McpCapabilityTool,
    args: Record<string, unknown>,
    invoke: (args: Record<string, unknown>) => Promise<McpInvocationResult>
  ): Promise<McpInvocationResult>
  callTransport?(
    call: (request: McpCallRequest) => Promise<unknown>,
    request: McpCallRequest
  ): Promise<unknown>
}

export interface CapabilitySource {
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
  resourceGenerations: WeakMap<object, string>
  client: MultiServerMCPClient
  tools: McpCapabilityTool[]
  aliasMaps: McpCapabilityAliasMaps
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

async function listServerTools(
  client: MultiServerMCPClient,
  providerKey: string,
  strict: boolean,
  signal?: AbortSignal
): Promise<Array<Record<string, unknown>>> {
  signal?.throwIfAborted()
  const serverClient = await client.getClient(providerKey)
  if (!serverClient) {
    if (strict) throw new Error(`MCP connection unavailable: ${providerKey}`)
    return []
  }
  // Resource-only MCP servers are valid connections. Calling tools/list on
  // them fails capability negotiation before their resources can be used.
  if (
    typeof serverClient.getServerCapabilities === "function" &&
    !serverClient.getServerCapabilities()?.tools
  )
    return []

  const tools: Array<Record<string, unknown>> = []
  let cursor: string | undefined
  const seen = new Set<string>()

  do {
    signal?.throwIfAborted()
    const response = await (
      serverClient as {
        listTools(input?: {
          cursor?: string
        }): Promise<{ tools?: Array<Record<string, unknown>>; nextCursor?: string }>
      }
    ).listTools(cursor ? { cursor } : undefined)

    tools.push(...(response.tools ?? []))
    cursor = response.nextCursor
    if (tools.length > 20_000 || seen.size >= 100 || (cursor && seen.has(cursor)))
      throw new Error("MCP tool discovery exceeded its page or size limit")
    if (cursor) seen.add(cursor)
  } while (cursor)

  return tools
}

export class ManagedMcpCapabilityService implements McpCapabilityService {
  private cache: CapabilityCache | null = null
  private initPromise: Promise<void> | null = null
  private readonly schemaCache = new SchemaCache()
  private epoch = 0
  private closed = false

  constructor(private readonly options: McpCapabilityCoreOptions) {}

  configuredServerNames(): string[] {
    return this.readSources().map((source) => source.providerDisplayName)
  }

  peekTools(): McpCapabilityTool[] | null {
    if (!this.cache || this.cache.fingerprint !== buildFingerprint(this.readSources())) return null
    return structuredClone(this.cache.tools)
  }

  async listTools(): Promise<McpCapabilityTool[]> {
    await this.ensureInitialized()
    return [...(this.cache?.tools ?? [])]
  }

  async getSnapshot(): Promise<{ fingerprint: string; tools: McpCapabilityTool[] }> {
    await this.ensureInitialized()
    return {
      fingerprint: this.cache?.fingerprint ?? "",
      tools: [...(this.cache?.tools ?? [])]
    }
  }

  async getTool(idOrAlias: string): Promise<McpCapabilityTool | null> {
    if (!idOrAlias.trim()) return null
    await this.ensureInitialized()
    return this.resolveTool(idOrAlias)
  }

  async invoke(
    idOrAlias: string,
    args: Record<string, unknown>,
    invocation?: McpInvocationOptions
  ): Promise<McpInvocationResult> {
    await this.ensureInitialized()

    const tool = this.resolveTool(idOrAlias)
    if (!tool) {
      throw new Error(`MCP tool not found: ${idOrAlias}`)
    }

    const connection = this.cache
    const client = connection?.client
    if (!client) {
      throw new Error("MCP runtime is not initialized")
    }

    const serverClient = await client.getClient(tool.providerKey)
    if (!serverClient) {
      throw new Error(`MCP client is unavailable for provider ${tool.providerDisplayName}`)
    }

    const invoke = async (effectiveArgs: Record<string, unknown>): Promise<McpInvocationResult> => {
      const signal = invocation?.signal ?? this.options.signal?.()
      signal?.throwIfAborted()
      if (
        this.closed ||
        this.cache !== connection ||
        buildFingerprint(this.readSources()) !== connection.fingerprint ||
        (invocation?.expectedConnectionGeneration !== undefined &&
          invocation.expectedConnectionGeneration !== tool.connectionGeneration)
      )
        throw (
          this.options.connectionExpired?.() ??
          new Error("MCP connection changed; discover and authorize the operation again")
        )
      const callClient = serverClient as {
        callTool(
          request: McpCallRequest,
          schema?: undefined,
          options?: { signal?: AbortSignal }
        ): Promise<unknown>
      }
      const request = { name: tool.toolName, arguments: effectiveArgs }
      const call = (value: McpCallRequest) => callClient.callTool(value, undefined, { signal })
      const raw = this.options.callTransport
        ? await this.options.callTransport(call, request)
        : await call(request)
      return normalizeMcpInvocationResult(tool.capabilityId, raw)
    }
    return this.options.aroundInvoke ? this.options.aroundInvoke(tool, args, invoke) : invoke(args)
  }

  private async resourceConnection(providerKey: string, invocation?: McpInvocationOptions) {
    const signal = invocation?.signal ?? this.options.signal?.()
    signal?.throwIfAborted()
    const source = this.readSources().find((item) => item.providerKey === providerKey)
    if (!source) throw new Error("MCP resource provider is unavailable")
    await this.ensureInitialized()
    const connection = this.cache
    if (!connection) throw new Error("MCP resource connection is unavailable")
    const client = await connection.client.getClient(providerKey)
    if (!client?.getServerCapabilities()?.resources)
      throw new Error("MCP provider does not advertise resources")
    let generation = connection.resourceGenerations.get(client)
    if (!generation) {
      generation = randomUUID()
      connection.resourceGenerations.set(client, generation)
    }
    const check = () => {
      signal?.throwIfAborted()
      if (
        this.closed ||
        this.cache !== connection ||
        buildFingerprint(this.readSources()) !== connection.fingerprint ||
        (invocation?.expectedConnectionGeneration !== undefined &&
          invocation.expectedConnectionGeneration !== generation)
      )
        throw (
          this.options.connectionExpired?.() ??
          new Error("MCP resource connection changed; discover and authorize again")
        )
    }
    check()
    return { client, source, generation, signal, check }
  }

  async resourceProvider(providerKey: string): Promise<McpResourceProvider> {
    const { source, generation, check } = await this.resourceConnection(providerKey)
    check()
    return {
      providerKey,
      providerDisplayName: source.providerDisplayName,
      connectionGeneration: generation
    }
  }

  async listResources(
    providerKey: string,
    kind: "resources" | "templates",
    cursor?: string,
    options?: McpInvocationOptions
  ) {
    const { client, signal, check } = await this.resourceConnection(providerKey, options)
    const params = cursor ? { cursor } : undefined
    const result =
      kind === "resources"
        ? await client.listResources(params, { signal })
        : await client.listResourceTemplates(params, { signal })
    check()
    return result
  }

  async readResource(providerKey: string, uri: string, options?: McpInvocationOptions) {
    const { client, signal, check } = await this.resourceConnection(providerKey, options)
    // Resource providers may perform remote work. Never retry a lost reply.
    const result = await client.readResource({ uri }, { signal })
    check()
    return result
  }

  async invalidate(reason?: string): Promise<void> {
    if (reason) {
      console.log(`[MCP] invalidate requested: ${reason}`)
    }

    this.epoch++
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
    this.closed = true
    await this.invalidate("close")
  }

  private async ensureInitialized(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.closed) throw new Error("MCP capability service is closed")
      const sources = this.readSources()
      if (this.cache?.fingerprint === buildFingerprint(sources)) return
      if (!sources.length) {
        await this.invalidate("no_sources")
        return
      }
      // All callers join the same rebuild, including callers released by an older rebuild.
      this.initPromise ??= this.rebuild()
      const pending = this.initPromise
      try {
        await pending
      } finally {
        if (this.initPromise === pending) this.initPromise = null
      }
    }
    throw new Error("MCP configuration keeps changing during discovery")
  }

  private readSources(): CapabilitySource[] {
    return this.options.readSources()
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
    const epoch = this.epoch
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
        const serverTools = await listServerTools(
          client,
          source.providerKey,
          this.options.strictConnections === true,
          this.options.signal?.()
        )
        for (const rawTool of serverTools) {
          const toolName = typeof rawTool.name === "string" ? rawTool.name : ""
          if (!toolName) continue
          if (
            shouldSuppressInAppBrowserMcpTool({
              providerDisplayName: source.providerDisplayName,
              toolName
            })
          ) {
            continue
          }

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

      if (
        this.closed ||
        this.epoch !== epoch ||
        buildFingerprint(this.readSources()) !== fingerprint
      )
        throw new Error("MCP configuration changed during discovery")
      const previous = this.cache
      const connectionGeneration = randomUUID()
      for (const tool of tools) tool.connectionGeneration = connectionGeneration
      this.cache = {
        fingerprint,
        resourceGenerations: new WeakMap(),
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
