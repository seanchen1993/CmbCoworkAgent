import { IDLE_MODEL_ID, IDLE_MODEL_NAME } from "./model-catalog"

// The "ultra" value is persisted in existing managed runs and schedules.
export type ManagedRunModelSelection = "default" | "ultra"

export const MANAGED_IDLE_MODEL_REF = `builtin:${IDLE_MODEL_ID}`

export const MANAGED_RUN_MODEL_LABELS: Record<ManagedRunModelSelection, string> = {
  default: "使用默认模型",
  ultra: `使用${IDLE_MODEL_NAME}`
}

export function resolveManagedRunModelSelection(value: unknown): ManagedRunModelSelection {
  if (value === undefined || value === "default") return "default"
  if (value === "ultra") return "ultra"
  throw new Error("托管模型选项无效，请重新选择")
}
