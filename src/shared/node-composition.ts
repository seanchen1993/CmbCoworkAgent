import type { PluginDerivationScope } from "./plugin-derivation"
import type {
  HarnessDynamicWorkflowConfig,
  HarnessFeatureCreateInput,
  HarnessFeatureCreateResult,
  HarnessProjectListItem
} from "./harness-board-types"

export interface NativeNodeCatalog {
  project: HarnessProjectListItem
  config: HarnessDynamicWorkflowConfig
  nodes: Array<{
    id: string
    label: string
    description: string
    inputs: string[]
    optionalInputs: string[]
    /** Explicit original-plugin fallback, distinct from an optional input. */
    entryInputs?: Array<{ path: string; guidance: string }>
    outputs: string[]
  }>
}

export interface NativeNodePlan extends NativeNodeCatalog {
  planId: string
  templateId: string
  selected: string[]
  includeOptionalDependencies: boolean
  added: string[]
  ordered: string[]
  optionalOmissions: Array<{ nodeId: string; path: string }>
  entryInputFallbacks: Array<{ nodeId: string; path: string; guidance: string }>
  expiresAt: number
}

export interface NodeCompositionApi {
  compatibility(
    input: PluginDerivationScope & { pluginId: string }
  ): Promise<import("./plugin-compatibility").PluginCompatibilityReport>
  projects(scope: PluginDerivationScope): Promise<HarnessProjectListItem[]>
  catalog(input: PluginDerivationScope & { projectId: string }): Promise<NativeNodeCatalog>
  preview(
    input: PluginDerivationScope & {
      projectId: string
      templateId: string
      selected: string[]
      includeOptionalDependencies?: boolean
    }
  ): Promise<NativeNodePlan>
  create(
    input: PluginDerivationScope & {
      planId: string
      feature: HarnessFeatureCreateInput
      acknowledgeEntryRequirements?: boolean
    }
  ): Promise<HarnessFeatureCreateResult>
}
