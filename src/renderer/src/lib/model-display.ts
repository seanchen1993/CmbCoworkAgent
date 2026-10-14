import type { ModelConfig } from "../types"

export type ModelDisplayConfig = Pick<ModelConfig, "id" | "source" | "model" | "name" | "available">

export interface ModelDisplay {
  name: string
  note: string | null
  matchedModelId: string | null
  state: "unspecified" | "unconfirmed" | "matched" | "not-found" | "ambiguous"
  /** Cached key metadata, not endpoint health. */
  available: boolean | null
}

function storageId(model: ModelDisplayConfig): string {
  const prefix = `${model.source}:`
  return model.id.startsWith(prefix) ? model.id.slice(prefix.length) : model.id
}

/** Name lookup only. Never changes a persisted reference or the model used by a request. */
export function resolveModelDisplay(
  modelRef: string | null | undefined,
  models: readonly ModelDisplayConfig[],
  hasCatalogSnapshot: boolean
): ModelDisplay {
  const raw = modelRef?.trim() ?? ""
  const fallback = raw.replace(/^(?:custom|builtin):/, "") || "未指定模型"
  if (!raw)
    return {
      name: fallback,
      note: null,
      matchedModelId: null,
      state: "unspecified",
      available: null
    }

  const groups: ModelDisplayConfig[][] = []
  if (raw.startsWith("builtin:")) {
    const id = raw.slice("builtin:".length)
    groups.push(models.filter((model) => model.source === "builtin" && model.id === raw))
    groups.push(models.filter((model) => model.source === "builtin" && storageId(model) === id))
  } else if (raw.startsWith("custom:")) {
    const id = raw.slice("custom:".length)
    groups.push(models.filter((model) => model.source === "custom" && model.id === raw))
    groups.push(models.filter((model) => model.source === "custom" && storageId(model) === id))
    groups.push(models.filter((model) => model.source === "custom" && model.model === id))
  } else {
    groups.push(models.filter((model) => model.source === "custom" && storageId(model) === raw))
    groups.push(models.filter((model) => model.source === "custom" && model.model === raw))
    groups.push(models.filter((model) => storageId(model) === raw || model.model === raw))
  }

  const candidates = groups.find((group) => group.length > 0) ?? []
  const matched = candidates.length === 1 ? candidates[0] : undefined
  if (!hasCatalogSnapshot)
    return {
      name: matched?.name.trim() || fallback,
      note: "名称尚未取得",
      matchedModelId: null,
      state: "unconfirmed",
      available: null
    }
  if (candidates.length > 1)
    return {
      name: fallback,
      note: "名称尚未确认",
      matchedModelId: null,
      state: "ambiguous",
      available: null
    }
  if (!matched)
    return {
      name: fallback,
      note: "名称未找到（按已取得列表）",
      matchedModelId: null,
      state: "not-found",
      available: null
    }
  return {
    name: matched.name.trim() || fallback,
    note: matched.available ? null : "未配置密钥",
    matchedModelId: matched.id,
    state: "matched",
    available: matched.available
  }
}
