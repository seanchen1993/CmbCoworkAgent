import { randomUUID } from "node:crypto"
import type { ClawSourceReference } from "../../shared/mods/claw"
import {
  OWNED_MCP_SERVER_PREFIX,
  type McpConnectionStatus,
  type McpConnectionView
} from "../../shared/mods/v2/mcp-connections"
import type { CapabilitySource } from "./capability-service"
import type { McpCapabilityService, McpCapabilityTool, McpConnectAdmission } from "./capability-types"
import { mcpConnectRefusal } from "./capability-types"
import { buildCapabilityAliases } from "./aliasing"
import { createOwnedMcpTransport, type OwnedMcpTransport } from "./owned-transport"
import { normalizeMcpInvocationResult } from "./result-utils"
import { ModError } from "../mods/errors"
import { withRawModMcp, publishCurrentModResult } from "../mods/adapters"
import { getModCallContext } from "../mods/context"
import { authorizeCurrentModInput } from "../mods/manager"
import { beforeModToolExecution } from "../mods/execution-error"

interface Lease {
  status: McpConnectionStatus
  source: CapabilitySource
  controller: AbortController
  transport: OwnedMcpTransport
  tools: McpCapabilityTool[]
  ready: Promise<void>
  waiters: number
  closing?: Promise<void>
}
// Main-process aggregate budget. Unknown cleanup continues occupying its slot.
const liveLeases = new Set<Lease>()

/** One instance belongs to one live Function source in one main-owned session incarnation. */
export class OwnedMcpConnections {
  private readonly leases = new Map<string, Lease>()
  private stopped = false
  private readonly monitor: ReturnType<typeof setInterval>

  constructor(private readonly host: {
    assertCurrent(): void
    assertOwner?(): void
    sources(): ClawSourceReference[]
    resolve(id: string, digest: string): CapabilitySource
    transport?: (source: CapabilitySource) => OwnedMcpTransport
  }) {
    this.monitor = setInterval(() => {
      for (const lease of this.leases.values()) {
        if (!["connecting", "connected"].includes(lease.status.state)) continue
        try { this.assertLease(lease) } catch { void this.closeLease(lease) }
      }
    }, 1_000)
    this.monitor.unref()
  }

  private current(): void {
    if (this.stopped) throw new ModError("MODS_MCP_CONTEXT_EXPIRED")
    this.host.assertOwner?.()
    this.host.assertCurrent()
  }

  private assertLease(lease: Lease): void {
    this.current()
    if (lease.transport.isClosed?.()) {
      void this.closeLease(lease)
      throw new ModError("MODS_MCP_CONTEXT_EXPIRED")
    }
    const selected = this.host.sources().find(item => item.id === lease.status.sourceId &&
      item.digest === lease.status.configDigest)
    if (!selected) throw new ModError("MODS_MCP_SOURCE_CHANGED")
    this.host.resolve(selected.id, selected.digest)
    if (!["connecting", "connected"].includes(lease.status.state))
      throw new ModError("MODS_MCP_CONTEXT_EXPIRED")
  }

  view(): McpConnectionView {
    this.current()
    const sources = this.host.sources().map(item => ({
      sourceId: item.id, name: item.name, configDigest: item.digest
    }))
    return { sources, connections: [...this.leases.values()].map(lease => ({ ...lease.status })) }
  }

  /** Trusted main-process settings projection; never performs an SDK admission or starts a server. */
  inspect(): McpConnectionStatus[] {
    try { this.host.assertOwner?.() } catch { return [] }
    return [...this.leases.values()].map(lease => ({ ...lease.status }))
  }

  status(server: string): McpConnectionStatus {
    this.current()
    const lease = this.require(server)
    if (lease.status.state === "connected" && lease.transport.isClosed?.()) {
      lease.status.state = "closed"
      lease.controller.abort()
      liveLeases.delete(lease)
    }
    if (lease.status.state === "connected") this.assertLease(lease)
    return { ...lease.status, tools: lease.status.state === "connected"
      ? structuredClone(lease.tools.map(tool => ({ name: tool.toolName,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}) }))) : [] }
  }

  private require(server: string): Lease {
    const lease = this.leases.get(server)
    if (!lease) throw new ModError("MODS_MCP_LEASE_NOT_OWNED")
    return lease
  }

  async connect(sourceId: string, signal: AbortSignal): Promise<McpConnectAdmission> {
    this.current()
    signal.throwIfAborted()
    const selected = this.host.sources().find(item => item.id === sourceId)
    if (!selected) return { value: mcpConnectRefusal("unapproved"), assertCurrent: () => this.current() }
    const source = this.host.resolve(selected.id, selected.digest)
    let lease = [...this.leases.values()].find(item => item.status.sourceId === sourceId &&
      ["connecting", "connected", "closing", "unknown"].includes(item.status.state))
    if (lease && ["closing", "unknown"].includes(lease.status.state))
      throw new ModError("MODS_MCP_CLEANUP_UNCONFIRMED")
    if (!lease) {
      const active = [...this.leases.values()].filter(item =>
        !["closed", "failed"].includes(item.status.state))
      if (active.length >= 16 || liveLeases.size >= 64) throw new ModError("MODS_RUNTIME_CAPACITY")
      if (this.leases.size >= 64) {
        const retired = [...this.leases.entries()].find(([, item]) =>
          ["closed", "failed"].includes(item.status.state))
        if (retired) this.leases.delete(retired[0])
      }
      let transport: OwnedMcpTransport
      try { transport = (this.host.transport ?? createOwnedMcpTransport)(source) }
      catch { return { value: mcpConnectRefusal("policy"), assertCurrent: () => this.current() } }
      const server = `${OWNED_MCP_SERVER_PREFIX}${randomUUID()}`
      lease = {
        status: { server, sourceId, configDigest: selected.digest, state: "connecting", toolCount: 0 },
        source, transport, controller: new AbortController(), tools: [],
        ready: Promise.resolve(), waiters: 0
      }
      const candidate = lease
      this.leases.set(server, candidate)
      liveLeases.add(candidate)
      candidate.ready = (async () => {
        try {
          const tools = await transport.initialize(candidate.controller.signal)
          this.assertLease(candidate)
          candidate.tools = buildCapabilityAliases(tools.map(tool => ({
            capabilityId: `${source.providerKey}:${tool.name}`,
            providerKey: source.providerKey, providerDisplayName: source.providerDisplayName,
            toolName: tool.name, description: tool.description, inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema, visibility: "eager", sourceKind: source.kind,
            scope: "global", pluginId: source.pluginId
          }))).map(tool => ({ ...tool, connectionGeneration: server, providerKey: server }))
          candidate.status.toolCount = tools.length
          candidate.status.state = "connected"
        } catch {
          const cancelled = candidate.controller.signal.aborted
          await this.closeLease(candidate)
          if (!cancelled && candidate.status.state === "closed") candidate.status.state = "failed"
          throw new ModError("MODS_MCP_CONNECT_FAILED")
        }
      })()
      void candidate.ready.catch(() => {})
    }
    const admitted = lease
    admitted.waiters++
    let abort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new ModError("MODS_CANCELLED"))
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
    })
    try {
      await Promise.race([admitted.ready, cancelled])
      signal.throwIfAborted()
      this.assertLease(admitted)
      return { value: { isConnected: true, server: admitted.status.server },
        assertCurrent: () => this.assertLease(admitted) }
    } catch (error) {
      if (signal.aborted) throw error
      this.current()
      return { value: mcpConnectRefusal("failed"), assertCurrent: () => this.current() }
    } finally {
      signal.removeEventListener("abort", abort)
      admitted.waiters--
      if (signal.aborted && !admitted.waiters && admitted.status.state === "connecting") {
        await this.closeLease(admitted)
        await admitted.ready.catch(() => {})
      }
    }
  }

  async disconnect(server: string): Promise<McpConnectionStatus> {
    this.current()
    const lease = this.require(server)
    await this.closeLease(lease)
    this.current()
    return { ...lease.status }
  }

  private closeLease(lease: Lease): Promise<void> {
    if (lease.closing) return lease.closing
    lease.status.state = "closing"
    lease.controller.abort()
    lease.closing = lease.transport.close().then(confirmed => {
      lease.status.state = confirmed ? "closed" : "unknown"
      if (confirmed) liveLeases.delete(lease)
    }, () => { lease.status.state = "unknown" })
    return lease.closing
  }

  async close(): Promise<void> {
    this.stopped = true
    clearInterval(this.monitor)
    await Promise.all([...this.leases.values()].map(lease => this.closeLease(lease)))
    if ([...this.leases.values()].some(lease => lease.status.state === "unknown"))
      throw new ModError("MODS_MCP_CLEANUP_UNCONFIRMED")
  }

  service(server: string): McpCapabilityService {
    const lease = this.require(server)
    const current = () => {
      this.assertLease(lease)
      if (lease.status.state !== "connected") throw new ModError("MODS_MCP_NOT_CONNECTED")
    }
    const tools = () => { current(); return lease.tools.map(tool => ({ ...tool })) }
    const getTool = (id: string) => tools().find(tool =>
      tool.capabilityId === id || tool.toolId === id || tool.canonicalToolId === id) ?? null
    return {
      listTools: async () => tools(), peekTools: tools, getTool: async id => getTool(id),
      invoke: async (id, args, assertCurrent) => {
        current()
        const tool = getTool(id)
        if (!tool) throw new ModError("MODS_MCP_TOOL_NOT_FOUND")
        return withRawModMcp(tool, args, async input => {
          await authorizeCurrentModInput(`mcp:${tool.capabilityId}`, input)
          await beforeModToolExecution(() => {
            current(); assertCurrent?.(); getModCallContext()?.assertMcpTool?.(tool)
          })
          const signal = getModCallContext()?.signal
          const raw = await lease.transport.call(tool.toolName, input,
            signal ? AbortSignal.any([signal, lease.controller.signal]) : lease.controller.signal)
          current(); assertCurrent?.()
          const value = await publishCurrentModResult(normalizeMcpInvocationResult(tool.capabilityId, raw))
          current(); assertCurrent?.()
          return value
        })
      },
      // This adapter is borrowed by one command; only the owning registry can close its lease.
      invalidate: async () => {}, close: async () => {}
    }
  }
}
