import { IDLE_MODEL_ID } from "./model-catalog"

export type ManagedRunModelSelection = "default" | "ultra"

export const MANAGED_ULTRA_MODEL_REF = `builtin:${IDLE_MODEL_ID}`

export const MANAGED_RUN_MODEL_LABELS: Record<ManagedRunModelSelection, string> = {
  default: "使用默认模型",
  ultra: "使用内置 Ultra 模型（夜间可用）"
}

export function resolveManagedRunModelSelection(value: unknown): ManagedRunModelSelection {
  if (value === undefined || value === "default") return "default"
  if (value === "ultra") return "ultra"
  throw new Error("托管模型选项无效，请重新选择")
}
