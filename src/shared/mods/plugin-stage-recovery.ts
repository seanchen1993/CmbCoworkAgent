export interface PluginStageRecoveryScope {
  workspace: string
  threadId: string
  incarnation: { token: string | null; legacyCreatedAt: number }
}

/** A plugin-owned recovery request. A declaration never grants command execution. */
export interface PluginStageRecoveryRequest {
  scope: PluginStageRecoveryScope
  trialId: string
  stageId: string
  stateMode: "target_in_progress" | "previous_done"
  expectedPackageDigest: string
  expectedAdapterDigest: string
  expectedInputsDigest: string
  allowNetworkSideEffects: true
}

export interface PluginStageRecoveryInspection {
  sourceId: string
  packageDigest: string
  adapterDigest: string
  inputsDigest: string
  featureId: string
  stages?: { id: string; title: string }[]
  requiresNetworkApproval: true
}

export interface PluginStageRecoveryPreparation {
  id: string
  digest: string
  sourceId: string
  stageId: string
  stateMode: PluginStageRecoveryRequest["stateMode"]
  phase: "needs-confirmation" | "applying" | "verified" | "adopted" | "failed" | "unknown"
  summary: string
  affectedArtifacts: string[]
  diagnostics: string[]
  canApply: boolean
  canReconcile?: boolean
  requiresNetworkApproval: true
  recoveredTrialId?: string
  recoveredProjectId?: string
}

/** Renderer requests identify an existing creator conversation. Main must derive the actual
 * workspace/incarnation from its live DevelopmentContext; never trust a renderer-supplied scope.
 */
export interface PluginStageRecoveryCaller {
  threadId: string
  expectedWorkspace: string
}
export interface PluginStageRecoveryApi {
  inspect(
    input: PluginStageRecoveryCaller & { trialId: string }
  ): Promise<PluginStageRecoveryInspection>
  latest(
    input: PluginStageRecoveryCaller & { trialId: string }
  ): Promise<PluginStageRecoveryPreparation | undefined>
  prepare(
    input: PluginStageRecoveryCaller & Omit<PluginStageRecoveryRequest, "scope">
  ): Promise<PluginStageRecoveryPreparation>
  apply(
    input: PluginStageRecoveryCaller & {
      preparationId: string
      expectedDigest: string
      allowNetworkSideEffects: true
    }
  ): Promise<{ trialId: string; projectId: string; preparation: PluginStageRecoveryPreparation }>
  reconcile(
    input: PluginStageRecoveryCaller & {
      preparationId: string
      expectedDigest: string
      allowNetworkSideEffects?: true
    }
  ): Promise<PluginStageRecoveryPreparation>
}
