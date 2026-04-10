import { IpcMain } from "electron"
import { MultiServerMCPClient } from "@langchain/mcp-adapters"
import {
  getMcpConnectors,
  getEnabledMcpConnectors,
  upsertMcpConnector,
  deleteMcpConnector,
  setMcpConnectorEnabled
} from "../storage"
import type { McpConnectorConfig, McpConnectorUpsert } from "../types"
import { invalidateGlobalMcpCapabilityService } from "../mcp/capability-service"

export function buildMcpServerConfig(config: {
  url: string
  advanced?: McpConnectorConfig["advanced"]
}): Record<string, unknown> {
  const base: Record<string, unknown> = { url: config.url }
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

function validateMcpConnectorInput(config: McpConnectorUpsert): void {
  if (!config.name || typeof config.name !== "string" || !config.name.trim()) {
    throw new Error("名称不能为空")
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
      params: { id?: string; url?: string; advanced?: McpConnectorConfig["advanced"] }
    ): Promise<{ success: boolean; tools?: string[]; error?: string }> => {
      let url: string
      let advanced: McpConnectorConfig["advanced"] | undefined

      if (params.id) {
        const connectors = getMcpConnectors()
        const connector = connectors.find((c) => c.id === params.id)
        if (!connector) {
          return { success: false, error: "连接器不存在" }
        }
        url = connector.url
        advanced = connector.advanced
      } else if (params.url) {
        url = params.url.trim()
        advanced = params.advanced
      } else {
        return { success: false, error: "请提供连接器 ID 或 URL" }
      }

      if (!url) {
        return { success: false, error: "URL 不能为空" }
      }

      let client: MultiServerMCPClient | null = null
      try {
        const serverConfig = buildMcpServerConfig({ url, advanced })
        client = new MultiServerMCPClient({
          throwOnLoadError: true,
          onConnectionError: "throw",
          useStandardContentBlocks: true,
          mcpServers: {
            test: serverConfig as { url: string; headers?: Record<string, string>; transport?: "sse" | "http"; reconnect?: object }
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
