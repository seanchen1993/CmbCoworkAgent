/** Shared model defaults for desktop and independent Bot Host. */
export const DEFAULT_MAX_TOKENS = 128_000
export const MIN_MAX_TOKENS = 32_000
export const MAX_MAX_TOKENS = 1_000_000
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192
export const MIN_MAX_OUTPUT_TOKENS = 1
export const MAX_MAX_OUTPUT_TOKENS = 100_000
export const DEFAULT_TEMPERATURE = 0.1
export const MIN_TEMPERATURE = 0
export const MAX_TEMPERATURE = 2
export const DEFAULT_TOP_P = 0.95
export const MIN_TOP_P = 0
export const MAX_TOP_P = 1
export const DEFAULT_TOP_K = 40
export const MIN_TOP_K = 0
export const MAX_TOP_K = 1_000
export type ThinkingEffort = "low" | "high" | "max"
export const DEFAULT_THINKING_EFFORT: ThinkingEffort = "high"
