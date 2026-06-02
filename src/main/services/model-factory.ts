import { ChatOpenAI } from "@langchain/openai"
import { getCustomModelConfigs } from "../storage"

export function createInternalChatModel(
  modelId: string | undefined,
  options?: { timeoutMs?: number; maxOutputTokens?: number }
): ChatOpenAI | null {
  const configs = getCustomModelConfigs()
  if (configs.length === 0) return null

  const config = modelId
    ? (configs.find((item) => item.id === modelId || item.model === modelId) ?? configs[0])
    : configs[0]

  if (!config.apiKey) return null

  return new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey,
    maxRetries: 0,
    timeout: options?.timeoutMs,
    maxTokens: options?.maxOutputTokens ?? config.maxOutputTokens,
    temperature: config.temperature,
    topP: config.topP,
    modelKwargs: {
      ...(config.topK && config.topK > 0 ? { top_k: config.topK } : {})
    },
    configuration: { baseURL: config.baseUrl }
  })
}
