import type { ModJson, ModObject } from "../types"

/** Claude Code v2.1.278 public repository projection, with adapted host limits. */
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
  | "session.usage"

export interface FunctionSessionUsageArgs {
  breakdown?: "summary" | "full"
  columns?: number
}

export type FunctionSessionContextCategoryKind = "used" | "free" | "buffer" | "deferred"

export type FunctionSessionContextCategory = ModObject & {
  name: string
  tokens: number
  color: string
  isDeferred: boolean
  kind: FunctionSessionContextCategoryKind
  /** LangChain and JSON token counts are estimates, never provider billing data. */
  estimated: boolean
}

export type FunctionSessionContextGridSquare = ModObject & {
  color: string
  isFilled: boolean
  categoryName: string
  tokens: number
  percentage: number
  squareFullness: number
}

export type FunctionSessionApiUsage = ModObject & {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

export type FunctionSessionMessageBreakdown = ModObject & {
  toolCallTokens: number
  toolResultTokens: number
  attachmentTokens: number
  assistantMessageTokens: number
  userMessageTokens: number
  redirectedContextTokens: number
  unattributedTokens: number
  toolCallsByType: Array<{ name: string; callTokens: number; resultTokens: number }>
  attachmentsByType: Array<{ name: string; tokens: number }>
}

export type FunctionSessionContextBreakdown = ModObject & {
  categories: FunctionSessionContextCategory[]
  totalTokens: number
  maxTokens: number
  rawMaxTokens: number
  autocompactSource: "auto"
  percentage: number
  gridRows: FunctionSessionContextGridSquare[][]
  model: string
  messageBreakdown: FunctionSessionMessageBreakdown
  apiUsage: FunctionSessionApiUsage | null
  /** True when any context category uses the local estimator. */
  estimated: boolean
}

export interface FunctionSessionUsage {
  context: {
    window: number
    tokens?: number
    percent?: number
    breakdown?: FunctionSessionContextBreakdown
  }
  rateLimits: Array<{ kind: string; percentUsed: number; resetsAt?: string }>
  cost?: { usd: number }
}

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
  turns?: number
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
  }
}
