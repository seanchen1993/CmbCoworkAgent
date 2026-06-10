// Context window limits by model (in tokens).
// These are approximate and may vary by provider deployment.
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "claude-opus-4-5-20251101": 200_000,
  "claude-sonnet-4-5-20250929": 200_000,
  "claude-3-5-sonnet-20241022": 200_000,
  "claude-3-5-haiku-20241022": 200_000,
  "claude-3-opus-20240229": 200_000,
  "claude-3-sonnet-20240229": 200_000,
  "claude-3-haiku-20240307": 200_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-4": 8_192,
  o1: 200_000,
  "o1-mini": 128_000,
  o3: 200_000,
  "o3-mini": 200_000,
  "gemini-3-pro-preview": 2_000_000,
  "gemini-3-flash-preview": 1_000_000,
  "gemini-2.5-pro": 2_000_000,
  "gemini-2.5-flash": 1_000_000,
  "gemini-2.5-flash-lite": 1_000_000,
  "gemini-2.0-flash": 1_000_000,
  "gemini-1.5-pro": 2_000_000,
  "gemini-1.5-flash": 1_000_000
}

const DEFAULT_CONTEXT_LIMIT = 128_000

export function getContextLimit(modelId: string): number {
  if (MODEL_CONTEXT_LIMITS[modelId]) {
    return MODEL_CONTEXT_LIMITS[modelId]
  }

  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (modelId.startsWith(key)) {
      return limit
    }
  }

  if (modelId.includes("claude")) return 200_000
  if (modelId.includes("gpt-4o") || modelId.includes("o1") || modelId.includes("o3")) {
    return 128_000
  }
  if (modelId.includes("gemini")) return 1_000_000

  return DEFAULT_CONTEXT_LIMIT
}
