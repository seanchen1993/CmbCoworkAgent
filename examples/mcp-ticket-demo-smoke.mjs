#!/usr/bin/env node
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverPath = resolve(__dirname, "mcp-ticket-demo-server.mjs")

const client = new Client({
  name: "cmb-ticket-demo-smoke",
  version: "1.0.0"
})

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  stderr: "pipe"
})

try {
  await client.connect(transport)

  const tools = await client.listTools()
  console.log("tools:", tools.tools.map((tool) => tool.name).join(", "))

  const result = await client.callTool({
    name: "ticket_list",
    arguments: {
      status: "not_closed",
      limit: 20
    }
  })

  const structured = result.structuredContent
  const rawBytes = Buffer.byteLength(JSON.stringify(structured, null, 2), "utf8")
  const first = structured?.items?.[0]

  console.log("ticket_list raw JSON bytes:", rawBytes)
  console.log("first ticket full keys:", Object.keys(first ?? {}).join(", "))
  console.log("first ticket id/title/status/owner:", {
    id: first?.id,
    title: first?.title,
    status: first?.status,
    owner: first?.owner
  })
  console.log("OK: demo MCP is ready for app testing.")
} finally {
  await client.close()
}
