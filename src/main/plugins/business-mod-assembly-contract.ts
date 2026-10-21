import type {
  BusinessModDefinition,
  BusinessModExtensionDefinition,
  BusinessModKernel
} from "../../shared/business-mods"
import type { DerivationFile, DerivationSnapshot } from "./derivation-source"
import {
  CONTEXT_HANDOFF_PROTOCOL,
  EXTENSION_CONTRACT_API_VERSION,
  REQUIRED_BUSINESS_CHECKS_PROTOCOL,
  type ExtensionContract
} from "../../shared/project-runtime"

export interface BusinessModAdapterContext {
  kernel: BusinessModKernel
  snapshot: DerivationSnapshot
  modules: BusinessModDefinition[]
  files: readonly DerivationFile[]
  skillSearchRoots: string[]
  name: string
  version: string
  contextProvider?: BusinessModExtensionDefinition["contextProvider"]
  verifiedArtifactIds?: string[]
}

export interface BusinessModAdapterProjection {
  runtime: unknown
  generated: Array<{ path: string; value: unknown }>
  requiredHooks?: string[]
  diagnostics: string[]
  missingProviders: string[]
  requiresFixedWorkflowAcknowledgement: boolean
  portability: { metadata?: Record<string, unknown>; compatibility: string }
}

export interface BusinessModAssemblyAdapter {
  readonly id: "autobiz-v1" | "host-linear-v1"
  readonly mode: "host" | "legacy"
  readonly stateOwner: "host" | "plugin"
  assertKernel(kernel: BusinessModKernel): void
  /** An owned reviewed identity cannot be relabeled for another static adapter. */
  ownsKernelIdentity?(kernel: BusinessModKernel): boolean
  /** Adapter-owned derived files must never be copied as opaque kernel resources. */
  reservedPaths(kernel: BusinessModKernel): string[]
  /** Returns only adapter-owned source paths whose lossless static projection was checked. */
  assertModularizationSource?(
    context: Pick<BusinessModAdapterContext, "kernel" | "snapshot" | "modules">
  ): string[]
  project(context: BusinessModAdapterContext): BusinessModAdapterProjection
}

/** Context negotiations are shared; resolving data or granting access remains native. */
export function businessModExtensionContract(
  provider: BusinessModAdapterContext["contextProvider"]
): ExtensionContract {
  return {
    apiVersion: EXTENSION_CONTRACT_API_VERSION,
    requires: [REQUIRED_BUSINESS_CHECKS_PROTOCOL, ...(provider ? [CONTEXT_HANDOFF_PROTOCOL] : [])],
    ...(provider
      ? {
          context: {
            sourceAccess: "read-only",
            mutableData: "host",
            configuration: "host-resolved",
            knowledge: {
              required: provider.required,
              ...(provider.knowledgeBinding ? { binding: provider.knowledgeBinding } : {})
            },
            provider: { entry: provider.entry, operations: provider.operations }
          }
        }
      : {})
  }
}
