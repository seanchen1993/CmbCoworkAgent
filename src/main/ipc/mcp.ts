import { IpcMain } from "electron"
import { MultiServerMCPClient } from "@langchain/mcp-adapters"
import type { Connection } from "@langchain/mcp-adapters"
import {
  getMcpConnectors,
  getEnabledMcpConnectors,
  upsertMcpConnector,
  deleteMcpConnector,
  setMcpConnectorEnabled
} from "../storage"
import { resolveMcpConnectorKind } from "../mcp/connector-kind"
import type { McpConnectorConfig, McpConnectorUpsert } from "../types"
import { invalidateGlobalMcpCapabilityService } from "../mcp/capability-service"

export function buildMcpServerConfig(config: {
  kind?: McpConnectorConfig["kind"]
  url?: string
  advanced?: McpConnectorConfig["advanced"]
  command?: string
  args?: string[]
  env?: Record<string, string>
}): Record<string, unknown> {
  const kind = resolveMcpConnectorKind(config)
  if (kind === "stdio") {
    return {
      transport: "stdio",
      command: config.command?.trim(),
      args: config.args ?? [],
      ...(config.env && Object.keys(config.env).length > 0 ? { env: config.env } : {})
    }
  }

  const base: Record<string, unknown> = { url: config.url?.trim() }
  if (config.advanced?.headers && Object.keys(config.advanced.headers).length > 0) {
    base.headers = config.advanced.headers
  }
  if (config.advanced?.transport) {
    base.transport = config.advanced.transport === "streamable-http" ? "http" : config.advanced.transport
  }
  if (config.advanced?.reconnect?.enabled) {
    base.reconnect = {
      enabled: true,
      maxAttempts: config.advanced.reconnect.maxAttempts ?? 3,
      delayMs: config.advanced.reconnect.delayMs ?? 1000
    }
  }
  return base
}

function toMcpConnectorUpsert(config: McpConnectorConfig): McpConnectorUpsert {
  return {
    name: config.name,
    kind: resolveMcpConnectorKind(config),
    url: config.url,
    command: config.command,
    args: config.args,
    env: config.env,
    enabled: config.enabled,
    advanced: config.advanced,
    lazyLoad: config.lazyLoad
  }
}

function validateMcpConnectorInput(config: McpConnectorUpsert): void {
  if (!config.name || typeof config.name !== "string" || !config.name.trim()) {
    throw new Error("名称不能为空")
  }

  const kind = resolveMcpConnectorKind(config)
  if (kind === "stdio") {
    if (!config.command || typeof config.command !== "string" || !config.command.trim()) {
      throw new Error("命令不能为空")
    }
    if (config.args && (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== "string"))) {
      throw new Error("命令参数格式无效")
    }
    if (
      config.env &&
      (typeof config.env !== "object" ||
        Array.isArray(config.env) ||
        Object.values(config.env).some((value) => typeof value !== "string"))
    ) {
      throw new Error("环境变量格式无效")
    }
    return
  }

  if (!config.url || typeof config.url !== "string" || !config.url.trim()) {
    throw new Error("URL 不能为空")
  }
  try {
    const parsed = new URL(config.url.trim())
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("URL 必须以 http:// 或 https:// 开头")
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("URL 必须")) throw e
    throw new Error("URL 格式无效")
  }
}

export function registerMcpHandlers(ipcMain: IpcMain): void {
  console.log("[MCP] Registering MCP handlers...")

  ipcMain.handle("mcp:list", async (): Promise<McpConnectorConfig[]> => {
    return getMcpConnectors()
  })

  ipcMain.handle(
    "mcp:create",
    async (_event, config: McpConnectorUpsert): Promise<{ id: string }> => {
      validateMcpConnectorInput(config)
      const id = upsertMcpConnector(config)
      await invalidateGlobalMcpCapabilityService("mcp:create")
      return { id }
    }
  )

  ipcMain.handle(
    "mcp:update",
    async (_event, config: McpConnectorUpsert & { id: string }): Promise<{ id: string }> => {
      validateMcpConnectorInput(config)
      const id = upsertMcpConnector(config)
      await invalidateGlobalMcpCapabilityService("mcp:update")
      return { id }
    }
  )

  ipcMain.handle("mcp:delete", async (_event, id: string): Promise<void> => {
    deleteMcpConnector(id)
    await invalidateGlobalMcpCapabilityService("mcp:delete")
  })

  ipcMain.handle(
    "mcp:setEnabled",
    async (_event, { id, enabled }: { id: string; enabled: boolean }): Promise<void> => {
      setMcpConnectorEnabled(id, enabled)
      await invalidateGlobalMcpCapabilityService("mcp:setEnabled")
    }
  )

  ipcMain.handle(
    "mcp:testConnection",
    async (
      _event,
      params: { id?: string; config?: McpConnectorUpsert; url?: string; advanced?: McpConnectorConfig["advanced"] }
    ): Promise<{ success: boolean; tools?: string[]; error?: string }> => {
      let config: McpConnectorUpsert

      if (params.id) {
        const connectors = getMcpConnectors()
        const connector = connectors.find((c) => c.id === params.id)
        if (!connector) {
          return { success: false, error: "连接器不存在" }
        }
        config = toMcpConnectorUpsert(connector)
      } else if (params.config) {
        config = params.config
      } else if (params.url) {
        config = {
          name: "test",
          url: params.url.trim(),
          advanced: params.advanced
        }
      } else {
        return { success: false, error: "请提供连接器 ID 或配置" }
      }

      let client: MultiServerMCPClient | null = null
      try {
        validateMcpConnectorInput(config)
        const serverConfig = buildMcpServerConfig(config)
        client = new MultiServerMCPClient({
          throwOnLoadError: true,
          onConnectionError: "throw",
          useStandardContentBlocks: true,
          mcpServers: {
            test: serverConfig as Connection
          }
        })

        const tools = await client.getTools()

        return {
          success: true,
          tools: tools.map((t) => t.name)
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return { success: false, error: message }
      } finally {
        if (client) {
          try { await client.close() } catch { /* best effort */ }
        }
      }
    }
  )
}

export { getEnabledMcpConnectors }
