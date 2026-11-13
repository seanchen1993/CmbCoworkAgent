import type { BaseMessage } from "@langchain/core/messages"
import { calculateModelInputBudgetTokens } from "../../../shared/model-token-budget"

export interface ProjectContextBudget {
  contextTokens: number
  outputTokens: number
  inputTokens: number
}
export function projectContextBudget(config: {
  maxTokens?: number
  maxOutputTokens?: number
}): ProjectContextBudget {
  if (!Number.isSafeInteger(config.maxTokens) || !Number.isSafeInteger(config.maxOutputTokens))
    throw new Error("默认模型缺少有效的上下文或最大输出配置，请检查模型设置")
  try {
    return {
      contextTokens: config.maxTokens!,
      outputTokens: config.maxOutputTokens!,
      inputTokens: calculateModelInputBudgetTokens(config.maxTokens!, config.maxOutputTokens!)
    }
  } catch {
    throw new Error("默认模型的最大输出配置没有留出足够的输入空间，请检查模型上下文与输出配置")
  }
}
/** Conservative local estimate for mixed Chinese/JSON, without downloading a tokenizer for intranet models. */
export function estimateProjectTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / 2)
}
export function estimateProjectMessages(messages: BaseMessage[]): number {
  return messages.reduce(
    (total, message) =>
      total +
      16 +
      estimateProjectTokens(
        JSON.stringify({
          content: message.content,
          ...("tool_calls" in message ? { tool_calls: message.tool_calls } : {}),
          ...("tool_call_id" in message ? { tool_call_id: message.tool_call_id } : {})
        })
      ),
    0
  )
}
