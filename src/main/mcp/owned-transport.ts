import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { CapabilitySource } from "./capability-service"
import { ModError } from "../mods/errors"

export interface OwnedMcpTransport {
  isClosed?(): boolean
  initialize(signal: AbortSignal): Promise<Array<{
    name: string
    description?: string
    inputSchema: Record<string, unknown>
    outputSchema?: Record<string, unknown>
  }>>
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  /** True only after the transport's physical close acknowledgement. */
  close(): Promise<boolean>
}

/** A dedicated stdio child. Remote transports remain policy-disabled until separately verified. */
export function createOwnedMcpTransport(source: CapabilitySource): OwnedMcpTransport {
  const config = source.serverConfig
  if (config.transport !== "stdio" || typeof config.command !== "string")
    throw new ModError("MODS_MCP_TRANSPORT_POLICY")
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args as string[] | undefined,
    env: config.env as Record<string, string> | undefined,
    stderr: "pipe"
  })
  // Do not log the process's stderr: it may contain host authentication material.
  transport.stderr?.on("data", () => {})
  const client = new Client({ name: "devclaw-owned-mcp", version: "1" })
  let started = false
  let physicallyClosed = false
  let acknowledge!: () => void
  const closed = new Promise<void>(resolve => { acknowledge = resolve })
  let closing: Promise<boolean> | undefined
  return {
    isClosed: () => physicallyClosed,
    async initialize(signal) {
      signal.throwIfAborted()
      started = true
      const initialization = client.connect(transport, { signal, timeout: 30_000 })
      const protocolClose = transport.onclose
      transport.onclose = () => {
        physicallyClosed = true
        acknowledge()
        protocolClose?.()
      }
      await initialization
      signal.throwIfAborted()
      const tools: Awaited<ReturnType<OwnedMcpTransport["initialize"]>> = []
      const cursors = new Set<string>()
      const names = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined,
          { signal, timeout: 30_000 })
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
      return tools
    },
    call: (name, args, signal) => client.callTool({ name, arguments: args }, undefined,
      { signal, timeout: 30_000 }),
    close() {
      if (closing) return closing
      closing = (async () => {
        if (!started) return true
        // SDK close may return immediately after SIGKILL. Only the actual child close event
        // proves reclamation; a timeout is deliberately an unknown tombstone, never closed.
        const deadline = new Promise<false>(resolve => {
          const timer = setTimeout(() => resolve(false), 7_000)
          timer.unref()
          void closed.then(() => clearTimeout(timer))
        })
        void client.close().catch(() => {})
        return Promise.race([closed.then(() => true), deadline])
      })()
      return closing.then(confirmed => confirmed || physicallyClosed)
    }
  }
}
