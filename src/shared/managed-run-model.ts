import {
  IDLE_ULTRA_MODEL_ID,
  IDLE_ULTRA_MODEL_NAME,
  MAODOU_PRO_MODEL_ID,
  MAODOU_PRO_MODEL_NAME
} from "./model-catalog"

export const MANAGED_RUN_MODEL_OPTIONS = [
  { value: "default", name: "默认模型", ref: undefined },
  // Existing Pro runs and schedules store the former "ultra" selection value.
  { value: "ultra", name: MAODOU_PRO_MODEL_NAME, ref: `builtin:${MAODOU_PRO_MODEL_ID}` },
  { value: "idle-ultra", name: IDLE_ULTRA_MODEL_NAME, ref: `builtin:${IDLE_ULTRA_MODEL_ID}` }
] as const

export type ManagedRunModelSelection = (typeof MANAGED_RUN_MODEL_OPTIONS)[number]["value"]

export function isManagedRunModelSelection(value: unknown): value is ManagedRunModelSelection {
  return MANAGED_RUN_MODEL_OPTIONS.some((option) => option.value === value)
}

export function getManagedRunModelOption(value?: ManagedRunModelSelection) {
  return MANAGED_RUN_MODEL_OPTIONS.find((option) => option.value === value) ?? MANAGED_RUN_MODEL_OPTIONS[0]
}

export function resolveManagedRunModelSelection(value: unknown): ManagedRunModelSelection {
  if (value === undefined) return "default"
  if (isManagedRunModelSelection(value)) return value
  throw new Error("托管模型选项无效，请重新选择")
}
