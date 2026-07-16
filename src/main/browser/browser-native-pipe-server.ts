import { EventEmitter } from "events"
import { createServer, type Server, type Socket } from "net"
import { endianness } from "os"
import {
  ensureOfficialBrowserUsePipeDiscoveryPathSync,
  removeOfficialBrowserUsePipeDiscoveryPathSync,
  shouldUseBrowserNativePipeDiscoveryServer
} from "./browser-platform"

export interface BrowserNativePipeTransport {
  sendNotification(method: string, params?: unknown): void
}

export interface BrowserNativePipeRpcBackend {
  handleRequest(
    method: string,
    params: unknown,
    transport: BrowserNativePipeTransport
  ): Promise<unknown> | unknown
}

export interface BrowserNativePipeBridgeOptions {
  backend: BrowserNativePipeRpcBackend
  phase: number
  pipePath: string
  sessionId: string
}

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: string | number | null
  result?: unknown
  error?: {
    code: number
    message: string
  }
}

const HEADER_BYTES = 4
const isLittleEndian = endianness() === "LE"

function readFrameLength(buffer: Buffer<ArrayBufferLike>): number {
  return isLittleEndian ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0)
}

function writeFrameLength(buffer: Buffer<ArrayBufferLike>, length: number): void {
  if (isLittleEndian) {
    buffer.writeUInt32LE(length, 0)
  } else {
    buffer.writeUInt32BE(length, 0)
  }
}

function encodeJsonRpcFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8")
  const frame = Buffer.alloc(HEADER_BYTES + payload.byteLength)
  writeFrameLength(frame, payload.byteLength)
  payload.copy(frame, HEADER_BYTES)
  return frame
}

function decodeJsonRpcFrames(buffer: Buffer<ArrayBufferLike>): {
  messages: unknown[]
  remainder: Buffer<ArrayBufferLike>
} {
  const messages: unknown[] = []
  let offset = 0

  while (buffer.byteLength - offset >= HEADER_BYTES) {
    const frameLength = readFrameLength(buffer.subarray(offset, offset + HEADER_BYTES))
    const frameStart = offset + HEADER_BYTES
    const frameEnd = frameStart + frameLength
    if (buffer.byteLength < frameEnd) break

    const payload = buffer.subarray(frameStart, frameEnd).toString("utf8")
    messages.push(JSON.parse(payload))
    offset = frameEnd
  }

  return {
    messages,
    remainder: buffer.subarray(offset)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class BrowserNativePipeConnection
  extends EventEmitter
  implements BrowserNativePipeTransport
{
  private closed = false
  private inputBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)

  constructor(
    private readonly backend: BrowserNativePipeRpcBackend,
    private readonly pipePath: string
  ) {
    super()
  }

  write(chunk: Uint8Array): boolean {
    if (this.closed) return false

    try {
      this.inputBuffer = Buffer.concat([this.inputBuffer, Buffer.from(chunk)])
      const decoded = decodeJsonRpcFrames(this.inputBuffer)
      this.inputBuffer = decoded.remainder

      for (const message of decoded.messages) {
        void this.handleMessage(message)
      }
      return true
    } catch (error) {
      this.emit("error", error)
      this.end()
      return false
    }
  }

  end(): void {
    if (this.closed) return
    this.closed = true
    this.emit("close")
  }

  sendNotification(method: string, params?: unknown): void {
    this.emitFrame({
      jsonrpc: "2.0",
      method,
      params
    })
  }

  private async handleMessage(message: unknown): Promise<void> {
    const request = message as JsonRpcRequest
    if (!request || typeof request !== "object" || typeof request.method !== "string") return

    const id = request.id ?? null
    if (request.id === undefined) return

    try {
      const result = await this.backend.handleRequest(request.method, request.params, this)
      this.sendResponse({ jsonrpc: "2.0", id, result })
    } catch (error) {
      this.sendResponse({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: errorMessage(error)
        }
      })
    }
  }

  private sendResponse(response: JsonRpcResponse): void {
    this.emitFrame(response)
  }

  private emitFrame(message: unknown): void {
    if (this.closed) return
    this.emit("data", encodeJsonRpcFrame(message))
  }

  getPath(): string {
    return this.pipePath
  }
}

export class BrowserNativePipeBridge {
  readonly pipePath: string
  private readonly discoveryReady: Promise<void>
  private discoveryServer: Server | null = null
  private readonly discoverySockets = new Set<Socket>()

  constructor(private readonly options: BrowserNativePipeBridgeOptions) {
    this.pipePath = options.pipePath
    ensureOfficialBrowserUsePipeDiscoveryPathSync(options.pipePath)
    this.discoveryReady = this.createDiscoveryServer()
    console.log(`[BrowserRuntime] iab backend registered for ${options.sessionId}.`)
  }

  private createDiscoveryServer(): Promise<void> {
    if (!shouldUseBrowserNativePipeDiscoveryServer(this.options.pipePath)) {
      return Promise.resolve()
    }

    const server = createServer((socket) => this.attachDiscoverySocket(socket))
    this.discoveryServer = server
    return new Promise((resolve) => {
      const logError = (error: Error): void => {
        console.warn(
          `[BrowserRuntime] windows native pipe failed for ${this.options.sessionId}: ${errorMessage(error)}.`
        )
      }
      const onReady = (): void => {
        server.off("error", onInitialError)
        server.on("error", logError)
        resolve()
      }
      const onInitialError = (error: Error): void => {
        server.off("listening", onReady)
        logError(error)
        resolve()
      }
      server.once("listening", onReady)
      server.once("error", onInitialError)
      try {
        server.listen(this.options.pipePath)
      } catch (error) {
        server.off("listening", onReady)
        server.off("error", onInitialError)
        logError(error instanceof Error ? error : new Error(String(error)))
        resolve()
      }
    })
  }

  private attachDiscoverySocket(socket: Socket): void {
    const connection = new BrowserNativePipeConnection(this.options.backend, this.options.pipePath)
    const closeConnection = (): void => connection.end()
    this.discoverySockets.add(socket)

    socket.on("data", (chunk) => {
      connection.write(chunk)
    })
    socket.once("end", closeConnection)
    socket.once("close", () => {
      this.discoverySockets.delete(socket)
      closeConnection()
    })
    socket.once("error", closeConnection)

    connection.on("data", (chunk: Uint8Array) => {
      if (!socket.destroyed) socket.write(chunk)
    })
    connection.once("close", () => {
      if (!socket.destroyed) socket.end()
    })
    connection.once("error", (error) => {
      socket.destroy(error instanceof Error ? error : undefined)
    })

    console.log(`[BrowserRuntime] native pipe connected for ${this.options.sessionId}.`)
  }

  ready(): Promise<void> {
    return this.discoveryReady
  }

  async createConnection(pipePath: string): Promise<BrowserNativePipeConnection> {
    if (pipePath !== this.pipePath) {
      throw new Error(`Browser native pipe backend is not registered: ${pipePath}`)
    }

    console.log(`[BrowserRuntime] native pipe connected for ${this.options.sessionId}.`)
    return new BrowserNativePipeConnection(this.options.backend, pipePath)
  }

  dispose(): void {
    removeOfficialBrowserUsePipeDiscoveryPathSync(this.pipePath)
    for (const socket of this.discoverySockets) {
      socket.destroy()
    }
    this.discoverySockets.clear()
    this.discoveryServer?.close()
    this.discoveryServer = null
  }
}

export function createBrowserNativePipeBridge(
  options: BrowserNativePipeBridgeOptions
): BrowserNativePipeBridge {
  return new BrowserNativePipeBridge(options)
}
