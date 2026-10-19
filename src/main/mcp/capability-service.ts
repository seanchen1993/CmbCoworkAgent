import {
  projectRuntimePluginSources,
  runtimeCapabilityAllowsMcp,
  captureRuntimePluginSourceToken,
  assertCurrentRuntimePluginSourceContent,
  currentRuntimePluginSource,
  retainRuntimePluginSourceToken,
  withRuntimePluginSource,
  type RuntimePluginSourceToken
} from "../plugins/runtime-source-scope"
import type { SnapshotLease } from "../harness-board/project-runtime/snapshot-retention"
import { prepareSnapshotMaintenance } from "../harness-board/project-runtime/snapshot-retention"
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
  const retained = captureRuntimePluginSourceToken()
  // MCP custody is exact even when legacy Hooks still retain their original ambient catalog.
  // Snapshot declarations, never a newer installation's cached count, determine retained servers.
  const plugins = projectRuntimePluginSources(retained ? [] : getPlugins()).filter(
    (plugin) => plugin.enabled && (retained || plugin.mcpServerCount > 0)
  )
  const sources: CapabilitySource[] = []
  const userInfo = getUserInfo()

  for (const plugin of plugins) {
    const configPath = join(plugin.path, ".mcp.json")
    const servers = parseMcpJsonFile(configPath)
    if (!servers) continue

    for (const [serverName, serverConfig] of Object.entries(servers)) {
      if (runtimeCapabilityAllowsMcp(plugin.id, serverName) === false) continue
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
        serverConfig: buildPluginServerConfig(serverConfig, userInfo, plugin.path)
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
  userInfo: ReturnType<typeof getUserInfo>,
  pluginRoot: string
): Record<string, unknown> {
  const expand = (value: string) => value.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot)
  // Resolve only this explicit package variable against the admitted source; never substitute
  // arbitrary environment/credentials or use the mutable installation for a pinned runtime.
  const strings = (values: Record<string, string> | undefined) => values &&
    Object.fromEntries(Object.entries(values).map(([key, value]) => [key, expand(value)]))
  if (config.command) {
    return buildMcpServerConfig({
      kind: "stdio",
      command: expand(config.command),
      args: config.args?.map(expand),
      env: strings(config.env)
    })
  }

  if (config.url) {
    return buildMcpServerConfig({
      kind: "remote",
      url: expand(config.url),
      advanced: {
        headers: resolveMcpHeaders({
          headers: strings(config.headers),
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
  constructor(
    private readonly boundDerivedPluginId?: string,
    private readonly capabilityToken?: RuntimePluginSourceToken
  ) {}
  private cache: CapabilityCache | null = null
  private initPromise: Promise<void> | null = null
  private readonly schemaCache = new SchemaCache()
  private revision = 0
  private closed = false
  private closing: Promise<void> | null = null
  private retirementFailure: unknown
  private readonly clients = new Set<MultiServerMCPClient>()
  private readonly retiring = new Map<MultiServerMCPClient, Promise<void>>()
  private readonly inflight = new Set<Promise<unknown>>()
  private unconfirmedStdioReaders = false

  get hasUnconfirmedSnapshotReaders(): boolean {
    return this.unconfirmedStdioReaders
  }

  private assertOpen(): void {
    if (this.closed) throw new ModError("MODS_MCP_SERVICE_CLOSED")
    if (this.retirementFailure) throw new ModError("MODS_MCP_CLEANUP_UNCONFIRMED")
  }

  private track<T>(work: () => Promise<T>): Promise<T> {
    this.assertOpen()
    const task = Promise.resolve().then(() => {
      this.assertOpen()
      return work()
    })
    this.inflight.add(task)
    void task.finally(() => this.inflight.delete(task)).catch(() => {})
    return task
  }

  private retire(client: MultiServerMCPClient): Promise<void> {
    const existing = this.retiring.get(client)
    if (existing) return existing
    const task = Promise.resolve()
      .then(() => client.close())
      .then(
        () => {
          this.clients.delete(client)
        },
        (error) => {
          this.retirementFailure = error
          throw error
        }
      )
      .finally(() => {
        if (this.retiring.get(client) === task) this.retiring.delete(client)
      })
    this.retiring.set(client, task)
    return task
  }

  configuredServerNames(): string[] {
    return this.readSources().map((source) => source.providerDisplayName)
  }

  peekTools(): McpCapabilityTool[] | null {
    if (!this.cache || this.cache.fingerprint !== buildFingerprint(this.readSources())) return null
    return structuredClone(this.cache.tools)
  }

  async listTools(): Promise<McpCapabilityTool[]> {
    return this.track(async () => {
      await this.ensureInitialized()
      this.assertOpen()
      return [...(this.cache?.tools ?? [])]
    })
  }

  async getSnapshot(): Promise<{ fingerprint: string; tools: McpCapabilityTool[] }> {
    return this.track(async () => {
      await this.ensureInitialized()
      this.assertOpen()
      return {
        fingerprint: this.cache?.fingerprint ?? "",
        tools: [...(this.cache?.tools ?? [])]
      }
    })
  }

  async getTool(idOrAlias: string): Promise<McpCapabilityTool | null> {
    return this.track(async () => {
      if (!idOrAlias.trim()) return null
      await this.ensureInitialized()
      this.assertOpen()
      return this.resolveTool(idOrAlias)
    })
  }

  async connectPluginServer(
    owner: McpConnectOwner,
    server: string,
    signal: AbortSignal,
    assertCurrent: () => void
  ): Promise<McpConnectAdmission> {
    return this.track(() => this.connectPluginServerInternal(owner, server, signal, assertCurrent))
  }

  private async connectPluginServerInternal(
    owner: McpConnectOwner,
    server: string,
    signal: AbortSignal,
    assertCurrent: () => void
  ): Promise<McpConnectAdmission> {
    const pluginId = owner.pluginId
    const sourcePath = owner.sourcePath
    const root = owner.root
    const check = () => {
      this.assertOpen()
      signal.throwIfAborted()
      assertCurrent()
    }
    const refused = (reason: "unlisted" | "disabled" | "failed"): McpConnectAdmission => ({
      value: mcpConnectRefusal(reason),
      assertCurrent: check
    })
    const readOwner = () => {
      // A retained package is not a mutable installation. The service's original opaque
      // token proves the exact admitted parent/selected sources even after ALS exits.
      const candidates = this.capabilityToken
        ? withRuntimePluginSource(this.capabilityToken, () => projectRuntimePluginSources([]))
        : getPlugins()
      const plugin = candidates.find((entry) => entry.id === pluginId)
      if (!plugin || plugin.path !== sourcePath) return null
      const actual = realpathSync(plugin.path)
      const expected = resolve(root)
      if (
        process.platform === "win32"
          ? actual.toLowerCase() !== expected.toLowerCase()
          : actual !== expected
      )
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
    return this.track(() => this.invokeInternal(idOrAlias, args, assertCurrent))
  }

  private async invokeInternal(
    idOrAlias: string,
    args: Record<string, unknown>,
    assertCurrent?: () => void
  ): Promise<McpInvocationResult> {
    this.assertSourceContent()
    assertCurrent?.()
    await this.ensureInitialized()
    this.assertOpen()
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
    this.assertOpen()
    if (!serverClient) {
      throw new Error(`MCP client is unavailable for provider ${tool.providerDisplayName}`)
    }

    return withRawModMcp(tool, args, async (args) => {
      await authorizeCurrentModInput(`mcp:${tool.capabilityId}`, args)
      await beforeModToolExecution(() => {
        this.assertOpen()
        this.assertSourceContent()
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
          this.assertOpen()
          this.assertSourceContent()
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
      this.assertSourceContent()
      assertCurrent?.()

      const result = await publishCurrentModResult(
        normalizeMcpInvocationResult(tool.capabilityId, raw)
      )
      this.assertSourceContent()
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

    // A pending rebuild observes the revision fence and retires its candidate before it settles.
    if (this.initPromise) await this.initPromise.catch(() => {})
    if (previous?.client) await this.retire(previous.client)
    if (this.retirementFailure) throw this.retirementFailure
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.revision++
    this.cache = null
    this.schemaCache.clear()
    this.retirementFailure = undefined
    const task = (async () => {
      // Include connect/list/invoke and rebuild continuations; closing an empty cache is not a drain.
      await Promise.allSettled([...this.inflight])
      if (this.initPromise) await this.initPromise.catch(() => {})
      await Promise.allSettled([...this.retiring.values()])
      if (this.retirementFailure) throw this.retirementFailure
      const results = await Promise.allSettled(
        [...this.clients].map((client) => this.retire(client))
      )
      if (results.some((result) => result.status === "rejected") || this.clients.size)
        throw new ModError("MODS_MCP_CLEANUP_UNCONFIRMED")
    })()
    this.closing = task
    try {
      await task
    } finally {
      if (this.closing === task) this.closing = null
    }
  }

  private async ensureInitialized(): Promise<void> {
    this.assertOpen()
    const fingerprint = buildFingerprint(this.readSources())
    if (this.cache?.fingerprint === fingerprint) {
      return
    }

    if (this.initPromise) {
      await this.initPromise
      this.assertOpen()
      const refreshedFingerprint = buildFingerprint(this.readSources())
      if (this.cache?.fingerprint === refreshedFingerprint) {
        return
      }
    }

    this.assertOpen()
    const task = this.rebuild()
    this.initPromise = task
    try {
      await task
    } finally {
      if (this.initPromise === task) this.initPromise = null
    }
  }

  private readSources(): CapabilitySource[] {
    this.assertOpen()
    if (this.capabilityToken)
      return withRuntimePluginSource(this.capabilityToken, () => toPluginSources())
    return [
      ...toConnectorSources(),
      ...toPluginSources().filter((source) =>
        isDerivationVisibleForProjectMode(
          { pluginId: source.pluginId, ...derivationVisibility(source.pluginId ?? "") },
          {
            projectMode: Boolean(this.boundDerivedPluginId),
            boundPluginId: this.boundDerivedPluginId
          }
        )
      )
    ]
  }

  /** The service owns the original opaque token, including callbacks entered outside ALS. */
  private assertSourceContent(): void {
    if (!this.capabilityToken) return
    withRuntimePluginSource(this.capabilityToken, () => {
      // Legacy/capabilities retain their original full entry check. Only host entry is cheap.
      if (currentRuntimePluginSource()?.mode === "host") assertCurrentRuntimePluginSourceContent()
    })
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
      const previous = this.cache
      this.cache = null
      this.schemaCache.clear()
      if (previous?.client) await this.retire(previous.client)
      return
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mcpServers: Record<string, any> = {}
    for (const source of sources) {
      mcpServers[source.providerKey] = source.serverConfig
    }

    if (this.capabilityToken) await prepareSnapshotMaintenance()
    this.assertOpen()
    if (revision !== this.revision) throw new ModError("MODS_MCP_CONTEXT_EXPIRED")
    const client = new MultiServerMCPClient({
      throwOnLoadError: false,
      onConnectionError: "ignore",
      useStandardContentBlocks: true,
      mcpServers
    })
    this.clients.add(client)
    if (
      sources.some(
        (source) =>
          typeof source.serverConfig.command === "string" ||
          source.serverConfig.transport === "stdio" ||
          source.serverConfig.type === "stdio"
      )
    )
      this.unconfirmedStdioReaders = true

    try {
      this.assertSourceContent()
      await client.initializeConnections()
      this.assertOpen()
      this.assertSourceContent()
      const seeds: McpCapabilitySeed[] = []

      for (const source of sources) {
        const serverTools = await listServerTools(client, source.providerKey)
        this.assertOpen()
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
      this.assertSourceContent()
      if (this.revision !== revision || buildFingerprint(this.readSources()) !== fingerprint)
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
        await this.retire(previous.client)
      }

      console.log(`[MCP] capability service ready with ${tools.length} tools`)
    } catch (error) {
      if (this.cache?.client === client) this.cache = null
      await this.retire(client)
      throw error
    }
  }
}

let globalCapabilityService: ManagedMcpCapabilityService | null = null
const selectedCapabilityServices = new Map<RuntimePluginSourceToken, ManagedMcpCapabilityService>()
const selectedSnapshotLeases = new Map<RuntimePluginSourceToken, SnapshotLease>()
const derivedCapabilityServices = new Map<string, ManagedMcpCapabilityService>()
let closingCapabilityServices: Promise<void> | null = null

function assertCapabilityRegistryOpen(): void {
  if (closingCapabilityServices) throw new ModError("MODS_MCP_SERVICE_CLOSED")
}

/** Native project binding, captured before discovery; unbound global discovery never starts copies. */
export function getProjectMcpCapabilityService(boundPluginId?: string): McpCapabilityService {
  assertCapabilityRegistryOpen()
  const token = captureRuntimePluginSourceToken()
  if (token) {
    // A completed/revoked retained owner cannot allocate a fresh service after settlement.
    currentRuntimePluginSource()
    let service = selectedCapabilityServices.get(token)
    if (!service) {
      const lease = retainRuntimePluginSourceToken(token, "capability-mcp-service")
      try {
        service = new ManagedMcpCapabilityService(undefined, token)
        selectedCapabilityServices.set(token, service)
        selectedSnapshotLeases.set(token, lease)
      } catch (error) {
        lease.release()
        throw error
      }
    }
    return service
  }
  if (!boundPluginId || !isDerivedPlugin(boundPluginId)) return getGlobalMcpCapabilityService()
  let service = derivedCapabilityServices.get(boundPluginId)
  if (!service) {
    service = new ManagedMcpCapabilityService(boundPluginId)
    derivedCapabilityServices.set(boundPluginId, service)
  }
  return service
}

export function getGlobalMcpCapabilityService(): McpCapabilityService {
  assertCapabilityRegistryOpen()
  if (!globalCapabilityService) {
    globalCapabilityService = new ManagedMcpCapabilityService()
  }
  return globalCapabilityService
}

export async function invalidateGlobalMcpCapabilityService(reason?: string): Promise<void> {
  await Promise.all(
    [
      ...selectedCapabilityServices.values(),
      ...derivedCapabilityServices.values(),
      ...(globalCapabilityService ? [globalCapabilityService] : [])
    ].map((service) => service.invalidate(reason))
  )
}

export async function closeGlobalMcpCapabilityService(): Promise<void> {
  if (closingCapabilityServices) return closingCapabilityServices
  // Close registry admission synchronously, before even a reentrant client.close can create a peer.
  const closing = Promise.resolve().then(async () => {
    const outcomes = await Promise.allSettled(
      [
        ...selectedCapabilityServices.values(),
        ...derivedCapabilityServices.values(),
        ...(globalCapabilityService ? [globalCapabilityService] : [])
      ].map((service) => service.close())
    )
    const failed = outcomes.find((outcome) => outcome.status === "rejected")
    if (failed?.status === "rejected") throw failed.reason
    for (const [token, service] of selectedCapabilityServices)
      if (service.hasUnconfirmedSnapshotReaders)
        selectedSnapshotLeases.get(token)?.keepUntilNextBoot?.()
    selectedCapabilityServices.clear()
    for (const lease of selectedSnapshotLeases.values()) lease.release()
    selectedSnapshotLeases.clear()
    derivedCapabilityServices.clear()
    globalCapabilityService = null
  })
  closingCapabilityServices = closing
  try {
    await closing
  } finally {
    if (closingCapabilityServices === closing) closingCapabilityServices = null
  }
}

export async function closeProjectCapabilityMcpService(
  token: RuntimePluginSourceToken
): Promise<void> {
  const service = selectedCapabilityServices.get(token)
  await service?.close()
  if (selectedCapabilityServices.get(token) === service) {
    if (service?.hasUnconfirmedSnapshotReaders)
      selectedSnapshotLeases.get(token)?.keepUntilNextBoot?.()
    selectedCapabilityServices.delete(token)
    selectedSnapshotLeases.get(token)?.release()
    selectedSnapshotLeases.delete(token)
  }
}
