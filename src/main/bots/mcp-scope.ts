import type { McpCapabilityService, McpCapabilityTool } from "../mcp/capability-types"

type BotMcpRole = "communication" | "execution"

/** The workbench browser has a global target; Bot browsing must use its own owner-bound tools. */
function isWorkbenchComputer(tool: McpCapabilityTool): boolean {
  return /browser|playwright|puppeteer|selenium|computer/i.test(
    `${tool.providerKey} ${tool.providerDisplayName} ${tool.toolName}`
  )
}

function isWebPageReader(tool: McpCapabilityTool): boolean {
  // A connector can have an opaque ID and a plugin can bundle unrelated domain tools.
  // Match the reader's advertised name or dedicated server, not arbitrary description text.
  const readerName = /(?:^|[^a-z0-9])(?:web[-_ ]?fetch|(?:fetch|read)[-_ ]?(?:url|web[-_ ]?page))(?:$|[^a-z0-9])/i
  const server = tool.providerKey.slice(tool.providerKey.lastIndexOf("/") + 1)
  if ([tool.toolName, tool.providerDisplayName, server].some(name => readerName.test(name))) return true
  const properties = tool.inputSchema?.properties
  return /^fetch(?:[_-]?(?:html|markdown|text|json))?$/i.test(tool.toolName) &&
    typeof properties === "object" && properties !== null && "url" in properties
}

export function createBotMcpScope(base: McpCapabilityService, role: BotMcpRole): McpCapabilityService {
  function scoped(tool: McpCapabilityTool): McpCapabilityTool | null {
    if (isWorkbenchComputer(tool)) return null
    if (!isWebPageReader(tool)) return tool
    if (role === "communication") return null
    return tool.visibility === "lazy" ? tool : { ...tool, visibility: "lazy" }
  }
  const catalog = (tools: McpCapabilityTool[]) =>
    tools.map(scoped).filter((tool): tool is McpCapabilityTool => tool !== null)

  return {
    listTools: async () => catalog(await base.listTools()),
    getSnapshot: base.getSnapshot
      ? async () => {
          const snapshot = await base.getSnapshot!()
          return {
            fingerprint: `${snapshot.fingerprint}:bot-scope-v2:${role}`,
            tools: catalog(snapshot.tools)
          }
        }
      : undefined,
    getTool: async (id) => {
      const tool = await base.getTool(id)
      return tool && scoped(tool)
    },
    invoke: async (id, args) => {
      // Resolve again at invocation: old discovery snapshots and aliases confer no authority.
      const tool = await base.getTool(id)
      if (!tool || !scoped(tool)) {
        if (tool && !isWorkbenchComputer(tool))
          throw new Error("请将网页读取交给独立任务")
        throw new Error("Bot 无权操作工作台的共享电脑目标，请在对应任务的浏览器中处理")
      }
      return base.invoke(tool.capabilityId, args)
    },
    invalidate: (reason) => base.invalidate(reason),
    // The application owns the shared connector pool; a Bot cannot close other users of it.
    close: async () => {}
  }
}
