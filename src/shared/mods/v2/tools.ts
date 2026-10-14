import type { ModObject } from "../types"
import type { ModTier } from "./contracts"

export interface FunctionToolInfo {
  name: string
  description: string
  mcp: boolean
}

export interface RegisteredFunctionTool extends FunctionToolInfo {
  plugin: string
  inputSchema: ModObject
  /** Omission uses the official lazy placement default. */
  isDeferred?: boolean
  /** Host identity: a replacement/session restart must be loaded again. */
  registrationId?: string
  tier?: ModTier
}
