// Real stdio MCP fixture. Each invocation records the actual serving process.
import { appendFileSync } from "node:fs"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const [journal, revision] = process.argv.slice(2)
if (!journal || !revision) throw Error("Journal and revision required")
const record = (entry) =>
  appendFileSync(journal, JSON.stringify({ pid: process.pid, ...entry }) + "\n")
const server = new McpServer({ name: "legacy-plugin-fixture", version: "1.0.0" })
server.registerTool(
  "echo",
  { description: "Local legacy plugin echo", inputSchema: { text: z.string() } },
  async ({ text }) => {
    record({ event: "call", revision, text })
    return {
      content: [{ type: "text", text: `${revision}:${text}` }],
      structuredContent: { revision, text, pid: process.pid }
    }
  }
)
await server.connect(new StdioServerTransport())
record({ event: "ready", revision })
