import { ChatOpenAI } from "@langchain/openai"
import { ReasoningDisplayChatOpenAICompletions } from "../../agent/interleaved-thinking-completions"

/** Preserve provider-visible reasoning for Design's direct model calls. */
export function createDesignModel(
  config: { model: string; apiKey: string; baseUrl: string },
  fetch?: typeof globalThis.fetch
): ChatOpenAI {
  const fields = {
    model: config.model,
    apiKey: config.apiKey,
    configuration: { baseURL: config.baseUrl, fetch },
    maxRetries: 0,
    maxTokens: 8192,
    temperature: 0.7,
    streaming: true
  }
  return new ChatOpenAI({
    ...fields,
    completions: new ReasoningDisplayChatOpenAICompletions(fields)
  } as never)
}
