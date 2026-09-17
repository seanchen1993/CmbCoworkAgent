import type { ModJson, ModObject } from "../types"

/** Frozen Claude Code 2.1.273 public repository projection. */
export interface FunctionSessionRepo {
  root: string
  remote: string | null
  internal: boolean
  name: string | null
}

/** A returned string is not authority; HTTP must resolve a real host-owned handle. */
export type FunctionSessionAuthorization = { handle: string; kind: "bearer" | "api-key" } | null

export type FunctionSessionReadMethod =
  | "session.repo"
  | "session.model"
  | "session.messages"
  | "session.turns"

export interface FunctionSessionToolResult {
  tool_use_id: string
  text: string
  isError: boolean
  result?: ModJson
}

export interface FunctionSessionToolUse {
  tool_use_id: string
  tool: string
  input: ModObject
  result?: ModJson
  text?: string
  isError?: true
}

export interface FunctionSessionMessage {
  role: "user" | "assistant"
  text: string
  toolUses: FunctionSessionToolUse[]
  toolResults?: FunctionSessionToolResult[]
}

export interface FunctionSessionCheckpoint {
  checkpointId: string
  messageCount: number
  messages?: FunctionSessionMessage[]
  turns: number
}
