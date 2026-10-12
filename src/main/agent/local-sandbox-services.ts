/** Host ports for the shared executor. All imports below are type-only.
 * Desktop injects its existing authorization/hook/telemetry services; headless
 * hosts must explicitly provide supported services or reject their use.
 */
export interface LocalSandboxServices {
  attachModBackend?: typeof import("../mods/adapters")["attachModBackend"]
  protectCurrentModData?: typeof import("../mods/adapters")["protectCurrentModData"]
  publishCurrentModResult?: typeof import("../mods/adapters")["publishCurrentModResult"]
  authorizeCurrentModInput?: typeof import("../mods/manager")["authorizeCurrentModInput"]
  getModCallContext?: typeof import("../mods/context")["getModCallContext"]
  currentFunctionExecution?: typeof import("../mods/v2/execution-context")["currentFunctionExecution"]
  areElevatedRootsPreparedAsync: typeof import("../ipc/sandbox")["areElevatedRootsPreparedAsync"]
  isElevatedSetupComplete: typeof import("../ipc/sandbox")["isElevatedSetupComplete"]
  markElevatedRootsPrepared: typeof import("../ipc/sandbox")["markElevatedRootsPrepared"]
  runElevatedSetupForPaths: typeof import("../ipc/sandbox")["runElevatedSetupForPaths"]
  normalizeDirKey: typeof import("../ipc/sandbox")["normalizeDirKey"]
  getElevatedSystemSensitivePathError: typeof import("../ipc/sandbox")["getElevatedSystemSensitivePathError"]
  validateElevatedWorkspaceRoot: typeof import("../ipc/sandbox")["validateElevatedWorkspaceRoot"]
  getWindowsSandboxMode: typeof import("../storage")["getWindowsSandboxMode"]
  runHooksEnriched?: typeof import("../hooks/required-skill")["runHooksEnriched"]
  isCodeFile?: typeof import("../services/adoption-tracker")["isCodeFile"]
  recordGen?: typeof import("../services/adoption-tracker")["recordGen"]
  recordShellFileOps?: typeof import("../services/adoption-tracker")["recordShellFileOps"]
  getHarnessStageAttributionForCodeGeneration?: typeof import("../services/harness-stage-attribution")["getHarnessStageAttributionForCodeGeneration"]
  markHarnessStageAttributionDirty?: typeof import("../services/harness-stage-attribution")["markHarnessStageAttributionDirty"]
  recordSystemConstraintRead?: typeof import("../services/system-constraint-read-reporter")["recordSystemConstraintRead"]
  recordTrustedToolFilePreviewSource?: typeof import("../services/trusted-tool-file-preview")["recordTrustedToolFilePreviewSource"]
}
