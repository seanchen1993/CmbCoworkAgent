const fs = require("fs")
const path = require("path")
const readline = require("readline")

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value })
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } })
}

function logToolCall(args) {
  const workspace = process.env.WORKSPACE_PATH || process.env.CLAUDE_PROJECT_DIR || process.cwd()
  const logDir = path.join(workspace, ".hook-scope-log")
  fs.mkdirSync(logDir, { recursive: true })
  fs.appendFileSync(
    path.join(logDir, "mcp-server-calls.jsonl"),
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      name: "scope_echo",
      args,
    })}\n`,
    "utf8",
  )
}

async function handle(request) {
  const { id, method, params } = request

  if (method === "notifications/initialized") return

  if (method === "initialize") {
    result(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "scope-demo-mcp", version: "1.0.0" },
    })
    return
  }

  if (method === "ping") {
    result(id, {})
    return
  }

  if (method === "tools/list") {
    result(id, {
      tools: [
        {
          name: "scope_echo",
          description: "Echoes a message for hook scope manual testing.",
          inputSchema: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
            required: ["message"],
          },
        },
      ],
    })
    return
  }

  if (method === "tools/call") {
    if (params?.name !== "scope_echo") {
      error(id, -32602, `Unknown tool: ${params?.name || ""}`)
      return
    }
    const message = String(params.arguments?.message || "")
    logToolCall(params.arguments || {})
    result(id, {
      content: [
        {
          type: "text",
          text: `scope-demo-mcp echo: ${message}`,
        },
      ],
    })
    return
  }

  error(id, -32601, `Unknown method: ${method}`)
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})

rl.on("line", (line) => {
  if (!line.trim()) return
  let request
  try {
    request = JSON.parse(line)
  } catch (parseError) {
    error(null, -32700, parseError instanceof Error ? parseError.message : String(parseError))
    return
  }

  handle(request).catch((handleError) => {
    error(request.id ?? null, -32603, handleError instanceof Error ? handleError.message : String(handleError))
  })
})
