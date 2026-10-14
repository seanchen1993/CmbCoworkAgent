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
    outputs: string[]
  }>
}

export interface NativeNodePlan extends NativeNodeCatalog {
  planId: string
  templateId: string
  selected: string[]
  added: string[]
  ordered: string[]
  optionalOmissions: Array<{ nodeId: string; path: string }>
  expiresAt: number
}

export interface NodeCompositionApi {
  projects(scope: PluginDerivationScope): Promise<HarnessProjectListItem[]>
  catalog(input: PluginDerivationScope & { projectId: string }): Promise<NativeNodeCatalog>
  preview(
    input: PluginDerivationScope & {
      projectId: string
      templateId: string
      selected: string[]
    }
  ): Promise<NativeNodePlan>
  create(
    input: PluginDerivationScope & {
      planId: string
      feature: HarnessFeatureCreateInput
    }
  ): Promise<HarnessFeatureCreateResult>
}
