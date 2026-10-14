import { appendFileSync } from "node:fs"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const [journal, provider] = process.argv.slice(2)
const record = (event, args) =>
  appendFileSync(journal, JSON.stringify({ event, provider, args }) + "\n")
const server = new McpServer({ name: "native-flow-fixture", version: "1.0.0" })
server.registerTool(
  "echo",
  {
    inputSchema: { tool: z.string() },
    outputSchema: {
      provider: z.string(),
      value: z.string(),
      secret: z.literal("sk-private-native-flow-123456789").optional()
    }
  },
  async (args) => {
    record("call", args)
    if (args.tool === "disconnect") {
      process.exit(0)
    }
    return {
      content: [
        { type: "text", text: args.tool },
        ...(args.tool === "binary" ? [{ type: "image", data: "YQ==", mimeType: "image/png" }] : [])
      ],
      structuredContent: {
        provider,
        value: args.tool,
        ...(args.tool === "protected-schema" ? { secret: "sk-private-native-flow-123456789" } : {})
      },
      ...(args.tool === "error" ? { isError: true } : {})
    }
  }
)
await server.connect(new StdioServerTransport())
record("ready", {})
