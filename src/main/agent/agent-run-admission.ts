import type { AgentRunExecutionContext, AgentRunRequest } from "./agent-run-service"
import {
  assertCurrentRuntimePluginSourceContent,
  withRuntimePluginSource
} from "../plugins/runtime-source-scope"

export interface AgentRunAdmission {
  context: AgentRunExecutionContext
  /** Called after the entire original run body settles, including cleanup. */
  settle(): void | Promise<void>
}
type AdmissionProvider = (
  request: AgentRunRequest,
  context: AgentRunExecutionContext
) => Promise<AgentRunAdmission | undefined>
let provider: AdmissionProvider | undefined
let internalComposition: AdmissionProvider | undefined
let projectCapabilities: AdmissionProvider | undefined

export function registerInternalCompositionRunAdmission(next: AdmissionProvider): () => void {
  if (internalComposition && internalComposition !== next)
    throw Error("COMPOSITION_ADMISSION_ALREADY_REGISTERED")
  internalComposition = next
  return () => {
    if (internalComposition === next) internalComposition = undefined
  }
}

export function registerProjectCapabilityRunAdmission(next: AdmissionProvider): () => void {
  if (projectCapabilities && projectCapabilities !== next)
    throw Error("PROJECT_CAPABILITY_ADMISSION_ALREADY_REGISTERED")
  projectCapabilities = next
  return () => {
    if (projectCapabilities === next) projectCapabilities = undefined
  }
}

/** One application-owned adapter. Unregistered/default paths preserve the original behavior. */
export function registerAgentRunAdmission(next: AdmissionProvider): () => void {
  if (provider && provider !== next) throw Error("AGENT_RUN_ADMISSION_ALREADY_REGISTERED")
  provider = next
  return () => {
    if (provider === next) provider = undefined
  }
}
export async function prepareAgentRunAdmission(
  request: AgentRunRequest,
  context: AgentRunExecutionContext
) {
  // Host-only internal registration verifies the owning durable composition before issuing a token.
  const internal = await internalComposition?.(request, context)
  if (internal) return internal
  const original = await provider?.(request, context)
  try {
    const selected = await projectCapabilities?.(request, original?.context ?? context)
    if (!selected) return original
    const reportUnknown = (code: string, error: unknown) => {
      const terminal = { outcome: "unknown" as const, code, error }
      original?.context.onRunTerminated?.(terminal)
      if (selected.context.onRunTerminated !== original?.context.onRunTerminated)
        selected.context.onRunTerminated?.(terminal)
    }
    const finalize = async (workflowFailure?: unknown) => {
      if (workflowFailure)
        reportUnknown("project_capability_workflow_cleanup_unconfirmed", workflowFailure)
      try {
        await selected.settle()
        // Always close first. Even a child that handled a revoked IO error cannot
        // publish a success against a changed final source/knowledge/configuration.
        if (selected.context.pluginSourceSnapshot)
          withRuntimePluginSource(
            selected.context.pluginSourceSnapshot,
            assertCurrentRuntimePluginSourceContent
          )
      } catch (error) {
        // Cleanup uncertainty outranks an earlier success callback in the original ledger.
        // Reuse its terminal channel rather than allowing the finally block to bless success.
        reportUnknown("project_capability_cleanup_unconfirmed", error)
        throw error
      } finally {
        await original?.settle()
      }
    }
    return {
      context: selected.context,
      settle: async () => {
        const token = selected.context.pluginSourceSnapshot
        if (token) {
          const { deferOwnedRuntimeWorkflowSettlement } = await import("./workflow/run-manager")
          // The final selected source, not its superseded parent token, owns the
          // real background entries. Keep both original resource owners until then.
          const owned = deferOwnedRuntimeWorkflowSettlement(token, finalize)
          if (owned.deferred) return
          await finalize(owned.failure)
          return
        }
        await finalize()
      }
    }
  } catch (error) {
    await original?.settle()
    throw error
  }
}
