import type { McpCapabilityService, McpCapabilityTool } from "../mcp/capability-types"

/** The workbench browser has a global target; Bot browsing must use its own owner-bound tools. */
function isWorkbenchComputer(name: string): boolean {
  return /browser|playwright|puppeteer|selenium|computer/i.test(name)
}
function allowed(tool: McpCapabilityTool): boolean {
  return !isWorkbenchComputer(`${tool.providerKey} ${tool.providerDisplayName} ${tool.toolName}`)
}

export function createBotMcpScope(base: McpCapabilityService): McpCapabilityService {
  return {
    configuredServerNames: base.configuredServerNames
      ? () => base.configuredServerNames!().filter((name) => !isWorkbenchComputer(name))
      : undefined,
    peekTools: base.peekTools ? () => base.peekTools!()?.filter(allowed) ?? null : undefined,
    listTools: async () => (await base.listTools()).filter(allowed),
    getSnapshot: base.getSnapshot
      ? async () => {
          const snapshot = await base.getSnapshot!()
          return {
            fingerprint: `${snapshot.fingerprint}:bot-scope-v1`,
            tools: snapshot.tools.filter(allowed)
          }
        }
      : undefined,
    getTool: async (id) => {
      const tool = await base.getTool(id)
      return tool && allowed(tool) ? tool : null
    },
    invoke: async (id, args) => {
      // Resolve again at invocation: old discovery snapshots and aliases confer no authority.
      const tool = await base.getTool(id)
      if (!tool || !allowed(tool))
        throw new Error("Bot 无权操作工作台的共享电脑目标，请使用 Bot 浏览器工具")
      return base.invoke(tool.capabilityId, args)
    },
    invalidate: (reason) => base.invalidate(reason),
    // The application owns the shared connector pool; a Bot cannot close other users of it.
    close: async () => {}
  }
}
