import { BotDomainError } from "../../shared/bot-types"
import { calculateModelInputBudgetTokens } from "../../shared/model-token-budget"
import { DEFAULT_MAX_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS } from "../models/defaults"

/** Helpers have no provider tokenizer. A UTF-8 byte ceiling is deliberately
 * conservative (including Chinese/emoji), and does not download vocabularies or
 * present an estimate as provider usage. Keep the normal Cmb output/safety reserve.
 */
export function memoryInputByteLimit(config: { maxTokens?: number; maxOutputTokens?: number }) {
  const context = config.maxTokens ?? DEFAULT_MAX_TOKENS
  const output = memoryOutputLimit(config)
  if (!Number.isSafeInteger(context) || context <= 0)
    throw new BotDomainError("memory_context_limit", "记忆整理的模型上下文配置无效")
  try {
    return calculateModelInputBudgetTokens(context, output)
  } catch {
    throw new BotDomainError("memory_context_limit", "记忆整理的模型上下文不足，请调整模型配置")
  }
}

export function memoryOutputLimit(config: { maxOutputTokens?: number }) {
  const output = config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  if (!Number.isSafeInteger(output) || output <= 0)
    throw new BotDomainError("memory_context_limit", "记忆整理的模型输出配置无效")
  return Math.min(output, 8192)
}

export function memoryRequestFits(system: string, data: unknown, limit: number): boolean {
  // Chat message framing is also covered by the shared 1000-token safety reserve.
  return (
    Buffer.byteLength(system, "utf8") + Buffer.byteLength(JSON.stringify(data), "utf8") <= limit
  )
}

export function memoryContextLimitError() {
  return new BotDomainError(
    "memory_context_limit",
    "待整理内容超出模型上下文，请配置更大上下文的模型后重试"
  )
}
