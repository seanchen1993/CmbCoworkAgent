import { AsyncLocalStorage } from "node:async_hooks"
import type { ModIdentity } from "../../shared/mods/types"

export interface ModCallContext {
  identity: ModIdentity
  toolId: string
  signal?: AbortSignal
  originMod?: string
  effectiveArgs?: Record<string, unknown>
  routeClaimed: boolean
  protectedOutput: boolean
  readOnly: boolean
  authorize?: (toolId: string, args: Record<string, unknown>) => Promise<void>
  approvalFingerprint?: string
  authorizedInput?: string
  userInitiated?: boolean
  mcpPermitConsumed?: boolean
  approvedOperation?: { toolId: string; args: Record<string, unknown> }
  assertLive?: () => void
  policyDigest?: string
  publish?: <T>(value: T, stage: "before-observers" | "final") => Promise<T>
  protectData?: <T>(value: T) => T
}

export const modCallContext = new AsyncLocalStorage<ModCallContext>()

export function getModCallContext(): ModCallContext | undefined {
  return modCallContext.getStore()
}
