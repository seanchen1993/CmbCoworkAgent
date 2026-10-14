import { randomUUID } from "node:crypto"
import path from "node:path"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type {
  FunctionPeerInput,
  FunctionPeerRecord,
  FunctionPeerSend
} from "../../../shared/mods/v2/peer"
import {
  encodeFunctionPeerContextRecord,
  FUNCTION_PEER_CONTEXT_LIMIT
} from "../../../shared/mods/v2/peer"
import type { FunctionPeerLedger } from "./peer-ledger"

const CAPACITY = 64
const TEXT_LIMIT = 32 * 1024
const QUEUE_LIMIT = 256 * 1024
const fail = (code: string) => new ModFunctionError(code)

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason ?? fail("MODS_CANCELLED"))
    signal.addEventListener("abort", cancel, { once: true })
    if (signal.aborted) cancel()
  })
  try {
    return await Promise.race([promise, cancelled])
  } finally {
    signal.removeEventListener("abort", cancel)
  }
}

interface PeerScope {
  workspace: string
  sessionId: string
  agentId: string
  signal?: AbortSignal
  assertLive(): void
}

export interface FunctionPeerSender extends PeerScope {
  plugin: string
  publish(text: string, signal: AbortSignal): Promise<string>
}

export interface FunctionPeerEndpoint extends PeerScope {
  receive(
    input: FunctionPeerInput,
    commit: (input: FunctionPeerInput) => Promise<{ text: string }>,
    signal: AbortSignal
  ): Promise<unknown>
}

export interface FunctionPeerConsumer {
  claim(): FunctionPeerRecord[]
  settle(ids: readonly string[], status: "delivered" | "uncertain"): void
  close(): void
}

interface Entry {
  scope: FunctionPeerEndpoint
  controller: AbortController
  runId: string
  records: Map<string, FunctionPeerRecord>
  reservations: number
  bytes: number
  consumer: FunctionPeerConsumer
}

function textBytes(text: unknown): number {
  if (typeof text !== "string" || !text.trim()) throw fail("MODS_PEER_TEXT")
  const bytes = Buffer.byteLength(text)
  if (bytes > TEXT_LIMIT) throw fail("MODS_PEER_TEXT_LIMIT")
  return bytes
}

function workspaceKey(workspace: string): string {
  const result = path.resolve(workspace)
  return process.platform === "win32" ? result.toLowerCase() : result
}

function key(scope: Pick<PeerScope, "workspace" | "sessionId" | "agentId">): string {
  return JSON.stringify([workspaceKey(scope.workspace), scope.sessionId, scope.agentId])
}

/** Only host-created physical endpoints can receive. Nothing here wakes or creates a user task. */
export class FunctionPeerInbox {
  private readonly endpoints = new Map<string, Entry>()
  private readonly aliases = new Map<string, Entry>()

  alias(
    logical: Pick<PeerScope, "workspace" | "sessionId" | "agentId">,
    physical: Pick<PeerScope, "workspace" | "sessionId" | "agentId">
  ): () => void {
    const entry = this.endpoints.get(key(physical))
    if (!entry || entry.controller.signal.aborted) throw fail("MODS_PEER_STALE_ENDPOINT")
    const identity = key(logical)
    if (this.endpoints.has(identity) || this.aliases.has(identity))
      throw fail("MODS_PEER_AMBIGUOUS_TARGET")
    this.aliases.set(identity, entry)
    return () => {
      if (this.aliases.get(identity) === entry) this.aliases.delete(identity)
    }
  }

  private lookup(identity: string): Entry | undefined {
    return this.endpoints.get(identity) ?? this.aliases.get(identity)
  }

  constructor(
    private readonly ledger: FunctionPeerLedger,
    private readonly onChange: (workspace: string, sessionId: string) => void = () => {}
  ) {}

  private changed(scope: PeerScope): void {
    try {
      this.onChange(scope.workspace, scope.sessionId)
    } catch {
      /* UI failure cannot undo delivery. */
    }
  }

  register(scope: FunctionPeerEndpoint): FunctionPeerConsumer {
    scope.signal?.throwIfAborted()
    scope.assertLive()
    const identity = key(scope)
    this.endpoints.get(identity)?.consumer.close()
    if (this.endpoints.size >= 100) throw fail("MODS_PEER_ENDPOINT_LIMIT")
    const controller = new AbortController()
    const assertLive = () => {
      controller.signal.throwIfAborted()
      scope.signal?.throwIfAborted()
      scope.assertLive()
      if (this.endpoints.get(identity) !== entry) throw fail("MODS_PEER_STALE_ENDPOINT")
    }
    const consumer: FunctionPeerConsumer = {
      claim: () => {
        assertLive()
        const queued: FunctionPeerRecord[] = []
        let bytes = 512 // Wrapper and JSON array delimiters.
        for (const item of entry.records.values()) {
          if (item.status !== "queued") continue
          const size = Buffer.byteLength(encodeFunctionPeerContextRecord(item)) + 1
          if (bytes + size > FUNCTION_PEER_CONTEXT_LIMIT) break
          bytes += size
          queued.push(item)
        }
        this.ledger.transition(
          queued.map((item) => item.id),
          "queued",
          "processing"
        )
        for (const item of queued) item.status = "processing"
        for (const sessionId of new Set(queued.map((item) => item.sessionId)))
          this.changed({ ...scope, sessionId })
        return queued.map((item) => ({ ...item }))
      },
      settle: (ids, status) => {
        const claimed = ids.map((id) => entry.records.get(id))
        if (claimed.some((record) => !record || record.status !== "processing"))
          throw fail("MODS_PEER_RECEIPT_CONFLICT")
        // Remove before persistence so an acknowledgment error can never replay model work.
        for (const record of claimed) {
          entry.records.delete(record!.id)
          entry.bytes -= Buffer.byteLength(record!.text)
        }
        try {
          this.ledger.transition(ids, "processing", status)
        } catch (error) {
          try {
            this.ledger.transition(ids, "processing", "uncertain")
          } catch {
            /* Startup recovery remains interrupted. */
          }
          throw error
        } finally {
          for (const sessionId of new Set(claimed.map((item) => item!.sessionId)))
            this.changed({ ...scope, sessionId })
        }
      },
      close: () => {
        if (controller.signal.aborted) return
        controller.abort(fail("MODS_PEER_STALE_ENDPOINT"))
        scope.signal?.removeEventListener("abort", consumer.close)
        if (this.endpoints.get(identity) === entry) this.endpoints.delete(identity)
        for (const [alias, target] of this.aliases) if (target === entry) this.aliases.delete(alias)
        const queued = [...entry.records.values()].filter((item) => item.status === "queued")
        // Claimed messages are settled by the in-flight model call; never put them back.
        try {
          this.ledger.transition(
            queued.map((item) => item.id),
            "queued",
            "interrupted"
          )
        } finally {
          for (const item of queued) entry.records.delete(item.id)
          for (const sessionId of new Set(queued.map((item) => item.sessionId)))
            this.changed({ ...scope, sessionId })
        }
      }
    }
    const entry: Entry = {
      scope,
      controller,
      runId: randomUUID(),
      records: new Map(),
      reservations: 0,
      bytes: 0,
      consumer
    }
    this.endpoints.set(identity, entry)
    scope.signal?.addEventListener("abort", consumer.close, { once: true })
    return consumer
  }

  async send(
    input: FunctionPeerSend,
    sender: FunctionPeerSender
  ): Promise<{ isDelivered: true } | { isDelivered: false; reason: string }> {
    textBytes(input.text)
    sender.signal?.throwIfAborted()
    sender.assertLive()
    let sessionId: string
    let agentId: string
    if (typeof input.to === "string") {
      if (input.to.startsWith("session:")) {
        sessionId = input.to.slice(8)
        agentId = "main"
      } else if (input.to.startsWith("agent:")) {
        sessionId = sender.sessionId
        agentId = input.to.slice(6)
      } else {
        const agent = !!this.lookup(key({ ...sender, agentId: input.to }))
        const session = !!this.lookup(key({ ...sender, sessionId: input.to, agentId: "main" }))
        if (agent && session) throw fail("MODS_PEER_AMBIGUOUS_TARGET")
        sessionId = agent ? sender.sessionId : input.to
        agentId = agent ? input.to : "main"
      }
    } else if (
      input.to &&
      typeof input.to === "object" &&
      Object.keys(input.to).length === 1 &&
      "sessionId" in input.to
    ) {
      sessionId = input.to.sessionId
      agentId = "main"
    } else if (
      input.to &&
      typeof input.to === "object" &&
      Object.keys(input.to).length === 1 &&
      "agentId" in input.to
    ) {
      sessionId = sender.sessionId
      agentId = input.to.agentId
    } else throw fail("MODS_PEER_TARGET")
    if (typeof sessionId !== "string" || !sessionId || typeof agentId !== "string" || !agentId)
      throw fail("MODS_PEER_TARGET")
    const identity = key({ ...sender, sessionId, agentId })
    const entry = this.lookup(identity)
    if (!entry) return { isDelivered: false, reason: "Target has no live run in this workspace" }
    if (
      entry.records.size + entry.reservations >= CAPACITY ||
      entry.bytes + TEXT_LIMIT > QUEUE_LIMIT
    )
      return { isDelivered: false, reason: "Target inbox is full" }
    entry.reservations++
    // Each asynchronous reservation charges the maximum rewritten text size.
    entry.bytes += TEXT_LIMIT
    const signal = AbortSignal.any([
      entry.controller.signal,
      ...(sender.signal ? [sender.signal] : [])
    ])
    const assertLive = () => {
      signal.throwIfAborted()
      sender.assertLive()
      entry.scope.assertLive()
      if (this.lookup(identity) !== entry) throw fail("MODS_PEER_STALE_ENDPOINT")
    }
    let committed = false
    let committing = false
    let open = true
    const origin = Object.freeze({
      kind:
        sender.sessionId === sessionId && sender.agentId === "main" && agentId !== "main"
          ? ("coordinator" as const)
          : ("peer" as const),
      plugin: sender.plugin
    })
    const expectedOrigin = JSON.stringify(origin)
    try {
      assertLive()
      const published = await abortable(sender.publish(input.text, signal), signal)
      assertLive()
      textBytes(published)
      const received: FunctionPeerInput = Object.freeze({
        origin,
        text: published,
        ...(agentId === "main" ? {} : { agentId })
      })
      await abortable(
        entry.scope.receive(
          received,
          async (rewritten) => {
            if (!open || committed || committing) throw fail("MODS_PEER_DUPLICATE_COMMIT")
            committing = true
            try {
              assertLive()
              if (
                !rewritten ||
                JSON.stringify(rewritten.origin) !== expectedOrigin ||
                rewritten.agentId !== received.agentId ||
                Object.keys(rewritten).some((name) => !["origin", "text", "agentId"].includes(name))
              )
                throw fail("MODS_PEER_PINNED_INPUT")
              textBytes(rewritten.text)
              const text = await abortable(sender.publish(rewritten.text, signal), signal)
              assertLive()
              if (!open) throw fail("MODS_PEER_STALE_DELIVERY")
              const bytes = textBytes(text)
              const now = Date.now()
              const record: FunctionPeerRecord = {
                id: randomUUID(),
                workspace: entry.scope.workspace,
                sessionId,
                agentId,
                runId: entry.runId,
                fromSessionId: sender.sessionId,
                fromAgentId: sender.agentId,
                plugin: sender.plugin,
                origin: origin.kind,
                text,
                status: "queued",
                createdAt: now,
                updatedAt: now
              }
              if (
                Buffer.byteLength(encodeFunctionPeerContextRecord(record)) + 512 >
                FUNCTION_PEER_CONTEXT_LIMIT
              )
                throw fail("MODS_PEER_CONTEXT_LIMIT")
              this.ledger.insert(record)
              entry.records.set(record.id, record)
              entry.bytes += bytes
              committed = true
              this.changed({ ...entry.scope, sessionId })
              return { text }
            } finally {
              committing = false
            }
          },
          signal
        ),
        signal
      )
      if (!committed) assertLive()
      return committed
        ? { isDelivered: true }
        : { isDelivered: false, reason: "Consumed by receiver" }
    } catch (error) {
      // A post-next hook error cannot retract an already committed, observable delivery.
      if (committed) return { isDelivered: true }
      throw error
    } finally {
      open = false
      entry.reservations--
      entry.bytes -= TEXT_LIMIT
    }
  }

  list(workspace: string, sessionId: string): FunctionPeerRecord[] {
    return this.ledger.list(workspace, sessionId)
  }

  close(workspace?: string, sessionId?: string): void {
    for (const entry of [...this.endpoints.values()])
      if (
        (!workspace || workspaceKey(entry.scope.workspace) === workspaceKey(workspace)) &&
        (!sessionId || entry.scope.sessionId === sessionId)
      )
        entry.consumer.close()
  }
}
