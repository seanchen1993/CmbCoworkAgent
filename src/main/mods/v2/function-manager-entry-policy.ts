import type { FunctionModsManager } from "./manager"

type CallableKeys<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never
}[keyof T]
export type FunctionManagerMethod = Extract<CallableKeys<FunctionModsManager>, string>
type MethodArguments<T> = T extends (...args: infer A) => unknown ? A : never
type ScopedMethod = {
  [K in FunctionManagerMethod]: MethodArguments<FunctionModsManager[K]> extends [
    string,
    string,
    ...unknown[]
  ]
    ? K
    : never
}[FunctionManagerMethod]
type CatalogPolicy<K> = K extends "prepareFlowScope"
  ? "direct" | "guard" | "retain-dispose"
  : "direct" | "guard"
type MethodPolicy<K> = {
  operation: K extends "turnComplete"
    ? "terminal"
    : K extends ScopedMethod
      ? "direct" | "retain" | "apply-before"
      : "direct"
  catalog: CatalogPolicy<K>
}
type CompleteEntryPolicy = { [K in FunctionManagerMethod]: MethodPolicy<K> }

/** Every public callable is classified. Direct entries retain their own existing native boundary.
 * These policies describe lifecycle admission, never capability or user-write authorization.
 * Keep operation wrapping inside catalog wrapping; do not turn quiet discovery into execution.
 */
const entryPolicies = {
  projectUseControlStore: { operation: "direct", catalog: "direct" },
  setProjectUseGrantResolver: { operation: "direct", catalog: "direct" },
  projectUseSourceFacts: { operation: "direct", catalog: "direct" },
  configureDevelopmentAccess: { operation: "direct", catalog: "direct" },
  stageDevelopment: { operation: "direct", catalog: "direct" },
  preflightDevelopment: { operation: "direct", catalog: "direct" },
  approveDevelopment: { operation: "direct", catalog: "direct" },
  developmentStatus: { operation: "direct", catalog: "direct" },
  developmentRetention: { operation: "direct", catalog: "direct" },
  stopDevelopment: { operation: "direct", catalog: "direct" },
  noteDevelopmentTurnSettled: { operation: "direct", catalog: "direct" },
  configurationBusy: { operation: "direct", catalog: "direct" },
  selectionRuntimeReady: { operation: "direct", catalog: "direct" },
  onConfigurationIdle: { operation: "direct", catalog: "direct" },
  assertCatalogIdle: { operation: "direct", catalog: "direct" },
  settleEmptyHostSource: { operation: "direct", catalog: "direct" },
  configList: { operation: "retain", catalog: "guard" },
  configSet: { operation: "retain", catalog: "guard" },
  readDirectoryUserConfig: { operation: "direct", catalog: "direct" },
  readRetainedDirectoryUserConfig: { operation: "direct", catalog: "direct" },
  readUserConfigIdentity: { operation: "direct", catalog: "direct" },
  prepareRuntimeSourceFacts: { operation: "direct", catalog: "direct" },
  getRuntimeSourceFacts: { operation: "direct", catalog: "direct" },
  isInstalledRuntimeSourceApproved: { operation: "direct", catalog: "direct" },
  assertRuntimeSourceConfiguration: { operation: "direct", catalog: "direct" },
  runtimeSourceReview: { operation: "direct", catalog: "direct" },
  assertRuntimeSourceReady: { operation: "direct", catalog: "direct" },
  approveRuntimeSource: { operation: "direct", catalog: "direct" },
  captureStageRecoveryConfiguration: { operation: "direct", catalog: "direct" },
  assertStageRecoveryConfiguration: { operation: "direct", catalog: "direct" },
  bindStageRecoveryConfiguration: { operation: "direct", catalog: "direct" },
  stageRecoveryConfigurationMatches: { operation: "direct", catalog: "direct" },
  readUserConfigDirectoryIdentity: { operation: "direct", catalog: "direct" },
  readRuntimePublicConfiguration: { operation: "direct", catalog: "direct" },
  readDirectoryUserConfigSnapshot: { operation: "direct", catalog: "direct" },
  userConfig: { operation: "retain", catalog: "guard" },
  saveUserConfig: { operation: "retain", catalog: "guard" },
  migrateUserConfig: { operation: "retain", catalog: "guard" },
  resetUserConfig: { operation: "direct", catalog: "direct" },
  saveSensitiveUserConfig: { operation: "retain", catalog: "guard" },
  pickUserConfigPath: { operation: "direct", catalog: "guard" },
  applyUserConfig: { operation: "direct", catalog: "guard" },
  forgetReleasedThread: { operation: "direct", catalog: "direct" },
  runtimeSessions: { operation: "direct", catalog: "direct" },
  releaseRuntimeSession: { operation: "direct", catalog: "guard" },
  resumeRuntimeSession: { operation: "direct", catalog: "guard" },
  reloadUserConfig: { operation: "direct", catalog: "guard" },
  completionPolicy: { operation: "direct", catalog: "direct" },
  setCompletionPolicy: { operation: "direct", catalog: "direct" },
  captureWorktreeRemovalObserver: { operation: "direct", catalog: "direct" },
  capturePromptOnlyBoundary: { operation: "direct", catalog: "direct" },
  preparePromptOnlyFlowScope: { operation: "direct", catalog: "direct" },
  runtimeReady: { operation: "retain", catalog: "guard" },
  clawSelection: { operation: "direct", catalog: "direct" },
  clawDefaultModel: { operation: "direct", catalog: "direct" },
  clawSelectionIssues: { operation: "direct", catalog: "direct" },
  effectiveStatus: { operation: "retain", catalog: "guard" },
  status: { operation: "direct", catalog: "guard" },
  creatorPlanningPrompt: { operation: "direct", catalog: "direct" },
  checkCompatibility: { operation: "direct", catalog: "guard" },
  approve: { operation: "direct", catalog: "guard" },
  revoke: { operation: "direct", catalog: "direct" },
  referencesSourceDirectory: { operation: "direct", catalog: "direct" },
  invalidate: { operation: "direct", catalog: "direct" },
  pluginsChanged: { operation: "direct", catalog: "direct" },
  invalidateAll: { operation: "direct", catalog: "direct" },
  appendConversation: { operation: "retain", catalog: "guard" },
  prepareEnd: { operation: "direct", catalog: "direct" },
  reconfigureSelection: { operation: "direct", catalog: "direct" },
  closeThread: { operation: "direct", catalog: "direct" },
  captureThreadRetirement: { operation: "direct", catalog: "direct" },
  closeThreadAndWait: { operation: "direct", catalog: "direct" },
  captureIdleThreadRetirement: { operation: "direct", catalog: "direct" },
  captureStartupModelGuard: { operation: "direct", catalog: "direct" },
  independentModelPrompt: { operation: "direct", catalog: "guard" },
  commands: { operation: "apply-before", catalog: "guard" },
  completionEvidence: { operation: "direct", catalog: "direct" },
  inspectCheckpointRecovery: { operation: "retain", catalog: "guard" },
  advanceAutobizCheckpoint: { operation: "retain", catalog: "guard" },
  interceptTool: { operation: "apply-before", catalog: "guard" },
  offerAgent: { operation: "apply-before", catalog: "guard" },
  registeredAgent: { operation: "direct", catalog: "direct" },
  receivePeer: { operation: "apply-before", catalog: "guard" },
  presentationEvent: { operation: "apply-before", catalog: "guard" },
  classicEvent: { operation: "apply-before", catalog: "guard" },
  turnStart: { operation: "apply-before", catalog: "guard" },
  turnStep: { operation: "apply-before", catalog: "guard" },
  prepareFlowScope: { operation: "apply-before", catalog: "retain-dispose" },
  completionGate: { operation: "retain", catalog: "guard" },
  measure: { operation: "retain", catalog: "guard" },
  turnComplete: { operation: "terminal", catalog: "guard" },
  turnNotices: { operation: "retain", catalog: "guard" },
  registeredTools: { operation: "apply-before", catalog: "guard" },
  interceptToolCheck: { operation: "retain", catalog: "guard" },
  hasToolCheck: { operation: "direct", catalog: "direct" },
  hasEventHandler: { operation: "retain", catalog: "guard" },
  logs: { operation: "retain", catalog: "guard" },
  feedback: { operation: "retain", catalog: "guard" },
  feedbackPresentation: { operation: "retain", catalog: "guard" },
  panes: { operation: "retain", catalog: "guard" },
  placedRows: { operation: "retain", catalog: "direct" },
  placedRead: { operation: "retain", catalog: "direct" },
  placedAct: { operation: "retain", catalog: "direct" },
  placedDismiss: { operation: "retain", catalog: "direct" },
  placedRelease: { operation: "retain", catalog: "direct" },
  placedRevealAck: { operation: "direct", catalog: "direct" },
  clearPlacedRows: { operation: "direct", catalog: "guard" },
  platformCapabilities: { operation: "direct", catalog: "direct" },
  mcpConnections: { operation: "direct", catalog: "direct" },
  mcpDisconnect: { operation: "direct", catalog: "direct" },
  platformSurfaceList: { operation: "direct", catalog: "direct" },
  platformSurfacePrepare: { operation: "direct", catalog: "direct" },
  platformBehaviorList: { operation: "direct", catalog: "direct" },
  platformSurfaceOpen: { operation: "direct", catalog: "direct" },
  platformSurfaceRead: { operation: "direct", catalog: "direct" },
  platformSurfaceAct: { operation: "direct", catalog: "direct" },
  platformSurfaceClose: { operation: "direct", catalog: "direct" },
  platformSurfaceDisable: { operation: "direct", catalog: "direct" },
  platformSurfaceEnable: { operation: "direct", catalog: "direct" },
  platformBehaviorPreview: { operation: "direct", catalog: "direct" },
  platformBehaviorApply: { operation: "direct", catalog: "direct" },
  platformBehaviorDisable: { operation: "direct", catalog: "direct" },
  publishHostFileEdit: { operation: "direct", catalog: "direct" },
  markdownLink: { operation: "retain", catalog: "guard" },
  markdownPreview: { operation: "direct", catalog: "direct" },
  markdownPreviewClose: { operation: "direct", catalog: "direct" },
  focusAck: { operation: "retain", catalog: "guard" },
  scrollAck: { operation: "retain", catalog: "guard" },
  act: { operation: "retain", catalog: "guard" },
  siteMount: { operation: "retain", catalog: "guard" },
  siteRead: { operation: "retain", catalog: "guard" },
  setDisplayProjectionEnabled: { operation: "direct", catalog: "direct" },
  siteMountOutcome: { operation: "retain", catalog: "guard" },
  siteRender: { operation: "retain", catalog: "guard" },
  siteUnmount: { operation: "retain", catalog: "guard" },
  siteAct: { operation: "retain", catalog: "guard" },
  clientAct: { operation: "retain", catalog: "guard" },
  actionCatalog: { operation: "retain", catalog: "guard" },
  verifyReadOnlyContextProvider: { operation: "direct", catalog: "direct" },
  verifyReadOnlyCheckProvider: { operation: "direct", catalog: "direct" },
  prepareAction: { operation: "apply-before", catalog: "guard" },
  runAction: { operation: "apply-before", catalog: "guard" },
  runCommand: { operation: "apply-before", catalog: "guard" },
  close: { operation: "direct", catalog: "direct" }
} as const satisfies CompleteEntryPolicy

for (const policy of Object.values(entryPolicies)) Object.freeze(policy)
export const FUNCTION_MANAGER_ENTRY_POLICIES = Object.freeze(entryPolicies)
const names = Object.keys(FUNCTION_MANAGER_ENTRY_POLICIES) as FunctionManagerMethod[]
export const FUNCTION_MANAGER_OPERATION_METHODS = Object.freeze(
  names.filter((name) => FUNCTION_MANAGER_ENTRY_POLICIES[name].operation !== "direct")
)
export const FUNCTION_MANAGER_CATALOG_METHODS = Object.freeze(
  names.filter((name) => FUNCTION_MANAGER_ENTRY_POLICIES[name].catalog !== "direct")
)
export const FUNCTION_MANAGER_CATALOG_DISPOSE_METHODS = Object.freeze(
  names.filter((name) => FUNCTION_MANAGER_ENTRY_POLICIES[name].catalog === "retain-dispose")
)
