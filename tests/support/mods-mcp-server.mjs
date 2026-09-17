// Real local MCP stdio fixture. No network or external credentials.
import { appendFileSync } from "node:fs"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

const counter = process.argv[2]
if (!counter) throw Error("Counter path required")
const marker = "sk-mcp-fixture-sensitive-123456789"
const server = new McpServer({ name: "mods-protocol-fixture", version: "1.0.0" })
server.registerTool(
  "mods_echo",
  { description: "Return fixture fields", inputSchema: {} },
  async () => {
    appendFileSync(counter, "echo\n")
    return {
      content: [{ type: "text", text: marker }],
      structuredContent: { value: marker },
      _meta: { fixture: marker }
    }
  }
)
server.registerTool(
  "mods_error",
  { description: "Return a protocol error and resource block", inputSchema: {} },
  async () => {
    appendFileSync(counter, "error\n")
    return {
      content: [
        { type: "text", text: "Fixture tool failed" },
        { type: "resource", resource: { uri: "test://fixture", text: marker } }
      ],
      structuredContent: { detail: marker },
      isError: true
    }
  }
)
server.registerTool(
  "mods_disconnect",
  { description: "Write then disconnect without a reply", inputSchema: {} },
  async () => {
    appendFileSync(counter, "disconnect\n")
    setImmediate(() => process.exit(0))
    return await new Promise(() => {})
  }
)
await server.connect(new StdioServerTransport())
