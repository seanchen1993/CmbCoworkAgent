export type FunctionPeerStatus = "queued" | "processing" | "delivered" | "uncertain" | "interrupted"

/** An explicit peer record, never a user turn or an authorization grant. */
export interface FunctionPeerRecord {
  id: string
  workspace: string
  sessionId: string
  agentId: string
  runId: string
  fromSessionId: string
  fromAgentId: string
  plugin: string
  origin: "peer" | "coordinator"
  text: string
  status: FunctionPeerStatus
  createdAt: number
  updatedAt: number
}

export interface FunctionPeerInput {
  origin: { kind: "peer" | "coordinator"; plugin: string }
  text: string
  agentId?: string
}

export interface FunctionPeerSend {
  to: string | { sessionId: string } | { agentId: string }
  text: string
}

export const FUNCTION_PEER_CONTEXT_LIMIT = 256 * 1024

/** Exactly the data embedded in model context, including delimiter-safe JSON escaping. */
export function encodeFunctionPeerContextRecord(record: FunctionPeerRecord): string {
  return JSON.stringify({
    id: record.id,
    fromSessionId: record.fromSessionId,
    fromAgentId: record.fromAgentId,
    plugin: record.plugin,
    text: record.text
  }).replace(
    /[<>&]/g,
    (character) => ({ "<": "\\u003c", ">": "\\u003e", "&": "\\u0026" })[character]!
  )
}
