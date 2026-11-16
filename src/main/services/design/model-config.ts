import { normalizeDesignModelId } from "../../../shared/design-model-selection"
import {
  getAvailableModelConfigOrDefault,
  getModelConfigByRef,
  type ResolvedModelConfig
} from "../../models/registry"

/** Resolve the selected source exactly; use the default only for an empty selection. */
export function getDesignModelConfig(
  modelId?: string | null
): (ResolvedModelConfig & { apiKey: string }) | null {
  const ref = normalizeDesignModelId(modelId)
  const config = ref ? getModelConfigByRef(ref) : getAvailableModelConfigOrDefault()
  return config?.apiKey ? { ...config, apiKey: config.apiKey } : null
}
