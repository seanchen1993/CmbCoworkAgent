import { AsyncLocalStorage } from "node:async_hooks"
import type { ModIdentity } from "../../shared/mods/types"
import type { McpCapabilityTool } from "../mcp/capability-types"
import type { ModRuntimeAuthority } from "./runtime-instance"

export interface ModCallContext {
  identity: ModIdentity
  runtimeAuthority?: ModRuntimeAuthority
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
  permissionReason?: string
  assertLive?: () => void
  assertMcpTool?: (tool: McpCapabilityTool) => void
  policyDigest?: string
  publish?: <T>(value: T, stage: "before-observers" | "final") => Promise<T>
  protectData?: <T>(value: T) => T
}

export const modCallContext = new AsyncLocalStorage<ModCallContext>()

export function getModCallContext(): ModCallContext | undefined {
  return modCallContext.getStore()
}

export function modPermissionReason(reason?: string): string | undefined {
  const permission = getModCallContext()?.permissionReason
  return permission ? [permission, reason].filter(Boolean).join("\n") : reason
}
