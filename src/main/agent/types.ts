// @ts-ignore this is a workaround to avoid type errors in the main process
import type { createAgentRuntime } from "./runtime"

// DeepAgent type: represents the fully initialized agent runtime instance
export type DeepAgent = Awaited<ReturnType<typeof createAgentRuntime>>
