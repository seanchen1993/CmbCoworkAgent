/** Static installed-package documentation. Never a project plan or execution approval. */
export interface PluginFlowDefinition {
  source: { pluginId: string; name: string; version: string; enabled: boolean }
  status: "ready" | "undeclared" | "invalid"
  format?: "native" | "legacy"
  declarationPath?: string
  declarationDigest?: string
  diagnostics: string[]
  templates: Array<{
    id: string
    title: string
    description: string
    kind: string
    /** Only explicitly declared order; never compiled from plugin code. */
    nodeIds?: string[]
    requiredNodeIds: string[]
  }>
  nodes: Array<{
    id: string
    title: string
    description: string
    skill?: string
    inputs: string[]
    outputs: string[]
    checks: string[]
    approval?: "none" | "human"
    resultApproval?: "none" | "human"
    optional?: { title: string; insertAfter?: string }
  }>
}

export interface PluginFlowDefinitionInput {
  pluginId: string
  expected: { name: string; version: string }
}

export type ReadPluginFlowDefinition = (
  input: PluginFlowDefinitionInput
) => Promise<PluginFlowDefinition>
