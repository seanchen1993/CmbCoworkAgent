export const MODEL_INPUT_SAFETY_BUFFER_TOKENS = 1_000
export const SUMMARIZATION_KEEP_RATIO = 0.1

export function calculateSummarizationKeepTokens(contextWindowTokens: number): number {
  const contextWindow = Math.floor(contextWindowTokens)
  if (contextWindow <= 0) {
    throw new Error("Context window must be positive.")
  }

  return Math.max(1, Math.floor(contextWindow * SUMMARIZATION_KEEP_RATIO))
}

export function calculateMaxCompatibleOutputTokens(contextWindowTokens: number): number {
  const contextWindow = Math.floor(contextWindowTokens)
  const keepTokens = calculateSummarizationKeepTokens(contextWindow)
  const maxOutputTokens = contextWindow - MODEL_INPUT_SAFETY_BUFFER_TOKENS - keepTokens - 1
  if (maxOutputTokens <= 0) {
    throw new Error("Context window is too small to retain context and reserve output space.")
  }
  return maxOutputTokens
}

export function calculateModelInputBudgetTokens(
  contextWindowTokens: number,
  maxOutputTokens: number
): number {
  const contextWindow = Math.floor(contextWindowTokens)
  const outputBudget = Math.floor(maxOutputTokens)
  if (contextWindow <= 0 || outputBudget <= 0) {
    throw new Error("Context window and max output tokens must both be positive.")
  }
  if (outputBudget + MODEL_INPUT_SAFETY_BUFFER_TOKENS >= contextWindow) {
    throw new Error(
      `Invalid model token budget: max output ${outputBudget} must leave more than ${MODEL_INPUT_SAFETY_BUFFER_TOKENS} tokens for input and safety within the ${contextWindow}-token context window.`
    )
  }

  return contextWindow - outputBudget - MODEL_INPUT_SAFETY_BUFFER_TOKENS
}

export function calculateSummarizationTriggerTokens(
  contextWindowTokens: number,
  maxOutputTokens: number
): number {
  const contextWindow = Math.floor(contextWindowTokens)
  const inputBudget = calculateModelInputBudgetTokens(contextWindowTokens, maxOutputTokens)
  const triggerTokens = Math.min(Math.floor(contextWindow * 0.75), inputBudget)
  const keepTokens = calculateSummarizationKeepTokens(contextWindow)

  if (triggerTokens <= keepTokens) {
    throw new Error(
      `Invalid model token budget: compaction trigger ${triggerTokens} must exceed retained context ${keepTokens}. Reduce max output tokens or increase the context window.`
    )
  }

  return triggerTokens
}
