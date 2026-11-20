import { getThreadCore } from "../db"
import { getModelConfigByRef } from "../models/registry"
import { isModelAvailable } from "../../shared/model-catalog"
import { assertIdleModelServiceHours } from "../../shared/idle-model-service-window"
import { MANAGED_ULTRA_MODEL_REF } from "../../shared/managed-run-model"
import { managedRunStore } from "./managed-run-store"
import { readHarnessFeatureMetadata } from "./service"

/** Only an active run may override a session's ordinary model selection. */
export function getManagedRunModelOverride(
  threadId: string,
  managedExecution = false
): string | undefined {
  const thread = getThreadCore(threadId)
  if (!thread?.metadata) return undefined
  let metadata: unknown
  try {
    metadata = JSON.parse(thread.metadata)
  } catch {
    return undefined
  }
  const feature = readHarnessFeatureMetadata(metadata)
  if (!feature?.runId) return undefined
  const record = managedRunStore.getRun({
    projectId: feature.projectId,
    featureId: feature.slug,
    runId: feature.runId
  })
  const run = record.snapshot
  if (record.corrupt || run?.status !== "running" || run.modelSelection !== "ultra") {
    return undefined
  }
  if (run.currentSession?.threadId !== threadId && !managedExecution) return undefined
  // A new session is already bound to the run before currentSession is updated.
  // The existing managedExecution launch marker covers that first turn only.
  const config = getModelConfigByRef(MANAGED_ULTRA_MODEL_REF)
  assertIdleModelServiceHours(config)
  const unavailableReason = config?.unavailableReason
  if (!isModelAvailable(config)) {
    throw new Error(
      `内置 Ultra 模型不可用：${unavailableReason || "请检查内置模型配置和登录用户信息"}`
    )
  }
  return MANAGED_ULTRA_MODEL_REF
}
