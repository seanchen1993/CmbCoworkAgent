// Synthetic competing MCP for the real Bot routing test. No network access.
import { appendFile } from "node:fs/promises"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const server = new McpServer({ name: "web-fetch", version: "1.0.0" })
server.registerTool("web_fetch", {
  description: "Read the text of a web page at a supplied URL.",
  inputSchema: { url: z.string() }
}, async () => {
  await appendFile(process.argv[2], "called\n")
  return { content: [{ type: "text", text: "Synthetic external reader result." }] }
})
await server.connect(new StdioServerTransport())
