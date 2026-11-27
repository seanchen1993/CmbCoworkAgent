import { isModelAvailable } from "../../shared/model-catalog"
import { getModelConfigByRef, getModelConfigs } from "./registry"

/** Same candidate order for group admission and the eventual task-model request. */
export function eligibleChatImageModels(requested: string | undefined, pinned: boolean) {
  const candidates = getModelConfigs().filter(isModelAvailable)
  const preferred = requested ? getModelConfigByRef(requested) : candidates[0]
  return (pinned ? [preferred] : [preferred, ...candidates]).filter(config =>
    isModelAvailable(config) && config.inputModalities?.includes("image"))
}
