import { AsyncLocalStorage } from "node:async_hooks"
import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import type { Callbacks } from "@langchain/core/callbacks/manager"
import { formatHookDateTime } from "../../shared/hook-time"
import type { SubagentExportTarget } from "../../shared/subagent-session-export"

interface CapturedSession {
  title: string
  createdAt: string
  updatedAt: string
  messages: Map<string, Record<string, unknown>>
  rawApiCall: string
}

const sessions = new Map<string, CapturedSession>()
const context = new AsyncLocalStorage<{ key: string; session: CapturedSession }>()

export function subagentExportKey(target: SubagentExportTarget): string {
  return JSON.stringify(
    target.kind === "multi"
      ? [target.kind, target.threadId, target.subagentId]
      : [target.kind, target.threadId, target.runId, target.agentIndex]
  )
}

function now(): string {
  return formatHookDateTime(Date.now())!
}

function activeSession(): CapturedSession | undefined {
  const scope = context.getStore()
  return scope && sessions.get(scope.key) === scope.session ? scope.session : undefined
}

/** Scope only observation; the callback's value and errors pass through unchanged. */
export function withSubagentSessionCapture<T>(
  target: SubagentExportTarget,
  title: string,
  run: () => T
): T {
  const key = subagentExportKey(target)
  const timestamp = now()
  const session: CapturedSession = {
    title,
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: new Map(),
    rawApiCall: ""
  }
  sessions.delete(key)
  sessions.set(key, session)
  while (sessions.size > 10) {
    const oldest = sessions.keys().next().value!
    const evicted = sessions.get(oldest)!
    evicted.messages.clear()
    evicted.rawApiCall = ""
    sessions.delete(oldest)
  }
  return context.run({ key, session }, run)
}

/** Return true even after eviction: a child request must never enter the parent cache. */
export function captureSubagentRawApiCall(body: BodyInit | null | undefined): boolean {
  if (!context.getStore()) return false
  const session = activeSession()
  if (session) {
    session.rawApiCall = typeof body === "string" ? body : ""
    session.updatedAt = now()
  }
  return true
}

function recordSnapshot(key: string, session: CapturedSession, snapshot: unknown): void {
  if (sessions.get(key) !== session) return
  try {
    const messages = (snapshot as { messages?: unknown } | null)?.messages
    if (!Array.isArray(messages)) return
    for (const value of messages) {
      if (!value || typeof value !== "object") continue
      const type = typeof value._getType === "function" ? value._getType() : value.type
      if (type === "remove") continue
      const message = JSON.parse(
        JSON.stringify({
          id: value.id,
          type,
          content: value.content,
          additional_kwargs: value.additional_kwargs,
          tool_calls: value.tool_calls,
          tool_call_id: value.tool_call_id,
          name: value.name
        })
      ) as Record<string, unknown>
      if (!type || message.content === undefined) continue
      // Graph messages normally have stable IDs. The fallback deduplicates an
      // id-less initial input until LangGraph assigns its ID on the first node.
      const fingerprint = JSON.stringify({ ...message, id: undefined })
      const id = typeof message.id === "string" ? message.id : `input:${fingerprint}`
      if (typeof message.id === "string") session.messages.delete(`input:${fingerprint}`)
      session.messages.set(id, message)
    }
    session.updatedAt = now()
  } catch {
    // Export observation must never fail the agent or change its state.
  }
}

/** Callbacks see original graph messages, before UI projection and compaction. */
export function subagentSessionCallbacks(callbacks?: Callbacks): Callbacks | undefined {
  const scope = context.getStore()
  if (!scope) return callbacks
  class SessionObserver extends BaseCallbackHandler {
    name = "subagent-session-export"
    handleChainStart(_chain: unknown, inputs: Record<string, unknown>): void {
      recordSnapshot(scope!.key, scope!.session, inputs)
    }
    handleChainEnd(outputs: Record<string, unknown>): void {
      recordSnapshot(scope!.key, scope!.session, outputs)
    }
  }
  const observer = new SessionObserver({ raiseError: false, _awaitHandler: true })
  return Array.isArray(callbacks) || !callbacks
    ? [...(callbacks ?? []), observer]
    : callbacks.copy([observer], true)
}

export function getCapturedSubagentSession(target: SubagentExportTarget): {
  title: string
  createdAt: string
  updatedAt: string
  messages: Record<string, unknown>[]
  rawApiCall: string
} | null {
  const session = sessions.get(subagentExportKey(target))
  if (!session) return null
  return { ...session, messages: Array.from(session.messages.values()) }
}
