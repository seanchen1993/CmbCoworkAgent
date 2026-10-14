import { createHash, randomUUID } from "crypto"
import { realpathSync } from "node:fs"
import { join, resolve } from "path"
import { MultiServerMCPClient } from "@langchain/mcp-adapters"
import { shouldSuppressInAppBrowserMcpTool } from "../browser/cdp/in-app-browser-mcp-tools"
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
  McpInvocationResult,
  McpConnectOwner,
  McpConnectAdmission
} from "./capability-types"
import { mcpConnectRefusal } from "./capability-types"
import { resolveMcpHeaders } from "./headers"
import { normalizeMcpInvocationResult } from "./result-utils"
import { SchemaCache } from "./schema-cache"
import { recordSuccessfulToolExample } from "./tool-example-store"
import { withRawModMcp, publishCurrentModResult } from "../mods/adapters"
import { getModCallContext } from "../mods/context"
import { authorizeCurrentModInput } from "../mods/manager"
import { invokeMcpToolWithRetry } from "./invocation-retry"
import { ModError } from "../mods/errors"
import { beforeModToolExecution } from "../mods/execution-error"
import type { ClawSourceEntry } from "../../shared/mods/claw"
import { derivationVisibility, isDerivedPlugin } from "../plugins/derivation-scope"
import { isDerivationVisibleForProjectMode } from "../../shared/skill-visibility"

interface CapabilitySource {
  kind: "connector" | "plugin"
  providerKey: string
  providerDisplayName: string
  visibility: "eager" | "lazy"
  priority: number
  scope: "global" | "plugin-active" | "plugin-installed"
  pluginId?: string
  ownerName?: string
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
        ownerName: plugin.name,
        fallback: normalizeFallbackPolicy(serverConfig.fallback),
        serverConfig: buildPluginServerConfig(serverConfig, userInfo)
      })
    }
  }

  return sources
}

function normalizeFallbackPolicy(
  policy: PluginMcpServerConfig["fallback"]
): McpFallbackPolicy | undefined {
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

/** Configuration metadata only: never creates a client or projects credentials. */
export function readConfiguredClawMcpSources(): ClawSourceEntry[] {
  const sources = [...toConnectorSources(), ...toPluginSources()]
  if (new Set(sources.map((source) => source.providerKey)).size !== sources.length)
    throw new ModError("CLAW_MCP_SOURCE_AMBIGUOUS")
  return sources.map((source) => ({
    id: source.providerKey,
    name: source.providerDisplayName,
    digest: buildFingerprint([source]),
    ...(source.pluginId ? { owner: source.ownerName ?? source.pluginId } : { owner: "全局连接器" })
  }))
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
    const response = await (
      serverClient as {
        listTools(input?: {
          cursor?: string
        }): Promise<{ tools?: Array<Record<string, unknown>>; nextCursor?: string }>
      }
    ).listTools(cursor ? { cursor } : undefined)

    tools.push(...(response.tools ?? []))
    cursor = response.nextCursor
  } while (cursor)

  return tools
}

class ManagedMcpCapabilityService implements McpCapabilityService {
  constructor(private readonly boundDerivedPluginId?: string) {}
  private cache: CapabilityCache | null = null
  private initPromise: Promise<void> | null = null
  private readonly schemaCache = new SchemaCache()
  private revision = 0

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

  async connectPluginServer(
    owner: McpConnectOwner,
    server: string,
    signal: AbortSignal,
    assertCurrent: () => void
  ): Promise<McpConnectAdmission> {
    const pluginId = owner.pluginId
    const sourcePath = owner.sourcePath
    const root = owner.root
    const check = () => {
      signal.throwIfAborted()
      assertCurrent()
    }
    const refused = (reason: "unlisted" | "disabled" | "failed"): McpConnectAdmission => ({
      value: mcpConnectRefusal(reason),
      assertCurrent: check
    })
    const readOwner = () => {
      const plugin = getPlugins().find((entry) => entry.id === pluginId)
      if (!plugin || plugin.path !== sourcePath) return null
      const actual = realpathSync(plugin.path)
      const expected = resolve(root)
      if (process.platform === "win32" ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected)
        return null
      return plugin
    }
    check()
    let plugin: ReturnType<typeof readOwner>
    try {
      plugin = readOwner()
    } catch {
      check()
      return refused("failed")
    }
    if (!plugin) return refused("unlisted")
    if (!plugin.enabled) return refused("disabled")
    const servers = parseMcpJsonFile(join(plugin.path, ".mcp.json"))
    if (!servers || !Object.hasOwn(servers, server)) return refused("unlisted")
    const providerKey = `plugin:${pluginId}/${server}`
    const source = this.readSources().find((entry) => entry.providerKey === providerKey)
    if (!source || source.kind !== "plugin" || source.pluginId !== pluginId)
      return refused("failed")
    const expectedSource = buildFingerprint([source])
    const checkSource = () => {
      check()
      const currentOwner = readOwner()
      const current = this.readSources().find((entry) => entry.providerKey === providerKey)
      if (
        !currentOwner?.enabled ||
        !current ||
        current.kind !== "plugin" ||
        current.pluginId !== pluginId ||
        buildFingerprint([current]) !== expectedSource
      )
        throw new ModError("MODS_MCP_CONTEXT_EXPIRED")
    }
    checkSource()
    try {
      await this.ensureInitialized()
    } catch (error) {
      checkSource()
      if (error instanceof ModError) throw error
      return refused("failed")
    }
    checkSource()
    const connection = this.cache
    if (!connection) return refused("failed")
    let client: Awaited<ReturnType<MultiServerMCPClient["getClient"]>>
    try {
      client = await connection.client.getClient(providerKey)
    } catch {
      checkSource()
      return refused("failed")
    }
    checkSource()
    const transport = client?.transport
    if (!client || !transport) return refused("failed")
    const connectedClient = client
    const current = () => {
      checkSource()
      if (
        this.cache !== connection ||
        buildFingerprint(this.readSources()) !== connection.fingerprint ||
        connectedClient.transport !== transport
      )
        throw new ModError("MODS_MCP_CONTEXT_EXPIRED")
    }
    current()
    return { value: { isConnected: true, server: providerKey }, assertCurrent: current }
  }

  async invoke(
    idOrAlias: string,
    args: Record<string, unknown>,
    assertCurrent?: () => void
  ): Promise<McpInvocationResult> {
    assertCurrent?.()
    await this.ensureInitialized()
    assertCurrent?.()

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

    return withRawModMcp(tool, args, async (args) => {
      await authorizeCurrentModInput(`mcp:${tool.capabilityId}`, args)
      await beforeModToolExecution(() => {
        assertCurrent?.()
        getModCallContext()?.assertMcpTool?.(tool)
        // Approval can await UI while settings change. Never send to a replaced connection,
        // even when the server still advertises the same name and schema.
        if (
          getModCallContext()?.assertMcpTool &&
          (this.cache !== connection ||
            buildFingerprint(this.readSources()) !== connection?.fingerprint)
        )
          throw new ModError("MODS_MCP_CONTEXT_EXPIRED")
      })
      const callClient = serverClient as {
        callTool(
          request: { name: string; arguments: Record<string, unknown> },
          resultSchema?: undefined,
          options?: { signal?: AbortSignal }
        ): Promise<unknown>
      }
      const signal = getModCallContext()?.signal
      const raw = await invokeMcpToolWithRetry(
        (request) => {
          assertCurrent?.()
          return signal
            ? callClient.callTool(request, undefined, { signal })
            : callClient.callTool(request)
        },
        {
          name: tool.toolName,
          arguments: args
        }
      )
      assertCurrent?.()

      const result = await publishCurrentModResult(
        normalizeMcpInvocationResult(tool.capabilityId, raw)
      )
      assertCurrent?.()

      try {
        if (!getModCallContext()) recordSuccessfulToolExample(tool, result)
      } catch (error) {
        console.warn(`[MCP] failed to persist tool example for "${tool.toolId}":`, error)
      }

      return result
    })
  }

  async invalidate(reason?: string): Promise<void> {
    if (reason) {
      console.log(`[MCP] invalidate requested: ${reason}`)
    }

    this.revision++
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
    return [...toConnectorSources(), ...toPluginSources().filter(source =>
      isDerivationVisibleForProjectMode({ pluginId: source.pluginId,
        ...derivationVisibility(source.pluginId ?? "") }, {
        projectMode: Boolean(this.boundDerivedPluginId), boundPluginId: this.boundDerivedPluginId
      }))]
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
    const revision = this.revision
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

      const previous = this.cache
      if (
        this.revision !== revision ||
        buildFingerprint(this.readSources()) !== fingerprint
      )
        throw new ModError("MODS_MCP_CONTEXT_EXPIRED")
      const connectionGeneration = randomUUID()
      for (const tool of tools) tool.connectionGeneration = connectionGeneration
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
const derivedCapabilityServices = new Map<string, ManagedMcpCapabilityService>()

/** Native project binding, captured before discovery; unbound global discovery never starts copies. */
export function getProjectMcpCapabilityService(boundPluginId?: string): McpCapabilityService {
  if (!boundPluginId || !isDerivedPlugin(boundPluginId)) return getGlobalMcpCapabilityService()
  let service = derivedCapabilityServices.get(boundPluginId)
  if (!service) {
    service = new ManagedMcpCapabilityService(boundPluginId)
    derivedCapabilityServices.set(boundPluginId, service)
  }
  return service
}

export function getGlobalMcpCapabilityService(): McpCapabilityService {
  if (!globalCapabilityService) {
    globalCapabilityService = new ManagedMcpCapabilityService()
  }
  return globalCapabilityService
}

export async function invalidateGlobalMcpCapabilityService(reason?: string): Promise<void> {
  await Promise.all([...derivedCapabilityServices.values(),
    ...(globalCapabilityService ? [globalCapabilityService] : [])].map(service => service.invalidate(reason)))
}

export async function closeGlobalMcpCapabilityService(): Promise<void> {
  await Promise.all([...derivedCapabilityServices.values(),
    ...(globalCapabilityService ? [globalCapabilityService] : [])].map(service => service.close()))
  derivedCapabilityServices.clear()
  globalCapabilityService = null
}
