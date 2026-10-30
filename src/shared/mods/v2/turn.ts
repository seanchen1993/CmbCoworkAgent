export interface FunctionTurnUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}

export interface FunctionTurnStart {
  text: string
  turnId: string
}

export type FunctionTurnComplete = {
  answer: string
  durationMs: number
  isAborted: boolean
  turnId: string
  agentId?: string
  usage?: FunctionTurnUsage
} & (
  | { reason: "answer" | "aborted" | "error" }
  | { reason: "refusal"; refusal: { category: string | null; explanation: string | null } }
)

export interface FunctionTurnResult {
  text: string
  usage?: FunctionTurnUsage
}

export interface FunctionTurnNotice {
  id: string
  turnId: string
  text: string
  anchorMessageId?: string
}
