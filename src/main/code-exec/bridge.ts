import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http"
import { randomUUID } from "crypto"
import type { AddressInfo } from "net"
import type { McpCapabilityService } from "../mcp/capability-types"
import type { CodeExecBridgePayload, CodeExecInvokeResponse, CodeExecMetaResponse } from "./types"

interface BridgeCallRequest {
  idOrAlias: string
  args?: Record<string, unknown>
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader("content-type", "application/json; charset=utf-8")
  res.end(JSON.stringify(payload))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"))
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization
  return header === `Bearer ${token}`
}

export class CodeExecBridge {
  private server: Server | null = null
  private token = randomUUID()
  private baseUrl = ""

  constructor(private readonly capabilityService: McpCapabilityService) {}

  async start(): Promise<CodeExecBridgePayload> {
    if (this.server && this.baseUrl) {
      return {
        bridgeUrl: this.baseUrl,
        token: this.token
      }
    }

    this.server = createServer(async (req, res) => {
      try {
        if (!isAuthorized(req, this.token)) {
          writeJson(res, 401, { error: "Unauthorized" })
          return
        }

        if (req.method === "POST" && req.url === "/meta") {
          const response: CodeExecMetaResponse = {
            tools: await this.capabilityService.listTools()
          }
          writeJson(res, 200, response)
          return
        }

        if (req.method === "POST" && req.url === "/call") {
          const payload = await readJson(req) as BridgeCallRequest
          const result = await this.capabilityService.invoke(
            payload.idOrAlias,
            payload.args ?? {}
          )
          const response: CodeExecInvokeResponse = { result }
          writeJson(res, 200, response)
          return
        }

        writeJson(res, 404, { error: "Not found" })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        writeJson(res, 500, { error: message })
      }
    })

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject)
      this.server?.listen(0, "127.0.0.1", () => {
        resolve()
      })
    })

    const address = this.server.address() as AddressInfo | null
    if (!address) {
      throw new Error("CodeExec bridge failed to bind to a local port")
    }

    this.baseUrl = `http://127.0.0.1:${address.port}`

    return {
      bridgeUrl: this.baseUrl,
      token: this.token
    }
  }

  async close(): Promise<void> {
    if (!this.server) return

    const server = this.server
    this.server = null
    this.baseUrl = ""

    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }
}
