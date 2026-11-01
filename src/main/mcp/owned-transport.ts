import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { CapabilitySource } from "./capability-service"
import { ModError } from "../mods/errors"
import { OwnedMcpRemoteFetch } from "./owned-remote-fetch"

export interface OwnedMcpTransport {
  isClosed?(): boolean
  initialize(signal: AbortSignal): Promise<
    Array<{
      name: string
      description?: string
      inputSchema: Record<string, unknown>
      outputSchema?: Record<string, unknown>
    }>
  >
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  /** True only after local child exit or owned network requests/streams are reclaimed. */
  close(): Promise<boolean>
}

/** A dedicated host-selected source. Configuration and credentials never come from the guest. */
export function createOwnedMcpTransport(source: CapabilitySource): OwnedMcpTransport {
  const config = source.serverConfig
  let network: OwnedMcpRemoteFetch | undefined
  let transport: Transport
  if (config.transport === "stdio" && typeof config.command === "string") {
    const stdio = new StdioClientTransport({
      command: config.command,
      args: config.args as string[] | undefined,
      env: config.env as Record<string, string> | undefined,
      stderr: "pipe"
    })
    // Do not log the process's stderr: it may contain host authentication material.
    stdio.stderr?.on("data", () => {})
    transport = stdio
  } else {
    const kind = config.transport ?? "http"
    if (
      !["http", "streamable-http", "sse"].includes(String(kind)) ||
      typeof config.url !== "string"
    )
      throw new ModError("MODS_MCP_TRANSPORT_POLICY")
    let url: URL
    try {
      url = new URL(config.url)
    } catch {
      throw new ModError("MODS_MCP_TRANSPORT_POLICY")
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
      throw new ModError("MODS_MCP_TRANSPORT_POLICY")
    let headers: Headers
    try {
      headers = new Headers(config.headers as HeadersInit | undefined)
    } catch {
      throw new ModError("MODS_MCP_TRANSPORT_POLICY")
    }
    if (
      [...headers].length > 128 ||
      Buffer.byteLength(JSON.stringify([...headers]), "utf8") > 32_768
    )
      throw new ModError("MODS_MCP_TRANSPORT_POLICY")
    network = new OwnedMcpRemoteFetch(url.origin)
    const options = { fetch: network.fetch, requestInit: { headers } }
    transport =
      kind === "sse"
        ? new SSEClientTransport(url, options)
        : new StreamableHTTPClientTransport(url, {
            ...options,
            reconnectionOptions: {
              maxRetries: 0,
              initialReconnectionDelay: 1_000,
              maxReconnectionDelay: 1_000,
              reconnectionDelayGrowFactor: 1
            }
          })
  }
  const client = new Client({ name: "devclaw-owned-mcp", version: "1" })
  let started = false
  let physicallyClosed = false
  let acknowledge!: () => void
  const closed = new Promise<void>((resolve) => {
    acknowledge = resolve
  })
  let closing: Promise<boolean> | undefined
  const result: OwnedMcpTransport = {
    isClosed: () => physicallyClosed,
    async initialize(ownerSignal) {
      ownerSignal.throwIfAborted()
      if (started || closing) throw new ModError("MODS_MCP_CONTEXT_EXPIRED")
      started = true
      // SSE start itself waits for the endpoint event, before the SDK request timeout
      // begins. Bound the entire handshake/listing and close its actual network lifetime.
      const deadline = new AbortController()
      const signal = AbortSignal.any([ownerSignal, deadline.signal])
      const timer = setTimeout(() => deadline.abort(), 30_000)
      timer.unref()
      const initialization = client.connect(transport, { signal, timeout: 30_000 })
      const protocolClose = transport.onclose
      transport.onclose = () => {
        protocolClose?.()
        const confirmed = () => {
          physicallyClosed = true
          acknowledge()
        }
        if (network) void network.close().then(confirmed)
        else confirmed()
      }
      const protocolError = transport.onerror
      if (network)
        transport.onerror = () => {
          protocolError?.(new ModError("MODS_MCP_REMOTE_IO"))
          void result.close()
        }
      let abort!: () => void
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => {
          reject(new ModError("MODS_CANCELLED"))
          void result.close()
        }
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
      })
      try {
        await Promise.race([initialization, cancelled])
        signal.throwIfAborted()
        const tools: Awaited<ReturnType<OwnedMcpTransport["initialize"]>> = []
        const cursors = new Set<string>()
        const names = new Set<string>()
        let cursor: string | undefined
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined, {
            signal,
            timeout: 30_000
          })
          for (const tool of page.tools) {
            if (names.has(tool.name)) throw new ModError("MODS_MCP_TOOL_AMBIGUOUS")
            names.add(tool.name)
            tools.push(tool)
          }
          if (tools.length > 256 || Buffer.byteLength(JSON.stringify(tools), "utf8") > 750_000)
            throw new ModError("MODS_MCP_TOOL_LIMIT")
          cursor = page.nextCursor
          if (cursor && (cursors.has(cursor) || cursors.size >= 32))
            throw new ModError("MODS_MCP_TOOL_LIMIT")
          if (cursor) cursors.add(cursor)
        } while (cursor)
        signal.throwIfAborted()
        if (closing || physicallyClosed) throw new ModError("MODS_MCP_CONTEXT_EXPIRED")
        return tools
      } catch (error) {
        // SDK errors may embed an HTTP URL, headers or server response text.
        if (network)
          throw new ModError(ownerSignal.aborted ? "MODS_CANCELLED" : "MODS_MCP_CONNECT_FAILED")
        throw error
      } finally {
        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
      }
    },
    async call(name, args, signal) {
      signal?.throwIfAborted()
      if (closing || physicallyClosed) throw new ModError("MODS_MCP_CONTEXT_EXPIRED")
      const abort = () => {
        void result.close()
      }
      signal?.addEventListener("abort", abort, { once: true })
      try {
        const value = await client.callTool({ name, arguments: args }, undefined, {
          signal,
          timeout: 30_000
        })
        signal?.throwIfAborted()
        if (closing || physicallyClosed) throw new ModError("MODS_MCP_CONTEXT_EXPIRED")
        return value
      } catch {
        await result.close()
        throw new ModError(signal?.aborted ? "MODS_CANCELLED" : "MODS_MCP_CALL_FAILED")
      } finally {
        signal?.removeEventListener("abort", abort)
      }
    },
    close() {
      if (closing) return closing
      closing = (async () => {
        if (!started) {
          physicallyClosed = true
          return true
        }
        // SDK close may return immediately after SIGKILL. Only the actual child close event
        // proves reclamation; a timeout is deliberately an unknown tombstone, never closed.
        const deadline = new Promise<false>((resolve) => {
          const timer = setTimeout(() => resolve(false), 7_000)
          timer.unref()
          void closed.then(() => clearTimeout(timer))
        })
        if (network) void network.close()
        void client.close().catch(() => {})
        return Promise.race([closed.then(() => true), deadline])
      })()
      return closing.then((confirmed) => confirmed || physicallyClosed)
    }
  }
  return result
}
