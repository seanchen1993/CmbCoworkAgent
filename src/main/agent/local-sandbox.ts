/** Desktop wiring for the shared LocalSandbox implementation. */
import { createLocalSandboxClass } from "./local-sandbox-core"
export * from "./local-sandbox-core"
import { attachModBackend, protectCurrentModData, publishCurrentModResult } from "../mods/adapters"
import { authorizeCurrentModInput } from "../mods/manager"
import { getModCallContext } from "../mods/context"
import { currentFunctionExecution } from "../mods/v2/execution-context"
import { areElevatedRootsPreparedAsync, isElevatedSetupComplete, markElevatedRootsPrepared, runElevatedSetupForPaths, normalizeDirKey, getElevatedSystemSensitivePathError, validateElevatedWorkspaceRoot } from "../ipc/sandbox"
import { getWindowsSandboxMode } from "../storage"
import { runHooksEnriched } from "../hooks/required-skill"
import { isCodeFile, recordGen, recordShellFileOps } from "../services/adoption-tracker"
import { getHarnessStageAttributionForCodeGeneration, markHarnessStageAttributionDirty } from "../services/harness-stage-attribution"
import { recordSystemConstraintRead } from "../services/system-constraint-read-reporter"
import { recordTrustedToolFilePreviewSource } from "../services/trusted-tool-file-preview"

export const LocalSandbox = createLocalSandboxClass({
  attachModBackend,
  protectCurrentModData,
  publishCurrentModResult,
  authorizeCurrentModInput,
  getModCallContext,
  currentFunctionExecution,
  areElevatedRootsPreparedAsync,
  isElevatedSetupComplete,
  markElevatedRootsPrepared,
  runElevatedSetupForPaths,
  normalizeDirKey,
  getElevatedSystemSensitivePathError,
  validateElevatedWorkspaceRoot,
  getWindowsSandboxMode,
  runHooksEnriched,
  isCodeFile,
  recordGen,
  recordShellFileOps,
  getHarnessStageAttributionForCodeGeneration,
  markHarnessStageAttributionDirty,
  recordSystemConstraintRead,
  recordTrustedToolFilePreviewSource
})
export type LocalSandbox = InstanceType<typeof LocalSandbox>
