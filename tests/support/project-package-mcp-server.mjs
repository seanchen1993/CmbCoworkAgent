// Deterministic real stdio JSON-RPC peer; no application hooks or model execution are mocked.
import { createInterface } from "node:readline"
import { appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const [journalArgument, revision] = process.argv.slice(2)
const journal = journalArgument === "-"
  ? process.env.CMB_E2E_PACKAGE_MCP_JOURNAL === "-"
    ? join(tmpdir(), "package-mcp.jsonl")
    : undefined
  : journalArgument
const lines = createInterface({ input: process.stdin })
for await (const line of lines) {
  const message = JSON.parse(line)
  if (message.id === undefined) continue
  let result
  if (message.method === "initialize")
    result = {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "project-package", version: "1.0.0" }
    }
  else if (message.method === "tools/list")
    result = {
      tools: [
        {
          name: "echo",
          description: "Package echo",
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
          },
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"]
          }
        }
      ]
    }
  else if (message.method === "tools/call") {
    const text = String(message.params.arguments.text)
    if (journal) appendFileSync(
      journal,
      JSON.stringify({ event: "call", revision, text, pid: process.pid, source: import.meta.url }) +
        "\n"
    )
    result = { content: [{ type: "text", text: `${revision}:${text}` }] }
  } else if (message.method === "ping") result = {}
  else {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Unsupported fixture method" }
      }) + "\n"
    )
    continue
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n")
}
